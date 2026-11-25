import type { PipelineSummary, ProjectAccess } from '@alpi/shared'
import { projectHeaders } from '../project-switcher/projects-api.ts'

// Запросы карточек контакта и организации (тикет crm-deals/14) к API: контакты
// (apps/api/src/contacts/contacts.ts), организации (apps/api/src/organizations/organizations.ts),
// сделки контакта и организации (`GET /v1/deals?contact=` и `?organization=`,
// apps/api/src/deals/board.ts), воронки — для названий воронки и этапа — и права пользователя
// в проекте (`GET /project/access`). Всё — в контексте текущего проекта. Отказ —
// ContactsApiError с кодом и подробностями ответа.

export type ContactLanguage = 'uk' | 'ru'
export const CONTACT_LANGUAGES: readonly ContactLanguage[] = ['uk', 'ru']

/** Контакт (ContactView в apps/api/src/contacts/contacts.ts). */
export interface ContactRecord {
  id: string
  firstName: string
  lastName: string | null
  language: ContactLanguage | null
  organizationId: string | null
  possibleDuplicate: boolean
  /** E.164, основной — первым. */
  phones: string[]
  /** Основной — первым. */
  emails: string[]
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

/** Организация (OrganizationView в apps/api/src/organizations/organizations.ts). */
export interface OrganizationRecord {
  id: string
  name: string
  address: string | null
  website: string | null
}

/** Создание или изменение контакта: только названные поля. Телефоны — как ввёл пользователь. */
export interface ContactInput {
  firstName?: string
  lastName?: string | null
  language?: ContactLanguage | null
  organizationId?: string | null
  phones?: string[]
  emails?: string[]
  /** Значения пользовательских полей: поля «всегда» при создании (тикет crm-fields/04). */
  custom?: Record<string, unknown>
}

export interface OrganizationInput {
  name?: string
  address?: string | null
  website?: string | null
}

export type DealStatus = 'open' | 'won' | 'lost'

/** Сделка в карточке контакта или организации (BoardDeal в apps/api/src/deals/board.ts). */
export interface RecordDeal {
  id: string
  title: string
  pipelineId: string
  stageId: string
  status: DealStatus
  amount: number
  currency: string
  ownerId: string | null
  ownerName: string | null
  primaryContactId: string
}

export interface RecordDeals {
  items: RecordDeal[]
  /** Есть ещё сделки сверх загруженных. */
  more: boolean
}

/** Сколько сделок и контактов загружает карточка за раз. */
export const RECORD_LIST_LIMIT = 200

/** Сделка, которая уйдёт в корзину вместе с контактом (409 CONTACT_HAS_DEALS). */
export interface DependentDeal {
  id: string
  title: string
}

/** Отказ API: код ответа, код ошибки и `details` тела, если есть. */
export class ContactsApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Record<string, unknown>

  constructor(status: number, code: string, details: Record<string, unknown> = {}) {
    super(`API ответил ${status} ${code}`)
    this.name = 'ContactsApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export interface ContactsApi {
  access(projectId: string): Promise<ProjectAccess>
  pipelines(projectId: string): Promise<PipelineSummary[]>
  contact(projectId: string, contactId: string): Promise<ContactRecord>
  searchContacts(projectId: string, query: string): Promise<ContactRecord[]>
  createContact(projectId: string, input: ContactInput): Promise<ContactRecord>
  updateContact(projectId: string, contactId: string, input: ContactInput): Promise<ContactRecord>
  /**
   * В корзину. Контакт основной в сделках — нужен `confirm` с id ровно этих сделок, иначе
   * 409 CONTACT_HAS_DEALS со списком `details.deals`.
   */
  removeContact(projectId: string, contactId: string, confirm: string[]): Promise<void>
  /** Сделки, где контакт основной или участник: все статусы, и архивные тоже. */
  contactDeals(projectId: string, contactId: string): Promise<RecordDeals>
  organization(projectId: string, organizationId: string): Promise<OrganizationRecord>
  searchOrganizations(projectId: string, query: string): Promise<OrganizationRecord[]>
  createOrganization(projectId: string, input: OrganizationInput): Promise<OrganizationRecord>
  updateOrganization(
    projectId: string,
    organizationId: string,
    input: OrganizationInput,
  ): Promise<OrganizationRecord>
  removeOrganization(projectId: string, organizationId: string): Promise<void>
  /** Контакты организации в охвате пользователя. */
  organizationContacts(projectId: string, organizationId: string): Promise<ContactRecord[]>
  organizationDeals(projectId: string, organizationId: string): Promise<RecordDeals>
}

export function createContactsApi(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): ContactsApi {
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
      throw new ContactsApiError(
        res.status,
        typeof payload?.code === 'string' ? payload.code : '',
        typeof payload?.details === 'object' && payload.details !== null
          ? (payload.details as Record<string, unknown>)
          : {},
      )
    }
    return (res.status === 204 ? undefined : await res.json()) as T
  }

  const contact = (id: string) => `/v1/contacts/${encodeURIComponent(id)}`
  const organization = (id: string) => `/v1/organizations/${encodeURIComponent(id)}`
  const query = (params: Record<string, string>) => new URLSearchParams(params).toString()
  // shortcut: одна страница из RECORD_LIST_LIMIT сделок, без «показать ещё»; добавить
  // подгрузку по nextCursor, когда у контакта или организации бывает больше 200 сделок.
  const deals = async (projectId: string, filter: Record<string, string>) => {
    const page = await send<{ items: RecordDeal[]; nextCursor: string | null }>(
      projectId,
      'GET',
      `/v1/deals?${query({ ...filter, status: 'any', archived: 'any', limit: String(RECORD_LIST_LIMIT) })}`,
    )
    return { items: page.items, more: page.nextCursor !== null }
  }

  return {
    access: (projectId) => send(projectId, 'GET', '/project/access'),
    pipelines: (projectId) => send(projectId, 'GET', '/v1/pipelines'),
    contact: (projectId, id) => send(projectId, 'GET', contact(id)),
    searchContacts: (projectId, text) =>
      send(projectId, 'GET', `/v1/contacts?${query({ q: text, limit: '10' })}`),
    createContact: (projectId, input) => send(projectId, 'POST', '/v1/contacts', input),
    updateContact: (projectId, id, input) => send(projectId, 'PUT', contact(id), input),
    removeContact: (projectId, id, confirm) =>
      send(
        projectId,
        'DELETE',
        confirm.length === 0
          ? contact(id)
          : `${contact(id)}?${query({ confirm: confirm.join(',') })}`,
      ),
    contactDeals: (projectId, id) => deals(projectId, { contact: id }),
    organization: (projectId, id) => send(projectId, 'GET', organization(id)),
    searchOrganizations: (projectId, text) =>
      send(projectId, 'GET', `/v1/organizations?${query({ q: text, limit: '10' })}`),
    createOrganization: (projectId, input) => send(projectId, 'POST', '/v1/organizations', input),
    updateOrganization: (projectId, id, input) => send(projectId, 'PUT', organization(id), input),
    removeOrganization: (projectId, id) => send(projectId, 'DELETE', organization(id)),
    organizationContacts: (projectId, id) =>
      send(
        projectId,
        'GET',
        `/v1/contacts?${query({ organizationId: id, limit: String(RECORD_LIST_LIMIT) })}`,
      ),
    organizationDeals: (projectId, id) => deals(projectId, { organization: id }),
  }
}
