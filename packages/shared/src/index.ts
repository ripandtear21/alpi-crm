import type { RolePermissions } from './permissions.ts'

export * from './api-keys/index.ts'
export * from './audit.ts'
export * from './events/index.ts'
export * from './fields/index.ts'
export * from './filters/index.ts'
export * from './http.ts'
export * from './intake/index.ts'
export * from './members.ts'
export * from './merge.ts'
export * from './permissions.ts'
export * from './phone.ts'
export * from './pipelines.ts'
export * from './products.ts'

// Общие типы сервера и клиента. Типы маршрутов API клиент берёт из apps/api через Hono RPC,
// сюда кладём то, что нужно обеим сторонам независимо от маршрутов.

/** Ответ `GET /health`. */
export interface HealthResponse {
  status: 'ok'
}

/** Проект в ответах API: `GET /projects` (мои проекты), `POST /projects`, `GET /project`. */
export interface ProjectSummary {
  id: string
  code: string
  name: string
}

/**
 * Ответ `GET /project/access`: права самого пользователя в текущем проекте (по роли участника).
 * Интерфейс прячет по ним действия без права; проверяет каждый запрос всё равно сервер.
 */
export interface ProjectAccess {
  userId: string
  permissions: RolePermissions
}

/** Заголовок запроса с id выбранного проекта: по нему API выполняет запрос в контексте проекта. */
export const PROJECT_HEADER = 'X-Project-Id'
