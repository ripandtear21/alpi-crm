import type { Database } from '@alpi/db'
import { can, type ResourceScope } from '@alpi/shared'
import { Hono } from 'hono'
import { type Kysely, sql } from 'kysely'
import { audit } from '../audit/record.ts'
import { recordChanges } from '../change-log/record.ts'
import {
  type ContactRow,
  type ContactView,
  contactView,
  LOGGED_FIELDS,
} from '../contacts/contacts.ts'
import {
  type Ctx,
  fail,
  type Outcome,
  ok,
  type Refusal,
  readBody,
  refuse,
  UUID,
} from '../contacts/http.ts'
import {
  CONTACT_SCOPE_RULES,
  type ContactScopeRule,
  CREATED_BY_RULE,
  contactScopePredicate,
} from '../contacts/scope.ts'
import { dealInScope, ownerAllowed } from '../deals/scope.ts'
import { type DealView, dealViews, lockDeals, reloadDeal } from '../deals/store.ts'
import { emitEvent } from '../events/emit.ts'
import { type PermissionsEnv, requestAccess, requirePermission } from '../middleware/permissions.ts'
import { CONTACT_MERGE_REGISTRY, movedDealIds } from './contact-registry.ts'
import {
  type DealMergeContext,
  type DealMergeErrorCode,
  mergeDeals,
  undoDealMerge,
} from './deal-core.ts'
import { mergedRefusal } from './merged.ts'
import {
  applyAll,
  type MergePair,
  type MovedItem,
  planAll,
  restoreAll,
  type UndoSkip,
} from './registry.ts'
import {
  changesOf,
  deadlockRefusal,
  insertMergeRecord,
  insertMovedItems,
  lockedMerge,
  type MergeContext,
  type MergeRow,
  type MergeView,
  markUndone,
  mergeContext,
  mergeViews,
  movedItems,
  nestedMerges,
  previewFields,
  readMergedId,
  type Snapshot,
  undoableMerges,
  undoRefusal,
} from './store.ts'

// Слияние контактов с откатом (тикет crm-intake/01; пункты 23, 25, 26, 29, 36; ADR 0005).
// Только по сессии: ключу API маршруты закрыты (403 API_KEY_NOT_ALLOWED).
//
// - `POST /v1/contacts/:id/merge` с `{ merge_contact_id }` — `:id` остаётся, второй скрывается
//   с отметкой «слит с :id». Что переходит — реестр merge/contact-registry.ts. Одной
//   транзакцией: перенос, merge_record и merge_moved_item, история обоих контактов, журнал
//   проекта (`contact.merged`), событие `contact.merged`.
//   Необязательное `keep_deal_ids` — какие сделки конфликтующих пар остаются (ниже).
// - `POST /v1/contacts/:id/merge/preview` — то же без записи: что перейдёт, какие поля
//   заполнятся, сколько сделок вне охвата пользователя, пары конфликтующих сделок. Тело — то же,
//   что у слияния (с `keep_deal_ids`): экран показывает выбор.
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
// Конфликтующие сделки (тикет crm-intake/04; пункт 31): открытые неархивные сделки обоих в
// одной воронке. Две такие у одного контакта запрещает база (deal_one_open_per_contact), поэтому
// каждая пара объединяется в том же действии обязательно — отказаться можно, только отменив всё
// слияние (решено без владельца — подтвердить). По умолчанию остаётся сделка оставшегося
// контакта; `keep_deal_ids` — сделки, которые остаются вместо неё: каждая — из своей пары, не
// больше одной на пару, иначе 422 MERGE_KEEP_DEAL_INVALID. Скрытые сделки (слитые с другими,
// тикет crm-intake/02) не конфликтуют: правило «одна открытая сделка в воронке» их не считает.
//
// Право на пару — «сделки: изменять» и обе сделки в охвате чтения и изменения сделок; иначе 403
// MERGE_DEAL_FORBIDDEN без данных чужих сделок (решено без владельца — подтвердить; пункт 26).
// Предпросмотр не отказывает: у такой пары `forbidden: true` и только воронка.
//
// Одна транзакция: блокировки контактов, затем сделок всех пар одним списком по id; строка
// слияния контактов (на неё ссылаются parent_id слияний сделок); слияние каждой пары
// (merge/deal-core.ts) — до переноса сделок контакта: индекс deal_one_open_per_contact не
// отложенный и не пустил бы вторую открытую сделку к оставшемуся; затем перенос контакта.
// События — `deal.merged` на пару и один `contact.merged`. Откат слияния контактов откатывает и
// эти слияния сделок (после возврата перешедшего к контакту) — `deal.unmerged` на пару и
// `contact.unmerged`; отдельно их не откатить (409 MERGE_UNDO_NESTED, merge/deal-core.ts).
// Отказ на любом шаге после первой записи откатывает всё до точки сохранения (atomically).
//
// Порядок блокировок (тикет crm-intake/12) — «контакт, потом сделки и заметки» на всех путях,
// которые держат контакт и его сделку или заметку вместе: слияние и откат контактов и сделок
// (deals/store.ts, lockDeals), правка заметки (notes/notes.ts, ownNote), участник, основной
// контакт и восстановление сделки (deals/deals.ts), приём регистраций (intake/process.ts). Запись
// слияния при откате блокируется после записей (merge/store.ts, lockedMerge): окончательное
// удаление держит запись и удаляет строки её слияний. Взаимоблокировка, которую порядок не
// покрыл, — 409 MERGE_RETRY (merge/store.ts, deadlockRefusal), а не 500.
//
// Общее со слиянием сделок — merge/store.ts (контекст, тело, поля предпросмотра, «было → стало»,
// список откатываемых слияний, проверки отката) и merge/merged.ts (ответ 404 CONTACT_MERGED).
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
  /**
   * Нет права «сделки: изменять» или одна из сделок конфликтующей пары вне охвата сделок
   * пользователя (тикет crm-intake/04).
   */
  | 'MERGE_DEAL_FORBIDDEN'
  /**
   * Сделка `details.dealId` из `keep_deal_ids` — не из конфликтующей пары или вторая из той же
   * пары.
   */
  | 'MERGE_KEEP_DEAL_INVALID'
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
  /**
   * Взаимоблокировка с одновременным изменением тех же записей (тикет crm-intake/12): ничего не
   * изменилось, запрос можно повторить (merge/store.ts, deadlockRefusal).
   */
  | 'MERGE_RETRY'

/** Откат слияния контактов откатывает и вложенные слияния сделок: их отказы — тоже ответ. */
type Result<T> = Outcome<T, MergeErrorCode | DealMergeErrorCode>

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
      (await mergedRefusal(ctx.db, 'contact', id, ctx.scope.read, ctx.viewer)) ??
      refuse(404, 'CONTACT_NOT_FOUND')
    )
  }
  if (row.deleted_at !== null) return refuse(404, 'CONTACT_NOT_FOUND')
  const scoped = await checkScope(ctx, id)
  return scoped.ok ? ok(row) : scoped
}

/** Пара конфликтующих сделок: сделка оставшегося контакта и сделка скрываемого. */
interface DealConflict {
  pipelineId: string
  pipelineName: string
  survivorDealId: string
  mergedDealId: string
  survivorOwnerId: string | null
  mergedOwnerId: string | null
}

/**
 * Открытые неархивные сделки обоих контактов в одной воронке. Пара на воронку: у каждого
 * контакта таких не больше одной (deal_one_open_per_contact).
 */
async function dealConflicts(ctx: MergeContext, pair: MergePair): Promise<DealConflict[]> {
  return ctx.db
    .selectFrom('deal as s')
    .innerJoin('deal as m', 'm.pipeline_id', 's.pipeline_id')
    .innerJoin('pipeline as p', 'p.id', 's.pipeline_id')
    .select([
      's.pipeline_id as pipelineId',
      'p.name as pipelineName',
      's.id as survivorDealId',
      'm.id as mergedDealId',
      's.owner_id as survivorOwnerId',
      'm.owner_id as mergedOwnerId',
    ])
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

/** Охват сделок для слияния пар конфликтующих сделок и их отката. */
function dealContext(ctx: MergeContext): DealMergeContext {
  return { ...ctx, scope: ctx.permissions.scopes.deals }
}

/** Право на сделки с ответственными `ownerIds`: «сделки: изменять», охват чтения и изменения. */
function dealsAllowed(ctx: MergeContext, ownerIds: readonly (string | null)[]): boolean {
  if (!can(ctx.permissions, 'deals', 'edit')) return false
  const { read, write } = ctx.permissions.scopes.deals
  return ownerIds.every(
    (owner) => ownerAllowed(owner, read, ctx.viewer) && ownerAllowed(owner, write, ctx.viewer),
  )
}

const conflictAllowed = (ctx: MergeContext, conflict: DealConflict) =>
  dealsAllowed(ctx, [conflict.survivorOwnerId, conflict.mergedOwnerId])

/**
 * Какая сделка каждой пары остаётся: по умолчанию — оставшегося контакта, сделки из `keep` —
 * вместо неё. Сделка из `keep` — только из пары, на которую у пользователя есть право, и не
 * больше одной на пару.
 */
function keptDeals(
  ctx: MergeContext,
  conflicts: readonly DealConflict[],
  keep: readonly string[],
): Result<MergePair[]> {
  const allowed = conflicts.filter((conflict) => conflictAllowed(ctx, conflict))
  const chosen = new Set<DealConflict>()
  for (const dealId of keep) {
    const conflict = allowed.find((c) => c.survivorDealId === dealId || c.mergedDealId === dealId)
    if (!conflict || chosen.has(conflict)) return refuse(422, 'MERGE_KEEP_DEAL_INVALID', { dealId })
    chosen.add(conflict)
  }
  return ok(
    conflicts.map((conflict) =>
      keep.includes(conflict.mergedDealId)
        ? { survivorId: conflict.mergedDealId, mergedId: conflict.survivorDealId }
        : { survivorId: conflict.survivorDealId, mergedId: conflict.mergedDealId },
    ),
  )
}

/** Отказ внутри `atomically`: откатывает всё, что сделано после точки сохранения. */
class Refused extends Error {
  readonly refusal: Refusal<MergeErrorCode | DealMergeErrorCode>

  constructor(refusal: Refusal<MergeErrorCode | DealMergeErrorCode>) {
    super(`слияние: отказ ${refusal.code}`)
    this.refusal = refusal
  }
}

/** Значение результата; отказ — исключение Refused. */
function unwrap<T>(outcome: Result<T>): T {
  if (!outcome.ok) throw new Refused(outcome)
  return outcome.value
}

/**
 * Все записи `fn` — или ни одной: отказ (Refused) откатывает до точки сохранения и становится
 * ответом, транзакция запроса остаётся рабочей; другая ошибка — 500 и откат всей транзакции
 * (middleware/project-context.ts). Своё имя точки сохранения: inSavepoint (roles/roles.ts)
 * внутри отката сделок ставит свою, и общее имя откатило бы не к той.
 */
async function atomically<T>(db: Kysely<Database>, fn: () => Promise<T>): Promise<Result<T>> {
  await sql`savepoint contact_merge`.execute(db)
  try {
    const value = await fn()
    await sql`release savepoint contact_merge`.execute(db)
    return ok(value)
  } catch (error) {
    if (!(error instanceof Refused)) throw error
    await sql`rollback to savepoint contact_merge`.execute(db)
    return error.refusal
  }
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
  /** Пары конфликтующих сделок: объединятся в том же действии (тикет crm-intake/04). */
  dealPairs: DealPairPreview[]
}

/** Пара конфликтующих сделок в предпросмотре. */
export interface DealPairPreview {
  pipeline: { id: string; name: string }
  /**
   * Нет права на обе сделки пары («сделки: изменять» и охват): данных сделок нет, слияние
   * ответит 403 MERGE_DEAL_FORBIDDEN.
   */
  forbidden: boolean
  /** Сделка оставшегося контакта; null — forbidden. */
  survivorDeal: DealView | null
  /** Сделка скрываемого контакта; null — forbidden. */
  mergedDeal: DealView | null
  /** Какая из двух останется; null — forbidden. */
  keepDealId: string | null
}

export interface MergeResult {
  merge: MergeView
  contact: ContactView
}

/** Слияние в ответе вместе с именем слитого контакта: список в карточке оставшегося. */
export interface ContactMergeView extends MergeView {
  mergedContact: { id: string; firstName: string; lastName: string | null }
}

/** Тело слияния и предпросмотра. */
interface MergeRequest {
  mergedId: string
  /** Сделки конфликтующих пар, которые остаются вместо сделки оставшегося контакта. */
  keepDealIds: string[]
}

function readMergeRequest(body: Record<string, unknown> | null): Result<MergeRequest> {
  const mergedId = readMergedId(body, 'contact', ['keep_deal_ids'])
  if (!mergedId.ok) return mergedId
  const keep = body?.keep_deal_ids ?? []
  if (!Array.isArray(keep)) return refuse(400, 'INVALID_MERGE', { path: 'keep_deal_ids' })
  const bad = keep.findIndex((dealId) => typeof dealId !== 'string' || !UUID.test(dealId))
  if (bad !== -1) return refuse(400, 'INVALID_MERGE', { path: `keep_deal_ids.${bad}` })
  return ok({
    mergedId: mergedId.value,
    keepDealIds: (keep as string[]).map((dealId) => dealId.toLowerCase()),
  })
}

/** Пара проверена и заблокирована: строки обоих контактов и конфликтующие сделки. */
async function checkedPair(
  ctx: MergeContext,
  survivorId: string,
  mergedId: string,
): Promise<
  Result<{ pair: MergePair; survivor: ContactRow; merged: ContactRow; conflicts: DealConflict[] }>
> {
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
  return ok({ pair, survivor: survivor.value, merged: merged.value, conflicts })
}

/** Пары конфликтующих сделок для предпросмотра: без права — только воронка. */
async function dealPairsPreview(
  ctx: MergeContext,
  conflicts: readonly DealConflict[],
  kept: readonly MergePair[],
): Promise<DealPairPreview[]> {
  const allowed = conflicts.filter((conflict) => conflictAllowed(ctx, conflict))
  const rows = []
  for (const id of allowed.flatMap((c) => [c.survivorDealId, c.mergedDealId])) {
    rows.push(await reloadDeal(ctx, id))
  }
  const views = new Map((await dealViews(ctx, rows)).map((view) => [view.id, view]))
  return conflicts.map((conflict, index) => {
    const pipeline = { id: conflict.pipelineId, name: conflict.pipelineName }
    if (!allowed.includes(conflict)) {
      return { pipeline, forbidden: true, survivorDeal: null, mergedDeal: null, keepDealId: null }
    }
    return {
      pipeline,
      forbidden: false,
      survivorDeal: views.get(conflict.survivorDealId) ?? null,
      mergedDeal: views.get(conflict.mergedDealId) ?? null,
      keepDealId: kept[index]?.survivorId ?? null,
    }
  })
}

async function preview(
  ctx: MergeContext,
  survivorId: string,
  request: MergeRequest,
): Promise<Result<MergePreview>> {
  const checked = await checkedPair(ctx, survivorId, request.mergedId)
  if (!checked.ok) return checked
  const { pair, survivor, merged, conflicts } = checked.value
  const kept = keptDeals(ctx, conflicts, request.keepDealIds)
  if (!kept.ok) return kept
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
  return ok({
    survivor: await contactView(ctx, survivor),
    merged: await contactView(ctx, merged),
    fields: (await previewFields(ctx, 'contact', items)).map((item) => ({
      field: item.field ?? '',
      value: item.value,
    })),
    phones: keys('phone'),
    emails: keys('email'),
    deals: of('deal').length,
    participations: of('deal_participant').length,
    notes: of('note').length,
    files: of('file').length,
    dealsOutOfScope: outOfScope,
    duplicateMarkCleared: of('possible_duplicate').length > 0,
    dealPairs: await dealPairsPreview(ctx, conflicts, kept.value),
  })
}

/** Состояние контакта для истории: поля журнала и все пользовательские поля (без фильтра роли). */
async function snapshot(ctx: MergeContext, id: string): Promise<Snapshot<ContactView>> {
  const row = await ctx.db
    .selectFrom('contact')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
  return { view: await contactView(ctx, row), custom: row.custom }
}

async function mergeContacts(
  ctx: MergeContext,
  survivorId: string,
  request: MergeRequest,
): Promise<Result<MergeResult>> {
  const checked = await checkedPair(ctx, survivorId, request.mergedId)
  if (!checked.ok) return checked
  const { pair, conflicts } = checked.value
  // До любой записи и без данных сделок в ответе.
  if (!conflicts.every((conflict) => conflictAllowed(ctx, conflict))) {
    return refuse(403, 'MERGE_DEAL_FORBIDDEN')
  }
  const kept = keptDeals(ctx, conflicts, request.keepDealIds)
  if (!kept.ok) return kept
  const dealPairs = kept.value
  // Сделки всех пар — одним списком по id (lockDeals): одновременные слияния не сцепятся.
  if (dealPairs.length > 0) {
    await lockDeals(
      ctx.db,
      dealPairs.flatMap((deals) => [deals.survivorId, deals.mergedId]),
    )
  }
  return atomically(ctx.db, () => mergeLocked(ctx, pair, dealPairs))
}

/** Слияние проверенной и заблокированной пары: сначала пары сделок, потом контакт. */
async function mergeLocked(
  ctx: MergeContext,
  pair: MergePair,
  dealPairs: readonly MergePair[],
): Promise<MergeResult> {
  const survivorBefore = await snapshot(ctx, pair.survivorId)
  const mergedBefore = await snapshot(ctx, pair.mergedId)
  const record = await insertMergeRecord(ctx, 'contact', pair)
  const deals = dealContext(ctx)
  for (const { survivorId, mergedId } of dealPairs) {
    unwrap(await mergeDeals(deals, survivorId, mergedId, record.id))
  }
  // Перешедшее контакта — после слияний сделок: слитые сделки пар уже скрыты, и перенос сделок
  // (contact-registry.ts, DEALS) не нарушит индекс; участие, которое добавило слияние сделок,
  // учтено.
  const items = await planAll(CONTACT_MERGE_REGISTRY, ctx, pair)
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
  await insertMovedItems(ctx, record.id, items)
  await recordChanges(ctx, { type: 'contact', id: pair.survivorId }, [
    ...changesOf(survivorBefore, await snapshot(ctx, pair.survivorId), LOGGED_FIELDS),
    { field: 'mergedContactId', before: null, after: pair.mergedId },
  ])
  await recordChanges(ctx, { type: 'contact', id: pair.mergedId }, [
    ...changesOf(mergedBefore, await snapshot(ctx, pair.mergedId), LOGGED_FIELDS),
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
  return { merge, contact: await contactView(ctx, survivor) }
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
      (await mergedRefusal(ctx.db, 'contact', id, ctx.scope.read, ctx.viewer)) ??
      refuse(404, 'CONTACT_NOT_FOUND')
    )
  }
  const rows = await undoableMerges(ctx.db, 'contact', contact.id)
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

async function undoMerge(ctx: MergeContext, id: string): Promise<Result<UndoResult>> {
  // Контакты, потом запись слияния (merge/store.ts, lockedMerge; тикет crm-intake/12).
  const locked = await lockedMerge(ctx.db, 'contact', id, (pair) =>
    lockContacts(ctx.db, [pair.survivorId, pair.mergedId]),
  )
  if (!locked.ok) return locked
  const { record, pair, rows } = locked.value
  const items = await movedItems(ctx.db, record.id)
  const survivor = rows.find((row) => row.id === pair.survivorId)
  const merged = rows.find((row) => row.id === pair.mergedId)
  if (!survivor || !merged) return refuse(404, 'MERGE_NOT_FOUND')
  const survivorScope = await checkScope(ctx, pair.survivorId)
  if (!survivorScope.ok) return survivorScope
  const mergedScope = await checkScope(ctx, pair.mergedId, hiddenContactRules(items))
  if (!mergedScope.ok) return mergedScope
  const refused = await undoRefusal(ctx.db, record, survivor, merged)
  if (refused) return refused
  const conflicts = await undoDealConflicts(ctx, pair, items)
  if (conflicts.length > 0) return refuse(409, 'MERGE_UNDO_DEAL_CONFLICT', { dealIds: conflicts })
  // Слияния сделок того же действия (тикет crm-intake/04): то же право, что на их слияние.
  // Блокировки — после контактов, как при слиянии: сначала сделки, потом строки их слияний
  // (как у отката слияния сделок, merge/store.ts, lockedMerge).
  const pending = await nestedMerges(ctx.db, record.id, false)
  if (pending.length > 0) {
    const deals = await lockDeals(
      ctx.db,
      pending.flatMap((row) => [row.survivor_id, row.merged_id]),
    )
    if (
      !dealsAllowed(
        ctx,
        deals.map((deal) => deal.owner_id),
      )
    ) {
      return refuse(403, 'MERGE_DEAL_FORBIDDEN')
    }
  }
  const nested = await nestedMerges(ctx.db, record.id)
  return atomically(ctx.db, () => undoLocked(ctx, record, items, nested))
}

/**
 * Участие, которое добавили вложенные слияния сделок: основной контакт слитой сделки стал
 * участником оставшейся (deal-registry.ts, PARTICIPANTS, primary_participant). Слияние контактов
 * потом сняло это участие (контакт стал основным сделки или слился с её основным) и записало
 * снятое как перешедшее; откат контакта его не возвращает — его убирает откат слияния сделок.
 * Ключи — `сделка/контакт`.
 */
async function nestedParticipations(
  db: Kysely<Database>,
  nested: readonly MergeRow[],
): Promise<Set<string>> {
  const keys = new Set<string>()
  for (const row of nested) {
    for (const item of await movedItems(db, row.id)) {
      if (item.kind !== 'primary_participant') continue
      keys.add(`${row.survivor_id}/${(item.value as { contactId: string }).contactId}`)
    }
  }
  return keys
}

/**
 * Ключ `сделка/контакт` снятого слиянием контактов участия (contact-registry.ts, DEALS):
 * участие оставшегося (survivor_participant) или слитого (deal_participant с `dropped`); у
 * остального — null.
 */
function participationKey(pair: MergePair, item: MovedItem): string | null {
  if (item.kind === 'survivor_participant') return `${item.itemId}/${pair.survivorId}`
  if (item.kind === 'deal_participant' && (item.value as { dropped?: boolean }).dropped) {
    return `${item.itemId}/${pair.mergedId}`
  }
  return null
}

/**
 * Откат проверенного слияния: сначала перешедшее к контакту, потом вложенные слияния сделок (в
 * обратном порядке) — их проверки читают строки сделок заново, уже с вернувшимся контактом.
 * Отказ отката сделок (Refused) откатывает и возврат контакта.
 */
async function undoLocked(
  ctx: MergeContext,
  record: MergeRow,
  items: readonly MovedItem[],
  nested: readonly MergeRow[],
): Promise<UndoResult> {
  const pair = { survivorId: record.survivor_id, mergedId: record.merged_id }
  const survivorBefore = await snapshot(ctx, pair.survivorId)
  const mergedBefore = await snapshot(ctx, pair.mergedId)
  const added = await nestedParticipations(ctx.db, nested)
  const skipped = await restoreAll(
    CONTACT_MERGE_REGISTRY,
    ctx,
    pair,
    items.filter((item) => {
      const key = participationKey(pair, item)
      return key === null || !added.has(key)
    }),
  )
  await ctx.db
    .updateTable('contact')
    .set({ merged_into_id: null, merged_at: null, updated_at: sql`now()` })
    .where('id', '=', pair.mergedId)
    .execute()
  const undone = await markUndone(ctx, record.id)
  const deals = dealContext(ctx)
  for (const row of [...nested].reverse()) {
    unwrap(await undoDealMerge(deals, row.id, record.id))
  }
  const survivorAfter = await snapshot(ctx, pair.survivorId)
  const mergedAfter = await snapshot(ctx, pair.mergedId)
  await recordChanges(ctx, { type: 'contact', id: pair.survivorId }, [
    ...changesOf(survivorBefore, survivorAfter, LOGGED_FIELDS),
    { field: 'mergedContactId', before: pair.mergedId, after: null },
  ])
  await recordChanges(ctx, { type: 'contact', id: pair.mergedId }, [
    ...changesOf(mergedBefore, mergedAfter, LOGGED_FIELDS),
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
  return { merge, contact: survivorAfter.view, mergedContact: mergedAfter.view, skipped }
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
      respond(c, await contactMerges(await mergeContext(c, 'contact'), c.req.param('id'))),
    )
    .post('/:id/merge/preview', edit, async (c) => {
      const request = readMergeRequest(await readBody(c))
      if (!request.ok) return fail(c, request)
      const ctx = await mergeContext(c, 'contact')
      return respond(
        c,
        await deadlockRefusal(ctx.db, () => preview(ctx, c.req.param('id'), request.value)),
      )
    })
    .post('/:id/merge', edit, async (c) => {
      const request = readMergeRequest(await readBody(c))
      if (!request.ok) return fail(c, request)
      const ctx = await mergeContext(c, 'contact')
      return respond(
        c,
        await deadlockRefusal(ctx.db, () => mergeContacts(ctx, c.req.param('id'), request.value)),
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
  const ctx = await mergeContext(c, 'contact')
  return respond(c, await deadlockRefusal(ctx.db, () => undoMerge(ctx, id)))
}
