import { type Database, withProject } from '@alpi/db'
import { IDEMPOTENT_REPLAYED_HEADER, PROJECT_HEADER } from '@alpi/shared'
import type { Context, Next } from 'hono'
import { createMiddleware } from 'hono/factory'
import { type Kysely, sql, type Transaction } from 'kysely'
import type { RequestActor } from '../api-keys/actor.ts'
import { audit } from '../audit/record.ts'
import type { AccessEnv } from '../auth/access-guard.ts'
import { problem } from '../http/problem.ts'
import type { ApiKeyEnv } from './api-key.ts'

// Контекст проекта для запроса (docs/adr/0001-izolyatsiya-proektov.md): клиент присылает
// выбранный проект в заголовке X-Project-Id, промежуточный слой проверяет участие пользователя
// и выполняет обработчик внутри withProject — row-level security базы показывает обработчику
// только строки этого проекта, без фильтров в коде.
//
// Заголовок, а не префикс пути /projects/:id/…: маршруты разделов не повторяют параметр
// проекта, клиент выставляет его в одном месте, а нестандартный заголовок браузер не пошлёт с
// чужого сайта без разрешения CORS (дополнительная защита от подделки запросов).

/** Переменные контекста Hono внутри проекта. */
export type ProjectEnv = {
  Variables: AccessEnv['Variables'] &
    ApiKeyEnv['Variables'] & {
      /**
       * id текущего проекта: пользователь в нём состоит или это проект ключа API. У запроса по
       * ключу нет `session`: автор запроса — `actor`.
       */
      projectId: string
      /** Кто выполняет запрос: пользователь или ключ API (тикет crm-api/01). */
      actor: RequestActor
      /** Транзакция с выставленным проектом: все запросы обработчика — через неё. */
      db: Transaction<Database>
    }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Действует на все маршруты, зарегистрированные после него; ставится после accessGuard.
 * - нет сессии с пройденной 2FA — 401 (accessGuard пропускает дальше без сессии открытые пути
 *   входа, и если такой путь не совпал с маршрутом Better Auth, он доходит сюда);
 * - нет заголовка — 400 PROJECT_REQUIRED;
 * - проекта нет, пользователь в нём не состоит или его участие отключено — одинаковый 403 PROJECT_FORBIDDEN, чтобы
 *   ответ не выдавал, существует ли проект.
 * Ошибка обработчика откатывает транзакцию проекта.
 */
export function projectContext(db: Kysely<Database>) {
  return createMiddleware<ProjectEnv>(async (c, next) => {
    const apiKey = c.get('apiKey')
    if (apiKey) return apiKeyProjectContext(db, apiKey, c, next)
    const session = c.get('session')
    if (!session?.user.twoFactorEnabled || session.session.twoFactorVerified !== true) {
      return problem(c, 401, 'UNAUTHORIZED')
    }
    const projectId = c.req.header(PROJECT_HEADER)
    if (!projectId) {
      return problem(c, 400, 'PROJECT_REQUIRED')
    }
    if (!UUID.test(projectId)) {
      return problem(c, 403, 'PROJECT_FORBIDDEN')
    }

    let member = false
    try {
      await withProject(db, projectId, async (trx) => {
        // project_id в условии — не замена политике, а вторая линия: решение о доступе не
        // держится на одном механизме.
        const row = await trx
          .selectFrom('project_member')
          .select('id')
          .where('project_id', '=', projectId)
          .where('user_id', '=', session.user.id)
          // Отключённое участие (тикет crm-foundation/06) — как его отсутствие.
          .where('disabled_at', 'is', null)
          .executeTakeFirst()
        if (!row) return
        member = true
        c.set('projectId', projectId)
        c.set('actor', { type: 'user', userId: session.user.id })
        c.set('db', trx)
        await next()
        // Hono перехватывает ошибку обработчика сам (ответ 500 уже готов) и не пробрасывает её
        // сюда: без этой строки транзакция с частью изменений зафиксировалась бы.
        if (c.error) throw c.error
      })
    } catch (error) {
      if (c.error !== undefined && error === c.error) return
      throw error
    }
    if (!member) {
      return problem(c, 403, 'PROJECT_FORBIDDEN')
    }
  })
}

/** Как часто обновляется отметка последнего запроса ключа: не пишем в базу на каждый запрос. */
const LAST_USED_PRECISION = '1 minute'

/** Методы, которые не меняют данных: такой запрос ключа в журнал проекта не пишется. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Контекст проекта для запроса по ключу API (тикет crm-api/01): проект — проект ключа, а не
 * заголовок. `X-Project-Id` не нужен; передан и не совпадает — 403 PROJECT_FORBIDDEN, до
 * какого-либо чтения из базы. Изменяющий запрос, который удался, пишется в журнал проекта
 * (api_key.request) той же транзакцией, автор — ключ.
 */
async function apiKeyProjectContext(
  db: Kysely<Database>,
  apiKey: { id: string; projectId: string },
  c: Context<ProjectEnv>,
  next: Next,
) {
  const header = c.req.header(PROJECT_HEADER)
  if (header !== undefined && header.toLowerCase() !== apiKey.projectId) {
    return problem(c, 403, 'PROJECT_FORBIDDEN')
  }
  try {
    await withProject(db, apiKey.projectId, async (trx) => {
      c.set('projectId', apiKey.projectId)
      c.set('actor', { type: 'api_key', apiKeyId: apiKey.id })
      c.set('db', trx)
      await trx
        .updateTable('api_key')
        .set({ last_used_at: sql`now()` })
        .where('id', '=', apiKey.id)
        .where('revoked_at', 'is', null)
        .where((eb) =>
          eb.or([
            eb('last_used_at', 'is', null),
            eb('last_used_at', '<', sql<Date>`now() - ${LAST_USED_PRECISION}::interval`),
          ]),
        )
        .execute()
      await next()
      if (c.error) throw c.error
      // Повтор по Idempotency-Key (http/idempotency.ts) ничего не меняет — в журнал не пишется.
      const replayed = c.res.headers.get(IDEMPOTENT_REPLAYED_HEADER) === 'true'
      if (!SAFE_METHODS.has(c.req.method) && c.res.status < 400 && !replayed) {
        await audit.record(trx, apiKey.projectId, {
          action: 'api_key.request',
          actorId: null,
          actorApiKeyId: apiKey.id,
          ip: c.get('clientIp'),
          entity: { type: 'api_key', id: apiKey.id },
          details: { method: c.req.method, path: c.req.path, status: c.res.status },
        })
      }
    })
  } catch (error) {
    if (c.error !== undefined && error === c.error) return
    throw error
  }
}
