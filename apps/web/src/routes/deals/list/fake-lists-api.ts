import {
  type FilterEntity,
  type FilterGroup,
  type FilterNode,
  fullPermissions,
  groupParts,
  isFilterGroup,
  mentionsField,
  type PipelineSummary,
  type RolePermissions,
  type SavedFilterSummary,
} from '@alpi/shared'
import {
  type BulkJob,
  type BulkStart,
  type ContactRow,
  type DealRow,
  type ListOwner,
  type ListRows,
  type ListsApi,
  ListsApiError,
  type OrganizationRow,
  type TrashItem,
} from './lists-api.ts'

// Подставной клиент списков для тестов: данные в памяти, фильтр и сортировка — как у API
// (настолько, насколько нужно тестам экранов), журнал вызовов, массовая операция идёт порциями
// при каждом опросе прогресса.

export const LIST_ME: ListOwner = { id: 'user-1', name: 'Власник' }
export const LIST_COLLEAGUE: ListOwner = { id: 'user-2', name: 'Остап Тестовий' }
export const LIST_PIPELINE = '00000000-0000-4000-9400-000000000001'
export const LIST_STAGE_NEW = '00000000-0000-4000-9400-000000000011'
export const LIST_STAGE_CALL = '00000000-0000-4000-9400-000000000012'

const PIPELINES: PipelineSummary[] = [
  {
    id: LIST_PIPELINE,
    code: 'alpi',
    name: 'ALPI',
    position: 1,
    isUpsell: false,
    archivedAt: null,
    stages: [
      { id: LIST_STAGE_NEW, pipelineId: LIST_PIPELINE, name: 'Новий лід', position: 1 },
      { id: LIST_STAGE_CALL, pipelineId: LIST_PIPELINE, name: 'Дзвінок', position: 2 },
    ],
  },
]

let counter = 0
const nextId = (prefix: string) => {
  counter += 1
  return `00000000-0000-4000-${prefix}-${String(counter).padStart(12, '0')}`
}

export function fakeDealRow(fields: Partial<DealRow> = {}): DealRow {
  return {
    id: nextId('9500'),
    title: 'Угода',
    pipelineId: LIST_PIPELINE,
    stageId: LIST_STAGE_NEW,
    amount: 0,
    currency: 'EUR',
    ownerId: LIST_ME.id,
    ownerName: LIST_ME.name,
    status: 'open',
    primaryContactId: nextId('9600'),
    contactName: 'Ірина Вигадана',
    stageChangedAt: '2026-11-01T10:00:00.000000Z',
    organizationId: null,
    organizationName: null,
    lostReasonId: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    wonAt: null,
    lostAt: null,
    archivedAt: null,
    ...fields,
  }
}

export function fakeContactRow(fields: Partial<ContactRow> = {}): ContactRow {
  return {
    id: nextId('9700'),
    firstName: 'Ірина',
    lastName: 'Вигадана',
    phone: '+380671234567',
    email: null,
    organizationId: null,
    organizationName: null,
    language: null,
    possibleDuplicate: false,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    ...fields,
  }
}

export function fakeOrganizationRow(fields: Partial<OrganizationRow> = {}): OrganizationRow {
  return {
    id: nextId('9800'),
    name: 'ТОВ Вигадка',
    address: null,
    website: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    ...fields,
  }
}

export interface FakeListsCall {
  method: string
  entity?: string
  value?: unknown
}

export interface FakeListsApi extends ListsApi {
  rows: { deals: DealRow[]; contacts: ContactRow[]; organizations: OrganizationRow[] }
  saved: SavedFilterSummary[]
  trashItems: TrashItem[]
  calls: FakeListsCall[]
  permissions: RolePermissions
  /** Размер страницы списка (курсор — смещение). */
  pageSize: number
  /** Сколько записей массовая операция обрабатывает за один опрос. */
  bulkStep: number
  /** Следующий вызов, меняющий данные, отклоняется этим отказом. */
  failNext: ListsApiError | null
}

/** Значение строки для поля фильтра. */
function fieldValue(entity: FilterEntity, row: Record<string, unknown>, field: string): unknown {
  if (entity === 'deals') {
    const map: Record<string, unknown> = {
      pipeline: row.pipelineId,
      stage: row.stageId,
      owner: row.ownerId,
      archived: row.archivedAt !== null,
      lostReason: row.lostReasonId,
      organization: row.organizationId,
    }
    if (field in map) return map[field]
  }
  if (entity === 'contacts' && field === 'name') {
    return [row.firstName, row.lastName].filter(Boolean).join(' ')
  }
  if (entity === 'contacts' && field === 'organization') return row.organizationId
  return row[field]
}

/** Подходит ли строка под фильтр (подставные клиенты списка и канбана). */
export function matchesFilter(
  entity: FilterEntity,
  row: Record<string, unknown>,
  node: FilterNode,
): boolean {
  if (isFilterGroup(node)) {
    const { op, items } = groupParts(node)
    if (items.length === 0) return true
    return op === 'and'
      ? items.every((item) => matchesFilter(entity, row, item))
      : items.some((item) => matchesFilter(entity, row, item))
  }
  const value = fieldValue(entity, row, node.field)
  const target = node.value === 'me' ? LIST_ME.id : node.value
  switch (node.op) {
    case 'eq':
      return value === target
    case 'neq':
      return value !== target
    case 'in':
      return Array.isArray(target) && target.includes(value as string)
    case 'not_in':
      return Array.isArray(target) && !target.includes(value as string)
    case 'lt':
      return String(value) < String(target)
    case 'lte':
      return String(value) <= String(target)
    case 'gt':
      return String(value) > String(target)
    case 'gte':
      return String(value) >= String(target)
    case 'contains':
      return String(value ?? '')
        .toLowerCase()
        .includes(String(target).toLowerCase())
    case 'empty':
      return value === null || value === undefined
    case 'not_empty':
      return value !== null && value !== undefined
  }
}

export function fakeListsApi(
  initial: Partial<FakeListsApi['rows']> = {},
  permissions: RolePermissions = fullPermissions(),
): FakeListsApi {
  const jobs = new Map<string, BulkJob & { ids: string[]; params: Record<string, unknown> }>()
  const api: FakeListsApi = {
    rows: { deals: [], contacts: [], organizations: [], ...initial },
    saved: [],
    trashItems: [],
    calls: [],
    permissions,
    pageSize: 50,
    bulkStep: 1000,
    failNext: null,

    async access() {
      return { userId: LIST_ME.id, permissions: api.permissions }
    },
    async pipelines() {
      return PIPELINES
    },
    async owners() {
      return [LIST_ME, LIST_COLLEAGUE]
    },
    async lostReasons() {
      return []
    },
    async page<E extends FilterEntity>(
      _projectId: string,
      entity: E,
      query: {
        filter: FilterGroup
        sort: string
        cursor?: string
      },
    ) {
      api.calls.push({ method: 'page', entity, value: query })
      const [column = '', direction] = query.sort.split(':')
      const filter =
        entity === 'deals' && !mentionsField(query.filter, 'archived')
          ? { and: [query.filter, { field: 'archived', op: 'eq' as const, value: false }] }
          : query.filter
      const rows = (api.rows[entity] as unknown as Record<string, unknown>[])
        .filter((row) => matchesFilter(entity, row, filter))
        .sort((a, b) => {
          const left = String(a[column] ?? '')
          const right = String(b[column] ?? '')
          const order =
            typeof a[column] === 'number'
              ? (a[column] as number) - (b[column] as number)
              : left.localeCompare(right)
          return direction === 'desc' ? -order : order
        })
      const start = query.cursor === undefined ? 0 : Number(query.cursor)
      const next = start + api.pageSize
      return {
        items: rows.slice(start, next) as unknown as ListRows[E][],
        nextCursor: next < rows.length ? String(next) : null,
      }
    },
    async count(projectId, entity, filter) {
      const size = api.pageSize
      api.pageSize = Number.MAX_SAFE_INTEGER
      const page = await api.page(projectId, entity, { filter, sort: 'id:asc' })
      api.pageSize = size
      api.calls.pop()
      return { count: page.items.length, approximate: false }
    },
    async exportCsv(_projectId, entity, query) {
      api.calls.push({ method: 'exportCsv', entity, value: query })
      return new Blob(['\uFEFF'])
    },
    async savedFilters(_projectId, entity) {
      return api.saved.filter((f) => f.entity === entity)
    },
    async saveFilter(_projectId, input) {
      api.calls.push({ method: 'saveFilter', value: input })
      if (api.failNext) {
        const error = api.failNext
        api.failNext = null
        throw error
      }
      const saved: SavedFilterSummary = {
        id: nextId('9900'),
        ...input,
        teamId: null,
        ownerId: LIST_ME.id,
        canDelete: true,
        createdAt: new Date().toISOString(),
      }
      api.saved.push(saved)
      return saved
    },
    async deleteFilter(_projectId, id) {
      api.saved = api.saved.filter((f) => f.id !== id)
    },
    async startBulk(projectId, input: BulkStart) {
      api.calls.push({ method: 'startBulk', value: input })
      if (api.failNext) {
        const error = api.failNext
        api.failNext = null
        throw error
      }
      let ids: string[]
      if ('ids' in input.selection) ids = input.selection.ids
      else {
        const size = api.pageSize
        api.pageSize = Number.MAX_SAFE_INTEGER
        const all = await api.page(projectId, 'deals', {
          filter: input.selection.filter,
          sort: 'id:asc',
        })
        api.pageSize = size
        api.calls.pop()
        ids = all.items.map((d) => d.id)
      }
      const job = {
        id: nextId('9a00'),
        action: input.action,
        status: 'queued' as const,
        total: ids.length,
        processed: 0,
        failed: 0,
        failure: null,
        errors: [],
        ids,
        params: input.params ?? {},
      }
      jobs.set(job.id, job)
      return job
    },
    async bulkJob(_projectId, id) {
      const job = jobs.get(id)
      if (!job) throw new ListsApiError(404, 'BULK_JOB_NOT_FOUND')
      const portion = job.ids.slice(job.processed, job.processed + api.bulkStep)
      for (const dealId of portion) {
        const deal = api.rows.deals.find((d) => d.id === dealId)
        if (!deal) continue
        if (job.action === 'deals.archive') deal.archivedAt = new Date().toISOString()
        if (job.action === 'deals.unarchive') deal.archivedAt = null
      }
      job.processed += portion.length
      job.status = job.processed >= job.ids.length ? 'done' : 'running'
      return { ...job }
    },
    async trash(_projectId, type) {
      return { items: api.trashItems.filter((item) => item.type === type), nextCursor: null }
    },
    async restore(_projectId, type, id) {
      api.calls.push({ method: 'restore', entity: type, value: id })
      if (api.failNext) {
        const error = api.failNext
        api.failNext = null
        throw error
      }
      api.trashItems = api.trashItems.filter((item) => item.id !== id)
    },
    async purge(_projectId, type, id) {
      api.calls.push({ method: 'purge', entity: type, value: id })
      api.trashItems = api.trashItems.filter((item) => item.id !== id)
    },
  }
  return api
}
