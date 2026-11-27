import type { ReactNode } from 'react'
import {
  MergeApiProvider,
  type MergeRecord,
  mergeApiContext,
  mergeSend,
  type UndoSkip,
  undoMerge,
  useMergeApi,
} from '../../../../components/merge/merge-api.tsx'
import type { DealCard } from '../deal-card-api.ts'

/** Отказ API слияния — общий для контактов и сделок (components/merge/merge-api.tsx). */
export { MergeApiError as DealMergesApiError } from '../../../../components/merge/merge-api.tsx'

// Запросы слияния сделок (тикет crm-intake/02) к API (apps/api/src/merge/deals.ts): поиск
// второй сделки, что перейдёт, слить, слияния в сделку, откат. Всё — в контексте текущего
// проекта, по сессии. Отказ — DealMergesApiError с кодом и подробностями ответа. Общее со
// слиянием контактов (запрос, отказ, откат, провайдер) — components/merge/merge-api.tsx (тикет
// crm-intake/12).
//
// Клиент берётся из DealMergesApiProvider (тесты подставляют свой); без провайдера — настоящий,
// поэтому дерево маршрутов (router.tsx) о слиянии не знает.

/** Слияние (MergeView в apps/api/src/merge/store.ts). */
export type DealMergeRecord = MergeRecord

/** Что откат не вернул (UndoSkip в apps/api/src/merge/registry.ts). */
export type DealUndoSkip = UndoSkip

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

export function createDealMergesApi(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): DealMergesApi {
  const send = mergeSend(fetchImpl)
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
    undo: (projectId, mergeId) => undoMerge(send, projectId, mergeId),
  }
}

const context = mergeApiContext(createDealMergesApi)

export function DealMergesApiProvider({
  api,
  children,
}: {
  api: DealMergesApi
  children: ReactNode
}) {
  return (
    <MergeApiProvider of={context} api={api}>
      {children}
    </MergeApiProvider>
  )
}

/** Клиент слияния сделок: из провайдера или настоящий. */
export const useDealMergesApi = (): DealMergesApi => useMergeApi(context)
