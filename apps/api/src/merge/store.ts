import type { Database } from '@alpi/db'
import { type Kysely, type Selectable, sql } from 'kysely'
import type { MergeActor, MergeEntity, MergePair, MovedItem } from './registry.ts'

// Запись слияния и перешедшее (таблицы merge_record и merge_moved_item, migrations/0026_merge.ts)
// — общие для контактов и сделок (тикет crm-intake/02). Строка слияния не удаляется: откат
// ставит отметку undone_at.

/** Сколько дней слияние можно откатить (пункт 29; ADR 0005). */
export const UNDO_DAYS = 30

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
  return actor.db
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
 * записи; строки блокируются до конца транзакции.
 */
export function nestedMerges(db: Kysely<Database>, parentId: string): Promise<MergeRow[]> {
  return db
    .selectFrom('merge_record')
    .selectAll()
    .where('parent_id', '=', parentId)
    .where('undone_at', 'is', null)
    .orderBy('merged_at')
    .orderBy('id')
    .forUpdate()
    .execute()
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
  return actor.db
    .updateTable('merge_record')
    .set({ undone_at: sql`now()`, undone_by: actor.actorId })
    .where('id', '=', mergeId)
    .returningAll()
    .executeTakeFirstOrThrow()
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
