import {
  type FakeMergeState,
  fakeMergeIds,
  mergeRecordOf,
  sampleMergeRecord,
  survivorMerges,
  takeFailure,
  undoneMerge,
} from '../../../../components/merge/fake-merge-api.ts'
import type { DealCard } from '../deal-card-api.ts'
import type { FakeDealCardApi } from '../fake-deal-card-api.ts'
import {
  type DealHit,
  type DealMergeListItem,
  type DealMergePreview,
  type DealMergesApi,
  DealMergesApiError,
} from './deal-merges-api.tsx'

// Подставной клиент слияния сделок для тестов экрана: слияния живут в памяти, сделки — в
// подставном клиенте карточки (`cards`): слияние скрывает вторую сделку (её запрос отвечает
// 404 DEAL_MERGED), откат возвращает. Отказ на следующий вызов слияния или отката — `fail`.
// Общее с контактами — components/merge/fake-merge-api.ts (тикет crm-intake/12).

export interface FakeDealMergesApi extends DealMergesApi, FakeMergeState<DealMergeListItem> {}

const fakeId = fakeMergeIds('9600')

export function sampleDealMerge(overrides: Partial<DealMergeListItem> = {}): DealMergeListItem {
  return {
    ...sampleMergeRecord('deal', fakeId(), '2099-12-20T10:00:00.000Z'),
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
      takeFailure(api)
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
      return { merge: mergeRecordOf(item), deal: deal(survivorId) }
    },
    async dealMerges(_projectId, dealId) {
      api.calls.push(`merges ${dealId}`)
      return survivorMerges(api, dealId)
    },
    async undo(_projectId, mergeId) {
      const item = undoneMerge(api, mergeId)
      const { [item.mergedId]: _hidden, ...visible } = cards.mergedInto
      cards.mergedInto = visible
      return {
        merge: mergeRecordOf(item),
        deal: deal(item.survivorId),
        mergedDeal: deal(item.mergedId),
        skipped: structuredClone(api.skipped),
      }
    },
  }
  return api
}
