import type { Database } from '@alpi/db'
import type { HealthResponse } from '@alpi/shared'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { Kysely } from 'kysely'
import { auditRoutes, systemAuditRoutes } from './audit/routes.ts'
import { type AccessEnv, accessGuard } from './auth/access-guard.ts'
import { AUTH_BASE_PATH, type Auth } from './auth/auth.ts'
import { type BulkDeps, bulkRoutes, NO_BULK } from './bulk/routes.ts'
import { contactsRoutes } from './contacts/contacts.ts'
import type { ContactDependents } from './contacts/dependents.ts'
import { dealsRoutes } from './deals/deals.ts'
import { DEAL_CONTACT_DEPENDENTS } from './deals/dependents.ts'
import { isFileUpload } from './files/files.ts'
import { lostReasonsRoutes } from './lost-reasons/lost-reasons.ts'
import { membersRoutes } from './members/members.ts'
import { NO_OPEN_DEALS, type OpenDealsChecker } from './members/open-deals.ts'
import type { PermissionsEnv } from './middleware/permissions.ts'
import { projectContext } from './middleware/project-context.ts'
import { organizationsRoutes } from './organizations/organizations.ts'
import { pipelinesRoutes } from './pipelines/pipelines.ts'
import { OPEN_STAGE_DEALS, type StageDealsChecker } from './pipelines/stage-deals.ts'
import { productsRoutes } from './products/products.ts'
import { currentProjectRoutes, projectsRoutes } from './projects/projects.ts'
import { rolesRoutes } from './roles/roles.ts'
import { type FileStorage, NO_FILE_STORAGE } from './storage/storage.ts'
import { teamsRoutes } from './teams/teams.ts'
import { entityRecordsRoutes } from './timeline/timeline.ts'

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
  /** Открытые сделки участника — для отключения участия; до эпика сделок — заглушка «нет». */
  openDeals?: OpenDealsChecker
  /** Массовые действия и очередь pg-boss (apps/api/src/jobs/jobs.ts); без них действий нет. */
  bulk?: BulkDeps
  /** Открытые сделки на этапе — для удаления этапа; по умолчанию — по таблице deal. */
  stageDeals?: StageDealsChecker
  /** Что удаляется вместе с контактом; по умолчанию — сделки, где он основной. */
  contactDependents?: ContactDependents
  /** Хранилище содержимого файлов (storage/storage.ts); без него файлов нет. */
  storage?: FileStorage
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
}: {
  stageDeals: StageDealsChecker
  contactDependents: ContactDependents
  storage: FileStorage
}) {
  return (
    new Hono<PermissionsEnv>()
      .route('/deals', dealsRoutes())
      .route('/pipelines', pipelinesRoutes({ stageDeals }))
      .route('/lost-reasons', lostReasonsRoutes())
      .route('/contacts', contactsRoutes({ dependents: contactDependents }))
      .route('/organizations', organizationsRoutes())
      .route('/products', productsRoutes())
      // Заметки, файлы и лента записи: /v1/deals/:id/notes, …/files, …/timeline.
      .route('/deals', entityRecordsRoutes('deal', storage))
      .route('/contacts', entityRecordsRoutes('contact', storage))
      .route('/organizations', entityRecordsRoutes('organization', storage))
  )
}

/**
 * Приложение API. Открыт без входа только /health; всё, что зарегистрировано после
 * accessGuard, требует сессию с включённой 2FA (исключения — в access-guard.ts).
 * Всё, что зарегистрировано после projectContext, выполняется в контексте проекта из
 * заголовка X-Project-Id, и только для его участника; новые разделы (сделки, контакты…)
 * регистрируются там же — путь вне проекта нужно добавить выше осознанно.
 */
export function createApp({
  auth,
  db,
  openDeals = NO_OPEN_DEALS,
  bulk = NO_BULK,
  stageDeals = OPEN_STAGE_DEALS,
  contactDependents = DEAL_CONTACT_DEPENDENTS,
  storage = NO_FILE_STORAGE,
}: AppDeps) {
  const jsonBodyLimit = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ code: 'PAYLOAD_TOO_LARGE' }, 413),
  })
  return (
    new Hono<AccessEnv>()
      .get('/health', (c) => c.json<HealthResponse>({ status: 'ok' }))
      // До входа и до контекста проекта: большое тело отклоняется, не дойдя ни до Better Auth,
      // ни до базы.
      .use('*', (c, next) =>
        isFileUpload(c.req.method, c.req.path) ? next() : jsonBodyLimit(c, next),
      )
      .use('*', accessGuard(auth))
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
      .route('/v1/bulk-jobs', bulkRoutes(bulk))
      .route('/v1', v1Routes({ stageDeals, contactDependents, storage }))
  )
}

/** Тип приложения для Hono RPC: клиент (apps/web) получает из него типы маршрутов. */
export type AppType = ReturnType<typeof createApp>
