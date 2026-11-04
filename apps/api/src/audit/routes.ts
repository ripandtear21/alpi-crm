import type { Database } from '@alpi/db'
import {
  type AuditActor,
  type AuditEntry,
  type AuditPage,
  isProjectAuditAction,
  isSystemAuditAction,
  type ProjectAuditAction,
  type SystemAuditAction,
} from '@alpi/shared'
import { Hono } from 'hono'
import { type Kysely, sql } from 'kysely'
import type { AccessEnv } from '../auth/access-guard.ts'
import { type PermissionsEnv, requireStandalone } from '../middleware/permissions.ts'

// Просмотр журнала (тикет crm-foundation/07).
// - GET /audit — журнал текущего проекта. Право — отдельное «настройки проекта»
//   (project_settings), а не «пользователи и роли»: в журнале будут не только роли и
//   участники, но и выгрузки, массовые операции и удаления из всех разделов, с адресами
//   пользователей. Из шаблонов это право есть только у администратора — экран для него.
// - GET /system-audit — системный журнал (входы, 2FA), только владельцу системы: читает его
//   функция базы system_audit_events, она же проверяет владельца.
// Страницы: новые сверху, курсор — (occurred_at, id) последней записи страницы.

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const MAX_ACTOR_LENGTH = 100

/** Время записи в курсоре — с микросекундами, в UTC: Date JavaScript теряет микросекунды. */
const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** SQLSTATE insufficient_privilege: system_audit_events отказала не-владельцу. */
const INSUFFICIENT_PRIVILEGE = '42501'

interface Cursor {
  at: string
  id: string
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.at}|${cursor.id}`).toString('base64url')
}

function decodeCursor(value: string): Cursor | null {
  const [at = '', id = ''] = Buffer.from(value, 'base64url').toString().split('|')
  return CURSOR_AT.test(at) && UUID.test(id) ? { at, id } : null
}

/** Строка журнала с автором — общая форма для обоих журналов. */
interface Row {
  id: string
  occurred_at: Date
  cursor_at: string
  actor_id: string | null
  actor_name: string | null
  actor_email: string | null
  ip: string | null
  action: string
  entity_type: string | null
  entity_id: string | null
  entity_name: string | null
  details: Record<string, unknown>
  attempted_email?: string | null
}

type Query<A> =
  | { ok: true; cursor: Cursor | null; action: A | null; actor: string | null; limit: number }
  | { ok: false; field: string }

/** Параметры страницы: ?cursor=&action=&actor=&limit= */
function readQuery<A>(
  query: Record<string, string | undefined>,
  isAction: (value: unknown) => value is A,
): Query<A> {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null
  if (query.cursor && !cursor) return { ok: false, field: 'cursor' }
  if (query.action && !isAction(query.action)) return { ok: false, field: 'action' }
  if (query.actor && query.actor.length > MAX_ACTOR_LENGTH) return { ok: false, field: 'actor' }
  const limit = query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return { ok: false, field: 'limit' }
  }
  return {
    ok: true,
    cursor,
    action: (query.action as A | undefined) || null,
    actor: query.actor || null,
    limit,
  }
}

/** Страница из `limit + 1` строк: лишняя строка говорит, что есть следующая страница. */
function toPage<A extends string>(rows: Row[], limit: number): AuditPage<A & AuditEntry['action']> {
  const items = rows.slice(0, limit)
  const last = items.at(-1)
  return {
    items: items.map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at.toISOString(),
      actor:
        row.actor_id === null
          ? null
          : ({
              id: row.actor_id,
              name: row.actor_name ?? '',
              email: row.actor_email ?? '',
            } satisfies AuditActor),
      ip: row.ip,
      action: row.action as A & AuditEntry['action'],
      entityType: row.entity_type,
      entityId: row.entity_id,
      entityName: row.entity_name,
      details:
        row.attempted_email == null
          ? row.details
          : { ...row.details, attemptedEmail: row.attempted_email },
    })),
    nextCursor:
      rows.length > limit && last ? encodeCursor({ at: last.cursor_at, id: last.id }) : null,
  }
}

const CURSOR_AT_SQL = `to_char(l.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

/** Журнал текущего проекта: `/audit`. */
export function auditRoutes() {
  return new Hono<PermissionsEnv>()
    .get('/', requireStandalone('project_settings'), async (c) => {
      const query = readQuery(c.req.query(), isProjectAuditAction)
      if (!query.ok) return c.json({ code: 'INVALID_QUERY', details: { path: query.field } }, 400)
      // Политика row-level security показывает только строки текущего проекта; project_id в
      // условии — вторая линия, как в projectContext.
      let builder = c
        .get('db')
        .selectFrom('audit_log as l')
        .leftJoin('user as u', 'u.id', 'l.actor_id')
        .leftJoin('user as t', (join) =>
          join.onRef('t.id', '=', 'l.entity_id').on('l.entity_type', '=', 'user'),
        )
        .select([
          'l.id',
          'l.occurred_at',
          sql<string>`${sql.raw(CURSOR_AT_SQL)}`.as('cursor_at'),
          'l.actor_id',
          'u.name as actor_name',
          'u.email as actor_email',
          sql<string | null>`host(l.ip)`.as('ip'),
          'l.action',
          'l.entity_type',
          'l.entity_id',
          't.name as entity_name',
          'l.details',
        ])
        .where('l.project_id', '=', c.get('projectId'))
        .orderBy('l.occurred_at', 'desc')
        .orderBy('l.id', 'desc')
        .limit(query.limit + 1)
      const { cursor, action, actor } = query
      if (cursor) {
        builder = builder.where(
          sql<boolean>`(l.occurred_at, l.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`,
        )
      }
      if (action) builder = builder.where('l.action', '=', action)
      if (actor) builder = builder.where('l.actor_id', '=', actor)
      const rows = await builder.execute()
      return c.json<AuditPage<ProjectAuditAction>>(toPage(rows, query.limit))
    })
    .get('/actors', requireStandalone('project_settings'), async (c) => {
      // Для фильтра «пользователь»: все, кто есть в журнале проекта, — и уже не участники.
      const rows = await c
        .get('db')
        .selectFrom('audit_log as l')
        .innerJoin('user as u', 'u.id', 'l.actor_id')
        .select(['u.id', 'u.name', 'u.email'])
        .where('l.project_id', '=', c.get('projectId'))
        .distinct()
        .orderBy('u.name')
        .orderBy('u.email')
        .execute()
      return c.json<AuditActor[]>(rows)
    })
}

/** Системный журнал для владельца системы: `/system-audit`. */
export function systemAuditRoutes(db: Kysely<Database>) {
  return new Hono<AccessEnv>().get('/', async (c) => {
    const query = readQuery(c.req.query(), isSystemAuditAction)
    if (!query.ok) return c.json({ code: 'INVALID_QUERY', details: { path: query.field } }, 400)
    const { cursor, action, actor, limit } = query
    try {
      const { rows } = await sql<Row>`
        select l.id, l.occurred_at, ${sql.raw(CURSOR_AT_SQL)} as cursor_at, l.actor_id,
          u.name as actor_name, u.email as actor_email, host(l.ip) as ip, l.action,
          l.entity_type, l.entity_id, u.name as entity_name, l.details, l.attempted_email
        from system_audit_events(
          ${c.get('session').user.id},
          ${cursor?.at ?? null}::timestamptz,
          ${cursor?.id ?? null}::uuid,
          ${action},
          ${actor},
          ${limit + 1}
        ) l
        left join "user" u on u.id = l.actor_id
        order by l.occurred_at desc, l.id desc
      `.execute(db)
      return c.json<AuditPage<SystemAuditAction>>(toPage(rows, limit))
    } catch (error) {
      if ((error as { code?: unknown }).code === INSUFFICIENT_PRIVILEGE) {
        return c.json({ code: 'PERMISSION_DENIED' }, 403)
      }
      throw error
    }
  })
}
