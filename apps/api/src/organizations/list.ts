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
import {
  type CustomNames,
  customCell,
  customColumnField,
  customHeaders,
  loadCustomNames,
} from '../export/custom.ts'
import type { FieldViewer } from '../fields/access.ts'
import { type CustomValues, visibleCustom } from '../fields/values.ts'
import { compileFilter, readFilterParam } from '../filters/compile.ts'
import { type CatalogField, catalogFor, listSortKey, unknownCustomSort } from '../filters/custom.ts'
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
  /** Значения пользовательских полей по коду (fields/values.ts). */
  custom: CustomValues
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
  /** Пользовательские поля, которые видит пользователь (filters/custom.ts). */
  custom: readonly CatalogField[]
  sort: OrganizationSort
  cursor?: PagePosition
  limit: number
}

type Result<T> = Outcome<T, 'INVALID_ORGANIZATION' | 'CUSTOM_FIELD_UNKNOWN'>

const invalid = (path: string, message?: string) =>
  refuse(400, 'INVALID_ORGANIZATION', { path, ...(message ? { message } : {}) })
const unknownField = (field: string) => refuse(422, 'CUSTOM_FIELD_UNKNOWN', { field })

const sortName = (sort: OrganizationSort) => `${sort.column}:${sort.direction}`

const sortKey = (sort: OrganizationSort, custom: readonly CatalogField[]) =>
  listSortKey(sort.column, SORT_KEYS, 'organization', custom)

export async function readOrganizationListQuery(c: Ctx): Promise<Result<OrganizationListQuery>> {
  const custom = await catalogFor(
    c.get('db'),
    c.get('access').permissions,
    'organization',
    c.req.query('filter'),
    c.req.query('sort'),
    c.req.query('columns'),
  )
  const filter = readFilterParam('organizations', c.req.query('filter'), custom)
  if (!filter.ok) {
    if (filter.unknownCustomField !== undefined) return unknownField(filter.unknownCustomField)
    return invalid(filter.path, filter.message)
  }
  const limit = readLimit(c.req.query('limit'))
  if (limit === undefined) return invalid('limit')
  const rawSort = c.req.query('sort')
  const sort = rawSort === undefined ? DEFAULT_SORT : parseSort('organizations', rawSort, custom)
  if (!sort) {
    const unknown = rawSort === undefined ? null : unknownCustomSort(rawSort, custom)
    return unknown === null ? invalid('sort') : unknownField(unknown)
  }
  const rawCursor = c.req.query('cursor')
  const cursor =
    rawCursor === undefined
      ? undefined
      : decodePageCursor(rawCursor, sortName(sort), sortKey(sort, custom).cast)
  if (rawCursor !== undefined && cursor === undefined) return invalid('cursor')
  return ok({ filter: filter.filter, custom, sort, limit, ...(cursor ? { cursor } : {}) })
}

function baseQuery(
  db: Kysely<Database>,
  actorId: string,
  filter: FilterGroup | undefined,
  custom: readonly CatalogField[],
) {
  let query = db.selectFrom('organization').where('organization.deleted_at', 'is', null)
  if (filter !== undefined) {
    query = query.where(compileFilter('organizations', filter, { actorId, custom }))
  }
  return query
}

export async function listOrganizationsPage(
  viewer: FieldViewer,
  actorId: string,
  { filter, custom: catalog, sort, cursor, limit }: OrganizationListQuery,
): Promise<OrganizationListPage> {
  const key = sortKey(sort, catalog)
  const { db } = viewer
  let query = baseQuery(db, actorId, filter, catalog)
    .select([
      'organization.id',
      'organization.name',
      'organization.address',
      'organization.website',
      'organization.custom',
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
  const custom = await visibleCustom(
    viewer,
    'organization',
    page.map((row) => row.custom),
  )
  return {
    items: page.map((row, index) => ({
      id: row.id,
      name: row.name,
      address: row.address,
      website: row.website,
      custom: custom[index] ?? {},
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
  { filter, custom }: Pick<OrganizationListQuery, 'filter' | 'custom'>,
): Promise<ListCount> {
  return countRows(db, baseQuery(db, actorId, filter, custom).select('organization.id'))
}

function organizationCell(
  item: OrganizationListItem,
  column: string,
  language: ExportLanguage,
  custom: { fields: readonly CatalogField[]; names: CustomNames },
): CsvValue {
  const field = customColumnField(column, custom.fields)
  if (field) return customCell(field, item.custom[field.code], custom.names, language)
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
  const query = await readOrganizationListQuery(c)
  if (!query.ok) return fail(c, query)
  const { filter, custom: catalog, sort, cursor: start } = query.value
  const chosen = readColumns('organizations', c.req.query('columns'), catalog)
  if (!chosen.ok) {
    return fail(
      c,
      chosen.unknownCustomField === undefined
        ? invalid('columns')
        : unknownField(chosen.unknownCustomField),
    )
  }
  const lang = readLanguage(c.req.query('lang'))
  if (!lang) return fail(c, invalid('lang'))
  const columns: readonly string[] = chosen.columns
  const language: ExportLanguage = lang
  const customFields = catalog.filter((field) => columns.includes(`custom.${field.id}`))
  const projectId = c.get('projectId')
  const actorId = c.get('session').user.id
  const { permissions } = c.get('access')
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
    yield UTF8_BOM + csvHeader(columns, language, customHeaders(columns, catalog, language))
    let cursor = start
    while (true) {
      const { page, names } = await withProject(rootDb, projectId, async (trx) => {
        const page = await listOrganizationsPage({ db: trx, permissions }, actorId, {
          filter,
          custom: catalog,
          sort,
          limit: EXPORT_BATCH,
          ...(cursor ? { cursor } : {}),
        })
        const values = page.items.map((item) => item.custom)
        return { page, names: await loadCustomNames(trx, customFields, values) }
      })
      const custom = { fields: customFields, names }
      if (page.items.length > 0) {
        yield page.items
          .map((item) =>
            csvRow(columns.map((column) => organizationCell(item, column, language, custom))),
          )
          .join('')
      }
      if (page.nextCursor === null) return
      cursor = decodePageCursor(page.nextCursor, sortName(sort), sortKey(sort, catalog).cast)
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
      const query = await readOrganizationListQuery(c)
      if (!query.ok) return fail(c, query)
      return c.json<OrganizationListPage>(
        await listOrganizationsPage(
          { db: c.get('db'), permissions: c.get('access').permissions },
          c.get('session').user.id,
          query.value,
        ),
      )
    })
    .get('/count', view, async (c) => {
      const query = await readOrganizationListQuery(c)
      if (!query.ok) return fail(c, query)
      return c.json<ListCount>(
        await countOrganizations(c.get('db'), c.get('session').user.id, query.value),
      )
    })
    .get('/export.csv', view, requireStandalone('export'), (c) => exportOrganizations(c, rootDb))
}
