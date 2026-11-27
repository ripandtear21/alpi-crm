import type { ContactRecord } from '../../../components/contact-form/contacts-api.ts'
import type {
  ContactMergeRecord,
  MergePreview,
  MergeRecord,
  MergesApi,
  UndoResult,
  UndoSkip,
} from './merges-api.tsx'
import { MergesApiError } from './merges-api.tsx'

// Подставной клиент слияния для тестов экрана: слияния живут в памяти, контакты для ответов —
// из `contacts` (тот же список, что у подставного клиента контактов). Отказ на следующий вызов —
// `fail`.

export interface FakeMergesApi extends MergesApi {
  merges: ContactMergeRecord[]
  /** Что пропустит откат (итог отката). */
  skipped: UndoSkip[]
  /** Отказ на следующий вызов слияния или отката. */
  fail: MergesApiError | null
  calls: string[]
}

let counter = 0
/** Хвост записи вызова: выбранные сделки пар, если есть. */
const keepSuffix = (ids: readonly string[]) => (ids.length > 0 ? ` keep=${ids.join(',')}` : '')
const fakeId = () => `00000000-0000-4000-9500-${String(++counter).padStart(12, '0')}`

export function sampleMerge(overrides: Partial<ContactMergeRecord> = {}): ContactMergeRecord {
  return {
    id: fakeId(),
    entityType: 'contact',
    survivorId: '',
    mergedId: '',
    parentId: null,
    mergedBy: { id: 'user-1', name: 'Власник' },
    mergedAt: '2026-11-20T10:00:00.000Z',
    undoUntil: '2026-12-20T10:00:00.000Z',
    undoneAt: null,
    mergedContact: { id: '', firstName: 'Ірина', lastName: null },
    ...overrides,
  }
}

export function fakeMergesApi({
  contacts,
  preview = {},
}: {
  /** Контакты проекта: живой список подставного клиента контактов. */
  contacts: () => ContactRecord[]
  /** Что вернёт предпросмотр сверх двух контактов. */
  preview?: Partial<MergePreview>
}): FakeMergesApi {
  const contact = (id: string) => {
    const found = contacts().find((item) => item.id === id)
    if (!found) throw new MergesApiError(404, 'CONTACT_NOT_FOUND')
    return structuredClone(found)
  }
  const takeFailure = () => {
    const failure = api.fail
    api.fail = null
    if (failure) throw failure
  }
  const api: FakeMergesApi = {
    merges: [],
    skipped: [],
    fail: null,
    calls: [],
    async preview(_projectId, survivorId, mergedId, keepDealIds = []) {
      api.calls.push(`preview ${survivorId} ${mergedId}${keepSuffix(keepDealIds)}`)
      return {
        survivor: contact(survivorId),
        merged: contact(mergedId),
        fields: [],
        phones: [],
        emails: [],
        deals: 0,
        participations: 0,
        notes: 0,
        files: 0,
        dealsOutOfScope: 0,
        duplicateMarkCleared: false,
        ...preview,
        // Какая сделка пары остаётся — как в API: из keepDealIds, иначе сделка оставшегося.
        dealPairs: (preview.dealPairs ?? []).map((pair) =>
          pair.forbidden
            ? pair
            : {
                ...pair,
                keepDealId:
                  pair.mergedDeal && keepDealIds.includes(pair.mergedDeal.id)
                    ? pair.mergedDeal.id
                    : (pair.survivorDeal?.id ?? null),
              },
        ),
      }
    },
    async merge(_projectId, survivorId, mergedId, keepDealIds = []) {
      api.calls.push(`merge ${survivorId} ${mergedId}${keepSuffix(keepDealIds)}`)
      takeFailure()
      const merged = contact(mergedId)
      const record = sampleMerge({
        survivorId,
        mergedId,
        mergedContact: { id: mergedId, firstName: merged.firstName, lastName: merged.lastName },
      })
      api.merges.unshift(record)
      const { mergedContact: _name, ...merge } = record
      return { merge, contact: contact(survivorId) }
    },
    async contactMerges(_projectId, contactId) {
      api.calls.push(`merges ${contactId}`)
      return structuredClone(api.merges.filter((m) => m.survivorId === contactId && !m.undoneAt))
    },
    async undo(_projectId, mergeId) {
      api.calls.push(`undo ${mergeId}`)
      takeFailure()
      const record = api.merges.find((m) => m.id === mergeId)
      if (!record) throw new MergesApiError(404, 'MERGE_NOT_FOUND')
      record.undoneAt = '2026-11-21T10:00:00.000Z'
      const { mergedContact: _name, ...merge } = record
      const result: UndoResult = {
        merge: merge as MergeRecord,
        contact: contact(record.survivorId),
        mergedContact: contact(record.mergedId),
        skipped: structuredClone(api.skipped),
      }
      return result
    },
  }
  return api
}
