import type { Database } from '@alpi/db'
import { type ApiKeyRequestErrorCode, isApiKeySecret } from '@alpi/shared'
import { getIP } from 'better-auth/api'
import type { Context, MiddlewareHandler } from 'hono'
import { createMiddleware } from 'hono/factory'
import { matchedRoutes } from 'hono/route'
import { METHOD_NAME_ALL } from 'hono/router'
import { type Kysely, sql } from 'kysely'
import { hashApiKeySecret } from '../api-keys/secret.ts'
import { normalizeIp } from '../audit/record.ts'
import type { Auth } from '../auth/auth.ts'
import { problem } from '../http/problem.ts'
import {
  createRateLimiter,
  type RateLimiter,
  rateLimited,
  rateLimitHeaders,
} from '../http/rate-limit.ts'

// Запрос по ключу API (тикет crm-api/01; .scratch/crm-api/spec.md, «Общие правила»).
//
// - Заголовок `Authorization: Bearer <секрет>` — запрос ключа. Cookie сессии в таком запросе не
//   читается: проверку сессии (accessGuard) app.ts пропускает. Нет заголовка Bearer — прежний
//   путь сессии без изменений.
// - Ключ ищет функция базы api_key_by_secret_hash по отпечатку секрета. Неизвестный, отозванный
//   и истёкший ключ, как и строка не в формате секрета, получают одинаковый 401
//   API_KEY_INVALID: ответ не выдаёт, был ли такой ключ.
// - Ключ проходит только на маршруты с отметкой apiKeyRoute — первым обработчиком маршрута
//   (сравнение по самой функции: у вложенных приложений Hono нет своего onError, поэтому
//   app.route() переносит обработчики как есть; появится onError — маршруты закроются ключу):
//     .get('/', apiKeyRoute, requirePermission('deals', 'view'), handler)
//   Любой другой маршрут — 403 API_KEY_NOT_ALLOWED при любой роли ключа: управление ключами,
//   ролями, участниками, журналом и всё, что ещё не открыто ключу явно. Обработчик маршрута с
//   отметкой не читает сессию: автор запроса — c.var.actor (api-keys/actor.ts).
// - Дальше запрос идёт тем же путём, что запрос пользователя: projectContext (проект ключа),
//   requirePermission (роль ключа), охват (roles/scope.ts).

/** Переменные контекста Hono для запроса по ключу. */
export type ApiKeyEnv = {
  Variables: {
    /** Ключ запроса — только у запроса с заголовком Bearer и действующим ключом. */
    apiKey?: { id: string; projectId: string }
  }
}

/**
 * Отметка «доступно ключу»: ставится первым обработчиком маршрута в контексте проекта (после
 * projectContext). Сама ничего не делает: apiKeyAuth ищет её среди обработчиков маршрута до
 * того, как маршрут начнёт выполняться. Без неё ключ получает 403 API_KEY_NOT_ALLOWED.
 */
export const apiKeyRoute: MiddlewareHandler = (_c, next) => next()

const BEARER = /^Bearer[ \t]+(\S*)[ \t]*$/i

/** Секрет из `Authorization: Bearer …`; null — заголовка Bearer нет (запрос по сессии). */
export function bearerSecret(c: Context): string | null {
  const header = c.req.header('authorization')
  if (header === undefined || !/^Bearer(\s|$)/i.test(header)) return null
  return BEARER.exec(header)?.[1] ?? ''
}

/**
 * Открыт ли маршрут запроса ключу. Отвечает первый маршрут (не промежуточный слой `use`),
 * совпавший с методом и путём: его первым обработчиком должна быть отметка apiKeyRoute.
 * Отметка на другом совпавшем маршруте не в счёт: `/v1/deals/count` (без отметки) обслуживает
 * свой обработчик, даже если у `/v1/deals/:id` отметка есть.
 */
function routeOpenToApiKey(c: Context): boolean {
  const route = matchedRoutes(c).find((r) => r.method !== METHOD_NAME_ALL)
  return route?.handler === apiKeyRoute
}

export function apiKeyError(c: Context, code: ApiKeyRequestErrorCode) {
  if (code === 'API_KEY_INVALID') {
    c.header('WWW-Authenticate', 'Bearer')
    return problem(c, 401, code)
  }
  return problem(c, 403, code)
}

/**
 * Первый промежуточный слой после ограничения тела: узнаёт запрос ключа и проверяет ключ,
 * лимит запросов ключа (http/rate-limit.ts, тикет crm-api/02) и маршрут. Для запроса по сессии
 * ничего не делает.
 */
export function apiKeyAuth(
  db: Kysely<Database>,
  auth: Auth,
  limiter: RateLimiter = createRateLimiter(),
) {
  return createMiddleware<ApiKeyEnv & { Variables: { clientIp: string | null } }>(
    async (c, next) => {
      const secret = bearerSecret(c)
      if (secret === null) return next()

      const key = isApiKeySecret(secret)
        ? (
            await sql<{ id: string; project_id: string }>`
              select id, project_id from api_key_by_secret_hash(${hashApiKeySecret(secret)})
            `.execute(db)
          ).rows[0]
        : undefined
      if (!key) return apiKeyError(c, 'API_KEY_INVALID')

      // Лимит считает каждый запрос действующего ключа; заголовки — в каждом ответе ключу.
      const limit = limiter.hit(key.id)
      const headers = rateLimitHeaders(limit)
      for (const [name, value] of Object.entries(headers)) c.header(name, value)
      if (!limit.allowed) return rateLimited(c, limit)
      if (!routeOpenToApiKey(c)) return apiKeyError(c, 'API_KEY_NOT_ALLOWED')

      c.set('apiKey', { id: key.id, projectId: key.project_id })
      c.set('clientIp', normalizeIp(getIP(c.req.raw, auth.options)))
      await next()
      // Ответ, собранный не через контекст (new Response), заголовков контекста не несёт.
      for (const [name, value] of Object.entries(headers)) {
        if (!c.res.headers.has(name)) c.res.headers.set(name, value)
      }
    },
  )
}
