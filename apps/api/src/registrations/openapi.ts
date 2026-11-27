import { z } from '@hono/zod-openapi'
import { requirePermission } from '../middleware/permissions.ts'
import {
  IdSchema,
  IsoTimeSchema,
  jsonContent,
  keyRoute,
  PageQuerySchema,
  pageSchema,
  pathParams,
} from '../openapi/openapi.ts'

// Регистрации, открытые ключу API (тикет crm-intake/09), в описании OpenAPI: одна регистрация и
// регистрации сделки и контакта, новые сверху. Те же маршруты обслуживают карточки apps/web.
// Схема ответа — та же, по которой тест сверяет настоящий ответ (registrations.test.ts).
// Примеры — только выдуманные данные.

const EXAMPLE_IDS = {
  registration: '7a2c9e4b-1d6f-4b8a-9c3e-5f0d2a7b8c14',
  source: '4e1b8c7a-9d3f-4a2e-8b6c-1f7d0e9a3b52',
  contact: '2e7c9a4b-5f1d-4c8e-a3b6-8d0f1e2c7a95',
  deal: '3f6b2c1e-8a4d-4e7f-9b21-5c0d7e9a1b42',
} as const

const text = (description: string) => z.string().nullable().openapi({ description })

/** Просмотр вебинара (тикет crm-intake/08): последние присланные значения. */
export const RegistrationViewSchema = z
  .strictObject({
    startedAt: IsoTimeSchema.nullable().openapi({ description: 'Начал смотреть' }),
    finishedAt: IsoTimeSchema.nullable().openapi({ description: 'Вышел' }),
    minutes: z.number().int().nullable().openapi({ description: 'Минут просмотрено' }),
    extra: z.record(z.string(), z.unknown()).nullable().openapi({
      description: 'Остальные ключи просмотра, как прислала платформа',
    }),
    updatedAt: IsoTimeSchema.openapi({ description: 'Когда просмотр обновлён последний раз' }),
  })
  .openapi('RegistrationView')

export const RegistrationSchema = z
  .strictObject({
    id: IdSchema,
    sourceId: IdSchema.openapi({ description: 'Источник регистраций' }),
    sourceName: z.string().openapi({ description: 'Название источника' }),
    contactId: IdSchema,
    dealId: IdSchema.nullable().openapi({
      description: 'null — сделку удалили окончательно, регистрация осталась у контакта',
    }),
    dealTitle: z.string().nullable().openapi({ description: 'Название сделки' }),
    eventId: z.string().openapi({ description: 'id события у источника' }),
    createdAt: IsoTimeSchema.openapi({ description: 'Когда регистрация пришла в CRM' }),
    registeredAt: IsoTimeSchema.nullable().openapi({
      description: 'Время регистрации, как прислал источник',
    }),
    name: text('Имя из формы; null и у контакта вне охвата чтения контактов роли'),
    phone: text('Телефон в E.164; null — не прислан, не разобран или контакт вне охвата'),
    phoneRaw: text('Телефон, как прислан, если не разобран'),
    dialCode: text('Код страны из формы'),
    email: text('Email из формы; null и у контакта вне охвата'),
    form: text('Форма'),
    webinar: text('Вебинар'),
    planName: text('Тариф'),
    pageUrl: text('Адрес страницы формы'),
    referrer: text('referrer'),
    utmSource: text('utm_source'),
    utmMedium: text('utm_medium'),
    utmCampaign: text('utm_campaign'),
    utmTerm: text('utm_term'),
    utmContent: text('utm_content'),
    adId: text('ad_id'),
    gclid: text('gclid'),
    gbraid: text('gbraid'),
    wbraid: text('wbraid'),
    fbclid: text('fbclid'),
    fbp: text('fbp'),
    fbc: text('fbc'),
    userAgent: text('user_agent'),
    extra: z.record(z.string(), z.unknown()).openapi({
      description: 'Остальные ключи тела, как прислал источник',
    }),
    view: RegistrationViewSchema.nullable().openapi({
      description: 'Просмотр вебинара; null — данных о просмотре нет',
    }),
  })
  .openapi('Registration')

const REGISTRATION_EXAMPLE = {
  id: EXAMPLE_IDS.registration,
  sourceId: EXAMPLE_IDS.source,
  sourceName: 'Лендінг курсу',
  contactId: EXAMPLE_IDS.contact,
  dealId: EXAMPLE_IDS.deal,
  dealTitle: 'Курс «Англійська B1» — Тестова Олена',
  eventId: 'evt-1029',
  createdAt: '2026-11-04T10:20:00.000Z',
  registeredAt: '2026-11-04T10:19:58.000Z',
  name: 'Олена Тестова',
  phone: '+380670000001',
  phoneRaw: null,
  dialCode: '+380',
  email: 'olena.testova@example.test',
  form: 'Форма на головній',
  webinar: 'Вебінар 12 листопада',
  planName: 'Базовий',
  pageUrl: 'https://example.test/course',
  referrer: 'https://www.google.com/',
  utmSource: 'facebook',
  utmMedium: 'cpc',
  utmCampaign: 'autumn',
  utmTerm: null,
  utmContent: null,
  adId: null,
  gclid: null,
  gbraid: null,
  wbraid: null,
  fbclid: null,
  fbp: null,
  fbc: null,
  userAgent: 'Mozilla/5.0',
  extra: { city: 'Київ' },
  view: null,
}

const view = requirePermission('deals', 'view')

const pageResponse = {
  200: {
    description: 'Страница регистраций, новые сверху',
    content: jsonContent(pageSchema(RegistrationSchema), {
      data: [REGISTRATION_EXAMPLE],
      next_cursor: null,
    }),
  },
}

export const getRegistrationRoute = keyRoute({
  method: 'get',
  path: '/registrations/{id}',
  tags: ['Регистрации'],
  summary: 'Регистрация',
  description:
    'Регистрация видна тому, кто видит её сделку (право «сделки: смотреть» и охват чтения); иначе 404, как несуществующая. Регистрация без сделки (сделку удалили окончательно) видна только с охватом «все». Имя, телефон и email — null, если контакт вне охвата чтения контактов.',
  middleware: [view],
  request: { params: pathParams({ id: EXAMPLE_IDS.registration }) },
  responses: {
    200: {
      description: 'Регистрация',
      content: jsonContent(RegistrationSchema, REGISTRATION_EXAMPLE),
    },
  },
})

export const dealRegistrationsRoute = keyRoute({
  method: 'get',
  path: '/deals/{id}/registrations',
  tags: ['Регистрации'],
  summary: 'Регистрации сделки',
  description:
    'Новые сверху; курсорная выдача. Сделка вне охвата чтения или слитая с другой — 404: регистрации слитой сделки — у оставшейся.',
  middleware: [view],
  request: { params: pathParams({ id: EXAMPLE_IDS.deal }), query: PageQuerySchema },
  responses: pageResponse,
})

export const contactRegistrationsRoute = keyRoute({
  method: 'get',
  path: '/contacts/{id}/registrations',
  tags: ['Регистрации'],
  summary: 'Регистрации контакта',
  description:
    'Регистрации по всем сделкам контакта, видимым роли; новые сверху; курсорная выдача. Нужны права «контакты: смотреть» и «сделки: смотреть»; контакт вне охвата чтения — 404.',
  middleware: [requirePermission('contacts', 'view'), view],
  request: { params: pathParams({ id: EXAMPLE_IDS.contact }), query: PageQuerySchema },
  responses: pageResponse,
})
