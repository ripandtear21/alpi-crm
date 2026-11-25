import type { Hook } from '@hono/zod-openapi'
import { z } from '@hono/zod-openapi'
import { fail, refuse } from '../contacts/http.ts'
import { requirePermission } from '../middleware/permissions.ts'
import { keyRoute, PageQuerySchema, pageSchema } from '../openapi/openapi.ts'
import { ARCHIVED_FILTERS, STATUS_FILTERS } from './board.ts'
import { DATE, DEAL_CURRENCIES, DEAL_STATUSES, MAX_AMOUNT, MAX_TITLE_LENGTH } from './store.ts'

// Запросы сделок, открытые ключу API (тикет crm-api/03), в описании OpenAPI. Каждый маршрут —
// keyRoute (openapi/openapi.ts): отметка «доступно ключу» первым обработчиком и схема, которая
// и проверяет запрос, и попадает в описание `/api/v1/openapi.json`.
//
// - Те же маршруты обслуживают и сессию пользователя (apps/web): одна функция сделки на оба
//   пути. Поэтому ошибка схемы отвечает так же, как разбор тела в deals.ts, — 400 INVALID_DEAL
//   с `details.path` (dealInputHook), а не общим INVALID_INPUT: клиент apps/web читает код.
// - Схемы не строже разбора тела в deals.ts: последнее слово — за ним (существующий день в
//   дате, две цифры после запятой в сумме, форма нового контакта — по правилам контактов).
//   Схема ловит форму и типы, разбор тела — остальное, с тем же кодом ответа.
// - Параметр `id` пути — строка: сделка с id не в формате UUID отвечает 404, как раньше.
// - Примеры — только выдуманные данные.

/** Ошибка схемы запроса сделки — 400 INVALID_DEAL с путём к полю, как у разбора тела. */
// biome-ignore lint/suspicious/noExplicitAny: один обработчик для маршрутов с любыми схемами
export const dealInputHook: Hook<any, any, any, any> = (result, c) => {
  if (result.success) return
  const [issue] = result.error.issues
  const path = issue?.path.map(String) ?? []
  // Лишний ключ тела — путь к самому ключу, как у разбора тела (unknownKey).
  if (issue?.code === 'unrecognized_keys' && issue.keys[0] !== undefined) path.push(issue.keys[0])
  return fail(c, refuse(400, 'INVALID_DEAL', { path: path.join('.') }))
}

const view = requirePermission('deals', 'view')
const create = requirePermission('deals', 'create')
const edit = requirePermission('deals', 'edit')

// ---- Примеры --------------------------------------------------------------------------------

const EXAMPLE_IDS = {
  deal: '3f6b2c1e-8a4d-4e7f-9b21-5c0d7e9a1b42',
  pipeline: '0c9e5a7b-2d14-4f63-8e8a-1b7c3d5f9a20',
  stage: '6a1d4f2e-9b3c-4d8a-a7e5-2f0b8c6d4e13',
  nextStage: '9d2e7b4a-1c6f-4a3e-b8d5-7e0f2a9c6b31',
  otherPipeline: '5b8a3e1f-6d2c-4b9e-9f7a-3c1e8d0b5a64',
  contact: '2e7c9a4b-5f1d-4c8e-a3b6-8d0f1e2c7a95',
  organization: '8c4f1b6e-3a7d-4e2b-b9c5-0a6d2f8e1c37',
  lostReason: '4d0a8e2c-7b5f-4c1d-8e9a-6f3b1c7d2e58',
  owner: 'Xq7tR2mK9vLp4sWb',
} as const

const DEAL_EXAMPLE = {
  id: EXAMPLE_IDS.deal,
  title: 'Курс «Англійська B1» — Тестова Олена',
  pipelineId: EXAMPLE_IDS.pipeline,
  stageId: EXAMPLE_IDS.stage,
  status: 'open',
  lostReasonId: null,
  amount: 12500,
  currency: 'UAH',
  ownerId: EXAMPLE_IDS.owner,
  primaryContactId: EXAMPLE_IDS.contact,
  organizationId: null,
  wonAt: null,
  lostAt: null,
  stageChangedAt: '2026-11-04T10:15:00.000Z',
  expectedCloseDate: '2026-12-01',
  archivedAt: null,
  deletedAt: null,
  createdBy: null,
  createdAt: '2026-11-04T10:00:00.000Z',
  updatedAt: '2026-11-04T10:15:00.000Z',
  participants: [],
  products: [],
  productsTotal: 0,
  custom: { dzherelo: 'Сайт' },
}

const BOARD_DEAL_EXAMPLE = {
  id: EXAMPLE_IDS.deal,
  title: DEAL_EXAMPLE.title,
  pipelineId: EXAMPLE_IDS.pipeline,
  stageId: EXAMPLE_IDS.stage,
  amount: 12500,
  currency: 'UAH',
  ownerId: EXAMPLE_IDS.owner,
  ownerName: 'Тестовий Менеджер',
  status: 'open',
  primaryContactId: EXAMPLE_IDS.contact,
  contactName: 'Олена Тестова',
  stageChangedAt: '2026-11-04T10:15:00.000000Z',
  organizationId: null,
  organizationName: null,
  lostReasonId: null,
  createdAt: '2026-11-04T10:00:00.000Z',
  wonAt: null,
  lostAt: null,
  archivedAt: null,
  custom: { dzherelo: 'Сайт' },
}

// ---- Схемы ----------------------------------------------------------------------------------

const Id = z.guid().openapi({ format: 'uuid' })
const IsoTime = z.string().openapi({ format: 'date-time' })
const Currency = z.enum(DEAL_CURRENCIES)
const Title = z.string().trim().min(1).max(MAX_TITLE_LENGTH)
const Amount = z.number().min(0).max(MAX_AMOUNT).openapi({
  description: 'Сумма сделки, не больше двух знаков после запятой',
})
const CloseDate = z.string().regex(DATE).nullable().openapi({
  format: 'date',
  description: 'Ожидаемая дата закрытия (YYYY-MM-DD); null — снять',
})
const OwnerId = z.string().min(1).max(100).nullable().openapi({
  description: 'Ответственный — id действующего участника проекта; null — общая очередь',
})
const Custom = z.record(z.string(), z.unknown()).openapi({
  description:
    'Значения пользовательских полей по коду. Меняются только переданные коды; null — очистить. Код скрытой для роли ключа группы — 422 CUSTOM_FIELD_UNKNOWN, группы «только чтение» — 403',
  example: { dzherelo: 'Сайт' },
})

const IdParams = z.object({
  id: z.string().openapi({
    param: { name: 'id', in: 'path' },
    format: 'uuid',
    example: EXAMPLE_IDS.deal,
  }),
})

export const DealSchema = z
  .object({
    id: Id,
    title: z.string(),
    pipelineId: Id,
    stageId: Id,
    status: z.enum(DEAL_STATUSES),
    lostReasonId: Id.nullable(),
    amount: z.number(),
    currency: Currency,
    ownerId: z.string().nullable().openapi({ description: 'null — общая очередь' }),
    primaryContactId: Id,
    organizationId: Id.nullable(),
    wonAt: IsoTime.nullable(),
    lostAt: IsoTime.nullable(),
    stageChangedAt: IsoTime,
    expectedCloseDate: z.string().nullable().openapi({ format: 'date' }),
    archivedAt: IsoTime.nullable(),
    deletedAt: IsoTime.nullable(),
    createdBy: z.string().nullable().openapi({
      description: 'Кто создал (id пользователя); null — ключ API или система',
    }),
    createdAt: IsoTime,
    updatedAt: IsoTime,
    participants: z.array(z.object({ contactId: Id, role: z.string().nullable() })),
    products: z.array(
      z.object({
        id: Id,
        productId: Id,
        name: z.string(),
        quantity: z.number(),
        unitPrice: z.number(),
        total: z.number(),
      }),
    ),
    productsTotal: z.number(),
    custom: z.record(z.string(), z.unknown()).openapi({
      description: 'Значения пользовательских полей по коду; полей скрытых групп нет',
    }),
  })
  .openapi('Deal')

const BoardDealSchema = z
  .object({
    id: Id,
    title: z.string(),
    pipelineId: Id,
    stageId: Id,
    amount: z.number(),
    currency: Currency,
    ownerId: z.string().nullable(),
    ownerName: z.string().nullable(),
    status: z.enum(DEAL_STATUSES),
    primaryContactId: Id,
    contactName: z.string().nullable().openapi({
      description: 'null — контакт вне охвата контактов роли',
    }),
    stageChangedAt: IsoTime,
    organizationId: Id.nullable(),
    organizationName: z.string().nullable(),
    lostReasonId: Id.nullable(),
    createdAt: IsoTime,
    wonAt: IsoTime.nullable(),
    lostAt: IsoTime.nullable(),
    archivedAt: IsoTime.nullable(),
    custom: z.record(z.string(), z.unknown()),
  })
  .openapi('DealListItem')

const ListQuerySchema = PageQuerySchema.extend({
  pipeline: Id.optional().openapi({ description: 'Воронка' }),
  stage: Id.optional().openapi({ description: 'Этап' }),
  contact: Id.optional().openapi({ description: 'Контакт: основной или участник' }),
  organization: Id.optional().openapi({ description: 'Организация' }),
  status: z.enum(STATUS_FILTERS).optional().openapi({ description: 'По умолчанию open' }),
  archived: z.enum(ARCHIVED_FILTERS).optional().openapi({ description: 'По умолчанию false' }),
  owner: z.string().min(1).max(100).optional().openapi({
    description: 'id ответственного; none — общая очередь. Значения me у ключа нет — 400',
  }),
  filter: z.string().optional().openapi({
    description:
      'Фильтр JSON: `{"and": [{"field": "amount", "op": "gte", "value": 1000}]}`; пользовательские поля — `custom.<код>`. Значения me у ключа нет — 400',
  }),
  sort: z.string().optional().openapi({
    description: '`поле:asc|desc`, например `createdAt:desc` (по умолчанию)',
  }),
})

const NewContactSchema = z.record(z.string(), z.unknown()).openapi({
  description:
    'Новый контакт — как тело создания контакта: firstName (обязательно), lastName, language (uk | ru), phones, emails, organizationId, custom. Нужно право «контакты: создавать»',
  example: { firstName: 'Олена', lastName: 'Тестова', phones: ['+380670000001'] },
})

const CreateBodySchema = z.strictObject({
  title: Title,
  pipelineId: Id,
  stageId: Id.optional().openapi({ description: 'По умолчанию — первый этап воронки' }),
  contactId: Id.optional().openapi({
    description: 'Существующий контакт; или contactId, или contact',
  }),
  contact: NewContactSchema.optional(),
  organizationId: Id.nullable().optional(),
  amount: Amount.optional(),
  currency: Currency.optional().openapi({ description: 'По умолчанию EUR' }),
  ownerId: OwnerId.optional().openapi({
    description:
      'Ответственный; по умолчанию у ключа — общая очередь. Назначить кого-то — право «передача сделок»',
  }),
  expectedCloseDate: CloseDate.optional(),
  custom: Custom.optional(),
})

const PatchBodySchema = z.strictObject({
  title: Title.optional(),
  amount: Amount.optional(),
  currency: Currency.optional(),
  expectedCloseDate: CloseDate.optional(),
  organizationId: Id.nullable().optional(),
  custom: Custom.optional(),
})

const CustomOnlySchema = z.strictObject({ custom: Custom.optional() })

// ---- Маршруты -------------------------------------------------------------------------------

const json = <T extends z.ZodType>(schema: T, example: unknown) => ({
  'application/json': { schema, example },
})

function body<T extends z.ZodType>(schema: T, example: unknown, required: boolean) {
  return { body: { required, content: json(schema, example) } }
}

const dealResponse = (description: string) => ({
  200: { description, content: json(DealSchema, DEAL_EXAMPLE) },
})

/** Действие над сделкой: POST /deals/{id}/<name>; ответ — сделка после действия. */
function action(
  name: string,
  summary: string,
  description: string,
  schema: z.ZodType,
  example: unknown,
  required: boolean,
) {
  return keyRoute({
    method: 'post',
    path: `/{id}/${name}`,
    tags: ['Сделки'],
    summary,
    description,
    middleware: [edit],
    request: { params: IdParams, ...body(schema, example, required) },
    responses: dealResponse('Сделка после действия'),
  })
}

export const listDealsRoute = keyRoute({
  method: 'get',
  path: '/',
  tags: ['Сделки'],
  summary: 'Список сделок',
  description:
    'Сделки в охвате чтения роли ключа: охват «свои» или «команда» у ключа — только сделки общей очереди. Курсорная выдача.',
  middleware: [view],
  request: { query: ListQuerySchema },
  responses: {
    200: {
      description: 'Страница сделок',
      content: json(pageSchema(BoardDealSchema), {
        data: [BOARD_DEAL_EXAMPLE],
        next_cursor: null,
      }),
    },
  },
})

export const getDealRoute = keyRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Сделки'],
  summary: 'Сделка',
  description: 'Сделка вне охвата чтения отвечает 404, как несуществующая.',
  middleware: [view],
  request: { params: IdParams },
  responses: dealResponse('Сделка'),
})

export const createDealRoute = keyRoute({
  method: 'post',
  path: '/',
  tags: ['Сделки'],
  summary: 'Создать сделку',
  description:
    'Основной контакт — существующий (`contactId`) или новый (`contact`). У человека в воронке — одна открытая сделка: вторая — 409 OPEN_DEAL_EXISTS (`details.dealId`, если сделка видна ключу, иначе только `details.managerName`). Этап с обязательными полями — 422 STAGE_REQUIREMENTS_MISSING со списком в `errors`; значения передаются в `custom` того же запроса.',
  middleware: [create],
  request: body(
    CreateBodySchema,
    {
      title: DEAL_EXAMPLE.title,
      pipelineId: EXAMPLE_IDS.pipeline,
      contact: { firstName: 'Олена', lastName: 'Тестова', phones: ['+380670000001'] },
      amount: 12500,
      currency: 'UAH',
      custom: { dzherelo: 'Сайт' },
    },
    true,
  ),
  responses: { 201: { description: 'Сделка создана', content: json(DealSchema, DEAL_EXAMPLE) } },
})

export const patchDealRoute = keyRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Сделки'],
  summary: 'Изменить поля сделки',
  description:
    'Название, сумма, валюта, ожидаемая дата закрытия, организация, пользовательские поля. Этап, статус, ответственного и архив этот запрос не меняет (у них свои действия), сумма ничего не двигает.',
  middleware: [edit],
  request: {
    params: IdParams,
    ...body(PatchBodySchema, { amount: 14000, expectedCloseDate: '2026-12-15' }, true),
  },
  responses: dealResponse('Сделка после изменения'),
})

export const stageRoute = action(
  'stage',
  'Сменить этап',
  'Этап своей воронки. Статус и сумма не меняются. Этап с обязательными полями — 422 STAGE_REQUIREMENTS_MISSING со списком в `errors`, сделка остаётся на месте.',
  z.strictObject({ stageId: Id, custom: Custom.optional() }),
  { stageId: EXAMPLE_IDS.nextStage, custom: { byudzhet: '15 000' } },
  true,
)

export const ownerRoute = action(
  'owner',
  'Сменить ответственного',
  'Назначить, сменить или снять (null — общая очередь) ответственного — только с правом «передача сделок», в том числе на сделке общей очереди. Ответственный — действующий участник проекта, иначе 422 OWNER_NOT_MEMBER.',
  z.strictObject({ ownerId: OwnerId }),
  { ownerId: EXAMPLE_IDS.owner },
  true,
)

export const winRoute = action(
  'win',
  'Выиграть',
  'Статус won; этап не меняется. Обязательные поля «при выигрыше» и «с этапа» — 422 со списком в `errors`.',
  CustomOnlySchema,
  { custom: { nomer_dohovoru: 'Д-0001' } },
  false,
)

export const loseRoute = action(
  'lose',
  'Проиграть',
  'Причина обязательна: не архивная, из справочника своего проекта (иначе 422). Этап не меняется.',
  z.strictObject({
    lostReasonId: Id.nullable()
      .optional()
      .openapi({ description: 'Причина проигрыша; без неё — 422 LOST_REASON_REQUIRED' }),
  }),
  { lostReasonId: EXAMPLE_IDS.lostReason },
  true,
)

export const reopenRoute = action(
  'reopen',
  'Открыть заново',
  'Статус open, причина снимается; этап не меняется. Вторая открытая сделка человека в воронке — 409 OPEN_DEAL_EXISTS.',
  z.strictObject({}),
  {},
  false,
)

export const archiveRoute = action(
  'archive',
  'В архив',
  'Отметка архива; статус и этап не меняются.',
  z.strictObject({}),
  {},
  false,
)

export const unarchiveRoute = action(
  'unarchive',
  'Из архива',
  'Снимает отметку архива. Вторая открытая сделка человека в воронке — 409 OPEN_DEAL_EXISTS.',
  z.strictObject({}),
  {},
  false,
)

export const moveRoute = action(
  'move',
  'Перенести в другую воронку',
  'Воронка своего проекта, её этап (по умолчанию первый). Обязательные поля этапа — 422 со списком в `errors`; вторая открытая сделка человека в новой воронке — 409.',
  z.strictObject({ pipelineId: Id, stageId: Id.optional(), custom: Custom.optional() }),
  { pipelineId: EXAMPLE_IDS.otherPipeline },
  true,
)
