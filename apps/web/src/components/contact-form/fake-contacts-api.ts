import {
  normalizeEmail,
  normalizePhone,
  type PipelineSummary,
  type ProjectAccess,
} from '@alpi/shared'
import { accessOf, USER_ID } from '../../routes/deals/$dealId/fake-deal-card-api.ts'
import {
  type ContactInput,
  type ContactRecord,
  type ContactsApi,
  ContactsApiError,
  type OrganizationRecord,
  type RecordDeal,
} from './contacts-api.ts'

// Подставной клиент карточек контакта и организации для тестов: данные в памяти и правила API,
// которые проверяет экран. Контакт вне охвата или удалённый — 404; телефон приводится к E.164,
// неразбираемый — 422 INVALID_PHONE с номером поля; телефон у видимого контакта — 409
// CONTACT_EXISTS со ссылкой; телефон «чужого клиента» (`foreignPhones`) — 409
// CONTACT_OUT_OF_SCOPE только с именем менеджера; удаление контакта, основного в сделках, без
// подтверждения ровно их списка — 409 CONTACT_HAS_DEALS. `calls` — какие изменения ушли в API.

export const CONTACT_ID = '00000000-0000-4000-9400-0000000000c1'
export const OTHER_CONTACT_ID = '00000000-0000-4000-9400-0000000000c2'
export const ORGANIZATION_ID = '00000000-0000-4000-9400-0000000000d1'
export const PIPELINE_ID = '00000000-0000-4000-9400-0000000000a1'
export const STAGE_LEAD = '00000000-0000-4000-9400-0000000000b1'
export const STAGE_DECISION = '00000000-0000-4000-9400-0000000000b2'
export { USER_ID }

export interface FakeContactsApi extends ContactsApi {
  contacts: ContactRecord[]
  organizations: OrganizationRecord[]
  deals: RecordDeal[]
  /** Участники сделок: id сделки → id контактов. */
  participants: Record<string, string[]>
  /** Телефоны контактов вне охвата: E.164 → имя менеджера (null — не в работе). */
  foreignPhones: Record<string, string | null>
  pipelineList: PipelineSummary[]
  me: ProjectAccess
  calls: string[]
}

let counter = 0
const fakeId = () => `00000000-0000-4000-9499-${String(++counter).padStart(12, '0')}`

export function sampleContact(overrides: Partial<ContactRecord> = {}): ContactRecord {
  return {
    id: CONTACT_ID,
    firstName: 'Ірина',
    lastName: 'Мельник',
    language: 'uk',
    organizationId: ORGANIZATION_ID,
    possibleDuplicate: false,
    phones: [],
    emails: ['iryna@example.test'],
    createdBy: USER_ID,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    ...overrides,
  }
}

export function sampleDeal(overrides: Partial<RecordDeal> = {}): RecordDeal {
  return {
    id: fakeId(),
    title: 'Ірина Мельник — курс',
    pipelineId: PIPELINE_ID,
    stageId: STAGE_LEAD,
    status: 'open',
    amount: 100,
    currency: 'EUR',
    ownerId: USER_ID,
    ownerName: 'Власник',
    primaryContactId: CONTACT_ID,
    ...overrides,
  }
}

export function fakeContactsApi({
  contacts = [sampleContact()],
  deals = [],
  access = accessOf('admin'),
}: {
  contacts?: ContactRecord[]
  deals?: RecordDeal[]
  access?: ProjectAccess
} = {}): FakeContactsApi {
  function contact(id: string): ContactRecord {
    const found = api.contacts.find((item) => item.id === id)
    if (!found) throw new ContactsApiError(404, 'CONTACT_NOT_FOUND')
    return found
  }
  function organization(id: string): OrganizationRecord {
    const found = api.organizations.find((item) => item.id === id)
    if (!found) throw new ContactsApiError(404, 'ORGANIZATION_NOT_FOUND')
    return found
  }
  /** Ключи из ввода — как на сервере: E.164 и нижний регистр, проверка совпадений. */
  function keys(input: ContactInput, selfId: string | null) {
    const phones: string[] = []
    for (const [index, raw] of (input.phones ?? []).entries()) {
      const phone = normalizePhone(raw)
      if (phone === null) {
        throw new ContactsApiError(422, 'INVALID_PHONE', { path: `phones.${index}` })
      }
      if (phone in api.foreignPhones) {
        const managerName = api.foreignPhones[phone]
        throw new ContactsApiError(409, 'CONTACT_OUT_OF_SCOPE', managerName ? { managerName } : {})
      }
      const other = api.contacts.find((c) => c.id !== selfId && c.phones.includes(phone))
      if (other) throw new ContactsApiError(409, 'CONTACT_EXISTS', { contactId: other.id })
      phones.push(phone)
    }
    const emails: string[] = []
    for (const [index, raw] of (input.emails ?? []).entries()) {
      const email = normalizeEmail(raw)
      if (email === null) {
        throw new ContactsApiError(422, 'INVALID_EMAIL', { path: `emails.${index}` })
      }
      emails.push(email)
    }
    return { phones, emails }
  }
  const dealsOf = (match: (deal: RecordDeal) => boolean) => ({
    items: structuredClone(api.deals.filter(match)),
    more: false,
  })

  const api: FakeContactsApi = {
    contacts: structuredClone(contacts),
    organizations: [{ id: ORGANIZATION_ID, name: 'ТОВ Вигадана', address: null, website: null }],
    deals: structuredClone(deals),
    participants: {},
    foreignPhones: {},
    pipelineList: [
      {
        id: PIPELINE_ID,
        code: 'alpi',
        name: 'ALPI',
        position: 1,
        isUpsell: false,
        archivedAt: null,
        stages: [
          { id: STAGE_LEAD, pipelineId: PIPELINE_ID, name: 'Новий лід', position: 1 },
          { id: STAGE_DECISION, pipelineId: PIPELINE_ID, name: 'Рішення', position: 2 },
        ],
      },
    ],
    me: access,
    calls: [],

    async access() {
      return structuredClone(api.me)
    },
    async pipelines() {
      return structuredClone(api.pipelineList)
    },
    async contact(_projectId, id) {
      return structuredClone(contact(id))
    },
    async searchContacts(_projectId, query) {
      const text = query.toLocaleLowerCase()
      return structuredClone(
        api.contacts.filter((c) =>
          `${c.firstName} ${c.lastName ?? ''}`.toLocaleLowerCase().includes(text),
        ),
      )
    },
    async createContact(_projectId, input) {
      const { phones, emails } = keys(input, null)
      const created: ContactRecord = sampleContact({
        id: fakeId(),
        firstName: input.firstName ?? '',
        lastName: input.lastName ?? null,
        language: input.language ?? null,
        organizationId: input.organizationId ?? null,
        phones,
        emails,
      })
      api.contacts.push(created)
      api.calls.push('createContact')
      return structuredClone(created)
    },
    async updateContact(_projectId, id, input) {
      const found = contact(id)
      const { phones, emails } = keys(input, id)
      if (input.firstName !== undefined) found.firstName = input.firstName
      if (input.lastName !== undefined) found.lastName = input.lastName
      if (input.language !== undefined) found.language = input.language
      if (input.organizationId !== undefined) found.organizationId = input.organizationId
      if (input.phones !== undefined) found.phones = phones
      if (input.emails !== undefined) found.emails = emails
      api.calls.push(`updateContact:${id}`)
      return structuredClone(found)
    },
    async removeContact(_projectId, id, confirm) {
      contact(id)
      const dependents = api.deals.filter((deal) => deal.primaryContactId === id)
      const ids = new Set(confirm)
      if (ids.size !== dependents.length || !dependents.every((deal) => ids.has(deal.id))) {
        throw new ContactsApiError(409, 'CONTACT_HAS_DEALS', {
          deals: dependents.map(({ id: dealId, title }) => ({ id: dealId, title })),
        })
      }
      api.calls.push(`removeContact:${id}:${[...confirm].sort().join(',')}`)
      api.contacts = api.contacts.filter((item) => item.id !== id)
      api.deals = api.deals.filter((deal) => deal.primaryContactId !== id)
    },
    async contactDeals(_projectId, id) {
      return dealsOf(
        (deal) => deal.primaryContactId === id || (api.participants[deal.id] ?? []).includes(id),
      )
    },
    async organization(_projectId, id) {
      return structuredClone(organization(id))
    },
    async searchOrganizations(_projectId, query) {
      const text = query.toLocaleLowerCase()
      return structuredClone(
        api.organizations.filter((org) => org.name.toLocaleLowerCase().includes(text)),
      )
    },
    async createOrganization(_projectId, input) {
      const created = {
        id: fakeId(),
        name: input.name ?? '',
        address: input.address ?? null,
        website: input.website ?? null,
      }
      api.organizations.push(created)
      api.calls.push('createOrganization')
      return structuredClone(created)
    },
    async updateOrganization(_projectId, id, input) {
      const found = organization(id)
      Object.assign(found, input)
      api.calls.push(`updateOrganization:${id}`)
      return structuredClone(found)
    },
    async removeOrganization(_projectId, id) {
      organization(id)
      api.organizations = api.organizations.filter((org) => org.id !== id)
      api.calls.push(`removeOrganization:${id}`)
    },
    async organizationContacts(_projectId, id) {
      return structuredClone(api.contacts.filter((c) => c.organizationId === id))
    },
    async organizationDeals(_projectId, id) {
      // У подставных сделок нет организации: сделки организации — сделки её контактов.
      const members = new Set(api.contacts.filter((c) => c.organizationId === id).map((c) => c.id))
      return dealsOf((deal) => members.has(deal.primaryContactId))
    },
  }
  return api
}
