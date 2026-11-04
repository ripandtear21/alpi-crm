import type { RolePermissions, RoleSummary } from '@alpi/shared'
import { projectHeaders } from '../../components/project-switcher/projects-api.ts'

// Запросы ролей проекта к API (apps/api/src/roles/roles.ts). Все — в контексте проекта.

export interface RoleInput {
  name: string
  permissions: RolePermissions
}

export interface RolesApi {
  list(projectId: string): Promise<RoleSummary[]>
  create(projectId: string, input: RoleInput): Promise<RoleSummary>
  update(projectId: string, roleId: string, input: RoleInput): Promise<RoleSummary>
  remove(projectId: string, roleId: string): Promise<void>
}

/** Отказ API с кодом ответа (`PERMISSION_DENIED`, `ROLE_NAME_TAKEN`…). */
export class RolesApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string) {
    super(`API ролей ответил ${status} ${code}`)
    this.status = status
    this.code = code
  }
}

export function createRolesApi(fetchImpl: typeof fetch = (...args) => fetch(...args)): RolesApi {
  async function send<T>(
    projectId: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers = projectHeaders(projectId)
    if (body !== undefined) headers.set('content-type', 'application/json')
    const res = await fetchImpl(`/api${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { code?: unknown } | null
      throw new RolesApiError(res.status, typeof payload?.code === 'string' ? payload.code : '')
    }
    return (res.status === 204 ? undefined : await res.json()) as T
  }

  return {
    list: (projectId) => send(projectId, 'GET', '/roles'),
    create: (projectId, input) => send(projectId, 'POST', '/roles', input),
    update: (projectId, roleId, input) => send(projectId, 'PUT', `/roles/${roleId}`, input),
    remove: (projectId, roleId) => send(projectId, 'DELETE', `/roles/${roleId}`),
  }
}
