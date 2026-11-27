import { createContext, type ReactNode, useContext, useState } from 'react'
import type { ContactRecord } from '../../../components/contact-form/contacts-api.ts'
import { projectHeaders } from '../../../components/project-switcher/projects-api.ts'

// Запросы слияния контактов (тикет crm-intake/01) к API (apps/api/src/merge/contacts.ts): что
// перейдёт, слить, слияния в контакт, откат. Всё — в контексте текущего проекта, по сессии.
// Отказ — MergesApiError с кодом и подробностями ответа.
//
// Клиент берётся из MergesApiProvider (тесты подставляют свой); без провайдера — настоящий,
// поэтому дерево маршрутов (router.tsx) о слиянии не знает.

/** Слияние (MergeView в apps/api/src/merge/store.ts). */
export interface MergeRecord {
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

/** Что откат не вернул (UndoSkip в apps/api/src/merge/registry.ts). */
export interface UndoSkip {
  kind: string
  itemId: string | null
  field: string | null
  value: unknown
  /** `gone` — удалено окончательно, `changed` — изменено после слияния. */
  reason: 'gone' | 'changed'
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

export class MergesApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Record<string, unknown>

  constructor(status: number, code: string, details: Record<string, unknown> = {}) {
    super(`API слияния ответил ${status} ${code}`)
    this.name = 'MergesApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export function createMergesApi(fetchImpl: typeof fetch = (...args) => fetch(...args)): MergesApi {
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
      throw new MergesApiError(
        res.status,
        typeof problem.code === 'string' ? problem.code : '',
        typeof problem.details === 'object' && problem.details !== null
          ? (problem.details as Record<string, unknown>)
          : {},
      )
    }
    return payload as T
  }
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
    undo: (projectId, mergeId) => send(projectId, 'POST', `/v1/merges/${mergeId}/undo`),
  }
}

const MergesApiContext = createContext<MergesApi | null>(null)

export function MergesApiProvider({ api, children }: { api: MergesApi; children: ReactNode }) {
  return <MergesApiContext.Provider value={api}>{children}</MergesApiContext.Provider>
}

/** Клиент слияния: из провайдера или настоящий. */
export function useMergesApi(): MergesApi {
  const provided = useContext(MergesApiContext)
  const [real] = useState(createMergesApi)
  return provided ?? real
}
