import type { ContactRecord } from '../../../components/contact-form/contacts-api.ts'
import {
  type FakeMergeState,
  fakeMergeIds,
  mergeRecordOf,
  sampleMergeRecord,
  survivorMerges,
  takeFailure,
  undoneMerge,
} from '../../../components/merge/fake-merge-api.ts'
import type { ContactMergeRecord, MergePreview, MergesApi, UndoResult } from './merges-api.tsx'
import { MergesApiError } from './merges-api.tsx'

// Подставной клиент слияния для тестов экрана: слияния живут в памяти, контакты для ответов —
// из `contacts` (тот же список, что у подставного клиента контактов). Отказ на следующий вызов —
// `fail`. Общее со сделками — components/merge/fake-merge-api.ts (тикет crm-intake/12).

export interface FakeMergesApi extends MergesApi, FakeMergeState<ContactMergeRecord> {}

/** Хвост записи вызова: выбранные сделки пар, если есть. */
const keepSuffix = (ids: readonly string[]) => (ids.length > 0 ? ` keep=${ids.join(',')}` : '')
const fakeId = fakeMergeIds('9500')

export function sampleMerge(overrides: Partial<ContactMergeRecord> = {}): ContactMergeRecord {
  return {
    ...sampleMergeRecord('contact', fakeId(), '2026-12-20T10:00:00.000Z'),
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
      takeFailure(api)
      const merged = contact(mergedId)
      const record = sampleMerge({
        survivorId,
        mergedId,
        mergedContact: { id: mergedId, firstName: merged.firstName, lastName: merged.lastName },
      })
      api.merges.unshift(record)
      return { merge: mergeRecordOf(record), contact: contact(survivorId) }
    },
    async contactMerges(_projectId, contactId) {
      api.calls.push(`merges ${contactId}`)
      return survivorMerges(api, contactId)
    },
    async undo(_projectId, mergeId) {
      const record = undoneMerge(api, mergeId)
      const result: UndoResult = {
        merge: mergeRecordOf(record),
        contact: contact(record.survivorId),
        mergedContact: contact(record.mergedId),
        skipped: structuredClone(api.skipped),
      }
      return result
    },
  }
  return api
}
