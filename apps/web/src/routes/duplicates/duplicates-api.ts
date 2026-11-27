import { projectHeaders } from '../../components/project-switcher/projects-api.ts'

// Запросы экрана «Дублі» (тикет crm-intake/05) к API: группы похожих записей и «не дубль»
// (apps/api/src/duplicates/routes.ts), счётчик в шапке, а объединение — существующими
// запросами слияния контактов и сделок с откатом (apps/api/src/merge). Всё — в контексте
// текущего проекта, по сессии. Отказ — DuplicatesApiError с кодом ответа.

export type DuplicateType = 'contact' | 'deal'

export type DuplicateReason = 'phone' | 'email' | 'mark' | 'name_phone' | 'open_deals'

/** Контакт группы (DuplicateContactRecord в apps/api/src/duplicates/routes.ts). */
export interface DuplicateContact {
  id: string
  firstName: string
  lastName: string | null
  phones: string[]
  emails: string[]
  createdAt: string
}

/** Сделка группы (DuplicateDealRecord там же). */
export interface DuplicateDeal {
  id: string
  title: string
  pipelineName: string
  stageName: string
  archived: boolean
  amount: string
  currency: string
  ownerName: string | null
  contactName: string
  createdAt: string
}

export interface DuplicatePair {
  aId: string
  bId: string
  reasons: DuplicateReason[]
}

export interface DuplicateGroup {
  id: string
  type: DuplicateType
  recordIds: string[]
  reasons: DuplicateReason[]
  pairs: DuplicatePair[]
  foundAt: string
  records: (DuplicateContact | DuplicateDeal)[]
}

export interface DuplicateGroupsPage {
  data: DuplicateGroup[]
  next_cursor: string | null
}

/** Число групп по типам; null — нет права «изменять» этот раздел. */
export type DuplicateCounts = Record<DuplicateType, number | null>

/**
 * Что перейдёт при слиянии — ответ `…/merge/preview` как есть (MergePreview контактов или
 * DealMergePreview сделок): экран показывает числа и списки, которые в нём есть.
 */
export type MergePreview = Record<string, unknown>

export interface DuplicatesApi {
  /** null — ни на один тип нет права (API ответил 403). */
  counts(projectId: string): Promise<DuplicateCounts | null>
  groups(
    projectId: string,
    type: DuplicateType,
    cursor?: string | null,
  ): Promise<DuplicateGroupsPage>
  notDuplicate(projectId: string, type: DuplicateType, aId: string, bId: string): Promise<void>
  preview(
    projectId: string,
    type: DuplicateType,
    survivorId: string,
    mergedId: string,
  ): Promise<MergePreview>
  /** Слияние `mergedId` в `survivorId`; ответ — id слияния для отката. */
  merge(
    projectId: string,
    type: DuplicateType,
    survivorId: string,
    mergedId: string,
  ): Promise<{ mergeId: string }>
  undo(projectId: string, mergeId: string): Promise<void>
}

export class DuplicatesApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string) {
    super(`API дублей ответил ${status} ${code}`)
    this.name = 'DuplicatesApiError'
    this.status = status
    this.code = code
  }
}

const SECTION: Record<DuplicateType, string> = { contact: 'contacts', deal: 'deals' }
const MERGED_FIELD: Record<DuplicateType, string> = {
  contact: 'merge_contact_id',
  deal: 'merge_deal_id',
}

export function createDuplicatesApi(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): DuplicatesApi {
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
      const code = (payload as { code?: unknown } | null)?.code
      throw new DuplicatesApiError(res.status, typeof code === 'string' ? code : '')
    }
    return payload as T
  }

  return {
    async counts(projectId) {
      try {
        return await send<DuplicateCounts>(projectId, 'GET', '/v1/duplicates/count')
      } catch (error) {
        if (error instanceof DuplicatesApiError && error.status === 403) return null
        throw error
      }
    },
    groups(projectId, type, cursor) {
      const query = new URLSearchParams({ type })
      if (cursor) query.set('cursor', cursor)
      return send(projectId, 'GET', `/v1/duplicates?${query}`)
    },
    async notDuplicate(projectId, type, aId, bId) {
      await send(projectId, 'POST', '/v1/duplicates/not-duplicate', { type, a_id: aId, b_id: bId })
    },
    preview(projectId, type, survivorId, mergedId) {
      return send(projectId, 'POST', `/v1/${SECTION[type]}/${survivorId}/merge/preview`, {
        [MERGED_FIELD[type]]: mergedId,
      })
    },
    async merge(projectId, type, survivorId, mergedId) {
      const result = await send<{ merge: { id: string } }>(
        projectId,
        'POST',
        `/v1/${SECTION[type]}/${survivorId}/merge`,
        { [MERGED_FIELD[type]]: mergedId },
      )
      return { mergeId: result.merge.id }
    },
    async undo(projectId, mergeId) {
      await send(projectId, 'POST', `/v1/merges/${mergeId}/undo`, {})
    },
  }
}
