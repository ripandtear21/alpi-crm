import { createContext, type ReactNode, useContext, useState } from 'react'
import { projectHeaders } from '../../../../components/project-switcher/projects-api.ts'
import type { DealCard } from '../deal-card-api.ts'

// Запросы слияния сделок (тикет crm-intake/02) к API (apps/api/src/merge/deals.ts): поиск
// второй сделки, что перейдёт, слить, слияния в сделку, откат. Всё — в контексте текущего
// проекта, по сессии. Отказ — DealMergesApiError с кодом и подробностями ответа.
//
// Клиент берётся из DealMergesApiProvider (тесты подставляют свой); без провайдера — настоящий,
// поэтому дерево маршрутов (router.tsx) о слиянии не знает.

/** Слияние (MergeView в apps/api/src/merge/store.ts). */
export interface DealMergeRecord {
  id: string
  entityType: 'contact' | 'deal'
  survivorId: string
  mergedId: string
  parentId: string | null
  mergedBy: { id: string; name: string } | null
  mergedAt: string
  undoUntil: string
  undoneAt: string | null
}

/** Слияние в карточке оставшейся: с названием слитой сделки. */
export interface DealMergeListItem extends DealMergeRecord {
  mergedDeal: { id: string; title: string }
}

/** Что перейдёт (DealMergePreview в apps/api/src/merge/deals.ts). */
export interface DealMergePreview {
  survivor: DealCard
  merged: DealCard
  /** Пустые поля оставшейся, которые заполнятся; у суммы значение — `{ amount, currency }`. */
  fields: { field: string; value: unknown }[]
  products: number
  convertedProducts: number
  participants: number
  primaryContactId: string | null
  notes: number
  files: number
}

/** Что откат не вернул (UndoSkip в apps/api/src/merge/registry.ts). */
export interface DealUndoSkip {
  kind: string
  itemId: string | null
  field: string | null
  value: unknown
  /** `gone` — удалено, `changed` — изменено после слияния. */
  reason: 'gone' | 'changed'
}

export interface DealUndoResult {
  merge: DealMergeRecord
  deal: DealCard
  mergedDeal: DealCard
  skipped: DealUndoSkip[]
}

/** Сделка в поиске второй сделки (`GET /v1/search`, группа deals). */
export interface DealHit {
  id: string
  title: string
  status: 'open' | 'won' | 'lost'
  archivedAt: string | null
}

export interface DealMergesApi {
  /** Сделки по названию (не меньше двух символов). */
  searchDeals(projectId: string, query: string): Promise<DealHit[]>
  preview(projectId: string, survivorId: string, mergedId: string): Promise<DealMergePreview>
  merge(
    projectId: string,
    survivorId: string,
    mergedId: string,
  ): Promise<{ merge: DealMergeRecord; deal: DealCard }>
  /** Слияния в сделку, которые ещё можно откатить. */
  dealMerges(projectId: string, dealId: string): Promise<DealMergeListItem[]>
  undo(projectId: string, mergeId: string): Promise<DealUndoResult>
}

export class DealMergesApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Record<string, unknown>

  constructor(status: number, code: string, details: Record<string, unknown> = {}) {
    super(`API слияния сделок ответил ${status} ${code}`)
    this.name = 'DealMergesApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export function createDealMergesApi(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): DealMergesApi {
  async function send<T>(projectId: string, method: string, path: string, body?: unknown) {
    // projectHeaders возвращает Headers: разворот `...` дал бы пустой объект и потерял бы X-Project-Id.
    const headers = projectHeaders(projectId)
    if (body !== undefined) headers.set('content-type', 'application/json')
    const res = await fetchImpl(`/api${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const payload = (await res.json().catch(() => null)) as unknown
    if (!res.ok) {
      const problem = (payload ?? {}) as { code?: unknown; details?: unknown }
      throw new DealMergesApiError(
        res.status,
        typeof problem.code === 'string' ? problem.code : '',
        typeof problem.details === 'object' && problem.details !== null
          ? (problem.details as Record<string, unknown>)
          : {},
      )
    }
    return payload as T
  }
  return {
    searchDeals: async (projectId, query) =>
      (
        await send<{ deals: { items: DealHit[] } }>(
          projectId,
          'GET',
          `/v1/search?q=${encodeURIComponent(query)}`,
        )
      ).deals.items,
    preview: (projectId, survivorId, mergedId) =>
      send(projectId, 'POST', `/v1/deals/${survivorId}/merge/preview`, {
        merge_deal_id: mergedId,
      }),
    merge: (projectId, survivorId, mergedId) =>
      send(projectId, 'POST', `/v1/deals/${survivorId}/merge`, { merge_deal_id: mergedId }),
    dealMerges: (projectId, dealId) => send(projectId, 'GET', `/v1/deals/${dealId}/merges`),
    undo: (projectId, mergeId) => send(projectId, 'POST', `/v1/merges/${mergeId}/undo`),
  }
}

const DealMergesApiContext = createContext<DealMergesApi | null>(null)

export function DealMergesApiProvider({
  api,
  children,
}: {
  api: DealMergesApi
  children: ReactNode
}) {
  return <DealMergesApiContext.Provider value={api}>{children}</DealMergesApiContext.Provider>
}

/** Клиент слияния сделок: из провайдера или настоящий. */
export function useDealMergesApi(): DealMergesApi {
  const provided = useContext(DealMergesApiContext)
  const [real] = useState(createDealMergesApi)
  return provided ?? real
}
