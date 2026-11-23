import { normalizePhone } from '@alpi/shared'
import {
  SEARCH_MIN_LENGTH,
  type SearchApi,
  SearchApiError,
  type SearchContactHit,
  type SearchDealHit,
  type SearchOrganizationHit,
  type SearchResults,
} from './search-api.ts'

// Подставной клиент быстрого поиска для тестов. Ищет как сервер тикета crm-deals/08 в общих
// чертах: телефон — по номеру в E.164 (только контакты), текст — подстрокой в названии сделки,
// имени контакта и названии организации. Охват роли — тоже «на сервере»: сделки, которых нет
// в `visibleDeals`, в ответ не попадают.

export interface FakeSearchDeal extends SearchDealHit {
  ownerId: string | null
}

export interface FakeSearchContact extends SearchContactHit {
  /** E.164. */
  phones: string[]
}

export interface FakeSearchApi extends SearchApi {
  calls: { projectId: string; query: string }[]
}

const PHONE_LIKE = /^\+?[\d\s().-]+$/
const GROUP_SIZE = 10

function group<T>(rows: T[]) {
  return { items: rows.slice(0, GROUP_SIZE), hasMore: rows.length > GROUP_SIZE }
}

export function fakeSearchApi({
  deals = [],
  contacts = [],
  organizations = [],
  visibleDeals = () => true,
  failWith,
}: {
  deals?: FakeSearchDeal[]
  contacts?: FakeSearchContact[]
  organizations?: SearchOrganizationHit[]
  /** Охват роли на сервере: какие сделки пользователь вправе видеть. */
  visibleDeals?: (deal: FakeSearchDeal) => boolean
  /** Ответ API с ошибкой: статус и код. */
  failWith?: { status: number; code: string | null }
} = {}): FakeSearchApi {
  const api: FakeSearchApi = {
    calls: [],
    async search(projectId, query) {
      api.calls.push({ projectId, query })
      if (failWith) throw new SearchApiError(failWith.status, failWith.code)
      const q = query.trim()
      const empty: SearchResults = {
        deals: group([]),
        contacts: group([]),
        organizations: group([]),
      }
      if (q.length < SEARCH_MIN_LENGTH) return empty
      if (PHONE_LIKE.test(q) && /\d/.test(q)) {
        const e164 = normalizePhone(q)
        return {
          ...empty,
          contacts: group(
            contacts
              .filter((contact) => e164 !== null && contact.phones.includes(e164))
              .map(({ id, firstName, lastName }) => ({ id, firstName, lastName })),
          ),
        }
      }
      const has = (text: string) => text.toLowerCase().includes(q.toLowerCase())
      return {
        deals: group(
          deals
            .filter((deal) => visibleDeals(deal) && has(deal.title))
            .map(({ id, title, status, archivedAt }) => ({ id, title, status, archivedAt })),
        ),
        contacts: group(
          contacts
            .filter((contact) => has(`${contact.firstName} ${contact.lastName ?? ''}`))
            .map(({ id, firstName, lastName }) => ({ id, firstName, lastName })),
        ),
        organizations: group(organizations.filter((organization) => has(organization.name))),
      }
    },
  }
  return api
}
