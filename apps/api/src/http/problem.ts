import { PROBLEM_CONTENT_TYPE, type ProblemDetails, type ProblemFieldError } from '@alpi/shared'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

// Ответ с ошибкой — одна функция для всех маршрутов `/api/v1` (тикет crm-api/02): формат
// RFC 9457 (problem details), `Content-Type: application/problem+json`.
//
// - `type` — `about:blank`: смысл ошибки несёт машинный код `code`, а `title` — фраза статуса
//   HTTP (RFC 9457, раздел 4.2.1).
// - `details` — подробности отказа в прежнем виде (`{ path }`, `{ contactId }`, список полей
//   этапа…): по ним клиент apps/web показывает ошибку, как до этого тикета.
// - `errors` — ошибки полей `{ field, code, message }` выводятся из `details` (fieldErrors):
//   `details.path` — одно поле; список обязательных полей (`details.fields`, тикет crm-fields/04)
//   — по полю `custom.<код>` на каждое.
// - Ответ 500 подробностей не раскрывает: код INTERNAL, без текста и стека ошибки.

const TITLES: Partial<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
}

/** Коды отказа, у которых `details.fields` — коды незаполненных обязательных полей. */
const REQUIRED_FIELD_CODES = new Set(['STAGE_REQUIREMENTS_MISSING', 'REQUIRED_FIELDS_MISSING'])

/** Ошибки полей из подробностей отказа; пусто — отказ не про поля. */
export function fieldErrors(code: string, details: Record<string, unknown> | undefined) {
  const errors: ProblemFieldError[] = []
  if (!details) return errors
  if (typeof details.path === 'string') {
    errors.push({ field: details.path, code, message: 'Invalid value' })
  }
  if (REQUIRED_FIELD_CODES.has(code) && Array.isArray(details.fields)) {
    for (const field of details.fields) {
      if (typeof field === 'string') {
        errors.push({ field: `custom.${field}`, code: 'REQUIRED', message: 'Field is required' })
      }
    }
  }
  return errors
}

export interface ProblemOptions {
  /** Подробности отказа в прежнем виде (их читает клиент apps/web). */
  details?: Record<string, unknown> | undefined
  /** Ошибки полей; по умолчанию — из `details` (fieldErrors). */
  errors?: ProblemFieldError[]
  /** Текст для человека; не для 500. */
  detail?: string
}

/** Тело ответа с ошибкой (без самого ответа: для повтора и для описания OpenAPI). */
export function problemBody(
  status: number,
  code: string,
  options: ProblemOptions = {},
): ProblemDetails {
  const body: ProblemDetails = {
    type: 'about:blank',
    title: TITLES[status] ?? 'Error',
    status,
    code,
  }
  if (options.detail !== undefined) body.detail = options.detail
  const errors = options.errors ?? fieldErrors(code, options.details)
  if (errors.length > 0) body.errors = errors
  if (options.details !== undefined) body.details = options.details
  return body
}

/**
 * Ответ с ошибкой `status` и кодом `code` в формате RFC 9457. Заголовки, уже выставленные на
 * контексте (`c.header`, например `WWW-Authenticate` или `Retry-After`), сохраняются.
 */
export function problem(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  options: ProblemOptions = {},
) {
  return c.body(JSON.stringify(problemBody(status, code, options)), status, {
    'Content-Type': PROBLEM_CONTENT_TYPE,
  })
}
