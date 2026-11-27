import type { Database } from '@alpi/db'
import { MERGE_UNDO_DAYS, type ResourceScope } from '@alpi/shared'
import { type Kysely, type Selectable, sql } from 'kysely'
import { requestAuthor } from '../api-keys/actor.ts'
import { diffFields, type FieldChange } from '../change-log/record.ts'
import { type Ctx, type Outcome, ok, type Refusal, refuse, UUID } from '../contacts/http.ts'
import { enqueueDuplicateScan } from '../duplicates/queue.ts'
import { visibleCustom } from '../fields/values.ts'
import { sqlState } from '../roles/roles.ts'
import { requestViewer } from '../roles/scope.ts'
import {
  canonical,
  type MergeActor,
  type MergeEntity,
  type MergePair,
  type MovedItem,
} from './registry.ts'

// Запись слияния и перешедшее (таблицы merge_record и merge_moved_item, migrations/0026_merge.ts)
// — общие для контактов и сделок (тикет crm-intake/02). Строка слияния не удаляется: откат
// ставит отметку undone_at. Запись слияния и отметка отката ставят поиск дублей обеих записей
// той же транзакцией (тикет crm-intake/05, duplicates/queue.ts): слияние переносит телефоны,
// email и сделки, слитая запись выходит из пар, откат возвращает её.
//
// Здесь же — общие части маршрутов слияния контактов (merge/contacts.ts) и сделок
// (merge/deals.ts, merge/deal-core.ts) с параметром вида записи (тикет crm-intake/12): контекст,
// тело запроса, поля предпросмотра, «было → стало», список откатываемых слияний, проверки отката
// и ответ 409 MERGE_RETRY на взаимоблокировку.

/** Сколько дней слияние можно откатить (пункт 29; ADR 0005) — общее с apps/web. */
export const UNDO_DAYS = MERGE_UNDO_DAYS

/** Кто сливает и охват записей сливаемого вида (контактов или сделок). */
export interface MergeContext extends MergeActor {
  scope: ResourceScope
}

/** Контекст слияния записей вида `entity` по запросу (только сессия). */
export async function mergeContext(c: Ctx, entity: MergeEntity): Promise<MergeContext> {
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
    scope: permissions.scopes[entity === 'contact' ? 'contacts' : 'deals'],
  }
}

/** Поле тела с id второй записи. */
const MERGED_ID_FIELD = { contact: 'merge_contact_id', deal: 'merge_deal_id' } as const

/**
 * id второй записи из тела слияния и предпросмотра (`merge_contact_id` или `merge_deal_id`) в
 * нижнем регистре. Других ключей, кроме `extra`, нет — иначе 400 INVALID_MERGE с путём ключа.
 */
export function readMergedId(
  body: Record<string, unknown> | null,
  entity: MergeEntity,
  extra: readonly string[] = [],
): Outcome<string, 'INVALID_MERGE'> {
  if (!body) return refuse(400, 'INVALID_MERGE', { path: '' })
  const field = MERGED_ID_FIELD[entity]
  const unknown = Object.keys(body).find((key) => key !== field && !extra.includes(key))
  if (unknown !== undefined) return refuse(400, 'INVALID_MERGE', { path: unknown })
  const id = body[field]
  if (typeof id !== 'string' || !UUID.test(id)) {
    return refuse(400, 'INVALID_MERGE', { path: field })
  }
  return ok(id.toLowerCase())
}

const customCode = (item: MovedItem) => (item.field ?? '').slice('custom.'.length)
const isCustom = (item: MovedItem) => item.field?.startsWith('custom.') ?? false

/**
 * Заполняемые поля для предпросмотра: пользовательские поля скрытых от роли групп в него не
 * попадают (но переходят).
 */
export async function previewFields(
  ctx: MergeContext,
  entity: MergeEntity,
  items: readonly MovedItem[],
): Promise<MovedItem[]> {
  const fields = items.filter((item) => item.kind === 'field')
  const [visible = {}] = await visibleCustom(ctx, entity, [
    Object.fromEntries(fields.filter(isCustom).map((item) => [customCode(item), item.value])),
  ])
  return fields.filter((item) => !isCustom(item) || Object.hasOwn(visible, customCode(item)))
}

/** Состояние записи для истории: ответ API и все пользовательские поля (без фильтра роли). */
export interface Snapshot<View extends object> {
  view: View
  custom: Record<string, unknown>
}

/** «Было → стало» записи: поля `fields` ответа API и пользовательские поля по коду. */
export function changesOf<View extends object>(
  before: Snapshot<View>,
  after: Snapshot<View>,
  fields: readonly (keyof View & string)[],
): FieldChange[] {
  const changes = diffFields(before.view, after.view, fields)
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
 * Слияния в запись `survivorId`, которые ещё можно откатить: новые сверху. Вложенное (слияние
 * сделок вместе со слиянием контактов) откатывается только с ним и в список не входит; у слияний
 * контактов parent_id нет.
 */
export function undoableMerges(
  db: Kysely<Database>,
  entity: MergeEntity,
  survivorId: string,
): Promise<MergeRow[]> {
  return db
    .selectFrom('merge_record')
    .selectAll()
    .where('entity_type', '=', entity)
    .where('survivor_id', '=', survivorId)
    .where('parent_id', 'is', null)
    .where('undone_at', 'is', null)
    .where('undo_until', '>', sql<Date>`now()`)
    .orderBy('merged_at', 'desc')
    .orderBy('id', 'desc')
    .execute()
}

/** Слияние, которое скрыло запись `id` вида `entity` и ещё не откачено. */
export async function hidingMerge(
  db: Kysely<Database>,
  entity: MergeEntity,
  id: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('merge_record')
    .select('id')
    .where('entity_type', '=', entity)
    .where('merged_id', '=', id)
    .where('undone_at', 'is', null)
    .orderBy('merged_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  return row?.id ?? null
}

/** Отказы отката по записи слияния: общие для контактов и сделок. */
export type UndoRefusalCode =
  | 'MERGE_NOT_FOUND'
  | 'MERGE_ALREADY_UNDONE'
  | 'MERGE_UNDO_EXPIRED'
  | 'MERGE_UNDO_BLOCKED'
  | 'MERGE_UNDO_SURVIVOR_TRASHED'

/**
 * Слияние `id` для отката под блокировкой. Записи слияния блокируются FOR UPDATE после строк
 * самих записей (`lockRecords` — оставшейся и слитой): окончательное удаление из корзины держит
 * запись и потом удаляет строки её слияний (purge_from_trash, migrations/0026_merge.ts), и
 * обратный порядок сцепился бы с ним (тикет crm-intake/12).
 */
export async function lockedMerge<Rows>(
  db: Kysely<Database>,
  entity: MergeEntity,
  id: string,
  lockRecords: (pair: MergePair) => Promise<Rows>,
): Promise<Outcome<{ record: MergeRow; pair: MergePair; rows: Rows }, UndoRefusalCode>> {
  const found = await findMerge(db, entity, id)
  if (!found) return refuse(404, 'MERGE_NOT_FOUND')
  if (found.undone_at !== null) return refuse(409, 'MERGE_ALREADY_UNDONE')
  const pair = { survivorId: found.survivor_id, mergedId: found.merged_id }
  const rows = await lockRecords(pair)
  // Пока ждали записи, слияние могли откатить или стереть вместе с записью.
  const record = await findMerge(db, entity, id, true)
  if (!record) return refuse(404, 'MERGE_NOT_FOUND')
  if (record.undone_at !== null) return refuse(409, 'MERGE_ALREADY_UNDONE')
  return ok({ record, pair, rows })
}

/** Запись слияния в проверке отката: оставшаяся и слитая. */
interface UndoRow {
  id: string
  merged_into_id: string | null
  deleted_at: Date | string | null
}

/**
 * Проверки отката после охвата: срок не прошёл; оставшаяся сама не слита с другой (иначе то, что
 * перешло к ней, осталось бы у скрытой — сначала откатить то слияние); позже никто из пары не
 * слит; оставшаяся не в корзине. null — откатывать можно.
 */
export async function undoRefusal(
  db: Kysely<Database>,
  record: MergeRow,
  survivor: UndoRow,
  merged: UndoRow,
): Promise<Refusal<UndoRefusalCode> | null> {
  if (await undoExpired(db, record)) return refuse(409, 'MERGE_UNDO_EXPIRED')
  const entity = record.entity_type as MergeEntity
  if (survivor.merged_into_id !== null) {
    return refuse(409, 'MERGE_UNDO_BLOCKED', {
      mergeId: await hidingMerge(db, entity, survivor.id),
    })
  }
  const later = await laterMerge(db, record)
  if (later !== null || merged.merged_into_id !== record.survivor_id) {
    return refuse(409, 'MERGE_UNDO_BLOCKED', { mergeId: later })
  }
  if (survivor.deleted_at !== null) return refuse(409, 'MERGE_UNDO_SURVIVOR_TRASHED')
  return null
}

/** SQLSTATE взаимоблокировки: база откатила одну из сцепившихся транзакций. */
const DEADLOCK_DETECTED = '40P01'

/**
 * Слияние, предпросмотр или откат `fn` в своей точке сохранения: взаимоблокировка с другим
 * изменением тех же записей откатывает только его — ответ 409 MERGE_RETRY (повторить запрос), а
 * не 500. Пути, которые держат контакт и сделку вместе, блокируют их в одном порядке — «контакт,
 * потом сделка и заметка» (тикет crm-intake/12); это — на случай, который порядок не покрыл
 * (deals/store.ts, lockDeals: основной контакт сменился, пока ждали блокировку).
 */
export async function deadlockRefusal<T, Code extends string>(
  db: Kysely<Database>,
  fn: () => Promise<Outcome<T, Code>>,
): Promise<Outcome<T, Code | 'MERGE_RETRY'>> {
  await sql`savepoint merge_attempt`.execute(db)
  try {
    const outcome = await fn()
    await sql`release savepoint merge_attempt`.execute(db)
    return outcome
  } catch (error) {
    if (sqlState(error) !== DEADLOCK_DETECTED) throw error
    await sql`rollback to savepoint merge_attempt`.execute(db)
    return refuse(409, 'MERGE_RETRY')
  }
}

export type MergeRow = Selectable<Database['merge_record']>

/** Слияние в ответах API. */
export interface MergeView {
  id: string
  entityType: MergeEntity
  survivorId: string
  mergedId: string
  /** Слияние, в том же действии которого объединены и эти записи; null — самостоятельное. */
  parentId: string | null
  mergedBy: { id: string; name: string } | null
  mergedAt: string
  /** До какого времени можно откатить. */
  undoUntil: string
  undoneAt: string | null
}

const iso = (value: Date | string) => new Date(value).toISOString()

/**
 * Пишет слияние и перешедшее; отметка «откатить до» — через UNDO_DAYS дней. Время слияния —
 * clock_timestamp() в момент записи (после блокировок обеих записей), а не now(): now() — время
 * начала транзакции запроса (её открывает middleware/project-context.ts до блокировок), и у
 * слияния, которое ждало чужую блокировку, оно оказалось бы раньше слияния, которого оно ждало
 * (laterMerge сравнивает по этому времени).
 */
export async function insertMerge(
  actor: MergeActor,
  entity: MergeEntity,
  pair: MergePair,
  items: readonly MovedItem[],
  parentId: string | null = null,
): Promise<MergeRow> {
  const row = await insertMergeRecord(actor, entity, pair, parentId)
  await insertMovedItems(actor, row.id, items)
  return row
}

/**
 * Только строка слияния, без перешедшего (тикет crm-intake/04): слияние контактов пишется
 * первым — на него ссылаются (parent_id) слияния сделок того же действия, а его перешедшее
 * известно только после них. parent_id задним числом не поставить: UPDATE строки слияния роли
 * приложения разрешён только для отметок отката (migrations/0026_merge.ts).
 */
export async function insertMergeRecord(
  actor: MergeActor,
  entity: MergeEntity,
  pair: MergePair,
  parentId: string | null = null,
): Promise<MergeRow> {
  const row = await actor.db
    .insertInto('merge_record')
    .values({
      project_id: actor.projectId,
      entity_type: entity,
      survivor_id: pair.survivorId,
      merged_id: pair.mergedId,
      parent_id: parentId,
      merged_by: actor.actorId,
      merged_at: sql<Date>`clock_timestamp()`,
      undo_until: sql<Date>`clock_timestamp() + make_interval(days => ${UNDO_DAYS})`,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
  await scanPair(actor, entity, pair)
  return row
}

/** Перешедшее при слиянии `mergeId`. */
export async function insertMovedItems(
  actor: MergeActor,
  mergeId: string,
  items: readonly MovedItem[],
): Promise<void> {
  if (items.length === 0) return
  await actor.db
    .insertInto('merge_moved_item')
    .values(
      items.map((item) => ({
        project_id: actor.projectId,
        merge_id: mergeId,
        kind: item.kind,
        item_id: item.itemId,
        field: item.field,
        value: JSON.stringify(item.value ?? null),
      })),
    )
    .execute()
}

/**
 * Неоткаченные вложенные слияния `parentId` (сделки, объединённые в том же действии) в порядке
 * записи; `lock` — строки блокируются до конца транзакции.
 */
export function nestedMerges(
  db: Kysely<Database>,
  parentId: string,
  lock = true,
): Promise<MergeRow[]> {
  const query = db
    .selectFrom('merge_record')
    .selectAll()
    .where('parent_id', '=', parentId)
    .where('undone_at', 'is', null)
    .orderBy('merged_at')
    .orderBy('id')
  return (lock ? query.forUpdate() : query).execute()
}

/** Поиск дублей обеих записей слияния — той же транзакцией. */
function scanPair(actor: MergeActor, entity: MergeEntity, pair: MergePair) {
  return enqueueDuplicateScan(actor.db, actor.projectId, [
    { entity, id: pair.survivorId },
    { entity, id: pair.mergedId },
  ])
}

/** Слияние `id` записей вида `entity`; `lock` — заблокировать строку до конца транзакции. */
export function findMerge(db: Kysely<Database>, entity: MergeEntity, id: string, lock = false) {
  const query = db
    .selectFrom('merge_record')
    .selectAll()
    .where('id', '=', id)
    .where('entity_type', '=', entity)
  return (lock ? query.forUpdate() : query).executeTakeFirst()
}

/** Перешедшее при слиянии `mergeId` — в порядке записи. */
export async function movedItems(db: Kysely<Database>, mergeId: string): Promise<MovedItem[]> {
  const rows = await db
    .selectFrom('merge_moved_item')
    .select(['kind', 'item_id', 'field', 'value'])
    .where('merge_id', '=', mergeId)
    .orderBy('id')
    .execute()
  return rows.map((row) => ({
    kind: row.kind,
    itemId: row.item_id,
    field: row.field,
    value: row.value,
  }))
}

/**
 * Более позднее неоткаченное слияние, в котором участвует одна из записей слияния `merge`:
 * его надо откатить первым. null — такого нет.
 */
export async function laterMerge(db: Kysely<Database>, merge: MergeRow): Promise<string | null> {
  const ids = [merge.survivor_id, merge.merged_id]
  const row = await db
    .selectFrom('merge_record')
    .select('id')
    .where('entity_type', '=', merge.entity_type)
    .where('undone_at', 'is', null)
    .where('id', '<>', merge.id)
    .where('merged_at', '>', merge.merged_at)
    .where((eb) => eb.or([eb('survivor_id', 'in', ids), eb('merged_id', 'in', ids)]))
    .orderBy('merged_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  return row?.id ?? null
}

/** Срок отката прошёл (по часам базы). */
export async function undoExpired(db: Kysely<Database>, merge: MergeRow): Promise<boolean> {
  const { expired } = await sql<{ expired: boolean }>`
    select now() > ${merge.undo_until}::timestamptz as expired
  `
    .execute(db)
    .then((result) => result.rows[0] ?? { expired: true })
  return expired
}

export async function markUndone(actor: MergeActor, mergeId: string): Promise<MergeRow> {
  const row = await actor.db
    .updateTable('merge_record')
    .set({ undone_at: sql`now()`, undone_by: actor.actorId })
    .where('id', '=', mergeId)
    .returningAll()
    .executeTakeFirstOrThrow()
  await scanPair(actor, row.entity_type as MergeEntity, {
    survivorId: row.survivor_id,
    mergedId: row.merged_id,
  })
  return row
}

/** Ответ API для строк слияний: имена тех, кто сливал, — одним запросом. */
export async function mergeViews(db: Kysely<Database>, rows: MergeRow[]): Promise<MergeView[]> {
  const userIds = [...new Set(rows.map((row) => row.merged_by))]
  const users =
    userIds.length === 0
      ? []
      : await db.selectFrom('user').select(['id', 'name']).where('id', 'in', userIds).execute()
  const names = new Map(users.map((user) => [user.id, user.name]))
  return rows.map((row) => ({
    id: row.id,
    entityType: row.entity_type as MergeEntity,
    survivorId: row.survivor_id,
    mergedId: row.merged_id,
    parentId: row.parent_id,
    mergedBy: names.has(row.merged_by)
      ? { id: row.merged_by, name: names.get(row.merged_by) ?? '' }
      : null,
    mergedAt: iso(row.merged_at),
    undoUntil: iso(row.undo_until),
    undoneAt: row.undone_at === null ? null : iso(row.undone_at),
  }))
}
