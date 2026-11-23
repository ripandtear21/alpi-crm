import { type Database, withProject } from '@alpi/db'
import { type FilterGroup, type ListCount, type ListSort, parseSort } from '@alpi/shared'
import { Hono } from 'hono'
import type { Kysely } from 'kysely'
import { recordInRequest } from '../audit/record.ts'
import { type Ctx, fail, type Outcome, ok, readLimit, refuse } from '../contacts/http.ts'
import {
  type CsvValue,
  csvHeader,
  csvResponse,
  csvRow,
  EXPORT_BATCH,
  type ExportLanguage,
  exportFilename,
  readColumns,
  readLanguage,
  UTF8_BOM,
} from '../export/csv.ts'
import { compileFilter, readFilterParam } from '../filters/compile.ts'
import {
  afterPosition,
  countRows,
  decodePageCursor,
  encodePageCursor,
  type PagePosition,
  type SortKey,
  textKey,
  timeKey,
} from '../filters/page.ts'
import {
  type PermissionsEnv,
  requirePermission,
  requireStandalone,
} from '../middleware/permissions.ts'

// Список организаций (тикет crm-deals/12): `GET /v1/organizations/list` — страница с фильтром,
// сортировкой (name|createdAt|updatedAt, по умолчанию name:asc) и курсором,
// `GET /v1/organizations/count`, `GET /v1/organizations/export.csv` (право export). Охвата у
// организаций нет; организации в корзине не показываются.

export interface OrganizationListItem {
  id: string
  name: string
  address: string | null
  website: string | null
  createdAt: string
  updatedAt: string
}

export interface OrganizationListPage {
  items: OrganizationListItem[]
  nextCursor: string | null
}

type OrganizationSort = ListSort<'organizations'>
const DEFAULT_SORT: OrganizationSort = { column: 'name', direction: 'asc' }

const SORT_KEYS: Record<OrganizationSort['column'], SortKey> = {
  name: textKey('organization.name'),
  createdAt: timeKey('organization.created_at'),
  updatedAt: timeKey('organization.updated_at'),
}

export interface OrganizationListQuery {
  filter: FilterGroup | undefined
  sort: OrganizationSort
  cursor?: PagePosition
  limit: number
}

type Result<T> = Outcome<T, 'INVALID_ORGANIZATION'>

const invalid = (path: string, message?: string) =>
  refuse(400, 'INVALID_ORGANIZATION', { path, ...(message ? { message } : {}) })

const sortName = (sort: OrganizationSort) => `${sort.column}:${sort.direction}`

export function readOrganizationListQuery(c: Ctx): Result<OrganizationListQuery> {
  const filter = readFilterParam('organizations', c.req.query('filter'))
  if (!filter.ok) return invalid(filter.path, filter.message)
  const limit = readLimit(c.req.query('limit'))
  if (limit === undefined) return invalid('limit')
  const rawSort = c.req.query('sort')
  const sort = rawSort === undefined ? DEFAULT_SORT : parseSort('organizations', rawSort)
  if (!sort) return invalid('sort')
  const rawCursor = c.req.query('cursor')
  const cursor =
    rawCursor === undefined
      ? undefined
      : decodePageCursor(rawCursor, sortName(sort), SORT_KEYS[sort.column].cast)
  if (rawCursor !== undefined && cursor === undefined) return invalid('cursor')
  return ok({ filter: filter.filter, sort, limit, ...(cursor ? { cursor } : {}) })
}

function baseQuery(db: Kysely<Database>, actorId: string, filter: FilterGroup | undefined) {
  let query = db.selectFrom('organization').where('organization.deleted_at', 'is', null)
  if (filter !== undefined) query = query.where(compileFilter('organizations', filter, { actorId }))
  return query
}

export async function listOrganizationsPage(
  db: Kysely<Database>,
  actorId: string,
  { filter, sort, cursor, limit }: OrganizationListQuery,
): Promise<OrganizationListPage> {
  const key = SORT_KEYS[sort.column]
  let query = baseQuery(db, actorId, filter)
    .select([
      'organization.id',
      'organization.name',
      'organization.address',
      'organization.website',
      'organization.created_at',
      'organization.updated_at',
    ])
    .select(key.text.as('sort_value'))
    .orderBy(key.order, sort.direction)
    .orderBy('organization.id', sort.direction)
    .limit(limit + 1)
  if (cursor) query = query.where(afterPosition(key, sort.direction, 'organization.id', cursor))
  const rows = await query.execute()
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    items: page.map((row) => ({
      id: row.id,
      name: row.name,
      address: row.address,
      website: row.website,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    })),
    nextCursor:
      rows.length > limit && last
        ? encodePageCursor(sortName(sort), { v: last.sort_value, id: last.id })
        : null,
  }
}

export async function countOrganizations(
  db: Kysely<Database>,
  actorId: string,
  filter: FilterGroup | undefined,
): Promise<ListCount> {
  return countRows(db, baseQuery(db, actorId, filter).select('organization.id'))
}

function organizationCell(item: OrganizationListItem, column: string): CsvValue {
  switch (column) {
    case 'name':
      return item.name
    case 'address':
      return item.address
    case 'website':
      return item.website
    case 'createdAt':
      return item.createdAt
    case 'updatedAt':
      return item.updatedAt
    default:
      return null
  }
}

/** `GET /v1/organizations/export.csv`: порции — каждая в своей транзакции проекта. */
export async function exportOrganizations(c: Ctx, rootDb: Kysely<Database>): Promise<Response> {
  const query = readOrganizationListQuery(c)
  if (!query.ok) return fail(c, query)
  const chosen = readColumns('organizations', c.req.query('columns'))
  if (!chosen) return fail(c, invalid('columns'))
  const lang = readLanguage(c.req.query('lang'))
  if (!lang) return fail(c, invalid('lang'))
  const columns: readonly string[] = chosen
  const language: ExportLanguage = lang
  const { filter, sort, cursor: start } = query.value
  const projectId = c.get('projectId')
  const actorId = c.get('session').user.id
  await recordInRequest(c, {
    action: 'export.downloaded',
    details: {
      list: 'organizations',
      columns,
      sort: sortName(sort),
      ...(filter ? { filter } : {}),
    },
  })
  async function* rows(): AsyncGenerator<string> {
    yield UTF8_BOM + csvHeader(columns, language)
    let cursor = start
    while (true) {
      const page = await withProject(rootDb, projectId, (trx) =>
        listOrganizationsPage(trx, actorId, {
          filter,
          sort,
          limit: EXPORT_BATCH,
          ...(cursor ? { cursor } : {}),
        }),
      )
      if (page.items.length > 0) {
        yield page.items
          .map((item) => csvRow(columns.map((column) => organizationCell(item, column))))
          .join('')
      }
      if (page.nextCursor === null) return
      cursor = decodePageCursor(page.nextCursor, sortName(sort), SORT_KEYS[sort.column].cast)
      if (!cursor) throw new Error('выгрузка: курсор своей же страницы не разобрался')
    }
  }
  return csvResponse(exportFilename('organizations'), rows())
}

/** Маршруты списка организаций: `/v1/organizations/list`, `/count`, `/export.csv`. */
export function organizationListRoutes(rootDb: Kysely<Database>) {
  const view = requirePermission('organizations', 'view')
  return new Hono<PermissionsEnv>()
    .get('/list', view, async (c) => {
      const query = readOrganizationListQuery(c)
      if (!query.ok) return fail(c, query)
      return c.json<OrganizationListPage>(
        await listOrganizationsPage(c.get('db'), c.get('session').user.id, query.value),
      )
    })
    .get('/count', view, async (c) => {
      const query = readOrganizationListQuery(c)
      if (!query.ok) return fail(c, query)
      return c.json<ListCount>(
        await countOrganizations(c.get('db'), c.get('session').user.id, query.value.filter),
      )
    })
    .get('/export.csv', view, requireStandalone('export'), (c) => exportOrganizations(c, rootDb))
}
