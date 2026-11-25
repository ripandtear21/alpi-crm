import { type Database, withProject } from '@alpi/db'
import {
  type FilterGroup,
  type ListCount,
  type ListSort,
  parseSort,
  type RolePermissions,
  type Scope,
} from '@alpi/shared'
import { Hono } from 'hono'
import { type Kysely, sql } from 'kysely'
import { recordInRequest } from '../audit/record.ts'
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
import { type CustomValues, visibleCustom } from '../fields/values.ts'
import { compileFilter, readFilterParam } from '../filters/compile.ts'
import {
  afterPosition,
  countRows,
  decodePageCursor,
  encodePageCursor,
  type PagePosition,
  type SortKey,
  timeKey,
} from '../filters/page.ts'
import {
  type PermissionsEnv,
  requirePermission,
  requireStandalone,
} from '../middleware/permissions.ts'
import { PROJECT_TEAMS, resolveViewer, type Viewer } from '../roles/scope.ts'
import { type Ctx, fail, type Outcome, ok, readLimit, refuse } from './http.ts'
import { contactScopePredicate } from './scope.ts'

// Список контактов (тикет crm-deals/12): `GET /v1/contacts/list` — страница с фильтром
// (filter=<JSON>, поля FILTER_FIELDS.contacts), сортировкой (sort=name|createdAt|updatedAt:
// asc|desc, по умолчанию createdAt:desc) и курсором; `GET /v1/contacts/count` — счётчик;
// `GET /v1/contacts/export.csv` — выгрузка (право export). Охват — охват чтения контактов
// (contacts/scope.ts), контакты в корзине не показываются. Прежний `GET /v1/contacts`
// (подсказки и карточки) не меняется.

/** Строка списка контактов. */
export interface ContactListItem {
  id: string
  firstName: string
  lastName: string | null
  /** Основной телефон (E.164) или первый; null — телефонов нет. */
  phone: string | null
  email: string | null
  organizationId: string | null
  /** null — организации нет или она в корзине. */
  organizationName: string | null
  language: string | null
  possibleDuplicate: boolean
  /** Значения пользовательских полей по коду (fields/values.ts). */
  custom: CustomValues
  createdAt: string
  updatedAt: string
}

export interface ContactListPage {
  items: ContactListItem[]
  nextCursor: string | null
}

type ContactSort = ListSort<'contacts'>
const DEFAULT_SORT: ContactSort = { column: 'createdAt', direction: 'desc' }

const SORT_KEYS: Record<ContactSort['column'], SortKey> = {
  name: {
    order: sql`concat_ws(' ', contact.first_name, contact.last_name)`,
    text: sql<string>`concat_ws(' ', contact.first_name, contact.last_name)`,
    cast: 'text',
  },
  createdAt: timeKey('contact.created_at'),
  updatedAt: timeKey('contact.updated_at'),
}

/** Кто смотрит список. */
export interface ContactListContext {
  db: Kysely<Database>
  projectId: string
  actorId: string
  /** Охват чтения контактов. */
  scope: Scope
  viewer: Viewer
  /** Права роли: какие группы полей видны (fields/access.ts). */
  permissions: RolePermissions
}

export interface ContactListQuery {
  filter: FilterGroup | undefined
  sort: ContactSort
  cursor?: PagePosition
  limit: number
}

type Result<T> = Outcome<T, 'INVALID_CONTACT'>

const invalid = (path: string, message?: string) =>
  refuse(400, 'INVALID_CONTACT', { path, ...(message ? { message } : {}) })

const sortName = (sort: ContactSort) => `${sort.column}:${sort.direction}`

export async function contactListContext(c: Ctx): Promise<ContactListContext> {
  const db = c.get('db')
  const actorId = c.get('session').user.id
  return {
    db,
    projectId: c.get('projectId'),
    actorId,
    scope: c.get('access').permissions.scopes.contacts.read,
    viewer: await resolveViewer(db, actorId, PROJECT_TEAMS),
    permissions: c.get('access').permissions,
  }
}

export function readContactListQuery(c: Ctx): Result<ContactListQuery> {
  const filter = readFilterParam('contacts', c.req.query('filter'))
  if (!filter.ok) return invalid(filter.path, filter.message)
  const limit = readLimit(c.req.query('limit'))
  if (limit === undefined) return invalid('limit')
  const rawSort = c.req.query('sort')
  const sort = rawSort === undefined ? DEFAULT_SORT : parseSort('contacts', rawSort)
  if (!sort) return invalid('sort')
  const rawCursor = c.req.query('cursor')
  const cursor =
    rawCursor === undefined
      ? undefined
      : decodePageCursor(rawCursor, sortName(sort), SORT_KEYS[sort.column].cast)
  if (rawCursor !== undefined && cursor === undefined) return invalid('cursor')
  return ok({ filter: filter.filter, sort, limit, ...(cursor ? { cursor } : {}) })
}

/** Контакты в охвате, не в корзине, по фильтру. */
function baseQuery(ctx: ContactListContext, filter: FilterGroup | undefined) {
  let query = ctx.db
    .selectFrom('contact')
    .where('contact.deleted_at', 'is', null)
    .where((eb) => contactScopePredicate(eb, ctx.scope, ctx.viewer))
  if (filter !== undefined) {
    query = query.where(compileFilter('contacts', filter, { actorId: ctx.actorId }))
  }
  return query
}

export async function listContactsPage(
  ctx: ContactListContext,
  { filter, sort, cursor, limit }: ContactListQuery,
): Promise<ContactListPage> {
  const key = SORT_KEYS[sort.column]
  let query = baseQuery(ctx, filter)
    .select([
      'contact.id',
      'contact.first_name',
      'contact.last_name',
      'contact.organization_id',
      'contact.language',
      'contact.possible_duplicate',
      'contact.custom',
      'contact.created_at',
      'contact.updated_at',
    ])
    .select(key.text.as('sort_value'))
    .orderBy(key.order, sort.direction)
    .orderBy('contact.id', sort.direction)
    .limit(limit + 1)
  if (cursor) {
    query = query.where(afterPosition(key, sort.direction, 'contact.id', cursor))
  }
  const rows = await query.execute()
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  const nextCursor =
    rows.length > limit && last
      ? encodePageCursor(sortName(sort), { v: last.sort_value, id: last.id })
      : null
  const ids = page.map((row) => row.id)
  const firstOf = async (table: 'contact_phone' | 'contact_email', column: 'phone' | 'email') => {
    if (ids.length === 0) return new Map<string, string>()
    // Основной — первым, дальше по алфавиту: та же очередь, что в карточке контакта.
    const keys = await ctx.db
      .selectFrom(table)
      .select(['contact_id', sql<string>`${sql.ref(column)}`.as('key')])
      .where('contact_id', 'in', ids)
      .orderBy('contact_id')
      .orderBy('is_primary', 'desc')
      .orderBy(sql.ref(column))
      .execute()
    const first = new Map<string, string>()
    for (const row of keys) if (!first.has(row.contact_id)) first.set(row.contact_id, row.key)
    return first
  }
  const [phones, emails] = await Promise.all([
    firstOf('contact_phone', 'phone'),
    firstOf('contact_email', 'email'),
  ])
  const organizationIds = [
    ...new Set(page.flatMap((row) => (row.organization_id ? [row.organization_id] : []))),
  ]
  const organizations = new Map(
    organizationIds.length === 0
      ? []
      : (
          await ctx.db
            .selectFrom('organization')
            .select(['id', 'name'])
            .where('id', 'in', organizationIds)
            .where('deleted_at', 'is', null)
            .execute()
        ).map((row) => [row.id, row.name]),
  )
  const custom = await visibleCustom(
    ctx,
    'contact',
    page.map((row) => row.custom),
  )
  return {
    items: page.map((row, index) => ({
      id: row.id,
      firstName: row.first_name,
      lastName: row.last_name,
      phone: phones.get(row.id) ?? null,
      email: emails.get(row.id) ?? null,
      organizationId: row.organization_id,
      organizationName:
        row.organization_id === null ? null : (organizations.get(row.organization_id) ?? null),
      language: row.language,
      possibleDuplicate: row.possible_duplicate,
      custom: custom[index] ?? {},
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    })),
    nextCursor,
  }
}

export async function countContacts(
  ctx: ContactListContext,
  filter: FilterGroup | undefined,
): Promise<ListCount> {
  return countRows(ctx.db, baseQuery(ctx, filter).select('contact.id'))
}

const LANGUAGE_LABELS: Record<ExportLanguage, Record<string, string>> = {
  uk: { uk: 'Українська', ru: 'Російська' },
  ru: { uk: 'Украинский', ru: 'Русский' },
}

function contactCell(item: ContactListItem, column: string, language: ExportLanguage): CsvValue {
  switch (column) {
    case 'name':
      return [item.firstName, item.lastName].filter(Boolean).join(' ')
    case 'phone':
      return item.phone
    case 'email':
      return item.email
    case 'organization':
      return item.organizationName
    case 'language':
      return item.language === null ? null : (LANGUAGE_LABELS[language][item.language] ?? null)
    case 'possibleDuplicate':
      return item.possibleDuplicate
    case 'createdAt':
      return item.createdAt
    case 'updatedAt':
      return item.updatedAt
    default:
      return null
  }
}

/** `GET /v1/contacts/export.csv`: как у сделок (export/deals.ts), порции — в своих транзакциях. */
export async function exportContacts(c: Ctx, rootDb: Kysely<Database>): Promise<Response> {
  const ctx = await contactListContext(c)
  const query = readContactListQuery(c)
  if (!query.ok) return fail(c, query)
  const chosen = readColumns('contacts', c.req.query('columns'))
  if (!chosen) return fail(c, invalid('columns'))
  const lang = readLanguage(c.req.query('lang'))
  if (!lang) return fail(c, invalid('lang'))
  const columns: readonly string[] = chosen
  const language: ExportLanguage = lang
  const { filter, sort, cursor: start } = query.value
  await recordInRequest(c, {
    action: 'export.downloaded',
    details: { list: 'contacts', columns, sort: sortName(sort), ...(filter ? { filter } : {}) },
  })
  async function* rows(): AsyncGenerator<string> {
    yield UTF8_BOM + csvHeader(columns, language)
    let cursor = start
    while (true) {
      const page = await withProject(rootDb, ctx.projectId, (trx) =>
        listContactsPage(
          { ...ctx, db: trx },
          { filter, sort, limit: EXPORT_BATCH, ...(cursor ? { cursor } : {}) },
        ),
      )
      if (page.items.length > 0) {
        yield page.items
          .map((item) => csvRow(columns.map((column) => contactCell(item, column, language))))
          .join('')
      }
      if (page.nextCursor === null) return
      cursor = decodePageCursor(page.nextCursor, sortName(sort), SORT_KEYS[sort.column].cast)
      if (!cursor) throw new Error('выгрузка: курсор своей же страницы не разобрался')
    }
  }
  return csvResponse(exportFilename('contacts'), rows())
}

/**
 * Маршруты списка контактов: `/v1/contacts/list`, `/count`, `/export.csv`. Монтируются до
 * contactsRoutes, иначе `list` разобрался бы как id контакта. `rootDb` — для порций выгрузки.
 */
export function contactListRoutes(rootDb: Kysely<Database>) {
  const view = requirePermission('contacts', 'view')
  return new Hono<PermissionsEnv>()
    .get('/list', view, async (c) => {
      const query = readContactListQuery(c)
      if (!query.ok) return fail(c, query)
      return c.json<ContactListPage>(
        await listContactsPage(await contactListContext(c), query.value),
      )
    })
    .get('/count', view, async (c) => {
      const query = readContactListQuery(c)
      if (!query.ok) return fail(c, query)
      return c.json<ListCount>(await countContacts(await contactListContext(c), query.value.filter))
    })
    .get('/export.csv', view, requireStandalone('export'), (c) => exportContacts(c, rootDb))
}
