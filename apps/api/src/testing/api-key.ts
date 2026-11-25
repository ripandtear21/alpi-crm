import { type ApiKeyWithSecret, PROJECT_HEADER, type RolePermissions } from '@alpi/shared'
import { expect } from 'vitest'
import {
  type ApiHarness,
  type Method,
  ORIGIN,
  type RequestOptions,
  type SignedInUser,
  type Target,
} from './api-harness.ts'

// Только для тестов: запрос по ключу API (тикет crm-api/01) — заголовок
// `Authorization: Bearer <секрет>`, без cookie сессии и без X-Project-Id (проект — проект ключа).
//
//   const role = await createRole(h, projectId, permissions)
//   const key = await createApiKey(admin, projectId, role)
//   const res = await key.api('POST', '/v1/deals', { body: { … } })

/** Ключ API проекта и запросы от его имени. */
export interface KeyClient {
  /** id ключа: автор в change_log, audit_log и событиях. */
  id: string
  secret: string
  /** Запрос к приложению харнесса (`createApp`) по этому ключу. */
  api(method: Method, path: string, options?: RequestOptions): Promise<Response>
  /** Тот же запрос к другому приложению (своему набору зависимостей `createApp`). */
  call(target: Target, method: Method, path: string, options?: RequestOptions): Promise<Response>
}

/**
 * Запрос по ключу `secret`: только `Authorization`, `Origin` и (если есть тело) `Content-Type`.
 * `options.project` — заголовок X-Project-Id (ключу он не нужен; передан — должен совпасть).
 */
export function keyRequest(
  target: Target,
  secret: string,
  method: Method,
  path: string,
  options: RequestOptions = {},
): Promise<Response> {
  const headers = new Headers({ origin: ORIGIN, authorization: `Bearer ${secret}` })
  if (options.project !== undefined) headers.set(PROJECT_HEADER, options.project)
  if (options.body !== undefined) headers.set('content-type', 'application/json')
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value)
  return Promise.resolve(
    target.request(`${ORIGIN}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  )
}

let roleCounter = 0

/** Роль проекта `projectId` с правами `permissions` — служебным подключением, в обход API. */
export async function createRole(
  h: ApiHarness,
  projectId: string,
  permissions: RolePermissions,
): Promise<string> {
  const { id } = await h.owner
    .insertInto('role')
    .values({
      project_id: projectId,
      name: `Роль ключа ${++roleCounter}`,
      permissions: JSON.stringify(permissions),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return id
}

/**
 * Ключ API проекта `projectId` с ролью `roleId`, созданный через API администратором проекта
 * `admin` (`POST /v1/api-keys`, секрет — из ответа). Запросы — к приложению `h.app`.
 */
export async function createApiKey(
  h: ApiHarness,
  admin: SignedInUser,
  projectId: string,
  roleId: string,
  name = `Автоматизація ${++roleCounter}`,
): Promise<KeyClient> {
  const res = await admin.api('POST', '/v1/api-keys', {
    project: projectId,
    body: { name, roleId },
  })
  expect(res.status).toBe(201)
  const { key, secret } = (await res.json()) as ApiKeyWithSecret
  return {
    id: key.id,
    secret,
    api: (method, path, options) => keyRequest(h.app, secret, method, path, options),
    call: (target, method, path, options) => keyRequest(target, secret, method, path, options),
  }
}
