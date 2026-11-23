import {
  type LostReasonGroupSummary,
  type MemberSummary,
  type PipelineSummary,
  type ProductSummary,
  type ProjectAccess,
  ROLE_TEMPLATES,
  type RoleTemplateKey,
} from '@alpi/shared'
import {
  type ContactCard,
  type DealCard,
  type DealCardApi,
  DealCardApiError,
  type OrganizationCard,
} from './deal-card-api.ts'

// Подставной клиент карточки сделки для тестов: данные в памяти и правила API, которые
// проверяет экран — сделка вне охвата отвечает 404, проигрыш без причины — 422, допродажа к
// контакту с открытой сделкой в воронке — 409 OPEN_DEAL_EXISTS с id той сделки, «Підставити»
// ставит сумму строк. `calls` — какие изменения ушли в API.

export const DEAL_ID = '00000000-0000-4000-9200-000000000001'
export const USER_ID = 'user-1'
export const OTHER_USER_ID = 'user-2'
export const PIPELINE_ID = '00000000-0000-4000-9200-0000000000a1'
export const UPSELL_PIPELINE_ID = '00000000-0000-4000-9200-0000000000a2'
export const STAGES = {
  lead: '00000000-0000-4000-9200-0000000000b1',
  contact: '00000000-0000-4000-9200-0000000000b2',
  decision: '00000000-0000-4000-9200-0000000000b3',
  upsellFirst: '00000000-0000-4000-9200-0000000000b4',
}
export const CONTACT_ID = '00000000-0000-4000-9200-0000000000c1'
export const PARTICIPANT_ID = '00000000-0000-4000-9200-0000000000c2'
export const ORGANIZATION_ID = '00000000-0000-4000-9200-0000000000d1'
export const REASON_ID = '00000000-0000-4000-9200-0000000000e1'
export const COURSE_ID = '00000000-0000-4000-9200-0000000000f1'

export interface FakeDealCardApi extends DealCardApi {
  deals: DealCard[]
  contacts: ContactCard[]
  organizations: OrganizationCard[]
  pipelineList: PipelineSummary[]
  reasonGroups: LostReasonGroupSummary[]
  catalogue: ProductSummary[]
  /** null — список участников проекта отвечает 403 (нет права «пользователи и роли»). */
  memberList: MemberSummary[] | null
  me: ProjectAccess
  calls: string[]
}

let counter = 0
function fakeId(): string {
  counter += 1
  return `00000000-0000-4000-9299-${String(counter).padStart(12, '0')}`
}

/** Права роли-шаблона: менеджер — без «передачи сделок» и без удаления. */
export function accessOf(template: RoleTemplateKey, userId = USER_ID): ProjectAccess {
  const role = ROLE_TEMPLATES.find((item) => item.key === template)
  if (!role) throw new Error(`нет шаблона ${template}`)
  return { userId, permissions: structuredClone(role.permissions) }
}

/** Открытая сделка: 100 EUR, две строки «Курс» по 100 (сумма по товарам 200), один участник. */
export function sampleDeal(overrides: Partial<DealCard> = {}): DealCard {
  return {
    id: DEAL_ID,
    title: 'Ірина Мельник — курс',
    pipelineId: PIPELINE_ID,
    stageId: STAGES.contact,
    status: 'open',
    lostReasonId: null,
    amount: 100,
    currency: 'EUR',
    ownerId: USER_ID,
    primaryContactId: CONTACT_ID,
    organizationId: ORGANIZATION_ID,
    wonAt: null,
    lostAt: null,
    stageChangedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    expectedCloseDate: null,
    archivedAt: null,
    deletedAt: null,
    createdBy: USER_ID,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    participants: [{ contactId: PARTICIPANT_ID, role: 'Платник' }],
    products: [
      {
        id: '00000000-0000-4000-9200-000000000101',
        productId: COURSE_ID,
        name: 'Курс',
        quantity: 2,
        unitPrice: 100,
        total: 200,
      },
    ],
    productsTotal: 200,
    ...overrides,
  }
}

export function fakeDealCardApi({
  role = 'admin',
  deals = [sampleDeal()],
}: {
  role?: RoleTemplateKey
  deals?: DealCard[]
} = {}): FakeDealCardApi {
  function deal(id: string): DealCard {
    const found = api.deals.find((item) => item.id === id && item.deletedAt === null)
    // Чужая (вне охвата), удалённая и несуществующая — одинаковый 404 без данных.
    if (!found) throw new DealCardApiError(404, 'DEAL_NOT_FOUND')
    return found
  }
  function change(id: string, name: string, apply: (found: DealCard) => void): DealCard {
    const found = deal(id)
    api.calls.push(name)
    apply(found)
    found.updatedAt = new Date().toISOString()
    return structuredClone(found)
  }
  function openConflict(contactId: string, pipelineId: string, excludeId?: string) {
    const other = api.deals.find(
      (item) =>
        item.id !== excludeId &&
        item.primaryContactId === contactId &&
        item.pipelineId === pipelineId &&
        item.status === 'open' &&
        item.archivedAt === null &&
        item.deletedAt === null,
    )
    if (other) throw new DealCardApiError(409, 'OPEN_DEAL_EXISTS', { dealId: other.id })
  }
  const total = (found: DealCard) =>
    Math.round(found.products.reduce((sum, line) => sum + line.total, 0) * 100) / 100

  const api: FakeDealCardApi = {
    deals: structuredClone(deals),
    contacts: [
      {
        id: CONTACT_ID,
        firstName: 'Ірина',
        lastName: 'Мельник',
        organizationId: ORGANIZATION_ID,
        possibleDuplicate: true,
        phones: ['+380501234567'],
        emails: ['iryna@example.test'],
      },
      {
        id: PARTICIPANT_ID,
        firstName: 'Петро',
        lastName: 'Мельник',
        organizationId: null,
        possibleDuplicate: false,
        phones: [],
        emails: [],
      },
    ],
    organizations: [{ id: ORGANIZATION_ID, name: 'Студія Мельник', address: null, website: null }],
    pipelineList: [
      {
        id: PIPELINE_ID,
        code: 'alpi',
        name: 'Воронка ALPI',
        position: 1,
        isUpsell: false,
        archivedAt: null,
        stages: [
          { id: STAGES.lead, pipelineId: PIPELINE_ID, name: 'Новий лід', position: 1 },
          { id: STAGES.contact, pipelineId: PIPELINE_ID, name: 'Контакт', position: 2 },
          { id: STAGES.decision, pipelineId: PIPELINE_ID, name: 'Рішення', position: 3 },
        ],
      },
      {
        id: UPSELL_PIPELINE_ID,
        code: 'upsell',
        name: 'Допродажі',
        position: 2,
        isUpsell: true,
        archivedAt: null,
        stages: [
          {
            id: STAGES.upsellFirst,
            pipelineId: UPSELL_PIPELINE_ID,
            name: 'Пропозиція',
            position: 1,
          },
        ],
      },
    ],
    reasonGroups: [
      {
        id: '00000000-0000-4000-9200-0000000000e0',
        name: 'Гроші',
        position: 1,
        archivedAt: null,
        reasons: [
          {
            id: REASON_ID,
            groupId: '00000000-0000-4000-9200-0000000000e0',
            name: 'Дорого',
            position: 1,
            archivedAt: null,
          },
        ],
      },
    ],
    catalogue: [
      {
        id: COURSE_ID,
        name: 'Курс',
        prices: { EUR: 100, UAH: 4000, USD: null },
        archivedAt: null,
        createdAt: '2026-11-01T10:00:00.000Z',
      },
    ],
    memberList: null,
    me: accessOf(role),
    calls: [],

    async access() {
      return structuredClone(api.me)
    },
    async deal(_projectId, id) {
      return structuredClone(deal(id))
    },
    async update(_projectId, id, fields) {
      return change(id, 'update', (found) => Object.assign(found, fields))
    },
    async changeStage(_projectId, id, stageId) {
      return change(id, 'stage', (found) => {
        found.stageId = stageId
        found.stageChangedAt = new Date().toISOString()
      })
    },
    async move(_projectId, id, pipelineId, stageId) {
      return change(id, 'move', (found) => {
        const pipeline = api.pipelineList.find((item) => item.id === pipelineId)
        found.pipelineId = pipelineId
        found.stageId = stageId ?? pipeline?.stages[0]?.id ?? found.stageId
      })
    },
    async win(_projectId, id) {
      return change(id, 'win', (found) => {
        found.status = 'won'
        found.wonAt = new Date().toISOString()
        found.lostAt = null
        found.lostReasonId = null
      })
    },
    async lose(_projectId, id, lostReasonId) {
      if (!lostReasonId) throw new DealCardApiError(422, 'LOST_REASON_REQUIRED')
      return change(id, 'lose', (found) => {
        found.status = 'lost'
        found.lostAt = new Date().toISOString()
        found.wonAt = null
        found.lostReasonId = lostReasonId
      })
    },
    async reopen(_projectId, id) {
      const found = deal(id)
      openConflict(found.primaryContactId, found.pipelineId, found.id)
      return change(id, 'reopen', (item) => {
        item.status = 'open'
        item.wonAt = null
        item.lostAt = null
        item.lostReasonId = null
      })
    },
    async archive(_projectId, id) {
      return change(id, 'archive', (found) => {
        found.archivedAt = new Date().toISOString()
      })
    },
    async unarchive(_projectId, id) {
      return change(id, 'unarchive', (found) => {
        found.archivedAt = null
      })
    },
    async take(_projectId, id) {
      return change(id, 'take', (found) => {
        found.ownerId = api.me.userId
      })
    },
    async remove(_projectId, id) {
      change(id, 'remove', (found) => {
        found.deletedAt = new Date().toISOString()
      })
    },
    async upsell(_projectId, id, input) {
      const source = deal(id)
      if (source.status !== 'won') throw new DealCardApiError(409, 'DEAL_NOT_WON')
      openConflict(source.primaryContactId, input.pipelineId)
      api.calls.push('upsell')
      const pipeline = api.pipelineList.find((item) => item.id === input.pipelineId)
      const created = sampleDeal({
        id: fakeId(),
        title: input.title,
        pipelineId: input.pipelineId,
        stageId: pipeline?.stages[0]?.id ?? '',
        primaryContactId: source.primaryContactId,
        amount: 0,
        participants: [],
        products: [],
        productsTotal: 0,
      })
      api.deals.push(created)
      return structuredClone(created)
    },
    async addParticipant(_projectId, id, contactId, participantRole) {
      return change(id, 'addParticipant', (found) => {
        found.participants.push({ contactId, role: participantRole })
      })
    },
    async updateParticipant(_projectId, id, contactId, participantRole) {
      return change(id, 'updateParticipant', (found) => {
        const participant = found.participants.find((item) => item.contactId === contactId)
        if (participant) participant.role = participantRole
      })
    },
    async removeParticipant(_projectId, id, contactId) {
      change(id, 'removeParticipant', (found) => {
        found.participants = found.participants.filter((item) => item.contactId !== contactId)
      })
    },
    async addLine(_projectId, id, input) {
      return change(id, 'addLine', (found) => {
        const product = api.catalogue.find((item) => item.id === input.productId)
        const unitPrice = input.unitPrice ?? product?.prices[found.currency] ?? 0
        found.products.push({
          id: fakeId(),
          productId: input.productId,
          name: product?.name ?? '?',
          quantity: input.quantity,
          unitPrice,
          total: unitPrice * input.quantity,
        })
        found.productsTotal = total(found)
      })
    },
    async updateLine(_projectId, id, lineId, lineChange) {
      return change(id, 'updateLine', (found) => {
        const line = found.products.find((item) => item.id === lineId)
        if (!line) return
        Object.assign(line, lineChange)
        line.total = line.quantity * line.unitPrice
        found.productsTotal = total(found)
      })
    },
    async removeLine(_projectId, id, lineId) {
      change(id, 'removeLine', (found) => {
        found.products = found.products.filter((item) => item.id !== lineId)
        found.productsTotal = total(found)
      })
    },
    async applyProductsTotal(_projectId, id) {
      return change(id, 'applyProductsTotal', (found) => {
        found.amount = found.productsTotal
      })
    },
    async pipelines() {
      return structuredClone(api.pipelineList)
    },
    async lostReasons() {
      return structuredClone(api.reasonGroups)
    },
    async contact(_projectId, contactId) {
      const found = api.contacts.find((item) => item.id === contactId)
      if (!found) throw new DealCardApiError(404, 'CONTACT_NOT_FOUND')
      return structuredClone(found)
    },
    async searchContacts(_projectId, query) {
      const text = query.toLocaleLowerCase()
      return structuredClone(
        api.contacts.filter((item) =>
          `${item.firstName} ${item.lastName ?? ''}`.toLocaleLowerCase().includes(text),
        ),
      )
    },
    async createContact(_projectId, input) {
      const created: ContactCard = {
        id: fakeId(),
        firstName: input.firstName,
        lastName: input.lastName ?? null,
        organizationId: null,
        possibleDuplicate: false,
        phones: input.phones ?? [],
        emails: input.emails ?? [],
      }
      api.contacts.push(created)
      return structuredClone(created)
    },
    async organization(_projectId, organizationId) {
      const found = api.organizations.find((item) => item.id === organizationId)
      if (!found) throw new DealCardApiError(404, 'ORGANIZATION_NOT_FOUND')
      return structuredClone(found)
    },
    async products() {
      return structuredClone(api.catalogue)
    },
    async members() {
      if (api.memberList === null) throw new DealCardApiError(403, 'PERMISSION_DENIED')
      return structuredClone(api.memberList)
    },
  }
  return api
}
