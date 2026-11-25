import type {
  FieldDefinitionSummary,
  FilterGroup,
  LostReasonGroupSummary,
  PipelineSummary,
} from '@alpi/shared'
import {
  type BoardDeal,
  type ContactOption,
  type DealCurrency,
  type DealOwner,
  type DealsApi,
  DealsApiError,
  type NewDealInput,
  type OwnerFilter,
  type PipelineAggregates,
} from './deals-api.ts'
import { matchesFilter } from './list/fake-lists-api.ts'

// Подставной клиент канбана для тестов: данные в памяти, как их отдаёт API (новые на этапе
// сверху, страницы по `pageSize` с курсором), и журнал вызовов. `failNext` — следующее действие
// (смена этапа, выигрыш, проигрыш, «взять», создание) отклоняется этим отказом.

/** Текущий пользователь подставного входа (routes/auth/fake-auth-api.ts). */
export const FAKE_ME: DealOwner = { id: 'user-1', name: 'Власник' }
export const FAKE_COLLEAGUE: DealOwner = { id: 'user-2', name: 'Остап Тестовий' }

export const PIPELINE_ID = '00000000-0000-4000-9200-000000000001'
export const STAGE_NEW = '00000000-0000-4000-9200-000000000011'
export const STAGE_CONTACT = '00000000-0000-4000-9200-000000000012'
export const STAGE_PAYMENT = '00000000-0000-4000-9200-000000000013'
export const REASON_EXPENSIVE = '00000000-0000-4000-9200-000000000031'

export interface FakeDealsCall {
  action: 'changeStage' | 'win' | 'lose' | 'take' | 'create' | 'stagePage'
  dealId?: string
  value?: unknown
  /** Значения обязательных полей, ушедшие вместе с действием (тикет crm-fields/04). */
  custom?: Record<string, unknown>
}

export interface FakeDealsApi extends DealsApi {
  deals: BoardDeal[]
  /** Пользовательские поля сделки (тикет crm-fields/07). */
  customFields: FieldDefinitionSummary[]
  /** Поля карточки канбана по воронкам. */
  cardFieldIds: Record<string, string[]>
  calls: FakeDealsCall[]
  failNext: DealsApiError | null
  pageSize: number
  contacts: ContactOption[]
}

let counter = 0
export function fakeDealId(): string {
  counter += 1
  return `00000000-0000-4000-9300-${String(counter).padStart(12, '0')}`
}

export function fakeDeal(fields: Partial<BoardDeal> = {}): BoardDeal {
  const id = fields.id ?? fakeDealId()
  return {
    id,
    title: `Угода ${id.slice(-4)}`,
    pipelineId: PIPELINE_ID,
    stageId: STAGE_NEW,
    amount: 100,
    currency: 'EUR',
    ownerId: FAKE_ME.id,
    ownerName: FAKE_ME.name,
    primaryContactId: '00000000-0000-4000-9400-000000000001',
    contactName: 'Ірина Вигадана',
    stageChangedAt: '2026-11-20T10:00:00.000000Z',
    ...fields,
  }
}

const PIPELINES: PipelineSummary[] = [
  {
    id: PIPELINE_ID,
    code: 'alpi',
    name: 'ALPI',
    position: 1,
    isUpsell: false,
    archivedAt: null,
    stages: [
      { id: STAGE_NEW, pipelineId: PIPELINE_ID, name: 'Новий лід', position: 1 },
      { id: STAGE_CONTACT, pipelineId: PIPELINE_ID, name: 'Контакт', position: 2 },
      { id: STAGE_PAYMENT, pipelineId: PIPELINE_ID, name: 'Оплата', position: 3 },
    ],
  },
]

const LOST_REASONS: LostReasonGroupSummary[] = [
  {
    id: '00000000-0000-4000-9200-000000000021',
    name: 'Якість ліда',
    position: 1,
    archivedAt: null,
    reasons: [
      {
        id: REASON_EXPENSIVE,
        groupId: '00000000-0000-4000-9200-000000000021',
        name: 'Дорого',
        position: 1,
        archivedAt: null,
      },
      {
        id: '00000000-0000-4000-9200-000000000032',
        groupId: '00000000-0000-4000-9200-000000000021',
        name: 'Застаріла',
        position: 2,
        archivedAt: '2026-11-01T10:00:00.000Z',
      },
    ],
  },
  {
    id: '00000000-0000-4000-9200-000000000022',
    name: 'Архівна група',
    position: 2,
    archivedAt: '2026-11-01T10:00:00.000Z',
    reasons: [],
  },
]

export function fakeDealsApi(deals: BoardDeal[] = []): FakeDealsApi {
  function failIfAsked() {
    const failure = api.failNext
    if (failure) {
      api.failNext = null
      throw failure
    }
  }

  function find(id: string): BoardDeal {
    const deal = api.deals.find((d) => d.id === id)
    if (!deal) throw new DealsApiError(404, 'DEAL_NOT_FOUND')
    return deal
  }

  function matches(
    deal: BoardDeal,
    owner: OwnerFilter | undefined,
    filter: FilterGroup | undefined,
  ): boolean {
    if (
      filter &&
      !matchesFilter('deals', { archivedAt: null, ...deal }, filter, api.customFields)
    ) {
      return false
    }
    if (owner === undefined) return true
    if (owner === 'none') return deal.ownerId === null
    return deal.ownerId === (owner === 'me' ? FAKE_ME.id : owner)
  }

  /** Как выдача канбана API: в `custom` только поля карточки воронки. */
  function onCard(deal: BoardDeal): BoardDeal {
    const ids = api.cardFieldIds[deal.pipelineId] ?? []
    const codes = new Set(api.customFields.filter((f) => ids.includes(f.id)).map((f) => f.code))
    const custom = Object.fromEntries(
      Object.entries(deal.custom ?? {}).filter(([code]) => codes.has(code)),
    )
    return { ...deal, custom }
  }

  const api: FakeDealsApi = {
    deals,
    customFields: [],
    cardFieldIds: {},
    calls: [],
    failNext: null,
    pageSize: 50,
    contacts: [
      {
        id: '00000000-0000-4000-9400-000000000002',
        firstName: 'Марко',
        lastName: 'Вигаданий',
        phones: ['+380671112233'],
      },
    ],
    async pipelines() {
      return structuredClone(PIPELINES)
    },
    async lostReasons() {
      return structuredClone(LOST_REASONS)
    },
    async owners() {
      return [FAKE_ME, FAKE_COLLEAGUE]
    },
    async fields() {
      return api.customFields.filter((f) => f.archivedAt === null)
    },
    async cardFields(_projectId, pipelineId) {
      return { fieldIds: api.cardFieldIds[pipelineId] ?? [] }
    },
    async stagePage(_projectId, { pipelineId, stageId, owner, filter, cursor }) {
      if (filter) api.calls.push({ action: 'stagePage', value: filter })
      const column = api.deals.filter(
        (d) => d.pipelineId === pipelineId && d.stageId === stageId && matches(d, owner, filter),
      )
      const start = cursor === undefined ? 0 : Number(cursor)
      const items = column.slice(start, start + api.pageSize)
      const next = start + api.pageSize
      return {
        items: structuredClone(items.map(onCard)),
        nextCursor: next < column.length ? String(next) : null,
      }
    },
    async aggregates(_projectId, pipelineId, owner, filter) {
      const result: PipelineAggregates = { stages: [] }
      for (const deal of api.deals) {
        if (deal.pipelineId !== pipelineId || !matches(deal, owner, filter)) continue
        let stage = result.stages.find((s) => s.stageId === deal.stageId)
        if (!stage) {
          stage = { stageId: deal.stageId, count: 0, sums: {} }
          result.stages.push(stage)
        }
        stage.count += 1
        const currency: DealCurrency = deal.currency
        stage.sums[currency] = (stage.sums[currency] ?? 0) + deal.amount
      }
      return result
    },
    async changeStage(_projectId, dealId, stageId, custom) {
      api.calls.push({
        action: 'changeStage',
        dealId,
        value: stageId,
        ...(custom ? { custom } : {}),
      })
      failIfAsked()
      const deal = find(dealId)
      deal.stageId = stageId
      // Пришедшая на этап — сверху колонки, как у API.
      api.deals = [deal, ...api.deals.filter((d) => d !== deal)]
    },
    async win(_projectId, dealId, custom) {
      api.calls.push({ action: 'win', dealId, ...(custom ? { custom } : {}) })
      failIfAsked()
      find(dealId)
      api.deals = api.deals.filter((d) => d.id !== dealId)
    },
    async lose(_projectId, dealId, lostReasonId) {
      api.calls.push({ action: 'lose', dealId, value: lostReasonId })
      failIfAsked()
      find(dealId)
      api.deals = api.deals.filter((d) => d.id !== dealId)
    },
    async take(_projectId, dealId) {
      api.calls.push({ action: 'take', dealId })
      failIfAsked()
      const deal = find(dealId)
      deal.ownerId = FAKE_ME.id
      deal.ownerName = FAKE_ME.name
    },
    async create(_projectId, input: NewDealInput) {
      api.calls.push({ action: 'create', value: input })
      failIfAsked()
      const contact = input.contact
      const deal = fakeDeal({
        title: input.title,
        pipelineId: input.pipelineId,
        stageId: input.stageId,
        amount: input.amount,
        currency: input.currency,
        ownerId: input.ownerId,
        ownerName: input.ownerId === FAKE_ME.id ? FAKE_ME.name : FAKE_COLLEAGUE.name,
        contactName: contact ? `${contact.firstName} ${contact.lastName ?? ''}`.trim() : null,
      })
      api.deals = [deal, ...api.deals]
      return { id: deal.id }
    },
    async searchContacts(_projectId, text) {
      const needle = text.trim().toLowerCase()
      return api.contacts.filter((c) =>
        `${c.firstName} ${c.lastName ?? ''}`.toLowerCase().includes(needle),
      )
    },
  }
  return api
}
