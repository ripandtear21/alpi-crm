import type {
  FieldDefinitionSummary,
  FieldEntity,
  FilterEntity,
  FilterGroup,
  ListCount,
  LostReasonGroupSummary,
  Page,
  PipelineSummary,
  ProjectAccess,
  SavedFilterSummary,
  SavedFilterVisibility,
} from '@alpi/shared'
import { readPage } from '@alpi/shared'
import { projectHeaders } from '../../../components/project-switcher/projects-api.ts'
import type { CustomValues } from './custom-values.ts'

// Запросы списков сделок, контактов и организаций (тикет crm-deals/12) к API: страницы с
// фильтром, сортировкой и курсором, счётчик, выгрузка CSV, сохранённые фильтры, массовые
// операции и корзина. Всё — `/api/v1/...` в контексте проекта; отказ — ListsApiError с кодом.

/** Строка списка сделок (apps/api/src/deals/board.ts, BoardDeal). */
export interface DealRow {
  id: string
  title: string
  pipelineId: string
  stageId: string
  amount: number
  currency: string
  ownerId: string | null
  ownerName: string | null
  status: 'open' | 'won' | 'lost'
  primaryContactId: string
  contactName: string | null
  stageChangedAt: string
  organizationId: string | null
  organizationName: string | null
  lostReasonId: string | null
  createdAt: string
  wonAt: string | null
  lostAt: string | null
  archivedAt: string | null
  /** Значения видимых пользователю пользовательских полей (тикет crm-fields/07). */
  custom?: CustomValues
}

/** Строка списка контактов (apps/api/src/contacts/list.ts). */
export interface ContactRow {
  id: string
  firstName: string
  lastName: string | null
  phone: string | null
  email: string | null
  organizationId: string | null
  organizationName: string | null
  language: string | null
  possibleDuplicate: boolean
  createdAt: string
  updatedAt: string
  custom?: CustomValues
}

/** Строка списка организаций (apps/api/src/organizations/list.ts). */
export interface OrganizationRow {
  id: string
  name: string
  address: string | null
  website: string | null
  createdAt: string
  updatedAt: string
  custom?: CustomValues
}

export interface ListRows {
  deals: DealRow
  contacts: ContactRow
  organizations: OrganizationRow
}

export interface ListPage<Row> {
  items: Row[]
  nextCursor: string | null
}

export interface ListQuery {
  filter: FilterGroup
  /** `<колонка>:<asc|desc>`. */
  sort: string
  cursor?: string
}

export interface ExportQuery {
  filter: FilterGroup
  sort: string
  columns: readonly string[]
  lang: 'uk' | 'ru'
}

export interface SaveFilterInput {
  entity: FilterEntity
  name: string
  visibility: SavedFilterVisibility
  filter: FilterGroup
}

export interface ListOwner {
  id: string
  name: string
}

/** Массовая операция (apps/api/src/bulk/routes.ts). */
export interface BulkJob {
  id: string
  action: string
  status: 'queued' | 'running' | 'done' | 'failed'
  total: number | null
  processed: number
  failed: number
  failure: string | null
  errors?: { position: number; recordId: string; code: string; message: string | null }[]
}

export interface BulkStart {
  action: string
  selection: { ids: string[] } | { filter: FilterGroup }
  params?: Record<string, unknown>
}

export type TrashType = 'deal' | 'contact' | 'organization'

export interface TrashItem {
  type: TrashType
  id: string
  title: string
  deletedAt: string
  deletedByName: string | null
  purgeAt: string
}

export class ListsApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Record<string, unknown>

  constructor(status: number, code: string, details: Record<string, unknown> = {}) {
    super(`API ответил ${status} ${code}`)
    this.name = 'ListsApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export interface ListsApi {
  access(projectId: string): Promise<ProjectAccess>
  pipelines(projectId: string): Promise<PipelineSummary[]>
  owners(projectId: string): Promise<ListOwner[]>
  lostReasons(projectId: string): Promise<LostReasonGroupSummary[]>
  /** Пользовательские поля сущности, видимые пользователю, без архивных. */
  fields(projectId: string, entity: FieldEntity): Promise<FieldDefinitionSummary[]>
  page<E extends FilterEntity>(
    projectId: string,
    entity: E,
    query: ListQuery,
  ): Promise<ListPage<ListRows[E]>>
  count(projectId: string, entity: FilterEntity, filter: FilterGroup): Promise<ListCount>
  exportCsv(projectId: string, entity: FilterEntity, query: ExportQuery): Promise<Blob>
  savedFilters(projectId: string, entity: FilterEntity): Promise<SavedFilterSummary[]>
  saveFilter(projectId: string, input: SaveFilterInput): Promise<SavedFilterSummary>
  deleteFilter(projectId: string, id: string): Promise<void>
  startBulk(projectId: string, input: BulkStart): Promise<BulkJob>
  bulkJob(projectId: string, id: string): Promise<BulkJob>
  trash(projectId: string, type: TrashType, cursor?: string): Promise<ListPage<TrashItem>>
  restore(projectId: string, type: TrashType, id: string): Promise<void>
  purge(projectId: string, type: TrashType, id: string): Promise<void>
}

/** Размер страницы списка. */
export const LIST_PAGE_SIZE = 50

/** Путь выдачи списка: у сделок — общая выдача канбана и списка, все статусы и архив по фильтру. */
const PAGE_PATH: Record<FilterEntity, string> = {
  deals: '/deals',
  contacts: '/contacts/list',
  organizations: '/organizations/list',
}
const COUNT_PATH: Record<FilterEntity, string> = {
  deals: '/deals/count',
  contacts: '/contacts/count',
  organizations: '/organizations/count',
}
const EXPORT_PATH: Record<FilterEntity, string> = {
  deals: '/deals/export.csv',
  contacts: '/contacts/export.csv',
  organizations: '/organizations/export.csv',
}
const TRASH_PATH: Record<TrashType, string> = {
  deal: '/deals',
  contact: '/contacts',
  organization: '/organizations',
}

/** Параметры статуса и архива сделок: в списке их решает фильтр (архивные скрыты по умолчанию). */
const DEAL_DEFAULTS = { status: 'any', archived: 'any' }

function search(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, value)
  }
  return query.toString()
}

export function createListsApi(fetchImpl: typeof fetch = (...args) => fetch(...args)): ListsApi {
  async function request(
    projectId: string,
    method: string,
    path: string,
    body?: unknown,
    base = '/api/v1',
  ): Promise<Response> {
    const headers = projectHeaders(projectId)
    if (body !== undefined) headers.set('content-type', 'application/json')
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as {
        code?: unknown
        details?: unknown
      } | null
      throw new ListsApiError(
        res.status,
        typeof payload?.code === 'string' ? payload.code : '',
        typeof payload?.details === 'object' && payload.details !== null
          ? (payload.details as Record<string, unknown>)
          : {},
      )
    }
    return res
  }
  const json = async <T>(
    projectId: string,
    method: string,
    path: string,
    body?: unknown,
    base?: string,
  ) => (await (await request(projectId, method, path, body, base)).json()) as T

  const listParams = (entity: FilterEntity, filter: FilterGroup) => ({
    ...(entity === 'deals' ? DEAL_DEFAULTS : {}),
    filter: JSON.stringify(filter),
  })

  return {
    access: (projectId) => json(projectId, 'GET', '/project/access', undefined, '/api'),
    pipelines: (projectId) => json(projectId, 'GET', '/pipelines'),
    owners: (projectId) => json(projectId, 'GET', '/deals/owners'),
    lostReasons: (projectId) => json(projectId, 'GET', '/lost-reasons'),
    fields: (projectId, entity) => json(projectId, 'GET', `/fields?${search({ entity })}`),
    // Страница `/api/v1` — `{ data, next_cursor }` (тикет crm-api/02); экраны держат её как ListPage.
    page: async (projectId, entity, { filter, sort, cursor }) =>
      readPage(
        await json<Page<ListRows[typeof entity]>>(
          projectId,
          'GET',
          `${PAGE_PATH[entity]}?${search({
            ...listParams(entity, filter),
            sort,
            limit: String(LIST_PAGE_SIZE),
            cursor,
          })}`,
        ),
      ),
    count: (projectId, entity, filter) =>
      json(projectId, 'GET', `${COUNT_PATH[entity]}?${search(listParams(entity, filter))}`),
    exportCsv: async (projectId, entity, { filter, sort, columns, lang }) =>
      (
        await request(
          projectId,
          'GET',
          `${EXPORT_PATH[entity]}?${search({
            ...listParams(entity, filter),
            sort,
            columns: columns.join(','),
            lang,
          })}`,
        )
      ).blob(),
    savedFilters: (projectId, entity) =>
      json(projectId, 'GET', `/saved-filters?${search({ entity })}`),
    saveFilter: (projectId, input) => json(projectId, 'POST', '/saved-filters', input),
    deleteFilter: async (projectId, id) => {
      await request(projectId, 'DELETE', `/saved-filters/${id}`)
    },
    startBulk: (projectId, input) => json(projectId, 'POST', '/bulk-jobs', input),
    bulkJob: (projectId, id) => json(projectId, 'GET', `/bulk-jobs/${id}`),
    trash: async (projectId, type, cursor) =>
      readPage(
        await json<Page<TrashItem>>(
          projectId,
          'GET',
          `/trash?${search({ type, cursor, limit: String(LIST_PAGE_SIZE) })}`,
        ),
      ),
    restore: async (projectId, type, id) => {
      await request(projectId, 'POST', `${TRASH_PATH[type]}/${id}/restore`, {})
    },
    purge: async (projectId, type, id) => {
      await request(projectId, 'DELETE', `${TRASH_PATH[type]}/${id}/permanent`)
    },
  }
}
