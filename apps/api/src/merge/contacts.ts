import type { Database } from '@alpi/db'
import { can, type ResourceScope } from '@alpi/shared'
import { Hono } from 'hono'
import { type Kysely, sql } from 'kysely'
import { requestAuthor } from '../api-keys/actor.ts'
import { audit } from '../audit/record.ts'
import { diffFields, type FieldChange, recordChanges } from '../change-log/record.ts'
import {
  type ContactRow,
  type ContactView,
  contactView,
  LOGGED_FIELDS,
} from '../contacts/contacts.ts'
import { type Ctx, fail, type Outcome, ok, readBody, refuse, UUID } from '../contacts/http.ts'
import { mergedContactRefusal } from '../contacts/merged.ts'
import {
  CONTACT_SCOPE_RULES,
  type ContactScopeRule,
  CREATED_BY_RULE,
  contactScopePredicate,
} from '../contacts/scope.ts'
import { dealInScope } from '../deals/scope.ts'
import { emitEvent } from '../events/emit.ts'
import { visibleCustom } from '../fields/values.ts'
import { type PermissionsEnv, requestAccess, requirePermission } from '../middleware/permissions.ts'
import { requestViewer } from '../roles/scope.ts'
import { CONTACT_MERGE_REGISTRY, movedDealIds } from './contact-registry.ts'
import {
  applyAll,
  canonical,
  type MergeActor,
  type MergePair,
  type MovedItem,
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

// Слияние контактов с откатом (тикет crm-intake/01; пункты 23, 25, 26, 29, 36; ADR 0005).
// Только по сессии: ключу API маршруты закрыты (403 API_KEY_NOT_ALLOWED).
//
// - `POST /v1/contacts/:id/merge` с `{ merge_contact_id }` — `:id` остаётся, второй скрывается
//   с отметкой «слит с :id». Что переходит — реестр merge/contact-registry.ts. Одной
//   транзакцией: перенос, merge_record и merge_moved_item, история обоих контактов, журнал
//   проекта (`contact.merged`), событие `contact.merged`.
// - `POST /v1/contacts/:id/merge/preview` — то же без записи: что перейдёт, какие поля
//   заполнятся, сколько сделок вне охвата пользователя.
// - `GET /v1/contacts/:id/merges` — слияния в этот контакт, которые ещё можно откатить.
// - `POST /v1/merges/:id/undo` — откат: возвращает ровно записанное в merge_moved_item. Маршрут
//   общий со сделками (merge/deals.ts, mergesRoutes), ветка контакта — undoContactMerge.
//
// Право — «контакты: изменять» и оба контакта в охвате изменения (пункт 26); вне охвата
// чтения — 404, как несуществующий, в охвате чтения, но не изменения — 403. Откат проверяет то
// же право на эти два контакта сейчас (решено без владельца — подтвердить). Охват скрытого
// контакта при откате — «создан пользователем» или сделки, которые к нему вернутся: своих
// сделок у скрытого контакта нет.
//
// Пока у обоих есть открытые неархивные сделки в одной воронке — 409 MERGE_DEAL_CONFLICT со
// списком пар (тикет 04 заменит отказ слиянием сделок). Скрытые сделки (слитые с другими, тикет
// crm-intake/02) не мешают: правило «одна открытая сделка в воронке» их не считает.
//
// Гонки (расширенная проверка PR #39):
// - Оба контакта блокируются FOR UPDATE в одном порядке (по id) до первого чтения. Заметка и файл
//   (timeline/entity.ts, FOR SHARE), участник и основной контакт сделки (deals/deals.ts,
//   liveContact, FOR SHARE) ждут слияния и потом не находят скрытый контакт.
// - Время слияния — clock_timestamp() после блокировок (merge/store.ts, insertMerge). Откат
//   отказывает, если оставшийся сам уже слит с другим: иначе перешедшее к нему осталось бы у
//   скрытого контакта.

export type MergeErrorCode =
  | 'PERMISSION_DENIED'
  | 'INVALID_MERGE'
  | 'CONTACT_NOT_FOUND'
  /** Один из контактов уже слит: `details.merged_into_id`. */
  | 'CONTACT_MERGED'
  /** Контакт нельзя слить с самим собой. */
  | 'MERGE_SAME_CONTACT'
  /** Открытые сделки обоих в одной воронке: `details.pairs`. */
  | 'MERGE_DEAL_CONFLICT'
  | 'MERGE_NOT_FOUND'
  | 'MERGE_ALREADY_UNDONE'
  /** Прошло 30 дней. */
  | 'MERGE_UNDO_EXPIRED'
  /**
   * Одна из записей слита ещё раз позже или оставшийся сам слит с другим: `details.mergeId` —
   * что откатить сначала.
   */
  | 'MERGE_UNDO_BLOCKED'
  /** Оставшийся контакт в корзине: сначала восстановить его. */
  | 'MERGE_UNDO_SURVIVOR_TRASHED'
  /** Вернувшаяся открытая сделка нарушит «одна открытая сделка в воронке»: `details.dealIds`. */
  | 'MERGE_UNDO_DEAL_CONFLICT'

type Result<T> = Outcome<T, MergeErrorCode>

interface MergeContext extends MergeActor {
  scope: ResourceScope
}

async function mergeContext(c: Ctx): Promise<MergeContext> {
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
    scope: permissions.scopes.contacts,
  }
}

// ---- Проверки --------------------------------------------------------------------------------

/** Контакт `id` в охвате `scope` по правилам `rules`, включая слитый. */
async function inScope(
  ctx: MergeContext,
  id: string,
  scope: ResourceScope['read'],
  rules: readonly ContactScopeRule[] = CONTACT_SCOPE_RULES,
): Promise<boolean> {
  const row = await ctx.db
    .selectFrom('contact')
    .select('id')
    .where('id', '=', id)
    .where((eb) => contactScopePredicate(eb, scope, ctx.viewer, rules, { includeMerged: true }))
    .executeTakeFirst()
  return row !== undefined
}

/** Охват чтения и изменения: вне чтения — 404, вне изменения — 403. */
async function checkScope(
  ctx: MergeContext,
  id: string,
  rules?: readonly ContactScopeRule[],
): Promise<Result<null>> {
  if (!(await inScope(ctx, id, ctx.scope.read, rules))) return refuse(404, 'CONTACT_NOT_FOUND')
  if (ctx.scope.write !== ctx.scope.read && !(await inScope(ctx, id, ctx.scope.write, rules))) {
    return refuse(403, 'PERMISSION_DENIED')
  }
  return ok(null)
}

/** Блокирует контакты `ids` в одном порядке (по id): одновременные слияния не сцепятся. */
async function lockContacts(db: Kysely<Database>, ids: readonly string[]): Promise<ContactRow[]> {
  return db
    .selectFrom('contact')
    .selectAll()
    .where('id', 'in', [...ids])
    .orderBy('id')
    .forUpdate()
    .execute()
}

/** Контакт, который можно слить: существует, не слит, не в корзине, в охвате изменения. */
async function mergeable(
  ctx: MergeContext,
  rows: readonly ContactRow[],
  id: string,
): Promise<Result<ContactRow>> {
  const row = rows.find((r) => r.id === id)
  if (!row) return refuse(404, 'CONTACT_NOT_FOUND')
  if (row.merged_into_id !== null) {
    return (
      (await mergedContactRefusal(ctx.db, id, ctx.scope.read, ctx.viewer)) ??
      refuse(404, 'CONTACT_NOT_FOUND')
    )
  }
  if (row.deleted_at !== null) return refuse(404, 'CONTACT_NOT_FOUND')
  const scoped = await checkScope(ctx, id)
  return scoped.ok ? ok(row) : scoped
}

/** Открытые неархивные сделки обоих контактов в одной воронке. */
async function dealConflicts(ctx: MergeContext, pair: MergePair) {
  return ctx.db
    .selectFrom('deal as s')
    .innerJoin('deal as m', 'm.pipeline_id', 's.pipeline_id')
    .select(['s.pipeline_id as pipelineId', 's.id as survivorDealId', 'm.id as mergedDealId'])
    .where('s.primary_contact_id', '=', pair.survivorId)
    .where('m.primary_contact_id', '=', pair.mergedId)
    .where('s.status', '=', 'open')
    .where('m.status', '=', 'open')
    .where('s.archived_at', 'is', null)
    .where('m.archived_at', 'is', null)
    .where('s.deleted_at', 'is', null)
    .where('m.deleted_at', 'is', null)
    .where('s.merged_into_id', 'is', null)
    .where('m.merged_into_id', 'is', null)
    .orderBy('s.pipeline_id')
    .orderBy('s.id')
    .execute()
}

// ---- Слияние ---------------------------------------------------------------------------------

/** Что перейдёт при слиянии — ответ предпросмотра. */
export interface MergePreview {
  survivor: ContactView
  merged: ContactView
  /** Пустые поля оставшегося, которые заполнятся: имя поля в API и значение. */
  fields: { field: string; value: unknown }[]
  /** Телефоны и email, которые перейдут (остальные у оставшегося уже есть). */
  phones: string[]
  emails: string[]
  /** Сделки, где слитый основной, и сделки, где он участник. */
  deals: number
  participations: number
  notes: number
  files: number
  /** Сколько из перешедших сделок вне охвата чтения сделок пользователя: они тоже перейдут. */
  dealsOutOfScope: number
  /** Отметка «возможный дубль» между этими двумя снимется. */
  duplicateMarkCleared: boolean
}

export interface MergeResult {
  merge: MergeView
  contact: ContactView
}

/** Слияние в ответе вместе с именем слитого контакта: список в карточке оставшегося. */
export interface ContactMergeView extends MergeView {
  mergedContact: { id: string; firstName: string; lastName: string | null }
}

function readMergedId(body: Record<string, unknown> | null): Result<string> {
  if (!body) return refuse(400, 'INVALID_MERGE', { path: '' })
  const extra = Object.keys(body).find((key) => key !== 'merge_contact_id')
  if (extra !== undefined) return refuse(400, 'INVALID_MERGE', { path: extra })
  const id = body.merge_contact_id
  if (typeof id !== 'string' || !UUID.test(id)) {
    return refuse(400, 'INVALID_MERGE', { path: 'merge_contact_id' })
  }
  return ok(id.toLowerCase())
}

/** Пара проверена и заблокирована: строки обоих контактов. */
async function checkedPair(
  ctx: MergeContext,
  survivorId: string,
  mergedId: string,
): Promise<Result<{ pair: MergePair; survivor: ContactRow; merged: ContactRow }>> {
  if (!UUID.test(survivorId)) return refuse(404, 'CONTACT_NOT_FOUND')
  const id = survivorId.toLowerCase()
  if (id === mergedId) return refuse(422, 'MERGE_SAME_CONTACT')
  const rows = await lockContacts(ctx.db, [id, mergedId])
  const survivor = await mergeable(ctx, rows, id)
  if (!survivor.ok) return survivor
  const merged = await mergeable(ctx, rows, mergedId)
  if (!merged.ok) return merged
  const pair = { survivorId: id, mergedId }
  const conflicts = await dealConflicts(ctx, pair)
  if (conflicts.length > 0) return refuse(409, 'MERGE_DEAL_CONFLICT', { pairs: conflicts })
  return ok({ pair, survivor: survivor.value, merged: merged.value })
}

async function preview(
  ctx: MergeContext,
  survivorId: string,
  mergedId: string,
): Promise<Result<MergePreview>> {
  const checked = await checkedPair(ctx, survivorId, mergedId)
  if (!checked.ok) return checked
  const { pair, survivor, merged } = checked.value
  const items = await planAll(CONTACT_MERGE_REGISTRY, ctx, pair)
  const of = (kind: string) => items.filter((item) => item.kind === kind)
  const keys = (kind: string) => of(kind).map((item) => (item.value as { key: string }).key)
  const dealIds = movedDealIds(items)
  const outOfScope =
    dealIds.length === 0
      ? 0
      : Number(
          (
            await ctx.db
              .selectFrom('deal')
              .select(sql<string>`count(*)`.as('count'))
              .where('id', 'in', dealIds)
              .where(
                sql<boolean>`not ${dealInScope(sql.ref('owner_id'), ctx.permissions.scopes.deals.read, ctx.viewer)}`,
              )
              .executeTakeFirstOrThrow()
          ).count,
        )
  // Пользовательские поля скрытых от роли групп в предпросмотр не попадают (но переходят).
  const fieldItems = of('field')
  const [visible = {}] = await visibleCustom(ctx, 'contact', [
    Object.fromEntries(
      fieldItems
        .filter((item) => item.field?.startsWith('custom.'))
        .map((item) => [(item.field ?? '').slice('custom.'.length), item.value]),
    ),
  ])
  return ok({
    survivor: await contactView(ctx, survivor),
    merged: await contactView(ctx, merged),
    fields: fieldItems
      .filter(
        (item) =>
          !item.field?.startsWith('custom.') ||
          Object.hasOwn(visible, (item.field ?? '').slice('custom.'.length)),
      )
      .map((item) => ({ field: item.field ?? '', value: item.value })),
    phones: keys('phone'),
    emails: keys('email'),
    deals: of('deal').length,
    participations: of('deal_participant').length,
    notes: of('note').length,
    files: of('file').length,
    dealsOutOfScope: outOfScope,
    duplicateMarkCleared: of('possible_duplicate').length > 0,
  })
}

/** Состояние контакта для истории: поля журнала и все пользовательские поля (без фильтра роли). */
async function snapshot(ctx: MergeContext, id: string) {
  const row = await ctx.db
    .selectFrom('contact')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
  return { view: await contactView(ctx, row), custom: row.custom }
}

type Snapshot = Awaited<ReturnType<typeof snapshot>>

/** «Было → стало» контакта: поля журнала и пользовательские поля по коду. */
function changesOf(before: Snapshot, after: Snapshot): FieldChange[] {
  const changes = diffFields(before.view, after.view, LOGGED_FIELDS)
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

async function mergeContacts(
  ctx: MergeContext,
  survivorId: string,
  mergedId: string,
): Promise<Result<MergeResult>> {
  const checked = await checkedPair(ctx, survivorId, mergedId)
  if (!checked.ok) return checked
  const { pair } = checked.value
  const items = await planAll(CONTACT_MERGE_REGISTRY, ctx, pair)
  const survivorBefore = await snapshot(ctx, pair.survivorId)
  const mergedBefore = await snapshot(ctx, pair.mergedId)
  await applyAll(CONTACT_MERGE_REGISTRY, ctx, pair, items)
  await ctx.db
    .updateTable('contact')
    .set({
      merged_into_id: pair.survivorId,
      merged_at: sql`clock_timestamp()`,
      updated_at: sql`now()`,
    })
    .where('id', '=', pair.mergedId)
    .execute()
  const record = await insertMerge(ctx, 'contact', pair, items)
  await recordChanges(ctx, { type: 'contact', id: pair.survivorId }, [
    ...changesOf(survivorBefore, await snapshot(ctx, pair.survivorId)),
    { field: 'mergedContactId', before: null, after: pair.mergedId },
  ])
  await recordChanges(ctx, { type: 'contact', id: pair.mergedId }, [
    ...changesOf(mergedBefore, await snapshot(ctx, pair.mergedId)),
    { field: 'mergedIntoId', before: null, after: pair.survivorId },
  ])
  await audit.record(ctx.db, ctx.projectId, {
    action: 'contact.merged',
    actorId: ctx.actorId,
    ip: ctx.ip,
    entity: { type: 'contact', id: pair.survivorId },
    details: { mergeId: record.id, mergedContactId: pair.mergedId },
  })
  await emitEvent(ctx, 'contact.merged', {
    contact_id: pair.survivorId,
    merged_contact_id: pair.mergedId,
  })
  const [merge] = await mergeViews(ctx.db, [record])
  if (!merge) throw new Error('слияние пропало в той же транзакции')
  const survivor = await ctx.db
    .selectFrom('contact')
    .selectAll()
    .where('id', '=', pair.survivorId)
    .executeTakeFirstOrThrow()
  return ok({ merge, contact: await contactView(ctx, survivor) })
}

/** Слияния в контакт `id`, которые ещё можно откатить: новые сверху. */
async function contactMerges(ctx: MergeContext, id: string): Promise<Result<ContactMergeView[]>> {
  if (!UUID.test(id)) return refuse(404, 'CONTACT_NOT_FOUND')
  const contact = await ctx.db
    .selectFrom('contact')
    .select('id')
    .where('id', '=', id)
    .where((eb) => contactScopePredicate(eb, ctx.scope.read, ctx.viewer))
    .executeTakeFirst()
  if (!contact) {
    return (
      (await mergedContactRefusal(ctx.db, id, ctx.scope.read, ctx.viewer)) ??
      refuse(404, 'CONTACT_NOT_FOUND')
    )
  }
  const rows = await ctx.db
    .selectFrom('merge_record')
    .selectAll()
    .where('entity_type', '=', 'contact')
    .where('survivor_id', '=', contact.id)
    .where('undone_at', 'is', null)
    .where('undo_until', '>', sql<Date>`now()`)
    .orderBy('merged_at', 'desc')
    .orderBy('id', 'desc')
    .execute()
  const views = await mergeViews(ctx.db, rows)
  const names =
    rows.length === 0
      ? []
      : await ctx.db
          .selectFrom('contact')
          .select(['id', 'first_name', 'last_name'])
          .where(
            'id',
            'in',
            rows.map((row) => row.merged_id),
          )
          .execute()
  const byId = new Map(names.map((row) => [row.id, row]))
  return ok(
    views.flatMap((view) => {
      const merged = byId.get(view.mergedId)
      if (!merged) return []
      return [
        {
          ...view,
          mergedContact: {
            id: merged.id,
            firstName: merged.first_name,
            lastName: merged.last_name,
          },
        },
      ]
    }),
  )
}

// ---- Откат -----------------------------------------------------------------------------------

export interface UndoResult {
  merge: MergeView
  contact: ContactView
  mergedContact: ContactView
  /** Что не вернулось: удалено окончательно (`gone`) или изменено после слияния (`changed`). */
  skipped: UndoSkip[]
}

/**
 * Охват скрытого контакта при откате: создан пользователем или его сделки (перешедшие при
 * слиянии) в охвате — то, по чему он был виден до слияния.
 */
function hiddenContactRules(items: readonly MovedItem[]): ContactScopeRule[] {
  const dealIds = movedDealIds(items)
  if (dealIds.length === 0) return [CREATED_BY_RULE]
  return [
    CREATED_BY_RULE,
    (_eb, scope, viewer) => sql<boolean>`exists (
      select 1 from deal d
      where d.id in (${sql.join(dealIds)})
        and ${dealInScope(sql.ref('d.owner_id'), scope, viewer)}
    )`,
  ]
}

/** Открытые неархивные сделки, которые вернутся к слитому и столкнутся в одной воронке. */
async function undoDealConflicts(
  ctx: MergeContext,
  pair: MergePair,
  items: readonly MovedItem[],
): Promise<string[]> {
  const returning = items.filter((item) => item.kind === 'deal').map((item) => item.itemId ?? '')
  if (returning.length === 0) return []
  const open = await ctx.db
    .selectFrom('deal')
    .select(['id', 'pipeline_id'])
    .where((eb) =>
      eb.or([
        eb.and([eb('id', 'in', returning), eb('primary_contact_id', '=', pair.survivorId)]),
        eb('primary_contact_id', '=', pair.mergedId),
      ]),
    )
    .where('status', '=', 'open')
    .where('archived_at', 'is', null)
    .where('deleted_at', 'is', null)
    .where('merged_into_id', 'is', null)
    .orderBy('id')
    .execute()
  const byPipeline = new Map<string, string[]>()
  for (const deal of open) {
    byPipeline.set(deal.pipeline_id, [...(byPipeline.get(deal.pipeline_id) ?? []), deal.id])
  }
  return [...byPipeline.values()].filter((ids) => ids.length > 1).flat()
}

/** Слияние, которое скрыло контакт `id` и ещё не откачено. */
async function hidingMerge(db: Kysely<Database>, id: string): Promise<string | null> {
  const row = await db
    .selectFrom('merge_record')
    .select('id')
    .where('entity_type', '=', 'contact')
    .where('merged_id', '=', id)
    .where('undone_at', 'is', null)
    .orderBy('merged_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  return row?.id ?? null
}

async function undoMerge(ctx: MergeContext, id: string): Promise<Result<UndoResult>> {
  const record = await findMerge(ctx.db, 'contact', id, true)
  if (!record) return refuse(404, 'MERGE_NOT_FOUND')
  if (record.undone_at !== null) return refuse(409, 'MERGE_ALREADY_UNDONE')
  const pair = { survivorId: record.survivor_id, mergedId: record.merged_id }
  const items = await movedItems(ctx.db, record.id)
  const rows = await lockContacts(ctx.db, [pair.survivorId, pair.mergedId])
  const survivor = rows.find((row) => row.id === pair.survivorId)
  const merged = rows.find((row) => row.id === pair.mergedId)
  if (!survivor || !merged) return refuse(404, 'MERGE_NOT_FOUND')
  const survivorScope = await checkScope(ctx, pair.survivorId)
  if (!survivorScope.ok) return survivorScope
  const mergedScope = await checkScope(ctx, pair.mergedId, hiddenContactRules(items))
  if (!mergedScope.ok) return mergedScope
  if (await undoExpired(ctx.db, record)) return refuse(409, 'MERGE_UNDO_EXPIRED')
  // Оставшийся сам слит с другим — сначала откатить то слияние: иначе то, что перешло к нему,
  // осталось бы у скрытого контакта.
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
  const conflicts = await undoDealConflicts(ctx, pair, items)
  if (conflicts.length > 0) return refuse(409, 'MERGE_UNDO_DEAL_CONFLICT', { dealIds: conflicts })

  const survivorBefore = await snapshot(ctx, pair.survivorId)
  const mergedBefore = await snapshot(ctx, pair.mergedId)
  const skipped = await restoreAll(CONTACT_MERGE_REGISTRY, ctx, pair, items)
  await ctx.db
    .updateTable('contact')
    .set({ merged_into_id: null, merged_at: null, updated_at: sql`now()` })
    .where('id', '=', pair.mergedId)
    .execute()
  const undone = await markUndone(ctx, record.id)
  const survivorAfter = await snapshot(ctx, pair.survivorId)
  const mergedAfter = await snapshot(ctx, pair.mergedId)
  await recordChanges(ctx, { type: 'contact', id: pair.survivorId }, [
    ...changesOf(survivorBefore, survivorAfter),
    { field: 'mergedContactId', before: pair.mergedId, after: null },
  ])
  await recordChanges(ctx, { type: 'contact', id: pair.mergedId }, [
    ...changesOf(mergedBefore, mergedAfter),
    { field: 'mergedIntoId', before: pair.survivorId, after: null },
  ])
  await audit.record(ctx.db, ctx.projectId, {
    action: 'contact.unmerged',
    actorId: ctx.actorId,
    ip: ctx.ip,
    entity: { type: 'contact', id: pair.survivorId },
    details: {
      mergeId: record.id,
      mergedContactId: pair.mergedId,
      skipped: skipped.map(({ kind, itemId, field, reason }) => ({ kind, itemId, field, reason })),
    },
  })
  await emitEvent(ctx, 'contact.unmerged', {
    contact_id: pair.survivorId,
    merged_contact_id: pair.mergedId,
  })
  const [merge] = await mergeViews(ctx.db, [undone])
  if (!merge) throw new Error('слияние пропало в той же транзакции')
  return ok({ merge, contact: survivorAfter.view, mergedContact: mergedAfter.view, skipped })
}

// ---- Маршруты --------------------------------------------------------------------------------

function respond<T>(c: Ctx, outcome: Result<T>) {
  return outcome.ok ? c.json(outcome.value as object) : fail(c, outcome)
}

/** Маршруты слияния контактов: `/v1/contacts/:id/merge…` (только сессия). */
export function contactMergeRoutes() {
  const edit = requirePermission('contacts', 'edit')
  return new Hono<PermissionsEnv>()
    .get('/:id/merges', requirePermission('contacts', 'view'), async (c) =>
      respond(c, await contactMerges(await mergeContext(c), c.req.param('id'))),
    )
    .post('/:id/merge/preview', edit, async (c) => {
      const mergedId = readMergedId(await readBody(c))
      if (!mergedId.ok) return fail(c, mergedId)
      return respond(c, await preview(await mergeContext(c), c.req.param('id'), mergedId.value))
    })
    .post('/:id/merge', edit, async (c) => {
      const mergedId = readMergedId(await readBody(c))
      if (!mergedId.ok) return fail(c, mergedId)
      return respond(
        c,
        await mergeContacts(await mergeContext(c), c.req.param('id'), mergedId.value),
      )
    })
}

/**
 * Ветка контакта общего отката `/v1/merges/:id/undo` (merge/deals.ts, mergesRoutes): право —
 * «контакты: изменять», охват проверяет откат. `id` — проверенный id слияния в нижнем регистре.
 */
export async function undoContactMerge(c: Ctx, id: string) {
  const access = await requestAccess(c)
  if (!access || !can(access.permissions, 'contacts', 'edit')) {
    return fail(c, refuse(403, 'PERMISSION_DENIED'))
  }
  return respond(c, await undoMerge(await mergeContext(c), id))
}
