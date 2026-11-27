import { type Database, withProject } from '@alpi/db'
import { INTAKE_RATE_LIMIT, type IntakeRequestErrorCode, isIntakeKey } from '@alpi/shared'
import { type Context, Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { type Kysely, sql } from 'kysely'
import { problem } from '../http/problem.ts'
import {
  createRateLimiter,
  type RateLimiter,
  type RateLimitOptions,
  rateLimited,
  rateLimitHeaders,
} from '../http/rate-limit.ts'
import { bearerSecret } from '../middleware/api-key.ts'
import { handleRegistration } from './journal.ts'
import { hashIntakeKey } from './key.ts'
import { handleWebinarView } from './webinar.ts'

// Запрос приёма по ключу источника (тикет crm-intake/03; .scratch/crm-intake/spec.md, «Общие
// правила»): `/api/intake/...` (снаружи префикс /api снимает обратный прокси, сюда доходит
// /intake/...).
//
// - Заголовок `Authorization: Bearer <ключ источника>`. Источник ищет функция базы
//   intake_source_by_key_hash по отпечатку ключа — проект ещё не известен. Неизвестный,
//   отключённый и старый после смены ключ, строка не в формате ключа и запрос без ключа получают
//   одинаковый 401 INTAKE_KEY_INVALID: ответ не выдаёт, был ли такой ключ. Ключ API здесь —
//   такой же неизвестный ключ.
// - Проект и воронку запроса берут из источника, а не из сессии, ключа API или заголовка
//   X-Project-Id. Cookie сессии не читается: группа /intake регистрируется в app.ts до проверки
//   ключа API и сессии.
// - 600 запросов в минуту на источник (пункт 19 ответов владельца): 429 RATE_LIMITED с
//   `Retry-After`, заголовки лимита — в каждом ответе источнику (http/rate-limit.ts). Счётчик
//   свой, не общий с ключами API.
// - Ни ключ, ни его отпечаток не пишутся ни в ответ, ни в журналы, ни в логи сервера.

/** Источник запроса приёма: кто прислал, в какой проект и какую воронку. */
export interface IntakeSource {
  id: string
  projectId: string
  pipelineId: string
}

/** Переменные контекста Hono для запроса приёма. */
export type IntakeEnv = {
  Variables: {
    /** Источник запроса — только после проверки ключа (intakeSourceAuth). */
    intakeSource: IntakeSource
  }
}

/**
 * Включённый источник по ключу; null — ключа нет, он не в формате ключа источника, неизвестен,
 * сменён или источник отключён (все случаи неразличимы).
 */
export async function intakeSourceByKey(
  db: Kysely<Database>,
  key: string | null,
): Promise<IntakeSource | null> {
  if (key === null || !isIntakeKey(key)) return null
  const row = (
    await sql<{ id: string; project_id: string; pipeline_id: string }>`
      select id, project_id, pipeline_id from intake_source_by_key_hash(${hashIntakeKey(key)})
    `.execute(db)
  ).rows[0]
  return row ? { id: row.id, projectId: row.project_id, pipelineId: row.pipeline_id } : null
}

/** Источник по заголовку `Authorization: Bearer <ключ>` запроса (тикеты 06 и 08). */
export function intakeSourceOfRequest(
  db: Kysely<Database>,
  c: Context,
): Promise<IntakeSource | null> {
  return intakeSourceByKey(db, bearerSecret(c))
}

export function intakeKeyError(c: Context, code: IntakeRequestErrorCode = 'INTAKE_KEY_INVALID') {
  c.header('WWW-Authenticate', 'Bearer')
  return problem(c, 401, code)
}

/** Как часто обновляется отметка последнего запроса источника: не пишем в базу на каждый запрос. */
const LAST_USED_PRECISION = '1 minute'

/**
 * Проверка ключа источника и лимита запросов: первый промежуточный слой группы /intake. Дальше
 * обработчик берёт источник из `c.var.intakeSource`.
 */
export function intakeSourceAuth(db: Kysely<Database>, limiter: RateLimiter) {
  return createMiddleware<IntakeEnv>(async (c, next) => {
    const source = await intakeSourceOfRequest(db, c)
    if (!source) return intakeKeyError(c)

    // Лимит считает каждый запрос включённого источника; заголовки — в каждом ответе ему.
    const limit = limiter.hit(source.id)
    const headers = rateLimitHeaders(limit)
    for (const [name, value] of Object.entries(headers)) c.header(name, value)
    if (!limit.allowed) return rateLimited(c, limit)

    await withProject(db, source.projectId, (trx) =>
      trx
        .updateTable('intake_source')
        .set({ last_used_at: sql`now()` })
        .where('id', '=', source.id)
        .where((eb) =>
          eb.or([
            eb('last_used_at', 'is', null),
            eb('last_used_at', '<', sql<Date>`now() - ${LAST_USED_PRECISION}::interval`),
          ]),
        )
        .execute(),
    )
    c.set('intakeSource', source)
    await next()
    // Ответ, собранный не через контекст (new Response), заголовков контекста не несёт.
    for (const [name, value] of Object.entries(headers)) {
      if (!c.res.headers.has(name)) c.res.headers.set(name, value)
    }
  })
}

/**
 * Группа `/intake` (снаружи — /api/intake): ключ источника и лимит, затем маршруты приёма.
 * Неизвестный путь с действующим ключом — 404 здесь же, чтобы запрос не ушёл к проверке ключа
 * API и сессии.
 */
export function intakeRoutes(db: Kysely<Database>, rateLimit: RateLimitOptions = {}) {
  const limiter = createRateLimiter({ limit: INTAKE_RATE_LIMIT, ...rateLimit })
  return (
    new Hono<IntakeEnv>()
      .use('*', intakeSourceAuth(db, limiter))
      // Регистрация (тикет crm-intake/06): обработка в том же запросе — 201 с id регистрации,
      // контакта и сделки, повтор event_id — 200 с теми же id; строка журнала входящих — всегда
      // (intake/journal.ts). Тело читается как текст: в журнал — как пришло.
      .post('/registrations', async (c) => {
        const answer = await handleRegistration(db, c.get('intakeSource'), await c.req.text())
        if ('code' in answer.body) {
          return problem(c, answer.status as ContentfulStatusCode, answer.body.code)
        }
        return c.json(answer.body, answer.status as ContentfulStatusCode)
      })
      // Просмотр вебинара (тикет crm-intake/08): дописывается в последнюю регистрацию контакта
      // на тот же вебинар — 200 с `matched`; ничего не создаёт (intake/webinar.ts).
      .post('/webinar-views', async (c) => {
        const answer = await handleWebinarView(db, c.get('intakeSource'), await c.req.text())
        if ('code' in answer.body) {
          return problem(c, answer.status as ContentfulStatusCode, answer.body.code)
        }
        return c.json(answer.body, 200)
      })
      .all('*', (c) => problem(c, 404, 'NOT_FOUND'))
  )
}
