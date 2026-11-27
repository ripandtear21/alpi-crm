import type {
  Registration,
  RegistrationsApi,
  RegistrationsApiError,
  RegistrationsOwner,
} from './registrations-api.tsx'

// Подставной клиент регистраций для тестов экрана: регистрации в памяти, страницы по `pageSize`
// (курсор — номер следующей строки). Порядок — как в массиве: тест кладёт новые сверху, как
// отдаёт API; у записи без регистраций — пустой список. `fail` — отказ на следующий запрос.

export interface FakeRegistrationsApi extends RegistrationsApi {
  /** Регистрации сделки или контакта по ключу `deal:<id>` / `contact:<id>`. */
  byOwner: Map<string, Registration[]>
  pageSize: number
  fail: RegistrationsApiError | null
  calls: string[]
}

let counter = 0
const fakeId = () => `00000000-0000-4000-9700-${String(++counter).padStart(12, '0')}`

export function sampleRegistration(overrides: Partial<Registration> = {}): Registration {
  return {
    id: fakeId(),
    sourceId: '00000000-0000-4000-9701-000000000001',
    sourceName: 'Лендінг курсу',
    contactId: '',
    dealId: null,
    dealTitle: null,
    eventId: `evt-${counter}`,
    createdAt: '2026-11-20T10:00:00.000Z',
    registeredAt: null,
    name: 'Ірина Мельник',
    phone: '+380671234567',
    phoneRaw: null,
    dialCode: null,
    email: null,
    form: null,
    webinar: null,
    planName: null,
    pageUrl: null,
    referrer: null,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    utmTerm: null,
    utmContent: null,
    adId: null,
    gclid: null,
    gbraid: null,
    wbraid: null,
    fbclid: null,
    fbp: null,
    fbc: null,
    userAgent: null,
    extra: {},
    view: null,
    ...overrides,
  }
}

const keyOf = (owner: RegistrationsOwner) => `${owner.kind}:${owner.id}`

export function fakeRegistrationsApi(
  entries: Record<string, Registration[]> = {},
  pageSize = 20,
): FakeRegistrationsApi {
  const api: FakeRegistrationsApi = {
    byOwner: new Map(Object.entries(entries)),
    pageSize,
    fail: null,
    calls: [],
    async list(_projectId, owner, cursor) {
      api.calls.push(`${keyOf(owner)}@${cursor ?? 0}`)
      if (api.fail) {
        const failure = api.fail
        api.fail = null
        throw failure
      }
      const rows = api.byOwner.get(keyOf(owner)) ?? []
      const start = cursor === null ? 0 : Number(cursor)
      const end = start + api.pageSize
      return {
        data: rows.slice(start, end),
        next_cursor: end < rows.length ? String(end) : null,
      }
    },
  }
  return api
}
