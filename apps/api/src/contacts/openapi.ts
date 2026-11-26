import { z } from '@hono/zod-openapi'
import { requirePermission } from '../middleware/permissions.ts'
import {
  IdSchema,
  IsoTimeSchema,
  jsonBody,
  jsonContent,
  keyRoute,
  PageQuerySchema,
  pageSchema,
  pathParams,
} from '../openapi/openapi.ts'

// Контакты и организации, открытые ключу API (тикет crm-api/04), в описании OpenAPI. Как у
// сделок (deals/openapi.ts): каждый маршрут — keyRoute, те же маршруты обслуживают и сессию
// apps/web, схема ловит форму и типы, а последнее слово — за разбором тела в contacts.ts и
// organizations.ts (тот же код ответа: 400 INVALID_CONTACT / INVALID_ORGANIZATION с путём).
// Удаление и восстановление ключу не открыты (решение владельца: удаления через API нет).
// Примеры — только выдуманные данные.

const EXAMPLE_IDS = {
  contact: '2e7c9a4b-5f1d-4c8e-a3b6-8d0f1e2c7a95',
  organization: '8c4f1b6e-3a7d-4e2b-b9c5-0a6d2f8e1c37',
} as const

const CONTACT_EXAMPLE = {
  id: EXAMPLE_IDS.contact,
  firstName: 'Олена',
  lastName: 'Тестова',
  language: 'uk',
  organizationId: EXAMPLE_IDS.organization,
  possibleDuplicate: false,
  possibleDuplicateOf: null,
  phones: ['+380670000001'],
  emails: ['olena.testova@example.test'],
  custom: { dzherelo: 'Сайт' },
  createdBy: null,
  createdAt: '2026-11-04T10:00:00.000Z',
  updatedAt: '2026-11-04T10:15:00.000Z',
}

const ORGANIZATION_EXAMPLE = {
  id: EXAMPLE_IDS.organization,
  name: 'ТОВ «Тестова школа»',
  address: 'м. Київ, вул. Вигадана, 1',
  website: 'https://school.example.test',
  custom: {},
  createdBy: null,
  createdAt: '2026-11-04T09:00:00.000Z',
  updatedAt: '2026-11-04T09:00:00.000Z',
}

const Custom = z.record(z.string(), z.unknown()).openapi({
  description:
    'Значения пользовательских полей по коду. Меняются только переданные коды; null — очистить. Код скрытой для роли ключа группы — 422 CUSTOM_FIELD_UNKNOWN, группы «только чтение» — 403',
  example: { dzherelo: 'Сайт' },
})

const CustomOut = z.record(z.string(), z.unknown()).openapi({
  description: 'Значения пользовательских полей по коду; полей скрытых для роли групп нет',
})

const CreatedBy = z.string().nullable().openapi({
  description: 'Кто создал (id пользователя); null — ключ API или система',
})

export const ContactSchema = z
  .object({
    id: IdSchema,
    firstName: z.string(),
    lastName: z.string().nullable(),
    language: z.enum(['uk', 'ru']).nullable().openapi({ description: 'Язык общения' }),
    organizationId: IdSchema.nullable(),
    possibleDuplicate: z.boolean().openapi({
      description: 'Возможный дубль: email совпал с другим контактом',
    }),
    possibleDuplicateOf: IdSchema.nullable().openapi({
      description:
        'С каким контактом совпал email при отметке «возможный дубль»; null — не известно',
    }),
    phones: z.array(z.string()).openapi({ description: 'E.164, основной — первым' }),
    emails: z.array(z.string()).openapi({ description: 'В нижнем регистре, основной — первым' }),
    custom: CustomOut,
    createdBy: CreatedBy,
    createdAt: IsoTimeSchema,
    updatedAt: IsoTimeSchema,
  })
  .openapi('Contact')

export const OrganizationSchema = z
  .object({
    id: IdSchema,
    name: z.string(),
    address: z.string().nullable(),
    website: z.string().nullable(),
    custom: CustomOut,
    createdBy: CreatedBy,
    createdAt: IsoTimeSchema,
    updatedAt: IsoTimeSchema,
  })
  .openapi('Organization')

const OutOfScopeSchema = z
  .object({
    managerName: z.string().nullable().openapi({
      description: 'Менеджер открытой сделки контакта («клиент уже в работе у …»); null — нет',
    }),
  })
  .nullable()
  .openapi('ContactOutOfScope', {
    description:
      '«Чужой клиент»: совпал контакт вне охвата роли — без его id, имени, телефонов и email; null — таких совпадений нет',
  })

const ContactSearchPageSchema = pageSchema(ContactSchema).extend({ outOfScope: OutOfScopeSchema })

const Text = (max: number) => z.string().max(max)

const ContactBody = {
  lastName: Text(100).nullable().optional(),
  language: z.enum(['uk', 'ru']).nullable().optional(),
  organizationId: z.string().nullable().optional().openapi({
    format: 'uuid',
    description: 'Организация своего проекта; null — снять',
  }),
  phones: z.array(z.string()).max(10).optional().openapi({
    description:
      'Телефоны в любой записи: приводятся к E.164 (номер без кода страны — Украина); неразбираемый — 422 INVALID_PHONE. Первый — основной. Передан — заменяет весь список',
  }),
  emails: z.array(z.string()).max(10).optional().openapi({
    description: 'Email; первый — основной. Передан — заменяет весь список',
  }),
  custom: Custom.optional(),
}

const CreateContactBody = z.strictObject({ firstName: Text(100), ...ContactBody })
const PatchContactBody = z.strictObject({ firstName: Text(100).optional(), ...ContactBody })

const OrganizationBody = {
  address: Text(500).nullable().optional(),
  website: Text(500).nullable().optional(),
  custom: Custom.optional(),
}
const CreateOrganizationBody = z.strictObject({ name: Text(200), ...OrganizationBody })
const PatchOrganizationBody = z.strictObject({ name: Text(200).optional(), ...OrganizationBody })

const ContactParams = pathParams({ id: EXAMPLE_IDS.contact })
const OrganizationParams = pathParams({ id: EXAMPLE_IDS.organization })

const contactResponse = (status: 200 | 201, description: string) => ({
  [status]: { description, content: jsonContent(ContactSchema, CONTACT_EXAMPLE) },
})
const organizationResponse = (status: 200 | 201, description: string) => ({
  [status]: { description, content: jsonContent(OrganizationSchema, ORGANIZATION_EXAMPLE) },
})

// ---- Контакты -------------------------------------------------------------------------------

export const searchContactsRoute = keyRoute({
  method: 'get',
  path: '/',
  tags: ['Контакты'],
  summary: 'Найти контакт по телефону или email',
  description:
    'Точное совпадение по телефону (в любой записи: `067 123 45 67`, `+380671234567` и `(067) 123-45-67` — один номер) или email без учёта регистра; оба параметра — оба условия. Нужен хотя бы один, иначе 400. Ответ — все совпадения одной страницей (`next_cursor` — null). Контакт вне охвата роли в `data` не попадает: вместо него — `outOfScope` («чужой клиент») без данных контакта.',
  middleware: [requirePermission('contacts', 'view')],
  request: {
    query: z.object({
      phone: z.string().optional().openapi({ example: '067 000 00 01' }),
      email: z.string().optional().openapi({ example: 'olena.testova@example.test' }),
    }),
  },
  responses: {
    200: {
      description: 'Совпадения',
      content: jsonContent(ContactSearchPageSchema, {
        data: [CONTACT_EXAMPLE],
        next_cursor: null,
        outOfScope: null,
      }),
    },
  },
})

export const getContactRoute = keyRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Контакты'],
  summary: 'Контакт',
  description:
    'Контакт вне охвата чтения или в корзине отвечает 404, как несуществующий. Контакт, слитый с другим, — 404 с кодом CONTACT_MERGED: `details.merged_into_id` — оставшийся контакт (в цепочке слияний — последний), `details.merge_id` и `details.undo_until` — слияние и срок его отката. То же — на изменение слитого контакта.',
  middleware: [requirePermission('contacts', 'view')],
  request: { params: ContactParams },
  responses: contactResponse(200, 'Контакт'),
})

export const createContactRoute = keyRoute({
  method: 'post',
  path: '/',
  tags: ['Контакты'],
  summary: 'Создать контакт',
  description:
    'Телефон совпал с контактом, видимым роли, — 409 CONTACT_EXISTS (`details.contactId`); с контактом вне охвата — 409 CONTACT_OUT_OF_SCOPE без его данных (только `details.managerName`, если он в работе). Совпал только email — контакт создаётся с `possibleDuplicate: true`. Контакт, созданный ключом, входит в охват «свои» и «команда» этого ключа.',
  middleware: [requirePermission('contacts', 'create')],
  request: jsonBody(CreateContactBody, {
    firstName: 'Олена',
    lastName: 'Тестова',
    language: 'uk',
    phones: ['067 000 00 01'],
    emails: ['olena.testova@example.test'],
    custom: { dzherelo: 'Сайт' },
  }),
  responses: contactResponse(201, 'Контакт создан'),
})

export const patchContactRoute = keyRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Контакты'],
  summary: 'Изменить контакт',
  description:
    'Меняются только переданные поля. Совпадение телефона и email — по тем же правилам, что при создании. Контакт в охвате чтения, но не изменения — 403.',
  middleware: [requirePermission('contacts', 'edit')],
  request: {
    params: ContactParams,
    ...jsonBody(PatchContactBody, { lastName: 'Тестова-Приклад', language: 'ru' }),
  },
  responses: contactResponse(200, 'Контакт после изменения'),
})

// ---- Организации ----------------------------------------------------------------------------

export const listOrganizationsRoute = keyRoute({
  method: 'get',
  path: '/',
  tags: ['Организации'],
  summary: 'Найти организацию по названию',
  description:
    'Название содержит `name` (без учёта регистра), как фильтр «название» списка организаций; `name` обязателен (пустой — все организации). Сортировка — по названию; курсорная выдача.',
  middleware: [requirePermission('organizations', 'view')],
  request: {
    query: PageQuerySchema.extend({
      name: z.string().max(200).optional().openapi({ example: 'Тестова' }),
    }),
  },
  responses: {
    200: {
      description: 'Страница организаций',
      content: jsonContent(pageSchema(OrganizationSchema), {
        data: [ORGANIZATION_EXAMPLE],
        next_cursor: null,
      }),
    },
  },
})

export const getOrganizationRoute = keyRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Организации'],
  summary: 'Организация',
  description: 'Организация в корзине отвечает 404, как несуществующая.',
  middleware: [requirePermission('organizations', 'view')],
  request: { params: OrganizationParams },
  responses: organizationResponse(200, 'Организация'),
})

export const createOrganizationRoute = keyRoute({
  method: 'post',
  path: '/',
  tags: ['Организации'],
  summary: 'Создать организацию',
  middleware: [requirePermission('organizations', 'create')],
  request: jsonBody(CreateOrganizationBody, {
    name: ORGANIZATION_EXAMPLE.name,
    website: ORGANIZATION_EXAMPLE.website,
  }),
  responses: organizationResponse(201, 'Организация создана'),
})

export const patchOrganizationRoute = keyRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Организации'],
  summary: 'Изменить организацию',
  description: 'Меняются только переданные поля.',
  middleware: [requirePermission('organizations', 'edit')],
  request: {
    params: OrganizationParams,
    ...jsonBody(PatchOrganizationBody, { address: 'м. Львів, вул. Вигадана, 2' }),
  },
  responses: organizationResponse(200, 'Организация после изменения'),
})
