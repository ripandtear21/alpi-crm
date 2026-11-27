import { type Context, createContext, type ReactNode, useContext, useState } from 'react'
import { projectHeaders } from '../project-switcher/projects-api.ts'

// Общее у клиентов слияния контактов (routes/contacts/merge/merges-api.tsx, тикет crm-intake/01)
// и сделок (routes/deals/$dealId/merge/deal-merges-api.tsx, тикет crm-intake/02) — тикет
// crm-intake/12: запись слияния и пропуск отката (как их отдаёт apps/api/src/merge/store.ts и
// registry.ts), отказ API с кодом и подробностями, запрос в контексте проекта по сессии, откат
// (общий маршрут `/v1/merges/:id/undo`) и провайдер клиента (тесты подставляют свой; без
// провайдера — настоящий, поэтому дерево маршрутов о слиянии не знает).

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

/** Что откат не вернул (UndoSkip в apps/api/src/merge/registry.ts). */
export interface UndoSkip {
  kind: string
  itemId: string | null
  field: string | null
  value: unknown
  /** `gone` — удалено окончательно, `changed` — изменено после слияния. */
  reason: 'gone' | 'changed'
}

/** Отказ API слияния или отката: статус, код и подробности ответа. */
export class MergeApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Record<string, unknown>

  constructor(status: number, code: string, details: Record<string, unknown> = {}) {
    super(`API слияния ответил ${status} ${code}`)
    this.name = 'MergeApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/** Код отказа API слияния; не отказ API — пустая строка. */
export const mergeErrorCode = (failure: unknown): string =>
  failure instanceof MergeApiError ? failure.code : ''

/** Запрос к API в контексте проекта `projectId`; отказ — MergeApiError. */
export type MergeSend = <T>(
  projectId: string,
  method: string,
  path: string,
  body?: unknown,
) => Promise<T>

export function mergeSend(fetchImpl: typeof fetch): MergeSend {
  return async <T,>(projectId: string, method: string, path: string, body?: unknown) => {
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
      throw new MergeApiError(
        res.status,
        typeof problem.code === 'string' ? problem.code : '',
        typeof problem.details === 'object' && problem.details !== null
          ? (problem.details as Record<string, unknown>)
          : {},
      )
    }
    return payload as T
  }
}

/** Откат слияния `mergeId` — маршрут общий для контактов и сделок. */
export const undoMerge = <T,>(send: MergeSend, projectId: string, mergeId: string) =>
  send<T>(projectId, 'POST', `/v1/merges/${mergeId}/undo`)

/** Клиент слияния для провайдера: контекст и настоящий клиент (`create`), когда провайдера нет. */
export interface MergeApiContext<Api> {
  context: Context<Api | null>
  create: () => Api
}

export const mergeApiContext = <Api,>(create: () => Api): MergeApiContext<Api> => ({
  context: createContext<Api | null>(null),
  create,
})

/** Провайдер клиента слияния `of`: тесты подставляют свой. */
export function MergeApiProvider<Api>({
  of,
  api,
  children,
}: {
  of: MergeApiContext<Api>
  api: Api
  children: ReactNode
}) {
  const { Provider } = of.context
  return <Provider value={api}>{children}</Provider>
}

/** Клиент слияния `of`: из провайдера или настоящий. */
export function useMergeApi<Api>(of: MergeApiContext<Api>): Api {
  const provided = useContext(of.context)
  const [real] = useState(of.create)
  return provided ?? real
}
