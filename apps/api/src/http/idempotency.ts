import { createHash } from 'node:crypto'
import type { Database } from '@alpi/db'
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_RETENTION_HOURS,
  IDEMPOTENT_REPLAYED_HEADER,
} from '@alpi/shared'
import { createMiddleware } from 'hono/factory'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { type Kysely, sql } from 'kysely'
import { isFileUpload } from '../files/files.ts'
import type { ProjectEnv } from '../middleware/project-context.ts'
import { sqlState } from '../roles/roles.ts'
import { problem } from './problem.ts'

// Заголовок `Idempotency-Key` (тикет crm-api/02; .scratch/crm-api/spec.md, «Общие правила»):
// повтор запроса с тем же значением не создаёт второй сделки, а возвращает сохранённый ответ.
//
// - Необязателен; действует на `POST` и `PATCH` маршрутов `/api/v1`, 1–255 символов (иначе 400
//   INVALID_IDEMPOTENCY_KEY). Загрузка файла (тело — поток до 25 МБ) заголовок не учитывает.
// - Область значения — автор запроса (пользователь или ключ API) в проекте: таблица
//   idempotency_record уникальна по (проект, автор, значение) и под row-level security.
//   Значение другого автора или другого проекта — независимый запрос.
// - Отпечаток запроса — SHA-256 метода, пути со строкой запроса и тела как есть (байт в байт).
//   То же значение с другим отпечатком — 422 IDEMPOTENCY_KEY_REUSED.
// - Повтор в течение 24 часов — сохранённые код и тело ответа с заголовком
//   `Idempotent-Replayed: true`; обработчик не вызывается, ничего не меняется. Старше 24 часов
//   запись не действует (и её удаляет ночная задача, jobs/idempotency-purge.ts).
// - Строка вставляется до обработчика той же транзакцией проекта, что изменение, и получает
//   ответ после него. Второй одинаковый запрос, пришедший, пока первый идёт, ждёт на вставке
//   (уникальный индекс) конца первой транзакции и получает её ответ; дольше WAIT_FOR_FIRST —
//   409 IDEMPOTENCY_IN_PROGRESS. Ошибка обработчика откатывает транзакцию вместе со строкой.
// - Сохраняются ответы 2xx и 4xx; ответ 5xx не сохраняется: такой запрос можно повторить.

const METHODS = new Set(['POST', 'PATCH'])

/** Сколько второй одинаковый запрос ждёт первого (lock_timeout PostgreSQL). */
const WAIT_FOR_FIRST = '10s'

/** SQLSTATE lock_not_available: lock_timeout истёк. */
const LOCK_NOT_AVAILABLE = '55P03'

/** Статусы, у ответа с которыми не бывает тела. */
const NULL_BODY_STATUSES = new Set([204, 205, 304])

interface Scope {
  project_id: string
  author_type: 'user' | 'api_key'
  author_id: string
  key: string
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Вставляет строку запроса без ответа; ждёт, если такую же вставляет параллельная транзакция.
 * id строки — вставлена (запрос новый), null — уже есть, 'timeout' — первый не закончился.
 */
async function claim(
  db: Kysely<Database>,
  scope: Scope,
  fingerprint: string,
): Promise<string | null | 'timeout'> {
  await sql`savepoint idempotency_claim`.execute(db)
  try {
    const { rows } = await sql<{ previous: string }>`
      select current_setting('lock_timeout') as previous
    `.execute(db)
    await sql`select set_config('lock_timeout', ${WAIT_FOR_FIRST}, true)`.execute(db)
    const inserted = await db
      .insertInto('idempotency_record')
      .values({ ...scope, fingerprint })
      .onConflict((oc) => oc.columns(['project_id', 'author_type', 'author_id', 'key']).doNothing())
      .returning('id')
      .executeTakeFirst()
    await sql`select set_config('lock_timeout', ${rows[0]?.previous ?? '0'}, true)`.execute(db)
    await sql`release savepoint idempotency_claim`.execute(db)
    return inserted?.id ?? null
  } catch (error) {
    await sql`rollback to savepoint idempotency_claim`.execute(db)
    if (sqlState(error) === LOCK_NOT_AVAILABLE) return 'timeout'
    throw error
  }
}

/**
 * Промежуточный слой маршрутов `/api/v1`: ставится после projectContext (нужны транзакция
 * проекта и автор запроса).
 */
export function idempotency() {
  return createMiddleware<ProjectEnv>(async (c, next) => {
    const key = c.req.header(IDEMPOTENCY_KEY_HEADER)
    if (key === undefined || !METHODS.has(c.req.method) || isFileUpload(c.req.method, c.req.path)) {
      return next()
    }
    if (key.length < 1 || key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
      return problem(c, 400, 'INVALID_IDEMPOTENCY_KEY')
    }

    const db = c.var.db
    const actor = c.var.actor
    const scope: Scope = {
      project_id: c.var.projectId,
      ...(actor.type === 'user'
        ? { author_type: 'user', author_id: actor.userId }
        : { author_type: 'api_key', author_id: actor.apiKeyId }),
      key,
    }
    const url = new URL(c.req.url)
    // Тело читается здесь и остаётся в кэше запроса Hono: обработчик прочитает его снова.
    const fingerprint = sha256(
      `${c.req.method}\n${url.pathname}${url.search}\n${await c.req.text()}`,
    )
    // Запись старше 24 часов не действует: значение можно использовать заново.
    await db
      .deleteFrom('idempotency_record')
      .where('project_id', '=', scope.project_id)
      .where('author_type', '=', scope.author_type)
      .where('author_id', '=', scope.author_id)
      .where('key', '=', scope.key)
      .where(
        'created_at',
        '<',
        sql<Date>`now() - make_interval(hours => ${IDEMPOTENCY_RETENTION_HOURS})`,
      )
      .execute()

    const claimed = await claim(db, scope, fingerprint)
    if (claimed === 'timeout') return problem(c, 409, 'IDEMPOTENCY_IN_PROGRESS')
    if (claimed === null) {
      const saved = await db
        .selectFrom('idempotency_record')
        .where('project_id', '=', scope.project_id)
        .where('author_type', '=', scope.author_type)
        .where('author_id', '=', scope.author_id)
        .where('key', '=', scope.key)
        .select(['fingerprint', 'response_status', 'response_content_type', 'response_body'])
        .executeTakeFirst()
      if (saved && saved.fingerprint !== fingerprint) {
        return problem(c, 422, 'IDEMPOTENCY_KEY_REUSED')
      }
      if (!saved || saved.response_status === null) {
        return problem(c, 409, 'IDEMPOTENCY_IN_PROGRESS')
      }
      const status = saved.response_status as ContentfulStatusCode
      const headers: Record<string, string> = { [IDEMPOTENT_REPLAYED_HEADER]: 'true' }
      if (saved.response_content_type) headers['Content-Type'] = saved.response_content_type
      return NULL_BODY_STATUSES.has(status)
        ? c.body(null, status as 204, headers)
        : c.body(saved.response_body ?? '', status, headers)
    }

    await next()
    // Ошибка обработчика: projectContext откатит транзакцию вместе со строкой.
    if (c.error) return
    const res = c.res
    if (res.status < 200 || res.status >= 500) {
      await db.deleteFrom('idempotency_record').where('id', '=', claimed).execute()
      return
    }
    await db
      .updateTable('idempotency_record')
      .set({
        response_status: res.status,
        response_content_type: res.headers.get('content-type'),
        response_body: await res.clone().text(),
      })
      .where('id', '=', claimed)
      .execute()
  })
}
