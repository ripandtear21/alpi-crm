import { Hono } from 'hono'
import { sql } from 'kysely'
import { type Ctx, fail, type Outcome, ok, readLimit, refuse, UUID } from '../contacts/http.ts'
import { filesRoutes } from '../files/files.ts'
import { type PermissionsEnv, requirePermission } from '../middleware/permissions.ts'
import { notesRoutes } from '../notes/notes.ts'
import type { FileStorage } from '../storage/storage.ts'
import {
  ENTITY_COLUMN,
  ENTITY_RESOURCE,
  type EntityErrorCode,
  type EntityType,
  entityFor,
} from './entity.ts'

// Лента записи (тикет crm-deals/07; spec.md MVP, раздел 5.2): `/v1/{deals|contacts|
// organizations}/:id/timeline` — изменения полей (change_log), заметки и файлы одним списком,
// новые сверху. `?type=change,note,file` — только эти виды; `?limit=` — 1…200, по умолчанию 50;
// `?cursor=` — из nextCursor прошлой страницы. Регистрации, задачи, платежи и звонки добавят их
// эпики — новой веткой в timelineRows. Экраны ленты — тикеты 13 и 14.
//
// Порядок — (время, id) по убыванию; курсор — эта пара у последней строки страницы, время с
// точностью базы (микросекунды): следующая страница начинается строго после неё, без повторов и
// пропусков, даже если у нескольких строк одно время.

export const TIMELINE_KINDS = ['change', 'note', 'file'] as const
export type TimelineKind = (typeof TIMELINE_KINDS)[number]

export type TimelineErrorCode = EntityErrorCode | 'INVALID_TIMELINE'

/** Строка ленты. Поля вида — в `change`, `note` или `file`, по `kind`. */
export interface TimelineItem {
  kind: TimelineKind
  id: string
  occurredAt: string
  /** Кто сделал; null — система. */
  actorId: string | null
  actorName: string | null
  change?: { field: string; before: unknown; after: unknown }
  note?: { text: string; updatedAt: string }
  file?: { name: string; contentType: string; size: number }
}

export interface TimelinePage {
  items: TimelineItem[]
  /** Курсор следующей страницы; null — страниц больше нет. */
  nextCursor: string | null
}

interface TimelineRow {
  kind: TimelineKind
  id: string
  occurred_at: Date
  /** Время строки с микросекундами, UTC: для курсора. */
  cursor_at: string
  actor_id: string | null
  actor_name: string | null
  field: string | null
  before: unknown
  after: unknown
  text: string | null
  updated_at: Date | null
  name: string | null
  content_type: string | null
  size: string | null
}

const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/

interface Cursor {
  at: string
  id: string
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.id])).toString('base64url')
}

function decodeCursor(raw: string): Cursor | undefined {
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
    if (!Array.isArray(value) || value.length !== 2) return undefined
    const [at, id] = value as unknown[]
    if (typeof at !== 'string' || !CURSOR_TIME.test(at)) return undefined
    if (typeof id !== 'string' || !UUID.test(id)) return undefined
    return { at, id }
  } catch {
    return undefined
  }
}

function readKinds(raw: string | undefined): TimelineKind[] | undefined {
  if (raw === undefined || raw.trim() === '') return [...TIMELINE_KINDS]
  const kinds = raw.split(',').map((kind) => kind.trim())
  if (!kinds.every((kind) => TIMELINE_KINDS.some((known) => known === kind))) return undefined
  return TIMELINE_KINDS.filter((kind) => kinds.includes(kind))
}

/**
 * Ветка запроса ленты на каждый вид: одинаковые столбцы с именами и типами в каждой ветке (первой
 * может оказаться любая — по фильтру `type`), недостающие — null.
 */
function branch(kind: TimelineKind, type: EntityType, id: string) {
  switch (kind) {
    case 'change':
      return sql`
        select 'change'::text as kind, l.id, l.occurred_at, l.actor_id, l.field, l.before, l.after,
          null::text as text, null::timestamptz as updated_at, null::text as name,
          null::text as content_type, null::bigint as size
        from change_log l
        where l.entity_type = ${type} and l.entity_id = ${id}`
    case 'note':
      return sql`
        select 'note'::text as kind, n.id, n.created_at as occurred_at, n.author_id as actor_id,
          null::text as field, null::jsonb as before, null::jsonb as after, n.text, n.updated_at,
          null::text as name, null::text as content_type, null::bigint as size
        from note n
        where ${sql.ref(`n.${ENTITY_COLUMN[type]}`)} = ${id}`
    case 'file':
      return sql`
        select 'file'::text as kind, f.id, f.created_at as occurred_at, f.author_id as actor_id,
          null::text as field, null::jsonb as before, null::jsonb as after, null::text as text,
          null::timestamptz as updated_at, f.name, f.content_type, f.size
        from file f
        where ${sql.ref(`f.${ENTITY_COLUMN[type]}`)} = ${id}`
  }
}

function item(row: TimelineRow): TimelineItem {
  const base = {
    kind: row.kind,
    id: row.id,
    occurredAt: new Date(row.occurred_at).toISOString(),
    actorId: row.actor_id,
    actorName: row.actor_name,
  }
  switch (row.kind) {
    case 'change':
      return { ...base, change: { field: row.field ?? '', before: row.before, after: row.after } }
    case 'note':
      return {
        ...base,
        note: { text: row.text ?? '', updatedAt: new Date(row.updated_at ?? 0).toISOString() },
      }
    case 'file':
      return {
        ...base,
        file: { name: row.name ?? '', contentType: row.content_type ?? '', size: Number(row.size) },
      }
  }
}

async function timeline(
  c: Ctx,
  type: EntityType,
): Promise<Outcome<TimelinePage, TimelineErrorCode>> {
  const limit = readLimit(c.req.query('limit'))
  if (limit === undefined) return refuse(400, 'INVALID_TIMELINE', { path: 'limit' })
  const kinds = readKinds(c.req.query('type'))
  if (!kinds) return refuse(400, 'INVALID_TIMELINE', { path: 'type' })
  const rawCursor = c.req.query('cursor')
  const cursor = rawCursor === undefined ? undefined : decodeCursor(rawCursor)
  if (rawCursor !== undefined && !cursor) return refuse(400, 'INVALID_TIMELINE', { path: 'cursor' })
  const entity = await entityFor(c, type, c.req.param('id') ?? '', 'read')
  if (!entity.ok) return entity

  const after = cursor
    ? sql`(t.occurred_at, t.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
    : sql`true`
  const { rows } = await sql<TimelineRow>`
    select t.*, u.name as actor_name,
      to_char(t.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at
    from (${sql.join(
      kinds.map((kind) => branch(kind, type, entity.value.id)),
      sql` union all `,
    )}) t
    left join "user" u on u.id = t.actor_id
    where ${after}
    order by t.occurred_at desc, t.id desc
    limit ${limit + 1}
  `.execute(c.get('db'))
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return ok({
    items: page.map(item),
    nextCursor:
      rows.length > limit && last ? encodeCursor({ at: last.cursor_at, id: last.id }) : null,
  })
}

/** Маршрут ленты записи вида `type`. */
export function timelineRoutes(type: EntityType) {
  return new Hono<PermissionsEnv>().get(
    '/:id/timeline',
    requirePermission(ENTITY_RESOURCE[type], 'view'),
    async (c) => {
      const outcome = await timeline(c, type)
      return outcome.ok ? c.json<TimelinePage>(outcome.value) : fail(c, outcome)
    },
  )
}

/**
 * Заметки, файлы и лента записи вида `type` — монтируются на путь её раздела рядом с его
 * маршрутами: `.route('/deals', entityRecordsRoutes('deal', storage))`.
 */
export function entityRecordsRoutes(type: EntityType, storage: FileStorage) {
  return new Hono<PermissionsEnv>()
    .route('/', notesRoutes(type))
    .route('/', filesRoutes(type, storage))
    .route('/', timelineRoutes(type))
}
