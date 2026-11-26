import type { DealCard } from '../deal-card-api.ts'
import type { FakeDealCardApi } from '../fake-deal-card-api.ts'
import {
  type DealHit,
  type DealMergeListItem,
  type DealMergePreview,
  type DealMergeRecord,
  type DealMergesApi,
  DealMergesApiError,
  type DealUndoSkip,
} from './deal-merges-api.tsx'

// Подставной клиент слияния сделок для тестов экрана: слияния живут в памяти, сделки — в
// подставном клиенте карточки (`cards`): слияние скрывает вторую сделку (её запрос отвечает
// 404 DEAL_MERGED), откат возвращает. Отказ на следующий вызов слияния или отката — `fail`.

export interface FakeDealMergesApi extends DealMergesApi {
  merges: DealMergeListItem[]
  /** Что пропустит откат (итог отката). */
  skipped: DealUndoSkip[]
  /** Отказ на следующий вызов слияния или отката. */
  fail: DealMergesApiError | null
  calls: string[]
}

let counter = 0
const fakeId = () => `00000000-0000-4000-9600-${String(++counter).padStart(12, '0')}`

export function sampleDealMerge(overrides: Partial<DealMergeListItem> = {}): DealMergeListItem {
  return {
    id: fakeId(),
    entityType: 'deal',
    survivorId: '',
    mergedId: '',
    parentId: null,
    mergedBy: { id: 'user-1', name: 'Власник' },
    mergedAt: '2026-11-20T10:00:00.000Z',
    undoUntil: '2099-12-20T10:00:00.000Z',
    undoneAt: null,
    mergedDeal: { id: '', title: '' },
    ...overrides,
  }
}

export function fakeDealMergesApi({
  cards,
  preview = {},
}: {
  /** Подставной клиент карточки: его сделки ищутся и сливаются. */
  cards: FakeDealCardApi
  /** Что вернёт предпросмотр сверх двух сделок. */
  preview?: Partial<Omit<DealMergePreview, 'survivor' | 'merged'>>
}): FakeDealMergesApi {
  const deal = (id: string): DealCard => {
    const found = cards.deals.find((item) => item.id === id)
    if (!found || cards.mergedInto[id]) throw new DealMergesApiError(404, 'DEAL_NOT_FOUND')
    return structuredClone(found)
  }
  const takeFailure = () => {
    const failure = api.fail
    api.fail = null
    if (failure) throw failure
  }
  const record = (item: DealMergeListItem): DealMergeRecord => {
    const { mergedDeal: _title, ...merge } = item
    return structuredClone(merge)
  }
  const api: FakeDealMergesApi = {
    merges: [],
    skipped: [],
    fail: null,
    calls: [],
    async searchDeals(_projectId, query) {
      api.calls.push(`search ${query}`)
      const text = query.toLocaleLowerCase()
      return cards.deals
        .filter((item) => !cards.mergedInto[item.id] && item.deletedAt === null)
        .filter((item) => item.title.toLocaleLowerCase().includes(text))
        .map(
          (item): DealHit => ({
            id: item.id,
            title: item.title,
            status: item.status,
            archivedAt: item.archivedAt,
          }),
        )
    },
    async preview(_projectId, survivorId, mergedId) {
      api.calls.push(`preview ${survivorId} ${mergedId}`)
      return {
        survivor: deal(survivorId),
        merged: deal(mergedId),
        fields: [],
        products: 0,
        convertedProducts: 0,
        participants: 0,
        primaryContactId: null,
        notes: 0,
        files: 0,
        ...preview,
      }
    },
    async merge(_projectId, survivorId, mergedId) {
      api.calls.push(`merge ${survivorId} ${mergedId}`)
      takeFailure()
      const merged = deal(mergedId)
      const item = sampleDealMerge({
        survivorId,
        mergedId,
        mergedDeal: { id: mergedId, title: merged.title },
      })
      api.merges.unshift(item)
      cards.mergedInto[mergedId] = {
        merged_into_id: survivorId,
        merge_id: item.id,
        undo_until: item.undoUntil,
      }
      return { merge: record(item), deal: deal(survivorId) }
    },
    async dealMerges(_projectId, dealId) {
      api.calls.push(`merges ${dealId}`)
      return structuredClone(api.merges.filter((m) => m.survivorId === dealId && !m.undoneAt))
    },
    async undo(_projectId, mergeId) {
      api.calls.push(`undo ${mergeId}`)
      takeFailure()
      const item = api.merges.find((m) => m.id === mergeId)
      if (!item) throw new DealMergesApiError(404, 'MERGE_NOT_FOUND')
      item.undoneAt = '2026-11-21T10:00:00.000Z'
      const { [item.mergedId]: _hidden, ...visible } = cards.mergedInto
      cards.mergedInto = visible
      return {
        merge: record(item),
        deal: deal(item.survivorId),
        mergedDeal: deal(item.mergedId),
        skipped: structuredClone(api.skipped),
      }
    },
  }
  return api
}
