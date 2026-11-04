import type { AuditActor, AuditPage, ProjectAuditAction } from '@alpi/shared'
import { projectHeaders } from '../../components/project-switcher/projects-api.ts'

// Запросы журнала проекта к API (apps/api/src/audit/routes.ts). Все — в контексте проекта.

export interface AuditFilter {
  action?: ProjectAuditAction
  actor?: string
  cursor?: string
}

export interface AuditApi {
  page(projectId: string, filter: AuditFilter): Promise<AuditPage<ProjectAuditAction>>
  /** Пользователи, у которых есть записи в журнале проекта: для фильтра. */
  actors(projectId: string): Promise<AuditActor[]>
}

/** Отказ API с кодом ответа (`PERMISSION_DENIED`…). */
export class AuditApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string) {
    super(`API журнала ответил ${status} ${code}`)
    this.status = status
    this.code = code
  }
}

export function createAuditApi(fetchImpl: typeof fetch = (...args) => fetch(...args)): AuditApi {
  async function get<T>(projectId: string, path: string): Promise<T> {
    const res = await fetchImpl(`/api${path}`, {
      headers: projectHeaders(projectId),
      credentials: 'same-origin',
    })
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { code?: unknown } | null
      throw new AuditApiError(res.status, typeof payload?.code === 'string' ? payload.code : '')
    }
    return (await res.json()) as T
  }

  return {
    page: (projectId, filter) => {
      const params = new URLSearchParams()
      if (filter.action) params.set('action', filter.action)
      if (filter.actor) params.set('actor', filter.actor)
      if (filter.cursor) params.set('cursor', filter.cursor)
      const query = params.size > 0 ? `?${params}` : ''
      return get(projectId, `/audit${query}`)
    },
    actors: (projectId) => get(projectId, '/audit/actors'),
  }
}
