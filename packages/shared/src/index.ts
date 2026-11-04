export * from './audit.ts'
export * from './members.ts'
export * from './permissions.ts'
export * from './phone.ts'
export * from './pipelines.ts'

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

/** Заголовок запроса с id выбранного проекта: по нему API выполняет запрос в контексте проекта. */
export const PROJECT_HEADER = 'X-Project-Id'
