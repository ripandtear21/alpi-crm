import { projectHeaders } from '../project-switcher/projects-api.ts'

// Быстрый поиск к API: `GET /v1/search?q=…` (снаружи — /api/v1/search; тикет crm-deals/08,
// apps/api/src/search/search.ts) по сделкам, контактам и организациям текущего проекта. Охват
// роли держит сервер: в ответе только то, что пользователь вправе видеть.

/** Короче API отвечает пустыми группами — строка поиска такой запрос не отправляет. */
export const SEARCH_MIN_LENGTH = 2
/** Длиннее API отвечает 400 INVALID_SEARCH — поле столько не принимает. */
export const SEARCH_MAX_LENGTH = 200

export type SearchDealStatus = 'open' | 'won' | 'lost'

export interface SearchDealHit {
  id: string
  title: string
  status: SearchDealStatus
  /** Отметка архива; null — не в архиве. */
  archivedAt: string | null
}

export interface SearchContactHit {
  id: string
  firstName: string
  lastName: string | null
}

export interface SearchOrganizationHit {
  id: string
  name: string
}

/** Группа результатов одного типа. */
export interface SearchGroup<T> {
  items: T[]
  /** Есть ещё результаты сверх показанных. */
  hasMore: boolean
}

/** Ответ `GET /v1/search`. */
export interface SearchResults {
  deals: SearchGroup<SearchDealHit>
  contacts: SearchGroup<SearchContactHit>
  organizations: SearchGroup<SearchOrganizationHit>
}

export class SearchApiError extends Error {
  readonly status: number
  readonly code: string | null

  constructor(status: number, code: string | null) {
    super(`Поиск: API ответил ${status}${code ? ` ${code}` : ''}`)
    this.name = 'SearchApiError'
    this.status = status
    this.code = code
  }
}

export interface SearchApi {
  search(projectId: string, query: string, signal?: AbortSignal): Promise<SearchResults>
}

const EMPTY_GROUP = { items: [], hasMore: false }

/** Группа, которой нет в ответе (нет права смотреть этот тип), — пустая. */
function groupOf<T>(value: SearchGroup<T> | null | undefined): SearchGroup<T> {
  return value && Array.isArray(value.items) ? value : EMPTY_GROUP
}

export function createSearchApi(fetchImpl: typeof fetch = (...args) => fetch(...args)): SearchApi {
  return {
    async search(projectId, query, signal) {
      const res = await fetchImpl(`/api/v1/search?${new URLSearchParams({ q: query })}`, {
        headers: projectHeaders(projectId),
        credentials: 'same-origin',
        ...(signal ? { signal } : {}),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { code?: unknown } | null
        throw new SearchApiError(res.status, typeof body?.code === 'string' ? body.code : null)
      }
      const body = (await res.json()) as Partial<SearchResults>
      return {
        deals: groupOf(body.deals),
        contacts: groupOf(body.contacts),
        organizations: groupOf(body.organizations),
      }
    },
  }
}
