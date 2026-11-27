import {
  INTAKE_RATE_LIMIT,
  MAX_EVENT_ID_LENGTH,
  MAX_REGISTRATION_TEXT_LENGTH,
  PROBLEM_CONTENT_TYPE,
  type REGISTRATION_TEXT_FIELDS,
} from '@alpi/shared'

// Раздел `/api/intake` описания API (тикет crm-intake/06): приём регистраций по ключу
// источника. Маршруты /intake живут вне приложения /v1 (app.ts, до проверки ключа API и
// сессии), поэтому описываются здесь вручную и подмешиваются в /api/v1/openapi.json, как раздел
// webhooks (openapi/events.ts). У пути — свой сервер `/api`: остальной документ — на `/api/v1`.

/** Схема безопасности ключа источника в components.securitySchemes. */
export const INTAKE_SECURITY = 'intakeSourceKey'

const PROBLEM_REF = { $ref: '#/components/schemas/Problem' }
const problemContent = { [PROBLEM_CONTENT_TYPE]: { schema: PROBLEM_REF } }

const TEXT = { type: 'string', maxLength: MAX_REGISTRATION_TEXT_LENGTH } as const

/** Описание полей тела, кроме event_id, phone, email, registered_at и owner_email. */
const TEXT_DESCRIPTIONS: Record<keyof typeof REGISTRATION_TEXT_FIELDS, string> = {
  name: 'Имя целиком — в имя контакта',
  dial_code: 'Код страны: номер без «+» получает его',
  form: 'Форма: идёт в название новой сделки «<имя или телефон> · <форма>»',
  webinar: 'Вебинар',
  plan_name: 'Тариф (planName)',
  page_url: 'Адрес страницы',
  referrer: 'Referrer',
  utm_source: 'utm_source',
  utm_medium: 'utm_medium',
  utm_campaign: 'utm_campaign',
  utm_term: 'utm_term',
  utm_content: 'utm_content',
  ad_id: 'id объявления',
  gclid: 'gclid',
  gbraid: 'gbraid',
  wbraid: 'wbraid',
  fbclid: 'fbclid',
  fbp: 'fbp',
  fbc: 'fbc',
  user_agent: 'User-Agent посетителя',
}

const REGISTRATION_BODY = {
  type: 'object',
  description:
    'Регистрация. Любые другие ключи верхнего уровня сохраняются в `extra` регистрации как есть. Строки длиннее 2000 символов обрезаются.',
  required: ['event_id'],
  properties: {
    event_id: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_EVENT_ID_LENGTH,
      description:
        'id события у источника: уникален в пределах источника и хранится вечно. Повтор — 200 с теми же id, ничего не создаётся',
    },
    phone: {
      type: 'string',
      description:
        'Телефон; без кода страны — украинский или с кодом из dial_code. Телефон главнее email при поиске контакта',
    },
    email: { type: 'string', description: 'Email' },
    ...Object.fromEntries(
      Object.entries(TEXT_DESCRIPTIONS).map(([key, description]) => [
        key,
        { ...TEXT, description },
      ]),
    ),
    registered_at: {
      type: 'string',
      format: 'date-time',
      description: 'Время регистрации у источника (ISO 8601)',
    },
    owner_email: {
      type: 'string',
      description:
        'Email пользователя CRM — ответственный новой сделки. Не участник проекта или отключён — сделка без ответственного и предупреждение OWNER_NOT_FOUND; существующей сделке ответственный не меняется',
    },
  },
} as const

const ACCEPTED = {
  type: 'object',
  required: [
    'registration_id',
    'contact_id',
    'deal_id',
    'deal_created',
    'contact_created',
    'warnings',
  ],
  properties: {
    registration_id: { type: ['string', 'null'], format: 'uuid' },
    contact_id: { type: ['string', 'null'], format: 'uuid' },
    deal_id: { type: ['string', 'null'], format: 'uuid' },
    deal_created: { type: 'boolean', description: 'Сделка создана этим запросом' },
    contact_created: { type: 'boolean', description: 'Контакт создан этим запросом' },
    warnings: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['PHONE_INVALID', 'EMAIL_INVALID', 'OWNER_NOT_FOUND', 'RECORDS_DELETED'],
      },
      description:
        'PHONE_INVALID — телефон не разобран (принята по email, исходный телефон сохранён); EMAIL_INVALID — email не разобран (принята по телефону); OWNER_NOT_FOUND — owner_email не участник проекта; RECORDS_DELETED — повтор события, чьи записи удалены окончательно (id — null)',
    },
  },
} as const

const EXAMPLE_BODY = {
  event_id: 'form-2026-11-27-000123',
  name: 'Олена Вигадана',
  phone: '067 000 00 00',
  email: 'olena@example.com',
  form: 'Вебінар з продажів',
  webinar: 'Продажі 2027',
  utm_source: 'facebook',
  utm_campaign: 'autumn',
  registered_at: '2026-11-27T09:15:00Z',
  quiz_answer: 'так',
}

const EXAMPLE_ANSWER = {
  registration_id: '0b6f6c1e-6a52-4d8e-9a4e-3f1d2c5b7a90',
  contact_id: '7c1d0e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f',
  deal_id: '3e2d1c0b-9a8f-4e7d-8c6b-5a4f3e2d1c0b',
  deal_created: true,
  contact_created: true,
  warnings: [],
}

const DESCRIPTION = `Регистрация с формы или лендинга. Отправляйте с сервера или из n8n, не из браузера посетителя: ключ источника виден каждому, кто откроет страницу (CORS не открыт).

Обработка — в том же запросе: найти контакт (телефон главнее email) или создать его; найденный дополняется, но не перезаписывается; открытая неархивная сделка контакта в воронке источника получает регистрацию, иначе создаётся новая на первом этапе этой воронки. Существующая сделка не меняется. Каждый запрос с телом лежит 30 дней в журнале входящих источника.

Лимит — ${INTAKE_RATE_LIMIT} запросов в минуту на источник; сверх — 429 \`RATE_LIMITED\` с \`Retry-After\`.`

/** Пути и схема безопасности раздела `/api/intake`. */
export function intakePaths() {
  return {
    securitySchemes: {
      [INTAKE_SECURITY]: {
        type: 'http',
        scheme: 'bearer',
        description:
          'Ключ источника регистраций (`alpi_src_…`): только приём, не ключ API. Неизвестный, отключённый и старый после смены ключ — одинаковый 401 INTAKE_KEY_INVALID',
      },
    },
    paths: {
      '/intake/registrations': {
        servers: [{ url: '/api' }],
        post: {
          summary: 'Принять регистрацию',
          description: DESCRIPTION,
          operationId: 'intake_registration',
          tags: ['intake'],
          security: [{ [INTAKE_SECURITY]: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: REGISTRATION_BODY, example: EXAMPLE_BODY } },
          },
          responses: {
            201: {
              description: 'Регистрация принята',
              content: { 'application/json': { schema: ACCEPTED, example: EXAMPLE_ANSWER } },
            },
            200: {
              description: 'Повтор event_id: те же id, ничего не создано',
              content: {
                'application/json': {
                  schema: ACCEPTED,
                  example: { ...EXAMPLE_ANSWER, deal_created: false, contact_created: false },
                },
              },
            },
            400: {
              description:
                'INVALID_REGISTRATION — тело не объект JSON; INVALID_EVENT_ID — нет event_id или он не 1–255 символов; CONTACT_KEYS_REQUIRED — нет ни верного телефона, ни верного email',
              content: problemContent,
            },
            401: { description: 'INTAKE_KEY_INVALID — ключ не действует', content: problemContent },
            413: { description: 'Тело больше 100 КБ', content: problemContent },
            422: {
              description:
                'PIPELINE_ARCHIVED, PIPELINE_HAS_NO_STAGES — новую сделку некуда поставить: воронка источника в архиве или без этапов',
              content: problemContent,
            },
            429: {
              description: `Больше ${INTAKE_RATE_LIMIT} запросов в минуту на источник`,
              headers: {
                'Retry-After': {
                  description: 'Секунд до конца окна',
                  schema: { type: 'integer', example: 42 },
                },
              },
              content: problemContent,
            },
            500: {
              description:
                'INTERNAL — сбой обработки: ничего не записано, строка в журнале входящих есть; запрос можно повторить',
              content: problemContent,
            },
          },
        },
      },
    },
  }
}
