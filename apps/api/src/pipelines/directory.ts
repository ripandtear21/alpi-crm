import type { Database } from '@alpi/db'
import { MAX_DIRECTORY_NAME_LENGTH, type PipelinesErrorCode } from '@alpi/shared'
import type { Context } from 'hono'
import { type Kysely, sql } from 'kysely'
import { problem } from '../http/problem.ts'
import type { PermissionsEnv } from '../middleware/permissions.ts'
import { sqlState } from '../roles/roles.ts'

// Общее для справочников сделок (тикет crm-deals/02): воронки и этапы (pipelines.ts), причины
// проигрыша (lost-reasons/lost-reasons.ts). Разбор тела запроса, ответы с кодом ошибки,
// перевод нарушений уникальности базы в 409 и перестановка порядка одним запросом.

export type Ctx = Context<PermissionsEnv>

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const UNIQUE_VIOLATION = '23505'

/** Ограничения уникальности (migrations/0008_pipelines.ts) → код ответа 409. */
const UNIQUE_CODES: Record<string, PipelinesErrorCode> = {
  pipeline_project_id_code_key: 'PIPELINE_CODE_TAKEN',
  pipeline_one_upsell_per_project: 'UPSELL_PIPELINE_EXISTS',
  lost_reason_group_project_id_name_key: 'LOST_REASON_GROUP_NAME_TAKEN',
  lost_reason_project_id_group_id_name_key: 'LOST_REASON_NAME_TAKEN',
}

export function fail(c: Ctx, status: 400 | 404 | 409, code: PipelinesErrorCode, path?: string) {
  return problem(c, status, code, path === undefined ? {} : { details: { path } })
}

export function invalid(c: Ctx, path: string) {
  return fail(c, 400, 'INVALID_INPUT', path)
}

/** Код 409 для нарушения уникальности справочника; другие ошибки — null (пробросить). */
export function uniqueRefusal(error: unknown): PipelinesErrorCode | null {
  if (sqlState(error) !== UNIQUE_VIOLATION) return null
  const constraint = (error as { constraint?: unknown }).constraint
  return typeof constraint === 'string' ? (UNIQUE_CODES[constraint] ?? null) : null
}

export async function readBody(c: Ctx): Promise<Record<string, unknown> | null> {
  const body = (await c.req.json().catch(() => null)) as unknown
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null
}

/** Название без пробелов по краям; null — не строка, пустое или длиннее предела. */
export function readName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  return name.length > 0 && name.length <= MAX_DIRECTORY_NAME_LENGTH ? name : null
}

/** Новый порядок: список разных uuid; null — не такой список. */
export function readIds(body: Record<string, unknown> | null): string[] | null {
  const ids = body?.ids
  if (!Array.isArray(ids)) return null
  if (!ids.every((id): id is string => typeof id === 'string' && UUID.test(id))) return null
  const lower = ids.map((id) => id.toLowerCase())
  return new Set(lower).size === lower.length ? lower : null
}

/** Отметка архива в ISO 8601 или null. */
export function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

type OrderedTable =
  | 'pipeline'
  | 'stage'
  | 'lost_reason_group'
  | 'lost_reason'
  // Конструктор полей (apps/api/src/fields).
  | 'field_group'
  | 'field_definition'
  | 'field_option'

/**
 * Переставляет записи `current` (id в нынешнем порядке, строки уже заблокированы) в порядок
 * `ids`: позиции 1, 2, 3… Новый порядок должен содержать ровно те же записи — иначе false и
 * ничего не меняется.
 */
export async function reorder(
  db: Kysely<Database>,
  table: OrderedTable,
  current: string[],
  ids: string[],
): Promise<boolean> {
  if (current.length !== ids.length) return false
  const known = new Set(current)
  if (!ids.every((id) => known.has(id))) return false
  await sql`
    update ${sql.table(table)} as t
    set position = o.ord, updated_at = now()
    from unnest(${ids}::uuid[]) with ordinality as o (id, ord)
    where t.id = o.id
  `.execute(db)
  return true
}
