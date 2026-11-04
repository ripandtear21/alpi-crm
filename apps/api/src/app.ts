import type { Database } from '@alpi/db'
import type { HealthResponse } from '@alpi/shared'
import { Hono } from 'hono'
import type { Kysely } from 'kysely'
import { type AccessEnv, accessGuard } from './auth/access-guard.ts'
import { AUTH_BASE_PATH, type Auth } from './auth/auth.ts'
import { projectContext } from './middleware/project-context.ts'
import { currentProjectRoutes, projectsRoutes } from './projects/projects.ts'

/** Ответ `GET /me`: кто вошёл. */
export interface MeResponse {
  id: string
  email: string
  name: string
  /** Роль вне проектов (плагин admin): 'admin' — владелец системы. */
  role: string | null
}

export interface AppDeps {
  auth: Auth
  /** Подключение ролью приложения (член alpi_app): под ней действует изоляция проектов. */
  db: Kysely<Database>
}

/**
 * Приложение API. Открыт без входа только /health; всё, что зарегистрировано после
 * accessGuard, требует сессию с включённой 2FA (исключения — в access-guard.ts).
 * Всё, что зарегистрировано после projectContext, выполняется в контексте проекта из
 * заголовка X-Project-Id, и только для его участника; новые разделы (сделки, контакты…)
 * регистрируются там же — путь вне проекта нужно добавить выше осознанно.
 */
export function createApp({ auth, db }: AppDeps) {
  return new Hono<AccessEnv>()
    .get('/health', (c) => c.json<HealthResponse>({ status: 'ok' }))
    .use('*', accessGuard(auth))
    .on(['GET', 'POST'], `${AUTH_BASE_PATH}/*`, (c) => auth.handler(c.req.raw))
    .get('/me', (c) => {
      const { user } = c.get('session')
      return c.json<MeResponse>({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role ?? null,
      })
    })
    .route('/projects', projectsRoutes(db))
    .use('*', projectContext(db))
    .route('/project', currentProjectRoutes())
}

/** Тип приложения для Hono RPC: клиент (apps/web) получает из него типы маршрутов. */
export type AppType = ReturnType<typeof createApp>
