import type { Database } from '@alpi/db'
import type { HealthResponse } from '@alpi/shared'
import { OpenAPIHono } from '@hono/zod-openapi'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import type { Kysely } from 'kysely'
import { apiKeysRoutes } from './api-keys/routes.ts'
import { auditRoutes, systemAuditRoutes } from './audit/routes.ts'
import { type AccessEnv, accessGuard } from './auth/access-guard.ts'
import { AUTH_BASE_PATH, type Auth } from './auth/auth.ts'
import { type BulkDeps, bulkRoutes, NO_BULK } from './bulk/routes.ts'
import { contactsRoutes } from './contacts/contacts.ts'
import type { ContactDependents } from './contacts/dependents.ts'
import { contactListRoutes } from './contacts/list.ts'
import { dealsRoutes, pipelineAggregatesRoutes } from './deals/deals.ts'
import { DEAL_CONTACT_DEPENDENTS } from './deals/dependents.ts'
import { dealListRoutes } from './deals/list-routes.ts'
import { CUSTOM_FIELD_REQUIREMENTS, type StageRequirements } from './deals/stage-requirements.ts'
import type { WebhookDeliveryOptions } from './events/deliver.ts'
import { type FieldsDeps, NO_FIELD_JOBS } from './fields/common.ts'
import { fieldsRoutes } from './fields/fields.ts'
import { fieldGroupsRoutes } from './fields/groups.ts'
import { isFileUpload } from './files/files.ts'
import { savedFiltersRoutes } from './filters/saved.ts'
import { idempotency } from './http/idempotency.ts'
import { problem } from './http/problem.ts'
import { createRateLimiter, type RateLimitOptions } from './http/rate-limit.ts'
import { intakeRoutes } from './intake/auth.ts'
import { intakeSourcesRoutes } from './intake/sources.ts'
import { lostReasonsRoutes } from './lost-reasons/lost-reasons.ts'
import { teamDirectoryRoutes, usersRoutes } from './members/directory.ts'
import { membersRoutes } from './members/members.ts'
import { OPEN_MEMBER_DEALS, type OpenDealsChecker } from './members/open-deals.ts'
import { memberTransferRoutes } from './members/transfer.ts'
import { dealMergeRoutes, mergesRoutes } from './merge/deals.ts'
import { apiKeyAuth } from './middleware/api-key.ts'
import type { PermissionsEnv } from './middleware/permissions.ts'
import { projectContext } from './middleware/project-context.ts'
import { DOCS_CSP, DOCS_HTML, v1Document, validationHook } from './openapi/openapi.ts'
import { organizationListRoutes } from './organizations/list.ts'
import { organizationsRoutes } from './organizations/organizations.ts'
import { pipelinesRoutes } from './pipelines/pipelines.ts'
import { OPEN_STAGE_DEALS, type StageDealsChecker } from './pipelines/stage-deals.ts'
import { productsRoutes } from './products/products.ts'
import { currentProjectRoutes, projectsRoutes } from './projects/projects.ts'
import { rolesRoutes } from './roles/roles.ts'
import { searchRoutes } from './search/search.ts'
import { type FileStorage, NO_FILE_STORAGE } from './storage/storage.ts'
import { teamsRoutes } from './teams/teams.ts'
import { entityRecordsRoutes } from './timeline/timeline.ts'
import { trashRoutes } from './trash/routes.ts'
import { NO_WEBHOOKS, webhookEndpointsRoutes } from './webhook-endpoints/routes.ts'

/**
 * Наибольшее тело запроса. JSON API (роли, вход) — единицы килобайт; большие тела не должны
 * доходить до разбора JSON и до транзакции проекта. Загрузка файлов (files/files.ts) идёт мимо
 * этого предела: у неё свой, 25 МБ, на своём маршруте.
 */
export const MAX_BODY_BYTES = 100 * 1024

/** Ответ `GET /me`: кто вошёл. */
export interface MeResponse {
  id: string
  email: string
  name: string
  /** Роль вне проектов (плагин admin): 'admin' — владелец системы. */
  role: string | null
}

export interface AppDeps {
  auth: Auth
  /** Подключение ролью приложения (член alpi_app): под ней действует изоляция проектов. */
  db: Kysely<Database>
  /** Открытые сделки участника — для отключения участия; по умолчанию — по таблице deal. */
  openDeals?: OpenDealsChecker
  /** Массовые действия и очередь pg-boss (apps/api/src/jobs/jobs.ts); без них действий нет. */
  bulk?: BulkDeps
  /** Открытые сделки на этапе — для удаления этапа; по умолчанию — по таблице deal. */
  stageDeals?: StageDealsChecker
  /** Что удаляется вместе с контактом; по умолчанию — сделки, где он основной. */
  contactDependents?: ContactDependents
  /** Хранилище содержимого файлов (storage/storage.ts); без него файлов нет. */
  storage?: FileStorage
  /**
   * Какие поля нужны, чтобы поставить сделку на этап или выиграть; по умолчанию — обязательные
   * пользовательские поля (тикет crm-fields/04).
   */
  stageRequirements?: StageRequirements
  /**
   * Конструктор полей: очередь окончательного удаления поля и часы (срок 30 дней после архива);
   * без очереди окончательное удаление поля с данными — ошибка 500.
   */
  fields?: FieldsDeps
  /**
   * Лимит запросов ключа API и, отдельным счётчиком, ключа источника регистраций
   * (http/rate-limit.ts): по умолчанию 600 в минуту, часы — Date.now.
   */
  rateLimit?: RateLimitOptions
  /**
   * Адреса событий (тикет crm-api/06): ключ шифрования секретов, разрешение http/localhost
   * (только тесты), разрешение имён; без ключа адреса не создаются (500).
   */
  webhooks?: WebhookDeliveryOptions
}

/** Код ошибки ответа на HTTPException (её бросают промежуточные слои Hono и @hono/zod-openapi). */
const HTTP_EXCEPTION_CODES: Partial<Record<number, string>> = {
  400: 'INVALID_INPUT',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
}

/**
 * Запросы `/api/v1/...` (снаружи префикс /api снимает обратный прокси, сюда доходит /v1/...):
 * разделы сделок, контактов и их справочников. Только по сессии пользователя и только в
 * контексте проекта — группа регистрируется после projectContext.
 */
function v1Routes({
  stageDeals,
  contactDependents,
  storage,
  stageRequirements,
  fields,
  db,
  webhooks,
}: {
  stageDeals: StageDealsChecker
  contactDependents: ContactDependents
  storage: FileStorage
  stageRequirements: StageRequirements
  fields: FieldsDeps
  /** Подключение ролью приложения: порции выгрузки CSV — в своих транзакциях проекта. */
  db: Kysely<Database>
  webhooks: WebhookDeliveryOptions
}) {
  return (
    // OpenAPIHono (@hono/zod-openapi): маршруты, объявленные через keyRoute (openapi/openapi.ts),
    // попадают в описание /api/v1/openapi.json; ошибка проверки их схемы — 400 INVALID_INPUT.
    new OpenAPIHono<PermissionsEnv>({ defaultHook: validationHook })
      // Списки (тикет 12): счётчики и выгрузка — до разделов, иначе `count`, `list` и
      // `export.csv` разобрались бы как id записи.
      .route('/deals', dealListRoutes(db))
      .route('/contacts', contactListRoutes(db))
      .route('/organizations', organizationListRoutes(db))
      .route('/saved-filters', savedFiltersRoutes())
      .route('/trash', trashRoutes())
      .route('/deals', dealsRoutes({ stageRequirements }))
      // Слияние сделок с откатом (тикет crm-intake/02) и откат слияний: только по сессии.
      .route('/deals', dealMergeRoutes())
      .route('/merges', mergesRoutes())
      .route('/pipelines', pipelinesRoutes({ stageDeals }))
      // Агрегаты колонок канбана: /v1/pipelines/:id/aggregates (deals/board.ts).
      .route('/pipelines', pipelineAggregatesRoutes())
      .route('/lost-reasons', lostReasonsRoutes())
      .route('/contacts', contactsRoutes({ dependents: contactDependents }))
      .route('/organizations', organizationsRoutes())
      .route('/products', productsRoutes())
      // Заметки, файлы и лента записи: /v1/deals/:id/notes, …/files, …/timeline.
      .route('/deals', entityRecordsRoutes('deal', storage))
      .route('/contacts', entityRecordsRoutes('contact', storage))
      .route('/organizations', entityRecordsRoutes('organization', storage))
      .route('/search', searchRoutes())
      // Справочники участников и команд для ключа API (тикет crm-api/04): только чтение.
      .route('/users', usersRoutes())
      .route('/teams', teamDirectoryRoutes())
      // Конструктор полей (эпик crm-fields): группы, описания и варианты.
      .route('/field-groups', fieldGroupsRoutes())
      .route('/fields', fieldsRoutes(fields))
      // Ключи API (тикет crm-api/01): только по сессии.
      .route('/api-keys', apiKeysRoutes())
      // Адреса событий и журнал доставок (тикет crm-api/06): только по сессии.
      .route('/webhook-endpoints', webhookEndpointsRoutes(webhooks))
      // Источники регистраций и их ключи (тикет crm-intake/03): только по сессии.
      .route('/intake-sources', intakeSourcesRoutes())
  )
}

/**
 * Приложение API. Открыт без входа только /health; /intake (приём регистраций) — только по
 * ключу источника регистраций (intake/auth.ts). Всё, что зарегистрировано после
 * accessGuard, требует сессию с включённой 2FA (исключения — в access-guard.ts) или ключ API
 * (`Authorization: Bearer`, middleware/api-key.ts) — и тогда только на маршрутах с отметкой
 * apiKeyRoute.
 * Всё, что зарегистрировано после projectContext, выполняется в контексте проекта из
 * заголовка X-Project-Id, и только для его участника; новые разделы (сделки, контакты…)
 * регистрируются там же — путь вне проекта нужно добавить выше осознанно.
 */
export function createApp({
  auth,
  db,
  openDeals = OPEN_MEMBER_DEALS,
  bulk = NO_BULK,
  stageDeals = OPEN_STAGE_DEALS,
  contactDependents = DEAL_CONTACT_DEPENDENTS,
  storage = NO_FILE_STORAGE,
  stageRequirements = CUSTOM_FIELD_REQUIREMENTS,
  fields = NO_FIELD_JOBS,
  rateLimit,
  webhooks = NO_WEBHOOKS,
}: AppDeps) {
  const jsonBodyLimit = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => problem(c, 413, 'PAYLOAD_TOO_LARGE'),
  })
  const sessionGuard = accessGuard(auth)
  const v1 = v1Routes({
    stageDeals,
    contactDependents,
    storage,
    stageRequirements,
    fields,
    db,
    webhooks,
  })
  // Описание строится один раз: маршруты приложения после создания не меняются.
  const openApiDocument = v1Document(v1)
  return (
    new Hono<AccessEnv>()
      .get('/health', (c) => c.json<HealthResponse>({ status: 'ok' }))
      // Описание API (тикет crm-api/02): открыто без входа и без ключа, данных не содержит.
      .get('/v1/openapi.json', (c) => c.json(openApiDocument))
      // Страница описания открыта на адресе приложения (там же сессионная cookie): скрипт с CDN
      // закреплён хешем, CSP не пускает другие скрипты и запросы на чужие адреса.
      .get('/v1/docs', (c) => c.html(DOCS_HTML, 200, { 'Content-Security-Policy': DOCS_CSP }))
      // До входа и до контекста проекта: большое тело отклоняется, не дойдя ни до Better Auth,
      // ни до базы.
      .use('*', (c, next) =>
        isFileUpload(c.req.method, c.req.path) ? next() : jsonBodyLimit(c, next),
      )
      // Приём регистраций (/api/intake, эпик crm-intake): только ключ источника — до проверки
      // ключа API и сессии; проект и воронку запросу даёт источник (intake/auth.ts).
      .route('/intake', intakeRoutes(db, rateLimit))
      // Запрос с ключом API: ключ и маршрут проверены здесь, сессия (cookie) не читается.
      .use('*', apiKeyAuth(db, auth, createRateLimiter(rateLimit)))
      .use('*', (c, next) => (c.get('apiKey') ? next() : sessionGuard(c, next)))
      .on(['GET', 'POST'], `${AUTH_BASE_PATH}/*`, (c) => auth.handler(c.req.raw))
      .get('/me', (c) => {
        const { user } = c.get('session')
        return c.json<MeResponse>({
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role ?? null,
        })
      })
      .route('/projects', projectsRoutes(db))
      .route('/system-audit', systemAuditRoutes(db))
      .use('*', projectContext(db))
      .route('/project', currentProjectRoutes())
      .route('/roles', rolesRoutes())
      .route('/members', membersRoutes({ auth, openDeals }))
      .route('/teams', teamsRoutes())
      .route('/audit', auditRoutes())
      // Маршруты /api/v1 (прокси отдаёт API путь без /api): разделы эпика сделок.
      // Idempotency-Key у POST и PATCH (http/idempotency.ts) — в транзакции проекта.
      .use('/v1/*', idempotency())
      .route('/v1/bulk-jobs', bulkRoutes(bulk))
      .route('/v1/members', memberTransferRoutes(bulk))
      .route('/v1', v1)
      // Ошибки в формате RFC 9457 (http/problem.ts): неизвестный путь — 404 NOT_FOUND,
      // необработанная ошибка — 500 INTERNAL без подробностей (они — только в журнал процесса).
      .notFound((c) => problem(c, 404, 'NOT_FOUND'))
      .onError((error, c) => {
        if (error instanceof HTTPException && error.status < 500) {
          return problem(c, error.status, HTTP_EXCEPTION_CODES[error.status] ?? 'HTTP_ERROR')
        }
        console.error('API: необработанная ошибка', error)
        return problem(c, 500, 'INTERNAL')
      })
  )
}

/** Тип приложения для Hono RPC: клиент (apps/web) получает из него типы маршрутов. */
export type AppType = ReturnType<typeof createApp>
