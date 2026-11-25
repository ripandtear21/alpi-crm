import type {
  LostReasonGroupSummary,
  MemberSummary,
  PipelineSummary,
  ProductSummary,
  ProjectAccess,
} from '@alpi/shared'
import { projectHeaders } from '../../../components/project-switcher/projects-api.ts'

// Запросы карточки сделки к API (тикет crm-deals/13): сделка и её действия
// (apps/api/src/deals/deals.ts), воронки и причины проигрыша, контакты и организация сделки,
// каталог товаров, участники проекта и права пользователя в проекте (`GET /project/access`).
// Всё — в контексте текущего проекта. Отказ — DealCardApiError с кодом и подробностями ответа.

export type DealStatus = 'open' | 'won' | 'lost'
export type DealCurrency = 'EUR' | 'UAH' | 'USD'
export const DEAL_CURRENCIES: readonly DealCurrency[] = ['EUR', 'UAH', 'USD']

export interface DealParticipant {
  contactId: string
  role: string | null
}

/** Строка товара; цены — в валюте сделки. */
export interface DealProductLine {
  id: string
  productId: string
  name: string
  quantity: number
  unitPrice: number
  total: number
}

/** Сделка, как её отдаёт API (DealView в apps/api/src/deals/store.ts). */
export interface DealCard {
  id: string
  title: string
  pipelineId: string
  stageId: string
  status: DealStatus
  lostReasonId: string | null
  amount: number
  currency: DealCurrency
  ownerId: string | null
  primaryContactId: string
  organizationId: string | null
  wonAt: string | null
  lostAt: string | null
  stageChangedAt: string
  expectedCloseDate: string | null
  archivedAt: string | null
  deletedAt: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
  participants: DealParticipant[]
  products: DealProductLine[]
  productsTotal: number
  /** Значения пользовательских полей по коду (тикет crm-fields/02), без скрытых от роли групп. */
  custom: Record<string, unknown>
}

/** Контакт (ContactView в apps/api/src/contacts/contacts.ts). */
export interface ContactCard {
  id: string
  firstName: string
  lastName: string | null
  organizationId: string | null
  possibleDuplicate: boolean
  /** E.164, основной — первым. */
  phones: string[]
  emails: string[]
}

/** Организация (OrganizationView в apps/api/src/organizations/organizations.ts). */
export interface OrganizationCard {
  id: string
  name: string
  address: string | null
  website: string | null
}

/** Изменение полей сделки: только названные поля. */
export interface DealChange {
  title?: string
  amount?: number
  currency?: DealCurrency
  expectedCloseDate?: string | null
  /** null — в общую очередь. */
  ownerId?: string | null
  primaryContactId?: string
}

export interface NewContactInput {
  firstName: string
  lastName?: string
  phones?: string[]
  emails?: string[]
}

export interface NewLineInput {
  productId: string
  quantity: number
  /** Не задано — цена товара в валюте сделки. */
  unitPrice?: number
}

/** Отказ API: код ответа, код ошибки и `details` тела, если есть. */
export class DealCardApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Record<string, unknown> | null

  constructor(status: number, code: string, details: Record<string, unknown> | null = null) {
    super(`API ответил ${status} ${code}`)
    this.status = status
    this.code = code
    this.details = details
  }
}

export interface DealCardApi {
  /** Права пользователя в текущем проекте. */
  access(projectId: string): Promise<ProjectAccess>
  deal(projectId: string, dealId: string): Promise<DealCard>
  update(projectId: string, dealId: string, change: DealChange): Promise<DealCard>
  /**
   * Смена этапа; `custom` — значения обязательных полей из формы заполнения (тикет
   * crm-fields/04), уходят тем же запросом.
   */
  changeStage(
    projectId: string,
    dealId: string,
    stageId: string,
    custom?: Record<string, unknown>,
  ): Promise<DealCard>
  /** Другая воронка; этап не задан — первый этап воронки. */
  move(projectId: string, dealId: string, pipelineId: string, stageId?: string): Promise<DealCard>
  win(projectId: string, dealId: string, custom?: Record<string, unknown>): Promise<DealCard>
  lose(projectId: string, dealId: string, lostReasonId: string): Promise<DealCard>
  reopen(projectId: string, dealId: string): Promise<DealCard>
  archive(projectId: string, dealId: string): Promise<DealCard>
  unarchive(projectId: string, dealId: string): Promise<DealCard>
  take(projectId: string, dealId: string): Promise<DealCard>
  remove(projectId: string, dealId: string): Promise<void>
  upsell(
    projectId: string,
    dealId: string,
    input: { pipelineId: string; title: string },
  ): Promise<DealCard>
  addParticipant(
    projectId: string,
    dealId: string,
    contactId: string,
    role: string | null,
  ): Promise<DealCard>
  updateParticipant(
    projectId: string,
    dealId: string,
    contactId: string,
    role: string | null,
  ): Promise<DealCard>
  removeParticipant(projectId: string, dealId: string, contactId: string): Promise<void>
  addLine(projectId: string, dealId: string, input: NewLineInput): Promise<DealCard>
  updateLine(
    projectId: string,
    dealId: string,
    lineId: string,
    change: { quantity?: number; unitPrice?: number },
  ): Promise<DealCard>
  removeLine(projectId: string, dealId: string, lineId: string): Promise<void>
  /** «Підставити»: сумма сделки := сумма строк товаров. */
  applyProductsTotal(projectId: string, dealId: string): Promise<DealCard>
  pipelines(projectId: string): Promise<PipelineSummary[]>
  lostReasons(projectId: string): Promise<LostReasonGroupSummary[]>
  contact(projectId: string, contactId: string): Promise<ContactCard>
  searchContacts(projectId: string, query: string): Promise<ContactCard[]>
  createContact(projectId: string, input: NewContactInput): Promise<ContactCard>
  organization(projectId: string, organizationId: string): Promise<OrganizationCard>
  products(projectId: string): Promise<ProductSummary[]>
  /** Участники проекта — только с правом «пользователи і ролі: бачити», иначе 403. */
  members(projectId: string): Promise<MemberSummary[]>
}

export function createDealCardApi(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): DealCardApi {
  async function send<T>(
    projectId: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers = projectHeaders(projectId)
    if (body !== undefined) headers.set('content-type', 'application/json')
    const res = await fetchImpl(`/api${path}`, {
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
      const details =
        typeof payload?.details === 'object' && payload.details !== null
          ? (payload.details as Record<string, unknown>)
          : null
      throw new DealCardApiError(
        res.status,
        typeof payload?.code === 'string' ? payload.code : '',
        details,
      )
    }
    return (res.status === 204 ? undefined : await res.json()) as T
  }

  const deal = (id: string) => `/v1/deals/${encodeURIComponent(id)}`
  const action = (projectId: string, id: string, name: string, body: unknown = {}) =>
    send<DealCard>(projectId, 'POST', `${deal(id)}/${name}`, body)

  return {
    access: (projectId) => send(projectId, 'GET', '/project/access'),
    deal: (projectId, id) => send(projectId, 'GET', deal(id)),
    update: (projectId, id, change) => send(projectId, 'PUT', deal(id), change),
    changeStage: (projectId, id, stageId, custom) =>
      action(projectId, id, 'stage', custom ? { stageId, custom } : { stageId }),
    move: (projectId, id, pipelineId, stageId) =>
      action(
        projectId,
        id,
        'move',
        stageId === undefined ? { pipelineId } : { pipelineId, stageId },
      ),
    win: (projectId, id, custom) => action(projectId, id, 'win', custom ? { custom } : {}),
    lose: (projectId, id, lostReasonId) => action(projectId, id, 'lose', { lostReasonId }),
    reopen: (projectId, id) => action(projectId, id, 'reopen'),
    archive: (projectId, id) => action(projectId, id, 'archive'),
    unarchive: (projectId, id) => action(projectId, id, 'unarchive'),
    take: (projectId, id) => action(projectId, id, 'take'),
    remove: (projectId, id) => send(projectId, 'DELETE', deal(id)),
    upsell: (projectId, id, input) => action(projectId, id, 'upsell', input),
    addParticipant: (projectId, id, contactId, role) =>
      send(projectId, 'POST', `${deal(id)}/participants`, { contactId, role }),
    updateParticipant: (projectId, id, contactId, role) =>
      send(projectId, 'PUT', `${deal(id)}/participants/${contactId}`, { role }),
    removeParticipant: (projectId, id, contactId) =>
      send(projectId, 'DELETE', `${deal(id)}/participants/${contactId}`),
    addLine: (projectId, id, input) => send(projectId, 'POST', `${deal(id)}/products`, input),
    updateLine: (projectId, id, lineId, change) =>
      send(projectId, 'PUT', `${deal(id)}/products/${lineId}`, change),
    removeLine: (projectId, id, lineId) =>
      send(projectId, 'DELETE', `${deal(id)}/products/${lineId}`),
    applyProductsTotal: (projectId, id) => action(projectId, id, 'apply-products-total'),
    pipelines: (projectId) => send(projectId, 'GET', '/v1/pipelines'),
    lostReasons: (projectId) => send(projectId, 'GET', '/v1/lost-reasons'),
    contact: (projectId, contactId) =>
      send(projectId, 'GET', `/v1/contacts/${encodeURIComponent(contactId)}`),
    searchContacts: (projectId, query) =>
      send(projectId, 'GET', `/v1/contacts?${new URLSearchParams({ q: query, limit: '10' })}`),
    createContact: (projectId, input) => send(projectId, 'POST', '/v1/contacts', input),
    organization: (projectId, organizationId) =>
      send(projectId, 'GET', `/v1/organizations/${encodeURIComponent(organizationId)}`),
    products: (projectId) => send(projectId, 'GET', '/v1/products'),
    members: (projectId) => send(projectId, 'GET', '/members'),
  }
}
