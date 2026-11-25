import {
  API_KEY_RATE_LIMIT,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_RETENTION_HOURS,
  IDEMPOTENT_REPLAYED_HEADER,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  PROBLEM_CONTENT_TYPE,
} from '@alpi/shared'
import type { Hook } from '@hono/zod-openapi'
import { createRoute, type OpenAPIHono, type RouteConfig, z } from '@hono/zod-openapi'
import type { MiddlewareHandler } from 'hono'
import { problem } from '../http/problem.ts'
import { apiKeyRoute } from '../middleware/api-key.ts'

// Описание API `/api/v1` в формате OpenAPI 3.1, построенное из кода (тикет crm-api/02).
//
// - Маршрут, открытый ключу API, объявляется через keyRoute и регистрируется методом
//   `openapi()` приложения OpenAPIHono (@hono/zod-openapi): одна схема zod и проверяет запрос,
//   и попадает в описание — описание не может разойтись с проверкой. Типы маршрута остаются
//   типами Hono RPC.
// - keyRoute ставит первым обработчиком отметку apiKeyRoute (middleware/api-key.ts): в описании
//   только маршруты, доступные ключу. Маршруты только для сессии регистрируются как раньше
//   (`.get()`, `.post()`) и в описание не попадают.
// - Ошибка проверки схемы — 400 INVALID_INPUT в формате RFC 9457 с `errors[].field` (путь в
//   теле, строке запроса или пути через точку).
// - Общие части описания: формат ошибки (Problem), курсорная выдача (`limit`, `cursor`,
//   `next_cursor`), `Idempotency-Key`, лимит запросов (429, заголовки RateLimit-*), схема
//   безопасности `bearer`. Маршруты добавляют тикеты crm-api/03 и 04.
// - Примеры в описании — только выдуманные данные.

/** Имя схемы безопасности: `Authorization: Bearer <секрет ключа API>`. */
const BEARER = 'bearer'

export const ProblemFieldErrorSchema = z
  .object({
    field: z.string().openapi({ example: 'custom.holovnyi_motyv' }),
    code: z.string().openapi({ example: 'REQUIRED' }),
    message: z.string().openapi({ example: 'Field is required' }),
  })
  .openapi('ProblemFieldError')

export const ProblemSchema = z
  .object({
    type: z.string().openapi({ example: 'about:blank' }),
    title: z.string().openapi({ example: 'Forbidden' }),
    status: z.number().int().openapi({ example: 403 }),
    detail: z.string().optional(),
    code: z.string().openapi({
      description: 'Машинный код ошибки',
      example: 'PERMISSION_DENIED',
    }),
    errors: z.array(ProblemFieldErrorSchema).optional().openapi({
      description: 'Ошибки полей: путь в теле запроса, код и текст',
    }),
    details: z.record(z.string(), z.unknown()).optional().openapi({
      description: 'Подробности отказа (зависят от кода)',
    }),
  })
  .openapi('Problem', { description: 'Ошибка в формате RFC 9457 (problem details)' })

const problemContent = { [PROBLEM_CONTENT_TYPE]: { schema: ProblemSchema } }

const RATE_LIMIT_HEADERS = {
  'RateLimit-Limit': {
    description: 'Запросов в минуту на ключ',
    schema: { type: 'integer' as const, example: API_KEY_RATE_LIMIT },
  },
  'RateLimit-Remaining': {
    description: 'Сколько запросов осталось в текущем окне',
    schema: { type: 'integer' as const, example: 599 },
  },
  'RateLimit-Reset': {
    description: 'Секунд до конца текущего окна',
    schema: { type: 'integer' as const, example: 42 },
  },
}

/** Ответы с ошибкой, общие для всех маршрутов ключа. */
export const ERROR_RESPONSES = {
  400: { description: 'Запрос не прошёл проверку', content: problemContent },
  401: { description: 'Ключ неизвестен, отозван или истёк', content: problemContent },
  403: { description: 'Роли ключа не хватает прав', content: problemContent },
  404: { description: 'Записи нет или она вне охвата роли', content: problemContent },
  409: {
    description:
      'Конфликт с текущим состоянием (в том числе запрос с тем же Idempotency-Key ещё выполняется)',
    content: problemContent,
  },
  422: { description: 'Запрос нарушает правила данных', content: problemContent },
  429: {
    description: `Больше ${API_KEY_RATE_LIMIT} запросов в минуту`,
    headers: {
      'Retry-After': {
        description: 'Секунд до конца окна',
        schema: { type: 'integer' as const, example: 42 },
      },
      ...RATE_LIMIT_HEADERS,
    },
    content: problemContent,
  },
  500: { description: 'Внутренняя ошибка (без подробностей)', content: problemContent },
} as const

/** Параметры курсорной выдачи: `?limit=` и `?cursor=`. */
export const PageQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_LIMIT_MAX)
    .default(PAGE_LIMIT_DEFAULT)
    .openapi({ description: 'Размер страницы', example: PAGE_LIMIT_DEFAULT }),
  cursor: z.string().optional().openapi({
    description: '`next_cursor` предыдущей страницы, как есть',
    example:
      'eyJzIjoiY3JlYXRlZEF0OmRlc2MiLCJ2IjoiMjAyNi0wMS0wMVQwMDowMDowMC4wMDAwMDBaIiwiaWQiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEifQ',
  }),
})

/** Страница выдачи `{ data, next_cursor }` со строками `item`. */
export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    data: z.array(item),
    next_cursor: z.string().nullable().openapi({
      description: 'Курсор следующей страницы; null — страниц больше нет',
    }),
  })
}

/**
 * Заголовок `Idempotency-Key` у `POST` и `PATCH`. Имя — строчными: так заголовки видит проверка
 * схемы Hono (имена заголовков HTTP регистр не различают).
 */
const IdempotencyHeadersSchema = z.object({
  [IDEMPOTENCY_KEY_HEADER.toLowerCase()]: z
    .string()
    .min(1)
    .max(IDEMPOTENCY_KEY_MAX_LENGTH)
    .optional()
    .openapi({
      description: `Повтор с тем же значением в течение ${IDEMPOTENCY_RETENTION_HOURS} часов возвращает сохранённый ответ с заголовком ${IDEMPOTENT_REPLAYED_HEADER}: true`,
      example: '6f1c2a4e-0b7d-4a51-9f3e-2c8d5b7a9e10',
    }),
})

/**
 * Маршрут, открытый ключу API: отметка apiKeyRoute первым обработчиком, схема безопасности
 * `bearer`, общие ответы с ошибкой; у `POST` и `PATCH` — заголовок `Idempotency-Key`.
 * Регистрируется методом `openapi()` приложения OpenAPIHono.
 */
export function keyRoute<R extends RouteConfig>(route: R): R & { getRoutingPath(): string } {
  const own: MiddlewareHandler[] =
    route.middleware === undefined
      ? []
      : Array.isArray(route.middleware)
        ? route.middleware
        : [route.middleware]
  const idempotent = route.method === 'post' || route.method === 'patch'
  const full = createRoute({
    ...route,
    middleware: [apiKeyRoute, ...own],
    security: [{ [BEARER]: [] }],
    request: {
      ...route.request,
      ...(idempotent && !route.request?.headers ? { headers: IdempotencyHeadersSchema } : {}),
    },
    responses: { ...ERROR_RESPONSES, ...route.responses },
  })
  // Типы обработчика и Hono RPC — те, что объявил сам маршрут: общие ответы с ошибкой и
  // заголовок Idempotency-Key добавляются в описание и проверку, а не в его типы.
  return full as unknown as R & { getRoutingPath(): string }
}

/** Ошибка проверки схемы запроса — 400 INVALID_INPUT с ошибками полей. */
// biome-ignore lint/suspicious/noExplicitAny: один обработчик для приложений с любым окружением
export const validationHook: Hook<any, any, any, any> = (result, c) => {
  if (result.success) return
  return problem(c, 400, 'INVALID_INPUT', {
    errors: result.error.issues.map((issue) => ({
      field: issue.path.map(String).join('.'),
      code: issue.code,
      message: issue.message,
    })),
  })
}

const DESCRIPTION = `API Alpi CRM для внешней автоматизации (n8n, Make, свой сервис).

- **Доступ** — ключ API проекта: \`Authorization: Bearer <секрет>\`. Ключ действует в своём проекте с правами своей роли.
- **Формат** — JSON, \`application/json; charset=utf-8\`; время — ISO 8601 в UTC. В \`/api/v1\` изменения только добавляют поля и маршруты.
- **Ошибки** — RFC 9457 (\`application/problem+json\`): \`type\`, \`title\`, \`status\`, \`code\` (машинный код), \`errors\` (ошибки полей: \`field\` — путь в теле, \`code\`, \`message\`). Ответ 500 подробностей не раскрывает: \`code: INTERNAL\`.
- **Списки** — курсорные: \`?limit=\` (1–${PAGE_LIMIT_MAX}, по умолчанию ${PAGE_LIMIT_DEFAULT}) и \`?cursor=\`; ответ \`{ "data": [...], "next_cursor": "…" | null }\`. Курсор непрозрачный; неверный курсор — 400.
- **Повтор без дублей** — заголовок \`${IDEMPOTENCY_KEY_HEADER}\` (1–${IDEMPOTENCY_KEY_MAX_LENGTH} символов) у \`POST\` и \`PATCH\`. Повтор с тем же значением и тем же запросом в течение ${IDEMPOTENCY_RETENTION_HOURS} часов возвращает сохранённый ответ с \`${IDEMPOTENT_REPLAYED_HEADER}: true\`; то же значение с другим запросом — 422 \`IDEMPOTENCY_KEY_REUSED\`; запрос ещё выполняется — 409 \`IDEMPOTENCY_IN_PROGRESS\`. Ответы 5xx не сохраняются.
- **Лимит** — ${API_KEY_RATE_LIMIT} запросов в минуту на ключ; сверх — 429 \`RATE_LIMITED\` с \`Retry-After\`. В каждом ответе — \`RateLimit-Limit\`, \`RateLimit-Remaining\`, \`RateLimit-Reset\`.`

/**
 * Описание OpenAPI 3.1 маршрутов `app` (приложение `/v1`): только маршруты, объявленные через
 * keyRoute, и общие части. Сервер — `/api/v1` (так путь видит клиент за обратным прокси).
 */
// biome-ignore lint/suspicious/noExplicitAny: описание строится по приложению с любым окружением
export function v1Document(app: OpenAPIHono<any, any, any>) {
  app.openAPIRegistry.register('Problem', ProblemSchema)
  app.openAPIRegistry.registerComponent('securitySchemes', BEARER, {
    type: 'http',
    scheme: 'bearer',
    description: 'Секрет ключа API проекта (`alpi_…`)',
  })
  return app.getOpenAPI31Document({
    openapi: '3.1.0',
    info: { title: 'Alpi CRM API', version: '1', description: DESCRIPTION },
    servers: [{ url: '/api/v1' }],
  })
}

/**
 * Страница `/api/v1/docs`: описание для браузера (Scalar API Reference с CDN, версия
 * закреплена); данных в ней нет, только ссылка на `/api/v1/openapi.json`.
 */
export const DOCS_HTML = `<!doctype html>
<html lang="uk">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Alpi CRM API</title>
  </head>
  <body>
    <script id="api-reference" data-url="/api/v1/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.84.0"></script>
  </body>
</html>
`
