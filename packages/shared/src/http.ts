// Общие правила `/api/v1` (тикет crm-api/02; .scratch/crm-api/spec.md, «Общие правила»):
// формат ошибки (RFC 9457, problem details), страница курсорной выдачи, заголовки
// идемпотентности и лимита запросов. Сервер отвечает так на всех маршрутах `/api/v1`, клиент
// apps/web читает ошибку по `code` (и `details`, как раньше), а страницу — по `data` и
// `next_cursor`.

/** Тип содержимого ответа с ошибкой (RFC 9457). */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json'

/** Ошибка проверки одного поля: путь в теле запроса (`custom.holovnyi_motyv`), код, текст. */
export interface ProblemFieldError {
  field: string
  code: string
  message: string
}

/**
 * Ответ с ошибкой (RFC 9457). `type`, `title`, `status`, `detail` — члены стандарта;
 * `code` — машинный код ошибки (`PERMISSION_DENIED`, `OPEN_DEAL_EXISTS`…), `errors` — ошибки
 * полей, `details` — подробности отказа в прежнем виде (их читает клиент apps/web).
 */
export interface ProblemDetails {
  type: string
  title: string
  status: number
  detail?: string
  code: string
  errors?: ProblemFieldError[]
  details?: Record<string, unknown>
}

/** Страница списка: строки и курсор следующей страницы; null — страниц больше нет. */
export interface Page<T> {
  data: T[]
  next_cursor: string | null
}

/** Размер страницы `?limit=`: по умолчанию и наибольший. */
export const PAGE_LIMIT_DEFAULT = 50
export const PAGE_LIMIT_MAX = 200

/** Заголовок запроса против дублей при повторе `POST` и `PATCH`. */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key'
/** Наибольшая длина значения `Idempotency-Key`. */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255
/** Заголовок ответа, повторённого по `Idempotency-Key`. */
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed'
/** Сколько часов хранится ответ для повтора по `Idempotency-Key`. */
export const IDEMPOTENCY_RETENTION_HOURS = 24

/** Запросов в минуту на один ключ API. Запросы по сессии пользователя не ограничены. */
export const API_KEY_RATE_LIMIT = 600

/** Коды ошибок, общие для всех маршрутов `/api/v1`. */
export type CommonApiErrorCode =
  | 'INTERNAL'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'RATE_LIMITED'
  | 'INVALID_IDEMPOTENCY_KEY'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'IDEMPOTENCY_IN_PROGRESS'

/**
 * Страница ответа `/api/v1` в виде, в котором её держат экраны клиента apps/web: строки и курсор
 * следующей страницы.
 */
export function readPage<T>(page: Page<T>): { items: T[]; nextCursor: string | null } {
  return { items: page.data, nextCursor: page.next_cursor }
}
