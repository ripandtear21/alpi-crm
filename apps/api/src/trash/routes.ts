import type { Database } from '@alpi/db'
import { can, type Page, type Resource } from '@alpi/shared'
import { Hono } from 'hono'
import { type Kysely, sql } from 'kysely'
import { type Ctx, fail, type Outcome, ok, readLimit, refuse } from '../contacts/http.ts'
import { contactScopePredicate } from '../contacts/scope.ts'
import { dealInScope } from '../deals/scope.ts'
import {
  afterPosition,
  decodePageCursor,
  encodePageCursor,
  type PagePosition,
  timeKey,
} from '../filters/page.ts'
import { type PermissionsEnv, requirePermission } from '../middleware/permissions.ts'
import { PROJECT_TEAMS, resolveViewer } from '../roles/scope.ts'
import { TRASH_RETENTION_DAYS } from './purge.ts'

// Корзина (тикет crm-deals/12; spec.md MVP, раздел 5.5): `GET /v1/trash?type=deal|contact|
// organization` — удалённые записи, недавно удалённые сверху, с курсором; у каждой — дата
// окончательного удаления (через 30 дней после удаления, задача trash-purge). Право —
// «корзина: смотреть» и «смотреть» саму часть системы; охват — как у записи: сделки и контакты
// вне охвата чтения не показываются. Восстановить — POST /v1/<раздел>/:id/restore (право
// «корзина: изменять»), удалить окончательно — DELETE /v1/<раздел>/:id/permanent («корзина:
// удалять»): маршруты разделов.

export const TRASH_TYPES = ['deal', 'contact', 'organization'] as const
export type TrashType = (typeof TRASH_TYPES)[number]

const RESOURCE: Record<TrashType, Resource> = {
  deal: 'deals',
  contact: 'contacts',
  organization: 'organizations',
}

/** Запись в корзине. */
export interface TrashItem {
  type: TrashType
  id: string
  /** Название сделки, имя контакта, название организации. */
  title: string
  deletedAt: string
  /** Кто удалил; null — неизвестно (удалена вместе с контактом системой и т. п.). */
  deletedByName: string | null
  /** Когда запись удалится окончательно. */
  purgeAt: string
}

/** Страница выдачи `/api/v1` (packages/shared, Page). */
export type TrashPage = Page<TrashItem>

type Result<T> = Outcome<T, 'INVALID_TRASH_QUERY' | 'PERMISSION_DENIED'>

const SORT = 'deletedAt:desc'
const DAY_MS = 24 * 60 * 60 * 1000

interface Row {
  id: string
  title: string
  deleted_at: string
  deleted_by: string | null
}

async function trashRows(
  c: Ctx,
  type: TrashType,
  cursor: PagePosition | undefined,
  limit: number,
): Promise<Row[]> {
  const db = c.get('db') as Kysely<Database>
  const userId = c.get('session').user.id
  const { permissions } = c.get('access')
  switch (type) {
    case 'deal': {
      const key = timeKey('deal.deleted_at')
      const viewer = await resolveViewer(db, userId, PROJECT_TEAMS)
      let query = db
        .selectFrom('deal')
        .select(['deal.id', 'deal.title', 'deal.deleted_by'])
        .select(key.text.as('deleted_at'))
        .where('deal.deleted_at', 'is not', null)
        // Слитая сделка скрыта и в корзине (тикет crm-intake/02).
        .where('deal.merged_into_id', 'is', null)
        .where(dealInScope(sql.ref('deal.owner_id'), permissions.scopes.deals.read, viewer))
        .orderBy('deal.deleted_at', 'desc')
        .orderBy('deal.id', 'desc')
        .limit(limit + 1)
      if (cursor) query = query.where(afterPosition(key, 'desc', 'deal.id', cursor))
      return (await query.execute()) as Row[]
    }
    case 'contact': {
      const key = timeKey('contact.deleted_at')
      const viewer = await resolveViewer(db, userId, PROJECT_TEAMS)
      let query = db
        .selectFrom('contact')
        .select(['contact.id', 'contact.deleted_by'])
        .select(sql<string>`concat_ws(' ', contact.first_name, contact.last_name)`.as('title'))
        .select(key.text.as('deleted_at'))
        .where('contact.deleted_at', 'is not', null)
        .where((eb) => contactScopePredicate(eb, permissions.scopes.contacts.read, viewer))
        .orderBy('contact.deleted_at', 'desc')
        .orderBy('contact.id', 'desc')
        .limit(limit + 1)
      if (cursor) query = query.where(afterPosition(key, 'desc', 'contact.id', cursor))
      return (await query.execute()) as Row[]
    }
    case 'organization': {
      const key = timeKey('organization.deleted_at')
      let query = db
        .selectFrom('organization')
        .select(['organization.id', 'organization.name as title', 'organization.deleted_by'])
        .select(key.text.as('deleted_at'))
        .where('organization.deleted_at', 'is not', null)
        .orderBy('organization.deleted_at', 'desc')
        .orderBy('organization.id', 'desc')
        .limit(limit + 1)
      if (cursor) query = query.where(afterPosition(key, 'desc', 'organization.id', cursor))
      return (await query.execute()) as Row[]
    }
  }
}

async function listTrash(c: Ctx): Promise<Result<TrashPage>> {
  const type = TRASH_TYPES.find((value) => value === c.req.query('type'))
  if (!type) return refuse(400, 'INVALID_TRASH_QUERY', { path: 'type' })
  if (!can(c.get('access').permissions, RESOURCE[type], 'view')) {
    return refuse(403, 'PERMISSION_DENIED')
  }
  const limit = readLimit(c.req.query('limit'))
  if (limit === undefined) return refuse(400, 'INVALID_TRASH_QUERY', { path: 'limit' })
  const rawCursor = c.req.query('cursor')
  const cursor =
    rawCursor === undefined ? undefined : decodePageCursor(rawCursor, SORT, 'timestamptz')
  if (rawCursor !== undefined && !cursor) {
    return refuse(400, 'INVALID_TRASH_QUERY', { path: 'cursor' })
  }
  const rows = await trashRows(c, type, cursor, limit)
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  const deleters = [...new Set(page.flatMap((row) => (row.deleted_by ? [row.deleted_by] : [])))]
  const names = new Map(
    deleters.length === 0
      ? []
      : (
          await c
            .get('db')
            .selectFrom('user')
            .select(['id', 'name'])
            .where('id', 'in', deleters)
            .execute()
        ).map((user) => [user.id, user.name]),
  )
  return ok({
    data: page.map((row) => ({
      type,
      id: row.id,
      title: row.title,
      deletedAt: row.deleted_at,
      deletedByName: row.deleted_by === null ? null : (names.get(row.deleted_by) ?? null),
      purgeAt: new Date(
        new Date(row.deleted_at).getTime() + TRASH_RETENTION_DAYS * DAY_MS,
      ).toISOString(),
    })),
    next_cursor:
      rows.length > limit && last
        ? encodePageCursor(SORT, { v: last.deleted_at, id: last.id })
        : null,
  })
}

/** Маршруты корзины: `/v1/trash`. */
export function trashRoutes() {
  return new Hono<PermissionsEnv>().get('/', requirePermission('trash', 'view'), async (c) => {
    const outcome = await listTrash(c)
    return outcome.ok ? c.json<TrashPage>(outcome.value) : fail(c, outcome)
  })
}
