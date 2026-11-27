import {
  type DuplicateCounts,
  type DuplicateGroup,
  type DuplicatesApi,
  DuplicatesApiError,
  type DuplicateType,
  type MergePreview,
} from './duplicates-api.ts'

// Только для тестов: экран «Дублі» без сервера. Группы задаёт тест; «не дубль» убирает пару
// (и группу, если пар не осталось), слияние убирает слитую запись из групп и записывает вызов.

export interface FakeDuplicatesApi extends DuplicatesApi {
  calls: string[]
  /** Отказ следующего предпросмотра или слияния с этим кодом. */
  failNext(code: string, status?: number): void
}

export function createFakeDuplicatesApi(
  initial: DuplicateGroup[],
  counts: DuplicateCounts = {
    contact: initial.filter((g) => g.type === 'contact').length,
    deal: initial.filter((g) => g.type === 'deal').length,
  },
): FakeDuplicatesApi {
  let groups = structuredClone(initial)
  const calls: string[] = []
  let failure: DuplicatesApiError | null = null
  let merges = 0
  const takeFailure = () => {
    const error = failure
    failure = null
    if (error) throw error
  }
  const of = (type: DuplicateType) => groups.filter((group) => group.type === type)
  return {
    calls,
    failNext(code, status = 409) {
      failure = new DuplicatesApiError(status, code)
    },
    async counts() {
      if (counts.contact === null && counts.deal === null) return null
      return {
        contact: counts.contact === null ? null : of('contact').length,
        deal: counts.deal === null ? null : of('deal').length,
      }
    },
    async groups(_projectId, type) {
      return { data: structuredClone(of(type)), next_cursor: null }
    },
    async notDuplicate(_projectId, type, aId, bId) {
      calls.push(`not-duplicate ${type} ${aId} ${bId}`)
      groups = groups
        .map((group) => ({
          ...group,
          pairs: group.pairs.filter(
            (pair) =>
              !(pair.aId === aId && pair.bId === bId) && !(pair.aId === bId && pair.bId === aId),
          ),
        }))
        .filter((group) => group.pairs.length > 0)
    },
    async preview(_projectId, type, survivorId, mergedId): Promise<MergePreview> {
      calls.push(`preview ${type} ${survivorId} ${mergedId}`)
      takeFailure()
      return type === 'contact'
        ? { phones: ['+380671234567'], emails: [], deals: 2, notes: 1, files: 0, dealPairs: [] }
        : { products: 1, participants: 0, notes: 3, files: 0, fields: [] }
    },
    async merge(_projectId, type, survivorId, mergedId) {
      calls.push(`merge ${type} ${survivorId} ${mergedId}`)
      takeFailure()
      groups = groups
        .map((group) => ({
          ...group,
          recordIds: group.recordIds.filter((id) => id !== mergedId),
          records: group.records.filter((record) => record.id !== mergedId),
          pairs: group.pairs.filter((pair) => pair.aId !== mergedId && pair.bId !== mergedId),
        }))
        .filter((group) => group.pairs.length > 0)
      return { mergeId: `merge-${++merges}` }
    },
    async undo(_projectId, mergeId) {
      calls.push(`undo ${mergeId}`)
    },
  }
}
