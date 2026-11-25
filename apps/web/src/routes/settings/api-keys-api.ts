import type { ApiKeyCreateInput, ApiKeySummary, ApiKeyWithSecret, RoleSummary } from '@alpi/shared'
import { projectHeaders } from '../../components/project-switcher/projects-api.ts'
import { RolesApiError } from './roles-api.ts'

// Запросы ключей API проекта (apps/api/src/api-keys/routes.ts): `/api/v1/api-keys`, в
// контексте проекта, по сессии. Роли для выбора — `/api/roles`. Отказ — RolesApiError с кодом
// ответа, как у остальных экранов настроек. Секрет приходит только в ответе на создание и
// перевыпуск и нигде не сохраняется.

export interface ApiKeysApi {
  list(projectId: string): Promise<ApiKeySummary[]>
  roles(projectId: string): Promise<RoleSummary[]>
  create(projectId: string, input: ApiKeyCreateInput): Promise<ApiKeyWithSecret>
  reissue(projectId: string, keyId: string): Promise<ApiKeyWithSecret>
  revoke(projectId: string, keyId: string): Promise<ApiKeySummary>
}

export function createApiKeysApi(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): ApiKeysApi {
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
    return (await res.json()) as T
  }

  return {
    list: (projectId) => send(projectId, 'GET', '/v1/api-keys'),
    roles: (projectId) => send(projectId, 'GET', '/roles'),
    create: (projectId, input) => send(projectId, 'POST', '/v1/api-keys', input),
    reissue: (projectId, keyId) => send(projectId, 'POST', `/v1/api-keys/${keyId}/reissue`),
    revoke: (projectId, keyId) => send(projectId, 'POST', `/v1/api-keys/${keyId}/revoke`),
  }
}
