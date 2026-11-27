import type { ReactNode } from 'react'
import type { ContactRecord } from '../../../components/contact-form/contacts-api.ts'
import {
  MergeApiProvider,
  type MergeRecord,
  mergeApiContext,
  mergeSend,
  type UndoSkip,
  undoMerge,
  useMergeApi,
} from '../../../components/merge/merge-api.tsx'

export type { MergeRecord, UndoSkip } from '../../../components/merge/merge-api.tsx'
/** Отказ API слияния — общий для контактов и сделок (components/merge/merge-api.tsx). */
export { MergeApiError as MergesApiError } from '../../../components/merge/merge-api.tsx'

// Запросы слияния контактов (тикет crm-intake/01) к API (apps/api/src/merge/contacts.ts): что
// перейдёт, слить, слияния в контакт, откат. Всё — в контексте текущего проекта, по сессии.
// Отказ — MergesApiError с кодом и подробностями ответа. Общее со слиянием сделок (запрос,
// отказ, откат, провайдер) — components/merge/merge-api.tsx (тикет crm-intake/12).
//
// Клиент берётся из MergesApiProvider (тесты подставляют свой); без провайдера — настоящий,
// поэтому дерево маршрутов (router.tsx) о слиянии не знает.

/** Слияние в карточке оставшегося: с именем слитого контакта. */
export interface ContactMergeRecord extends MergeRecord {
  mergedContact: { id: string; firstName: string; lastName: string | null }
}

/** Что перейдёт (MergePreview в apps/api/src/merge/contacts.ts). */
export interface MergePreview {
  survivor: ContactRecord
  merged: ContactRecord
  fields: { field: string; value: unknown }[]
  phones: string[]
  emails: string[]
  deals: number
  participations: number
  notes: number
  files: number
  dealsOutOfScope: number
  duplicateMarkCleared: boolean
  /** Пары конфликтующих сделок: объединятся в том же действии (тикет crm-intake/04). */
  dealPairs: DealPairPreview[]
}

/** Сделка пары в предпросмотре (часть DealView в apps/api/src/deals/store.ts). */
export interface MergePairDeal {
  id: string
  title: string
  amount: number
  currency: string
}

/** Пара конфликтующих сделок (DealPairPreview в apps/api/src/merge/contacts.ts). */
export interface DealPairPreview {
  pipeline: { id: string; name: string }
  /** Нет права на обе сделки пары: данных сделок нет, слияние ответит 403 MERGE_DEAL_FORBIDDEN. */
  forbidden: boolean
  /** Сделка контакта, который остаётся; null — forbidden. */
  survivorDeal: MergePairDeal | null
  /** Сделка контакта, который будет скрыт; null — forbidden. */
  mergedDeal: MergePairDeal | null
  /** Какая из двух останется; null — forbidden. */
  keepDealId: string | null
}

export interface UndoResult {
  merge: MergeRecord
  contact: ContactRecord
  mergedContact: ContactRecord
  skipped: UndoSkip[]
}

export interface MergesApi {
  /** `keepDealIds` — сделки пар, которые остаются вместо сделки оставшегося контакта. */
  preview(
    projectId: string,
    survivorId: string,
    mergedId: string,
    keepDealIds?: string[],
  ): Promise<MergePreview>
  merge(
    projectId: string,
    survivorId: string,
    mergedId: string,
    keepDealIds?: string[],
  ): Promise<{ merge: MergeRecord; contact: ContactRecord }>
  /** Слияния в контакт, которые ещё можно откатить. */
  contactMerges(projectId: string, contactId: string): Promise<ContactMergeRecord[]>
  undo(projectId: string, mergeId: string): Promise<UndoResult>
}

export function createMergesApi(fetchImpl: typeof fetch = (...args) => fetch(...args)): MergesApi {
  const send = mergeSend(fetchImpl)
  const mergeBody = (mergedId: string, keepDealIds: string[] = []) => ({
    merge_contact_id: mergedId,
    ...(keepDealIds.length > 0 ? { keep_deal_ids: keepDealIds } : {}),
  })
  return {
    preview: (projectId, survivorId, mergedId, keepDealIds) =>
      send(
        projectId,
        'POST',
        `/v1/contacts/${survivorId}/merge/preview`,
        mergeBody(mergedId, keepDealIds),
      ),
    merge: (projectId, survivorId, mergedId, keepDealIds) =>
      send(projectId, 'POST', `/v1/contacts/${survivorId}/merge`, mergeBody(mergedId, keepDealIds)),
    contactMerges: (projectId, contactId) =>
      send(projectId, 'GET', `/v1/contacts/${contactId}/merges`),
    undo: (projectId, mergeId) => undoMerge(send, projectId, mergeId),
  }
}

const context = mergeApiContext(createMergesApi)

export function MergesApiProvider({ api, children }: { api: MergesApi; children: ReactNode }) {
  return (
    <MergeApiProvider of={context} api={api}>
      {children}
    </MergeApiProvider>
  )
}

/** Клиент слияния: из провайдера или настоящий. */
export const useMergesApi = (): MergesApi => useMergeApi(context)
