import type { Database } from '@alpi/db'
import type { ResourceScope } from '@alpi/shared'
import { type Kysely, sql } from 'kysely'
import { audit } from '../audit/record.ts'
import { diffFields, type FieldChange, recordChanges } from '../change-log/record.ts'
import { type Outcome, ok, refuse, UUID } from '../contacts/http.ts'
import { ownerAllowed } from '../deals/scope.ts'
import {
  type DealRow,
  type DealView,
  dealView,
  LOGGED_FIELDS,
  lockDeals,
  mergedDealRefusal,
  reloadDeal,
} from '../deals/store.ts'
import { emitEvent } from '../events/emit.ts'
import { inSavepoint, sqlState } from '../roles/roles.ts'
import { DEAL_MERGE_REGISTRY } from './deal-registry.ts'
import {
  applyAll,
  canonical,
  type MergeActor,
  type MergePair,
  planAll,
  restoreAll,
  type UndoSkip,
} from './registry.ts'
import {
  findMerge,
  insertMerge,
  laterMerge,
  type MergeView,
  markUndone,
  mergeViews,
  movedItems,
  undoExpired,
} from './store.ts'

// Ядро слияния сделок и его отката (тикет crm-intake/02): проверки пары, слияние, откат. Общее
// для маршрутов сделок (merge/deals.ts) и слияния контактов, которое в том же действии
// объединяет их конфликтующие сделки (тикет crm-intake/04, merge/contacts.ts). Отдельный модуль:
// merge/deals.ts импортирует merge/contacts.ts (общий откат), и обратный импорт дал бы цикл.
//
// Функции не открывают своей транзакции: работают в транзакции проекта запроса (`ctx.db`).

export type DealMergeErrorCode =
  | 'PERMISSION_DENIED'
  | 'INVALID_MERGE'
  | 'DEAL_NOT_FOUND'
  /** Одна из сделок уже слита: `details.merged_into_id`. */
  | 'DEAL_MERGED'
  /** Сделку нельзя слить с самой собой. */
  | 'MERGE_SAME_DEAL'
  | 'MERGE_NOT_FOUND'
  | 'MERGE_ALREADY_UNDONE'
  /** Прошло 30 дней. */
  | 'MERGE_UNDO_EXPIRED'
  /**
   * Одна из сделок слита ещё раз позже или оставшаяся сама слита с другой: `details.mergeId` —
   * что откатить сначала.
   */
  | 'MERGE_UNDO_BLOCKED'
  /** Оставшаяся сделка в корзине: сначала восстановить её. */
  | 'MERGE_UNDO_SURVIVOR_TRASHED'
  /**
   * Вернувшаяся открытая сделка нарушит «одна открытая сделка у человека в воронке»:
   * `details.dealId` — мешающая сделка (решено без владельца — подтвердить).
   */
  | 'MERGE_UNDO_DEAL_CONFLICT'
  /** Основной контакт слитой сделки в корзине: сначала восстановить контакт. */
  | 'CONTACT_IN_TRASH'
  /** Слитая сделка открыта на этапе, который удалили, пока она была скрыта. */
  | 'STAGE_DELETED'
  /**
   * Сделки объединены вместе со слиянием контактов (тикет crm-intake/04): откатывается только
   * вместе с ним, `details.mergeId` — слияние контактов.
   */
  | 'MERGE_UNDO_NESTED'

export type DealResult<T> = Outcome<T, DealMergeErrorCode>

export interface DealMergeContext extends MergeActor {
  /** Охват сделок. */
  scope: ResourceScope
}

// ---- Проверки --------------------------------------------------------------------------------

/** Сделка в охвате: вне чтения — 404, вне изменения — 403. */
export function checkDealScope(ctx: DealMergeContext, row: DealRow): DealResult<null> {
  if (!ownerAllowed(row.owner_id, ctx.scope.read, ctx.viewer)) return refuse(404, 'DEAL_NOT_FOUND')
  if (!ownerAllowed(row.owner_id, ctx.scope.write, ctx.viewer)) {
    return refuse(403, 'PERMISSION_DENIED')
  }
  return ok(null)
}

/** Сделка, которую можно слить: существует, не слита, не в корзине, в охвате изменения. */
async function mergeable(
  ctx: DealMergeContext,
  rows: readonly DealRow[],
  id: string,
): Promise<DealResult<DealRow>> {
  const row = rows.find((r) => r.id === id)
  if (!row) return refuse(404, 'DEAL_NOT_FOUND')
  if (row.merged_into_id !== null) {
    return (
      (await mergedDealRefusal(ctx.db, id, ctx.scope.read, ctx.viewer)) ??
      refuse(404, 'DEAL_NOT_FOUND')
    )
  }
  if (row.deleted_at !== null) return refuse(404, 'DEAL_NOT_FOUND')
  const scoped = checkDealScope(ctx, row)
  return scoped.ok ? ok(row) : scoped
}

/** Пара проверена и заблокирована: строки обеих сделок. */
export async function checkedDealPair(
  ctx: DealMergeContext,
  survivorId: string,
  mergedId: string,
): Promise<DealResult<{ pair: MergePair; survivor: DealRow; merged: DealRow }>> {
  if (!UUID.test(survivorId)) return refuse(404, 'DEAL_NOT_FOUND')
  const id = survivorId.toLowerCase()
  if (id === mergedId) return refuse(422, 'MERGE_SAME_DEAL')
  const rows = await lockDeals(ctx.db, [id, mergedId])
  const survivor = await mergeable(ctx, rows, id)
  if (!survivor.ok) return survivor
  const merged = await mergeable(ctx, rows, mergedId)
  if (!merged.ok) return merged
  return ok({ pair: { survivorId: id, mergedId }, survivor: survivor.value, merged: merged.value })
}

// ---- Слияние ---------------------------------------------------------------------------------

export interface DealMergeResult {
  merge: MergeView
  deal: DealView
}

/** Состояние сделки для истории: ответ API и все пользовательские поля (без фильтра роли). */
async function snapshot(ctx: DealMergeContext, id: string) {
  const row = await reloadDeal(ctx, id)
  return { view: await dealView(ctx, row), custom: row.custom }
}

type Snapshot = Awaited<ReturnType<typeof snapshot>>

/** «Было → стало» сделки: поля истории, строки товаров и пользовательские поля по коду. */
function changesOf(before: Snapshot, after: Snapshot): FieldChange[] {
  const changes = diffFields(before.view, after.view, [...LOGGED_FIELDS, 'products'])
  const codes = [...new Set([...Object.keys(before.custom), ...Object.keys(after.custom)])].sort()
  for (const code of codes) {
    const was = before.custom[code] ?? null
    const now = after.custom[code] ?? null
    if (canonical(was) !== canonical(now)) {
      changes.push({ field: `custom.${code}`, before: was, after: now })
    }
  }
  return changes
}

/**
 * Слияние сделки `mergedId` в `survivorId`. `parentId` — слияние контактов, в том же действии
 * которого объединяются сделки (тикет crm-intake/04); null — самостоятельное.
 */
export async function mergeDeals(
  ctx: DealMergeContext,
  survivorId: string,
  mergedId: string,
  parentId: string | null = null,
): Promise<DealResult<DealMergeResult>> {
  const checked = await checkedDealPair(ctx, survivorId, mergedId)
  if (!checked.ok) return checked
  const { pair } = checked.value
  const items = await planAll(DEAL_MERGE_REGISTRY, ctx, pair)
  const survivorBefore = await snapshot(ctx, pair.survivorId)
  const mergedBefore = await snapshot(ctx, pair.mergedId)
  await applyAll(DEAL_MERGE_REGISTRY, ctx, pair, items)
  await ctx.db
    .updateTable('deal')
    .set({
      merged_into_id: pair.survivorId,
      merged_at: sql`clock_timestamp()`,
      updated_at: sql`now()`,
    })
    .where('id', '=', pair.mergedId)
    .execute()
  const record = await insertMerge(ctx, 'deal', pair, items, parentId)
  const survivorAfter = await snapshot(ctx, pair.survivorId)
  await recordChanges(ctx, { type: 'deal', id: pair.survivorId }, [
    ...changesOf(survivorBefore, survivorAfter),
    { field: 'mergedDealId', before: null, after: pair.mergedId },
  ])
  await recordChanges(ctx, { type: 'deal', id: pair.mergedId }, [
    ...changesOf(mergedBefore, await snapshot(ctx, pair.mergedId)),
    { field: 'mergedIntoId', before: null, after: pair.survivorId },
  ])
  await audit.record(ctx.db, ctx.projectId, {
    action: 'deal.merged',
    actorId: ctx.actorId,
    ip: ctx.ip,
    entity: { type: 'deal', id: pair.survivorId },
    details: {
      mergeId: record.id,
      mergedDealId: pair.mergedId,
      ...(parentId === null ? {} : { parentMergeId: parentId }),
    },
  })
  await emitEvent(ctx, 'deal.merged', { deal_id: pair.survivorId, merged_deal_id: pair.mergedId })
  const [merge] = await mergeViews(ctx.db, [record])
  if (!merge) throw new Error('слияние пропало в той же транзакции')
  return ok({ merge, deal: survivorAfter.view })
}

// ---- Откат -----------------------------------------------------------------------------------

export interface DealUndoResult {
  merge: MergeView
  deal: DealView
  mergedDeal: DealView
  /** Что не вернулось: удалено (`gone`) или изменено после слияния (`changed`). */
  skipped: UndoSkip[]
}

const UNIQUE_VIOLATION = '23505'

/** Открытая неархивная сделка того же контакта в той же воронке — помешает вернуть `merged`. */
async function openDealConflict(ctx: DealMergeContext, merged: DealRow): Promise<string | null> {
  if (merged.status !== 'open' || merged.archived_at !== null) return null
  const row = await ctx.db
    .selectFrom('deal')
    .select('id')
    .where('pipeline_id', '=', merged.pipeline_id)
    .where('primary_contact_id', '=', merged.primary_contact_id)
    .where('status', '=', 'open')
    .where('archived_at', 'is', null)
    .where('deleted_at', 'is', null)
    .where('merged_into_id', 'is', null)
    .where('id', '<>', merged.id)
    .orderBy('id')
    .limit(1)
    .executeTakeFirst()
  return row?.id ?? null
}

/** Слияние, которое скрыло сделку `id` и ещё не откачено. */
async function hidingMerge(db: Kysely<Database>, id: string): Promise<string | null> {
  const row = await db
    .selectFrom('merge_record')
    .select('id')
    .where('entity_type', '=', 'deal')
    .where('merged_id', '=', id)
    .where('undone_at', 'is', null)
    .orderBy('merged_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  return row?.id ?? null
}

/**
 * Откат слияния сделок `id`. `parentId` — слияние контактов, которое откатывается вместе с ним
 * (тикет crm-intake/04); у самостоятельного отката null, и вложенное слияние он не откатывает
 * (409 MERGE_UNDO_NESTED). Строки сделок читаются здесь, после блокировки: откат слияния
 * контактов перед этим уже вернул основной контакт слитой сделки.
 */
export async function undoDealMerge(
  ctx: DealMergeContext,
  id: string,
  parentId: string | null = null,
): Promise<DealResult<DealUndoResult>> {
  const record = await findMerge(ctx.db, 'deal', id, true)
  if (!record) return refuse(404, 'MERGE_NOT_FOUND')
  if (record.undone_at !== null) return refuse(409, 'MERGE_ALREADY_UNDONE')
  const pair = { survivorId: record.survivor_id, mergedId: record.merged_id }
  const rows = await lockDeals(ctx.db, [pair.survivorId, pair.mergedId])
  const survivor = rows.find((row) => row.id === pair.survivorId)
  const merged = rows.find((row) => row.id === pair.mergedId)
  if (!survivor || !merged) return refuse(404, 'MERGE_NOT_FOUND')
  const survivorScope = checkDealScope(ctx, survivor)
  if (!survivorScope.ok) return survivorScope
  const mergedScope = checkDealScope(ctx, merged)
  if (!mergedScope.ok) return mergedScope
  if (record.parent_id !== parentId) {
    return refuse(409, 'MERGE_UNDO_NESTED', { mergeId: record.parent_id })
  }
  if (await undoExpired(ctx.db, record)) return refuse(409, 'MERGE_UNDO_EXPIRED')
  // Оставшаяся сама слита с другой — сначала откатить то слияние: иначе то, что перешло к ней,
  // осталось бы у скрытой сделки.
  if (survivor.merged_into_id !== null) {
    return refuse(409, 'MERGE_UNDO_BLOCKED', {
      mergeId: await hidingMerge(ctx.db, survivor.id),
    })
  }
  const later = await laterMerge(ctx.db, record)
  if (later !== null || merged.merged_into_id !== pair.survivorId) {
    return refuse(409, 'MERGE_UNDO_BLOCKED', { mergeId: later })
  }
  if (survivor.deleted_at !== null) return refuse(409, 'MERGE_UNDO_SURVIVOR_TRASHED')
  // FOR SHARE: контакт не уйдёт в корзину, пока сделка возвращается.
  const contact = await ctx.db
    .selectFrom('contact')
    .select('id')
    .where('id', '=', merged.primary_contact_id)
    .where('deleted_at', 'is', null)
    .forShare()
    .executeTakeFirst()
  if (!contact) return refuse(409, 'CONTACT_IN_TRASH')
  if (merged.status === 'open') {
    const stage = await ctx.db
      .selectFrom('stage')
      .select('id')
      .where('id', '=', merged.stage_id)
      .where('deleted_at', 'is', null)
      .forShare()
      .executeTakeFirst()
    if (!stage) return refuse(409, 'STAGE_DELETED')
  }
  const conflict = await openDealConflict(ctx, merged)
  if (conflict !== null) return refuse(409, 'MERGE_UNDO_DEAL_CONFLICT', { dealId: conflict })

  const survivorBefore = await snapshot(ctx, pair.survivorId)
  const mergedBefore = await snapshot(ctx, pair.mergedId)
  // Сначала сделка возвращается (единственный шаг, который может получить отказ базы: открытую
  // сделку того же контакта в воронке создали одновременно), потом — перешедшее: отказ
  // фиксирует транзакцию запроса, и половина отката не должна остаться.
  try {
    await inSavepoint(ctx.db, () =>
      ctx.db
        .updateTable('deal')
        .set({ merged_into_id: null, merged_at: null, updated_at: sql`now()` })
        .where('id', '=', pair.mergedId)
        .execute(),
    )
  } catch (error) {
    if (sqlState(error) === UNIQUE_VIOLATION) {
      return refuse(409, 'MERGE_UNDO_DEAL_CONFLICT', {
        dealId: await openDealConflict(ctx, merged),
      })
    }
    throw error
  }
  const skipped = await restoreAll(
    DEAL_MERGE_REGISTRY,
    ctx,
    pair,
    await movedItems(ctx.db, record.id),
  )
  const undone = await markUndone(ctx, record.id)
  const survivorAfter = await snapshot(ctx, pair.survivorId)
  const mergedAfter = await snapshot(ctx, pair.mergedId)
  await recordChanges(ctx, { type: 'deal', id: pair.survivorId }, [
    ...changesOf(survivorBefore, survivorAfter),
    { field: 'mergedDealId', before: pair.mergedId, after: null },
  ])
  await recordChanges(ctx, { type: 'deal', id: pair.mergedId }, [
    ...changesOf(mergedBefore, mergedAfter),
    { field: 'mergedIntoId', before: pair.survivorId, after: null },
  ])
  await audit.record(ctx.db, ctx.projectId, {
    action: 'deal.unmerged',
    actorId: ctx.actorId,
    ip: ctx.ip,
    entity: { type: 'deal', id: pair.survivorId },
    details: {
      mergeId: record.id,
      mergedDealId: pair.mergedId,
      skipped: skipped.map(({ kind, itemId, field, reason }) => ({ kind, itemId, field, reason })),
    },
  })
  await emitEvent(ctx, 'deal.unmerged', {
    deal_id: pair.survivorId,
    merged_deal_id: pair.mergedId,
  })
  const [merge] = await mergeViews(ctx.db, [undone])
  if (!merge) throw new Error('слияние пропало в той же транзакции')
  return ok({ merge, deal: survivorAfter.view, mergedDeal: mergedAfter.view, skipped })
}
