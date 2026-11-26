import type { Database } from '@alpi/db'
import { can, type ResourceScope } from '@alpi/shared'
import { Hono } from 'hono'
import { type Kysely, sql } from 'kysely'
import { requestAuthor } from '../api-keys/actor.ts'
import { audit } from '../audit/record.ts'
import { diffFields, type FieldChange, recordChanges } from '../change-log/record.ts'
import { type Ctx, fail, type Outcome, ok, readBody, refuse, UUID } from '../contacts/http.ts'
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
import { visibleCustom } from '../fields/values.ts'
import { type PermissionsEnv, requestAccess, requirePermission } from '../middleware/permissions.ts'
import { inSavepoint, sqlState } from '../roles/roles.ts'
import { requestViewer } from '../roles/scope.ts'
import { DEAL_MERGE_REGISTRY, type MovedAmount } from './deal-registry.ts'
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

// Слияние сделок с откатом (тикет crm-intake/02; пункты 26, 29, 30, 36; ADR 0005). Только по
// сессии: ключу API маршруты закрыты (403 API_KEY_NOT_ALLOWED).
//
// - `POST /v1/deals/:id/merge` с `{ merge_deal_id }` — `:id` остаётся, вторая скрывается с
//   отметкой «слита с :id». Что переходит — реестр merge/deal-registry.ts. Одной транзакцией:
//   перенос, merge_record и merge_moved_item, история обеих сделок, журнал проекта
//   (`deal.merged`), событие `deal.merged`.
// - `POST /v1/deals/:id/merge/preview` — то же без записи: что перейдёт и какие поля заполнятся.
// - `GET /v1/deals/:id/merges` — слияния в эту сделку, которые ещё можно откатить.
// - `POST /v1/merges/:id/undo` — откат (общий маршрут слияний, ветка по типу записи): возвращает
//   ровно записанное в merge_moved_item.
//
// Обе сделки — своего проекта, не в корзине, не слиты, разные; статус и воронка любые. Право —
// «сделки: изменять» и обе сделки в охвате изменения (пункт 26): вне охвата чтения — 404, как
// несуществующая, в охвате чтения, но не изменения — 403. Откат проверяет то же право на эти две
// сделки сейчас (тот, кто может их объединить).
//
// Гонки (расширенная проверка PR #39, тикет crm-intake/01):
// - Обе сделки блокируются FOR UPDATE в одном порядке до первого чтения. Добавление заметки,
//   файла (timeline/entity.ts, FOR SHARE), строки товара и участника (deals/store.ts,
//   writableDeal, FOR UPDATE) ждёт слияния и потом не находит скрытую сделку.
// - Время слияния — clock_timestamp() после блокировок (merge/store.ts, insertMerge). Откат
//   отказывает, если оставшаяся сама уже слита с другой: иначе перешедшее к ней осталось бы у
//   скрытой сделки.

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

type Result<T> = Outcome<T, DealMergeErrorCode>

interface DealMergeContext extends MergeActor {
  /** Охват сделок. */
  scope: ResourceScope
}

async function mergeContext(c: Ctx): Promise<DealMergeContext> {
  const db = c.get('db')
  const actor = c.get('actor')
  const { actorId } = requestAuthor(actor)
  // Маршруты — только сессия: автор всегда пользователь.
  if (actorId === null) throw new Error('слияние без пользователя')
  const { permissions } = c.get('access')
  return {
    db,
    projectId: c.get('projectId'),
    actorId,
    actorApiKeyId: null,
    ip: c.get('clientIp'),
    permissions,
    viewer: await requestViewer(db, actor),
    scope: permissions.scopes.deals,
  }
}

// ---- Проверки --------------------------------------------------------------------------------

/** Сделка в охвате: вне чтения — 404, вне изменения — 403. */
function checkScope(ctx: DealMergeContext, row: DealRow): Result<null> {
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
): Promise<Result<DealRow>> {
  const row = rows.find((r) => r.id === id)
  if (!row) return refuse(404, 'DEAL_NOT_FOUND')
  if (row.merged_into_id !== null) {
    return (
      (await mergedDealRefusal(ctx.db, id, ctx.scope.read, ctx.viewer)) ??
      refuse(404, 'DEAL_NOT_FOUND')
    )
  }
  if (row.deleted_at !== null) return refuse(404, 'DEAL_NOT_FOUND')
  const scoped = checkScope(ctx, row)
  return scoped.ok ? ok(row) : scoped
}

function readMergedId(body: Record<string, unknown> | null): Result<string> {
  if (!body) return refuse(400, 'INVALID_MERGE', { path: '' })
  const extra = Object.keys(body).find((key) => key !== 'merge_deal_id')
  if (extra !== undefined) return refuse(400, 'INVALID_MERGE', { path: extra })
  const id = body.merge_deal_id
  if (typeof id !== 'string' || !UUID.test(id)) {
    return refuse(400, 'INVALID_MERGE', { path: 'merge_deal_id' })
  }
  return ok(id.toLowerCase())
}

/** Пара проверена и заблокирована: строки обеих сделок. */
async function checkedPair(
  ctx: DealMergeContext,
  survivorId: string,
  mergedId: string,
): Promise<Result<{ pair: MergePair; survivor: DealRow; merged: DealRow }>> {
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

/** Что перейдёт при слиянии — ответ предпросмотра. */
export interface DealMergePreview {
  survivor: DealView
  merged: DealView
  /**
   * Пустые поля оставшейся, которые заполнятся: имя поля в API и значение. У суммы значение —
   * `{ amount, currency }`.
   */
  fields: { field: string; value: unknown }[]
  products: number
  /** Сколько строк товаров получат цену товара в валюте оставшейся сделки. */
  convertedProducts: number
  participants: number
  /** Основной контакт слитой, который станет участником оставшейся; null — не станет. */
  primaryContactId: string | null
  notes: number
  files: number
}

export interface DealMergeResult {
  merge: MergeView
  deal: DealView
}

/** Слияние в ответе вместе с названием слитой сделки: список в карточке оставшейся. */
export interface DealMergeListItem extends MergeView {
  mergedDeal: { id: string; title: string }
}

async function preview(
  ctx: DealMergeContext,
  survivorId: string,
  mergedId: string,
): Promise<Result<DealMergePreview>> {
  const checked = await checkedPair(ctx, survivorId, mergedId)
  if (!checked.ok) return checked
  const { pair, survivor, merged } = checked.value
  const items = await planAll(DEAL_MERGE_REGISTRY, ctx, pair)
  const of = (kind: string) => items.filter((item) => item.kind === kind)
  // Пользовательские поля скрытых от роли групп в предпросмотр не попадают (но переходят).
  const fieldItems = of('field')
  const [visible = {}] = await visibleCustom(ctx, 'deal', [
    Object.fromEntries(
      fieldItems
        .filter((item) => item.field?.startsWith('custom.'))
        .map((item) => [(item.field ?? '').slice('custom.'.length), item.value]),
    ),
  ])
  const primary = of('primary_participant')[0]
  return ok({
    survivor: await dealView(ctx, survivor),
    merged: await dealView(ctx, merged),
    fields: fieldItems
      .filter(
        (item) =>
          !item.field?.startsWith('custom.') ||
          Object.hasOwn(visible, (item.field ?? '').slice('custom.'.length)),
      )
      .map((item) => {
        if (item.field !== 'amount') return { field: item.field ?? '', value: item.value }
        const { amount, currency } = item.value as MovedAmount
        return { field: 'amount', value: { amount: Number(amount), currency } }
      }),
    products: of('deal_product').length,
    convertedProducts: of('deal_product').filter(
      (item) => (item.value as { convertedPrice: string | null }).convertedPrice !== null,
    ).length,
    participants: of('deal_participant').length,
    primaryContactId: primary ? (primary.value as { contactId: string }).contactId : null,
    notes: of('note').length,
    files: of('file').length,
  })
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

async function mergeDeals(
  ctx: DealMergeContext,
  survivorId: string,
  mergedId: string,
): Promise<Result<DealMergeResult>> {
  const checked = await checkedPair(ctx, survivorId, mergedId)
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
  const record = await insertMerge(ctx, 'deal', pair, items)
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
    details: { mergeId: record.id, mergedDealId: pair.mergedId },
  })
  await emitEvent(ctx, 'deal.merged', { deal_id: pair.survivorId, merged_deal_id: pair.mergedId })
  const [merge] = await mergeViews(ctx.db, [record])
  if (!merge) throw new Error('слияние пропало в той же транзакции')
  return ok({ merge, deal: survivorAfter.view })
}

/** Слияния в сделку `id`, которые ещё можно откатить: новые сверху. */
async function dealMerges(ctx: DealMergeContext, id: string): Promise<Result<DealMergeListItem[]>> {
  if (!UUID.test(id)) return refuse(404, 'DEAL_NOT_FOUND')
  const deal = await ctx.db
    .selectFrom('deal')
    .select(['id', 'owner_id', 'deleted_at', 'merged_into_id'])
    .where('id', '=', id.toLowerCase())
    .executeTakeFirst()
  if (!deal || !ownerAllowed(deal.owner_id, ctx.scope.read, ctx.viewer)) {
    return refuse(404, 'DEAL_NOT_FOUND')
  }
  if (deal.merged_into_id !== null) {
    return (
      (await mergedDealRefusal(ctx.db, deal.id, ctx.scope.read, ctx.viewer)) ??
      refuse(404, 'DEAL_NOT_FOUND')
    )
  }
  const rows = await ctx.db
    .selectFrom('merge_record')
    .selectAll()
    .where('entity_type', '=', 'deal')
    .where('survivor_id', '=', deal.id)
    .where('undone_at', 'is', null)
    .where('undo_until', '>', sql<Date>`now()`)
    .orderBy('merged_at', 'desc')
    .orderBy('id', 'desc')
    .execute()
  const views = await mergeViews(ctx.db, rows)
  const titles =
    rows.length === 0
      ? []
      : await ctx.db
          .selectFrom('deal')
          .select(['id', 'title'])
          .where(
            'id',
            'in',
            rows.map((row) => row.merged_id),
          )
          .execute()
  const byId = new Map(titles.map((row) => [row.id, row.title]))
  return ok(
    views.flatMap((view) => {
      const title = byId.get(view.mergedId)
      return title === undefined ? [] : [{ ...view, mergedDeal: { id: view.mergedId, title } }]
    }),
  )
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

async function undoDealMerge(ctx: DealMergeContext, id: string): Promise<Result<DealUndoResult>> {
  const record = await findMerge(ctx.db, 'deal', id, true)
  if (!record) return refuse(404, 'MERGE_NOT_FOUND')
  if (record.undone_at !== null) return refuse(409, 'MERGE_ALREADY_UNDONE')
  const pair = { survivorId: record.survivor_id, mergedId: record.merged_id }
  const rows = await lockDeals(ctx.db, [pair.survivorId, pair.mergedId])
  const survivor = rows.find((row) => row.id === pair.survivorId)
  const merged = rows.find((row) => row.id === pair.mergedId)
  if (!survivor || !merged) return refuse(404, 'MERGE_NOT_FOUND')
  const survivorScope = checkScope(ctx, survivor)
  if (!survivorScope.ok) return survivorScope
  const mergedScope = checkScope(ctx, merged)
  if (!mergedScope.ok) return mergedScope
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

// ---- Маршруты --------------------------------------------------------------------------------

function respond<T>(c: Ctx, outcome: Result<T>) {
  return outcome.ok ? c.json(outcome.value as object) : fail(c, outcome)
}

/** Маршруты слияния сделок: `/v1/deals/:id/merge…` (только сессия). */
export function dealMergeRoutes() {
  const edit = requirePermission('deals', 'edit')
  return new Hono<PermissionsEnv>()
    .get('/:id/merges', requirePermission('deals', 'view'), async (c) =>
      respond(c, await dealMerges(await mergeContext(c), c.req.param('id'))),
    )
    .post('/:id/merge/preview', edit, async (c) => {
      const mergedId = readMergedId(await readBody(c))
      if (!mergedId.ok) return fail(c, mergedId)
      return respond(c, await preview(await mergeContext(c), c.req.param('id'), mergedId.value))
    })
    .post('/:id/merge', edit, async (c) => {
      const mergedId = readMergedId(await readBody(c))
      if (!mergedId.ok) return fail(c, mergedId)
      return respond(c, await mergeDeals(await mergeContext(c), c.req.param('id'), mergedId.value))
    })
}

/**
 * Откат слияния: `/v1/merges/:id/undo` (только сессия). Ветка — по типу записей слияния, право
 * — «изменять» их часть системы (сделки — «сделки: изменять»); охват проверяет ветка. Слияния
 * контактов добавит тикет crm-intake/01 своей веткой.
 */
export function mergesRoutes() {
  return new Hono<PermissionsEnv>().post('/:id/undo', async (c) => {
    const raw = c.req.param('id')
    if (!UUID.test(raw)) return fail(c, refuse(404, 'MERGE_NOT_FOUND'))
    const id = raw.toLowerCase()
    const record = await c
      .get('db')
      .selectFrom('merge_record')
      .select('entity_type')
      .where('id', '=', id)
      .executeTakeFirst()
    const access = await requestAccess(c)
    if (!access) return fail(c, refuse(403, 'PERMISSION_DENIED'))
    switch (record?.entity_type) {
      case 'deal':
        if (!can(access.permissions, 'deals', 'edit')) {
          return fail(c, refuse(403, 'PERMISSION_DENIED'))
        }
        return respond(c, await undoDealMerge(await mergeContext(c), id))
      default:
        return fail(c, refuse(404, 'MERGE_NOT_FOUND'))
    }
  })
}
