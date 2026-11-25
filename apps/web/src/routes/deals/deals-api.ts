import type {
  FieldDefinitionSummary,
  FilterGroup,
  KanbanCardFields,
  LostReasonGroupSummary,
  PipelineSummary,
} from '@alpi/shared'
import { projectHeaders } from '../../components/project-switcher/projects-api.ts'

// Запросы канбана к API (apps/api/src/deals): `/api/v1/...` в контексте проекта. Отказ —
// DealsApiError с кодом и подробностями ответа (список полей этапа, «клиент уже в работе у …»).

export const DEAL_CURRENCIES = ['EUR', 'UAH', 'USD'] as const
export type DealCurrency = (typeof DEAL_CURRENCIES)[number]

/** Карточка сделки на канбане (apps/api/src/deals/board.ts, BoardDeal). */
export interface BoardDeal {
  id: string
  title: string
  pipelineId: string
  stageId: string
  amount: number
  currency: DealCurrency
  /** null — общая очередь. */
  ownerId: string | null
  ownerName: string | null
  primaryContactId: string
  /** null — контакт вне охвата контактов пользователя. */
  contactName: string | null
  stageChangedAt: string
  /**
   * Значения полей карточки канбана воронки (до 3, тикет crm-fields/07): выдача канбана
   * отдаёт только их и только видимые пользователю; пустое поле не приходит.
   */
  custom?: Readonly<Record<string, unknown>>
}

export interface DealsPage {
  items: BoardDeal[]
  /** Курсор следующей страницы; null — страниц больше нет. */
  nextCursor: string | null
}

export interface StageAggregate {
  stageId: string
  count: number
  sums: Partial<Record<DealCurrency, number>>
}

export interface PipelineAggregates {
  stages: StageAggregate[]
}

export interface DealOwner {
  id: string
  name: string
}

/** Фильтр ответственного: 'me' — я, 'none' — без ответственного, иначе id участника. */
export type OwnerFilter = 'me' | 'none' | (string & {})

export interface StagePageQuery {
  pipelineId: string
  stageId: string
  owner?: OwnerFilter
  /** Фильтр канбана — тот же формат, что у списка сделок (тикет crm-deals/12). */
  filter?: FilterGroup
  cursor?: string
}

/** Контакт в подсказках формы создания сделки. */
export interface ContactOption {
  id: string
  firstName: string
  lastName: string | null
  phones: string[]
}

export interface NewContactInput {
  firstName: string
  lastName: string | null
  phones: string[]
}

/** Новая сделка: существующий контакт (`contactId`) или новый (`contact`). */
export interface NewDealInput {
  title: string
  pipelineId: string
  stageId: string
  amount: number
  currency: DealCurrency
  ownerId: string
  contactId?: string
  contact?: NewContactInput
  /** Значения пользовательских полей: обязательные на выбранном этапе (тикет crm-fields/04). */
  custom?: Record<string, unknown>
}

export class DealsApiError extends Error {
  readonly status: number
  readonly code: string
  /** Подробности отказа: `fields`, `dealId`, `managerName`, `path`… */
  readonly details: Record<string, unknown>

  constructor(status: number, code: string, details: Record<string, unknown> = {}) {
    super(`API ответил ${status} ${code}`)
    this.name = 'DealsApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export interface DealsApi {
  pipelines(projectId: string): Promise<PipelineSummary[]>
  lostReasons(projectId: string): Promise<LostReasonGroupSummary[]>
  owners(projectId: string): Promise<DealOwner[]>
  /** Пользовательские поля сделки, видимые пользователю, без архивных. */
  fields(projectId: string): Promise<FieldDefinitionSummary[]>
  /** Поля карточки канбана воронки, видимые пользователю, по порядку. */
  cardFields(projectId: string, pipelineId: string): Promise<KanbanCardFields>
  stagePage(projectId: string, query: StagePageQuery): Promise<DealsPage>
  aggregates(
    projectId: string,
    pipelineId: string,
    owner: OwnerFilter | undefined,
    filter?: FilterGroup,
  ): Promise<PipelineAggregates>
  /**
   * Смена этапа; `custom` — значения обязательных полей из формы заполнения (тикет
   * crm-fields/04), уходят тем же запросом.
   */
  changeStage(
    projectId: string,
    dealId: string,
    stageId: string,
    custom?: Record<string, unknown>,
  ): Promise<void>
  win(projectId: string, dealId: string, custom?: Record<string, unknown>): Promise<void>
  lose(projectId: string, dealId: string, lostReasonId: string): Promise<void>
  take(projectId: string, dealId: string): Promise<void>
  create(projectId: string, input: NewDealInput): Promise<{ id: string }>
  searchContacts(projectId: string, text: string): Promise<ContactOption[]>
}

export function createDealsApi(fetchImpl: typeof fetch = (...args) => fetch(...args)): DealsApi {
  async function send<T>(
    projectId: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers = projectHeaders(projectId)
    if (body !== undefined) headers.set('content-type', 'application/json')
    const res = await fetchImpl(`/api/v1${path}`, {
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
      throw new DealsApiError(
        res.status,
        typeof payload?.code === 'string' ? payload.code : '',
        typeof payload?.details === 'object' && payload.details !== null
          ? (payload.details as Record<string, unknown>)
          : {},
      )
    }
    return (await res.json()) as T
  }

  const query = (params: Record<string, string | undefined>) => {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) search.set(key, value)
    }
    return search.toString()
  }
  /** Пустой фильтр не отправляется: адрес запроса канбана без фильтра остаётся прежним. */
  const filterParam = (filter: FilterGroup | undefined) =>
    filter && ('and' in filter ? filter.and : filter.or).length > 0
      ? JSON.stringify(filter)
      : undefined
  const action = (projectId: string, dealId: string, name: string, body: unknown = {}) =>
    send<unknown>(projectId, 'POST', `/deals/${dealId}/${name}`, body).then(() => undefined)

  return {
    pipelines: (projectId) => send(projectId, 'GET', '/pipelines'),
    lostReasons: (projectId) => send(projectId, 'GET', '/lost-reasons'),
    owners: (projectId) => send(projectId, 'GET', '/deals/owners'),
    fields: (projectId) => send(projectId, 'GET', '/fields?entity=deal'),
    cardFields: (projectId, pipelineId) =>
      send(projectId, 'GET', `/pipelines/${pipelineId}/card-fields`),
    stagePage: (projectId, { pipelineId, stageId, owner, filter, cursor }) =>
      send(
        projectId,
        'GET',
        `/deals?${query({ view: 'kanban', pipeline: pipelineId, stage: stageId, owner, filter: filterParam(filter), cursor })}`,
      ),
    aggregates: (projectId, pipelineId, owner, filter) =>
      send(
        projectId,
        'GET',
        `/pipelines/${pipelineId}/aggregates?${query({ owner, filter: filterParam(filter) })}`,
      ),
    changeStage: (projectId, dealId, stageId, custom) =>
      action(projectId, dealId, 'stage', custom ? { stageId, custom } : { stageId }),
    win: (projectId, dealId, custom) => action(projectId, dealId, 'win', custom ? { custom } : {}),
    lose: (projectId, dealId, lostReasonId) => action(projectId, dealId, 'lose', { lostReasonId }),
    take: (projectId, dealId) => action(projectId, dealId, 'take'),
    create: (projectId, input) => send(projectId, 'POST', '/deals', input),
    searchContacts: (projectId, text) =>
      send(projectId, 'GET', `/contacts?${query({ q: text, limit: '10' })}`),
  }
}
