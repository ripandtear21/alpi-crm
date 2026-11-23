import type { Database } from '@alpi/db'
import { EXACT_COUNT_LIMIT, type ListCount, type SortDirection } from '@alpi/shared'
import { type Kysely, type RawBuilder, type SelectQueryBuilder, type SqlBool, sql } from 'kysely'

// Постраничная выдача списков с сортировкой по колонке (тикет crm-deals/12): курсор — значение
// колонки сортировки и id последней строки, следующая страница — строго после этой пары.
// Строки с равным значением (одинаковая сумма) упорядочены по id, поэтому каждая строка
// приходит ровно один раз. Колонки сортировки — непустые столбцы (SORTABLE_COLUMNS в
// packages/shared/src/filters), иначе пара «значение, id» была бы неоднозначной.

/** Тип значения колонки сортировки в курсоре. */
export type SortCast = 'timestamptz' | 'numeric' | 'text'

/** Колонка сортировки: выражение для ORDER BY и его значение строкой для курсора. */
export interface SortKey {
  order: RawBuilder<unknown>
  /** То же значение текстом: время — ISO 8601 UTC до микросекунд, число — как есть. */
  text: RawBuilder<string>
  cast: SortCast
}

/** Время столбца `column` строкой ISO 8601 UTC до микросекунд (курсор не теряет точность). */
export function isoMicros(column: string): RawBuilder<string> {
  return sql<string>`to_char(${sql.ref(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
}

export function timeKey(column: string): SortKey {
  return { order: sql.ref(column), text: isoMicros(column), cast: 'timestamptz' }
}

export function numericKey(column: string): SortKey {
  return { order: sql.ref(column), text: sql<string>`${sql.ref(column)}::text`, cast: 'numeric' }
}

export function textKey(column: string): SortKey {
  return { order: sql.ref(column), text: sql<string>`${sql.ref(column)}`, cast: 'text' }
}

/** Позиция в выдаче: значение колонки сортировки и id строки. */
export interface PagePosition {
  v: string
  id: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const NUMBER = /^\d{1,14}(?:\.\d{1,2})?$/
const MAX_TEXT = 400

/** Значение курсора подходит к типу колонки (иначе база ответила бы ошибкой, а не 400). */
export function validCursorValue(cast: SortCast, value: string): boolean {
  switch (cast) {
    case 'timestamptz': {
      if (!TIME.test(value)) return false
      const date = new Date(value)
      return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19)
    }
    case 'numeric':
      return NUMBER.test(value)
    case 'text':
      return value.length <= MAX_TEXT
  }
}

/**
 * Курсор: непрозрачная строка base64url с колонкой и направлением сортировки, значением и id.
 * Курсор другой сортировки не подходит (400): страницы одной выдачи — с одной сортировкой.
 */
export function encodePageCursor(sort: string, position: PagePosition): string {
  return Buffer.from(JSON.stringify({ s: sort, v: position.v, id: position.id })).toString(
    'base64url',
  )
}

/** Курсор из строки запроса для сортировки `sort`; не тот — undefined. */
export function decodePageCursor(
  raw: string,
  sort: string,
  cast: SortCast,
): PagePosition | undefined {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const { s, v, id } = value as Record<string, unknown>
  if (s !== sort || typeof v !== 'string' || typeof id !== 'string' || !UUID.test(id)) {
    return undefined
  }
  return validCursorValue(cast, v) ? { v, id: id.toLowerCase() } : undefined
}

const CAST: Record<SortCast, (value: string) => RawBuilder<unknown>> = {
  timestamptz: (value) => sql`cast(${value} as timestamptz)`,
  numeric: (value) => sql`cast(${value} as numeric)`,
  text: (value) => sql`cast(${value} as text)`,
}

/** Условие «строка после позиции» для сортировки `key` по `direction`, затем по `idColumn`. */
export function afterPosition(
  key: SortKey,
  direction: SortDirection,
  idColumn: string,
  position: PagePosition,
): RawBuilder<SqlBool> {
  const row = sql`(${key.order}, ${sql.ref(idColumn)})`
  const at = sql`(${CAST[key.cast](position.v)}, cast(${position.id} as uuid))`
  return direction === 'desc' ? sql<SqlBool>`${row} < ${at}` : sql<SqlBool>`${row} > ${at}`
}

/**
 * Счётчик выдачи `query` (уже с условиями WHERE): до EXACT_COUNT_LIMIT — точное число, выше —
 * оценка планировщика базы. Точный подсчёт больших выборок дорог, а «≈ 48 000» пользователю
 * достаточно.
 */
export async function countRows(
  db: Kysely<Database>,
  // biome-ignore lint/suspicious/noExplicitAny: запрос любой таблицы списка
  query: SelectQueryBuilder<any, any, any>,
): Promise<ListCount> {
  const rows = query.clearSelect().clearOrderBy().clearLimit().select(sql`1`.as('one'))
  const capped = await sql<{ n: number }>`
    select count(*)::int as n from (${rows.limit(EXACT_COUNT_LIMIT + 1)}) as capped
  `.execute(db)
  const exact = capped.rows[0]?.n ?? 0
  if (exact <= EXACT_COUNT_LIMIT) return { count: exact, approximate: false }
  const [plan] = await rows.explain('json')
  const estimate = Number(
    (plan as { 'QUERY PLAN'?: { Plan?: { 'Plan Rows'?: unknown } }[] } | undefined)?.[
      'QUERY PLAN'
    ]?.[0]?.Plan?.['Plan Rows'] ?? 0,
  )
  return { count: Math.max(EXACT_COUNT_LIMIT + 1, Math.round(estimate)), approximate: true }
}
