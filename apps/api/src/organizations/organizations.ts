import type { Database, OrganizationTable } from '@alpi/db'
import type { CustomFieldErrorCode, Page, RolePermissions } from '@alpi/shared'
import { OpenAPIHono } from '@hono/zod-openapi'
import { type Kysely, type Selectable, sql } from 'kysely'
import { requestAuthor } from '../api-keys/actor.ts'
import { audit } from '../audit/record.ts'
import {
  type ChangeAuthor,
  diffFields,
  purgeFromTrash,
  recordChanges,
} from '../change-log/record.ts'
import {
  type Ctx,
  fail,
  likePattern,
  type Outcome,
  ok,
  optionalText,
  readBody,
  readLimit,
  refusalHook,
  refuse,
  requiredText,
  typed,
  UUID,
} from '../contacts/http.ts'
import {
  createOrganizationRoute,
  getOrganizationRoute,
  listOrganizationsRoute,
  patchOrganizationRoute,
} from '../contacts/openapi.ts'
import type { FieldViewer } from '../fields/access.ts'
import { clearedRequired, missingRequired, requiredFieldsOutcome } from '../fields/requirements.ts'
import {
  type CustomValues,
  changesCustom,
  customInsert,
  customUpdate,
  finishCustom,
  prepareCustom,
  readCustomInput,
  visibleCustom,
} from '../fields/values.ts'
import { decodePageCursor, encodePageCursor } from '../filters/page.ts'
import { type PermissionsEnv, requirePermission } from '../middleware/permissions.ts'

// Организации проекта (тикет crm-deals/03; spec.md, раздел 3.2): маршруты `/v1/organizations`
// (снаружи — /api/v1/organizations). Права — часть системы `organizations`; охвата у
// организаций нет (в каталоге прав он только у сделок, контактов, задач и платежей).
// Восстановить из корзины — «корзина: изменять», окончательно удалить — «корзина: удалять».
//
// Удаление (ответ владельца, пункт 35): организация уходит в корзину, а у её контактов связь
// остаётся до окончательного удаления; окончательное удаление обнуляет связь у контактов (и
// пишет это в их журнал изменений), историю самой организации стирает.
//
// Ключ API (тикет crm-api/04) проходит на поиск по названию, чтение, создание и PATCH
// (contacts/openapi.ts); удаление, восстановление и PUT — только сессия.

export type OrganizationsErrorCode =
  | 'PERMISSION_DENIED'
  | 'INVALID_ORGANIZATION'
  | 'ORGANIZATION_NOT_FOUND'
  | 'NOT_IN_TRASH'
  /** Значения пользовательских полей (`custom`, fields/values.ts). */
  | CustomFieldErrorCode

type Result<T> = Outcome<T, OrganizationsErrorCode>

/** Организация в ответах API. */
export interface OrganizationView {
  id: string
  name: string
  address: string | null
  website: string | null
  /** Значения пользовательских полей по коду (fields/values.ts). */
  custom: CustomValues
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

const LOGGED_FIELDS = [
  'name',
  'address',
  'website',
] as const satisfies readonly (keyof OrganizationView)[]

const MAX_NAME_LENGTH = 200
const MAX_TEXT_LENGTH = 500

interface OrganizationInput {
  name?: string
  address?: string | null
  website?: string | null
  /** Значения пользовательских полей: меняются только переданные коды. */
  custom?: CustomValues
}

const INPUT_FIELDS = new Set(['name', 'address', 'website', 'custom'])

function parseInput(body: Record<string, unknown>, create: boolean): Result<OrganizationInput> {
  const invalid = (path: string) => refuse(400, 'INVALID_ORGANIZATION', { path })
  for (const key of Object.keys(body)) {
    if (!INPUT_FIELDS.has(key)) return invalid(key)
  }
  const input: OrganizationInput = {}
  if (create || body.name !== undefined) {
    const name = requiredText(body.name, MAX_NAME_LENGTH)
    if (name === undefined) return invalid('name')
    input.name = name
  }
  for (const field of ['address', 'website'] as const) {
    if (body[field] === undefined) continue
    const value = optionalText(body[field], MAX_TEXT_LENGTH)
    if (value === undefined) return invalid(field)
    input[field] = value
  }
  const custom = readCustomInput(body.custom)
  if (custom === null) return invalid('custom')
  if (custom !== undefined) input.custom = custom
  if (!create && Object.keys(input).length === 0) return invalid('')
  return ok(input)
}

interface OrganizationContext extends ChangeAuthor {
  ip: string | null
  /** Права роли: какие группы полей видны и меняются (fields/access.ts). */
  permissions: RolePermissions
}

function organizationContext(c: Ctx): OrganizationContext {
  return {
    db: c.get('db'),
    projectId: c.get('projectId'),
    // Автор — участник или ключ API (тикет crm-api/04): сессии у запроса по ключу нет.
    ...requestAuthor(c.get('actor')),
    ip: c.get('clientIp'),
    permissions: c.get('access').permissions,
  }
}

type OrganizationRow = Selectable<OrganizationTable>

/** Ответ API для строк организаций. */
async function views(viewer: FieldViewer, rows: OrganizationRow[]): Promise<OrganizationView[]> {
  const custom = await visibleCustom(
    viewer,
    'organization',
    rows.map((row) => row.custom),
  )
  return rows.map((row, index) => ({
    id: row.id,
    name: row.name,
    address: row.address,
    website: row.website,
    custom: custom[index] ?? {},
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }))
}

async function view(viewer: FieldViewer, row: OrganizationRow): Promise<OrganizationView> {
  const [one] = await views(viewer, [row])
  if (!one) throw new Error('организация пропала в той же транзакции')
  return one
}

/** Организация `id` (в корзине или нет), строка заблокирована до конца транзакции. */
async function lockOrganization(
  db: Kysely<Database>,
  id: string,
): Promise<OrganizationRow | undefined> {
  if (!UUID.test(id)) return undefined
  return db
    .selectFrom('organization')
    .selectAll()
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
}

async function updateOrganization(
  ctx: OrganizationContext,
  id: string,
  input: OrganizationInput,
): Promise<Result<OrganizationView>> {
  const row = await lockOrganization(ctx.db, id)
  if (!row || row.deleted_at !== null) return refuse(404, 'ORGANIZATION_NOT_FOUND')
  const { custom: customInput, ...fields } = input
  const custom = await prepareCustom(ctx, 'organization', row.custom, customInput ?? {})
  if (!custom.ok) return custom
  // Поле «всегда» не очищается (тикет crm-fields/04); правка других полей проходит.
  const cleared = requiredFieldsOutcome(
    await clearedRequired(ctx, 'organization', null, custom.value),
  )
  if (!cleared.ok) return cleared
  const before = await view(ctx, row)
  const updated = await ctx.db
    .updateTable('organization')
    .set({
      ...fields,
      ...(changesCustom(custom.value) ? { custom: customUpdate(custom.value) } : {}),
      updated_at: sql`now()`,
    })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow()
  const after = await view(ctx, updated)
  await recordChanges(ctx, { type: 'organization', id }, diffFields(before, after, LOGGED_FIELDS))
  await finishCustom(ctx, { type: 'organization', id }, custom.value, { history: true })
  return ok(after)
}

async function trashOrganization(ctx: OrganizationContext, id: string): Promise<Result<null>> {
  const row = await lockOrganization(ctx.db, id)
  if (!row || row.deleted_at !== null) return refuse(404, 'ORGANIZATION_NOT_FOUND')
  const { deleted_at } = await ctx.db
    .updateTable('organization')
    .set({ deleted_at: sql`now()`, deleted_by: ctx.actorId })
    .where('id', '=', id)
    .returning('deleted_at')
    .executeTakeFirstOrThrow()
  await recordChanges(ctx, { type: 'organization', id }, [
    { field: 'deletedAt', before: null, after: deleted_at && new Date(deleted_at).toISOString() },
  ])
  return ok(null)
}

async function restoreOrganization(
  ctx: OrganizationContext,
  id: string,
): Promise<Result<OrganizationView>> {
  const row = await lockOrganization(ctx.db, id)
  if (!row) return refuse(404, 'ORGANIZATION_NOT_FOUND')
  if (row.deleted_at === null) return refuse(409, 'NOT_IN_TRASH')
  const restored = await ctx.db
    .updateTable('organization')
    .set({ deleted_at: null, deleted_by: null, updated_at: sql`now()` })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow()
  await recordChanges(ctx, { type: 'organization', id }, [
    { field: 'deletedAt', before: new Date(row.deleted_at).toISOString(), after: null },
  ])
  return ok(await view(ctx, restored))
}

async function purgeOrganization(ctx: OrganizationContext, id: string): Promise<Result<null>> {
  const row = await lockOrganization(ctx.db, id)
  if (!row) return refuse(404, 'ORGANIZATION_NOT_FOUND')
  if (row.deleted_at === null) return refuse(409, 'NOT_IN_TRASH')
  // Связь у контактов обнуляет внешний ключ (ON DELETE SET NULL); в их историю — явно.
  const linked = await ctx.db
    .selectFrom('contact')
    .select('id')
    .where('organization_id', '=', id)
    .forUpdate()
    .execute()
  for (const contact of linked) {
    await recordChanges(ctx, { type: 'contact', id: contact.id }, [
      { field: 'organizationId', before: id, after: null },
    ])
  }
  await purgeFromTrash(ctx, { type: 'organization', id })
  await audit.record(ctx.db, ctx.projectId, {
    action: 'organization.purged',
    actorId: ctx.actorId,
    ip: ctx.ip,
    entity: { type: 'organization', id },
  })
  return ok(null)
}

/** Сортировка поиска по названию в курсоре (filters/page.ts). */
const NAME_SORT = 'name:asc'

/**
 * Поиск по названию для ключа API и интеграций: название содержит `name` (ILIKE, как фильтр
 * «название» списка организаций), по названию, курсорная выдача `/api/v1`.
 */
async function searchOrganizations(
  ctx: OrganizationContext,
  c: Ctx,
  name: string,
): Promise<Result<Page<OrganizationView>>> {
  const limit = readLimit(c.req.query('limit'))
  if (limit === undefined) return refuse(400, 'INVALID_ORGANIZATION', { path: 'limit' })
  const rawCursor = c.req.query('cursor')
  const cursor =
    rawCursor === undefined ? undefined : decodePageCursor(rawCursor, NAME_SORT, 'text')
  if (rawCursor !== undefined && !cursor) {
    return refuse(400, 'INVALID_ORGANIZATION', { path: 'cursor' })
  }
  let query = ctx.db
    .selectFrom('organization')
    .selectAll()
    .where('deleted_at', 'is', null)
    .where('name', 'ilike', likePattern(name.trim()))
    .orderBy('name')
    .orderBy('id')
    .limit(limit + 1)
  if (cursor) query = query.where(sql<boolean>`(name, id) > (${cursor.v}, ${cursor.id}::uuid)`)
  const rows = await query.execute()
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return ok({
    data: await views(ctx, page),
    next_cursor:
      rows.length > limit && last
        ? encodePageCursor(NAME_SORT, { v: last.name, id: last.id })
        : null,
  })
}

async function createOrganization(
  ctx: OrganizationContext,
  input: OrganizationInput,
): Promise<Result<OrganizationView>> {
  const custom = await prepareCustom(ctx, 'organization', {}, input.custom ?? {})
  if (!custom.ok) return custom
  // Поля «всегда» (тикет crm-fields/04): без значения организация не создаётся.
  const required = requiredFieldsOutcome(
    await missingRequired(ctx, { entity: 'organization' }, custom.value.set),
  )
  if (!required.ok) return required
  const row = await ctx.db
    .insertInto('organization')
    .values({
      project_id: ctx.projectId,
      name: input.name ?? '',
      address: input.address ?? null,
      website: input.website ?? null,
      custom: customInsert(custom.value),
      created_by: ctx.actorId,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
  await finishCustom(ctx, { type: 'organization', id: row.id }, custom.value, { history: false })
  return ok(await view(ctx, row))
}

/** Маршруты организаций: `/v1/organizations`. */
export function organizationsRoutes() {
  const hook = refusalHook('INVALID_ORGANIZATION')
  const respond = <T>(c: Ctx, outcome: Result<T>, status: 200 | 201 = 200) =>
    typed(outcome.ok ? c.json(outcome.value as object, status) : fail(c, outcome))
  const update = async (c: Ctx) => {
    const body = await readBody(c)
    if (!body) return fail(c, refuse(400, 'INVALID_ORGANIZATION', { path: '' }))
    const input = parseInput(body, false)
    if (!input.ok) return fail(c, input)
    const outcome = await updateOrganization(
      organizationContext(c),
      c.req.param('id') ?? '',
      input.value,
    )
    return outcome.ok ? c.json<OrganizationView>(outcome.value) : fail(c, outcome)
  }
  // Маршруты, открытые ключу API, — `openapi()` с keyRoute (contacts/openapi.ts); остальные —
  // только сессия: ключ получает 403 API_KEY_NOT_ALLOWED.
  const app = new OpenAPIHono<PermissionsEnv>()
  // С `name` — поиск (страница с курсором); без него — прежняя выдача подсказок apps/web
  // (массив, `?q=`), ключу она не открыта.
  app.openapi(
    listOrganizationsRoute,
    async (c) => {
      const ctx = organizationContext(c)
      const name = c.req.query('name')
      if (name !== undefined) return respond(c, await searchOrganizations(ctx, c, name))
      if (c.get('apiKey')) return respond(c, refuse(400, 'INVALID_ORGANIZATION', { path: 'name' }))
      const limit = readLimit(c.req.query('limit'))
      if (limit === undefined)
        return respond(c, refuse(400, 'INVALID_ORGANIZATION', { path: 'limit' }))
      let query = ctx.db
        .selectFrom('organization')
        .selectAll()
        .where('deleted_at', 'is', null)
        .orderBy('name')
        .orderBy('id')
        .limit(limit)
      const q = c.req.query('q')?.trim()
      if (q) query = query.where('name', 'ilike', likePattern(q))
      return respond(c, ok(await views(ctx, await query.execute())))
    },
    hook,
  )
  app.openapi(
    getOrganizationRoute,
    async (c) => {
      const id = c.req.param('id') ?? ''
      const row = UUID.test(id)
        ? await c
            .get('db')
            .selectFrom('organization')
            .selectAll()
            .where('id', '=', id)
            .where('deleted_at', 'is', null)
            .executeTakeFirst()
        : undefined
      if (!row) return respond(c, refuse(404, 'ORGANIZATION_NOT_FOUND'))
      return respond(c, ok(await view(organizationContext(c), row)))
    },
    hook,
  )
  app.openapi(
    createOrganizationRoute,
    async (c) => {
      const body = await readBody(c)
      if (!body) return respond(c, refuse(400, 'INVALID_ORGANIZATION', { path: '' }))
      const input = parseInput(body, true)
      if (!input.ok) return respond(c, input)
      return respond(c, await createOrganization(organizationContext(c), input.value), 201)
    },
    hook,
  )
  app.openapi(patchOrganizationRoute, async (c) => typed(await update(c)), hook)
  // Карточка организации apps/web — PUT с теми же правилами, что PATCH; ключу закрыт.
  return app
    .put('/:id', requirePermission('organizations', 'edit'), update)
    .delete('/:id', requirePermission('organizations', 'delete'), async (c) => {
      const outcome = await trashOrganization(organizationContext(c), c.req.param('id'))
      return outcome.ok ? c.body(null, 204) : fail(c, outcome)
    })
    .post('/:id/restore', requirePermission('trash', 'edit'), async (c) => {
      const outcome = await restoreOrganization(organizationContext(c), c.req.param('id'))
      return outcome.ok ? c.json<OrganizationView>(outcome.value) : fail(c, outcome)
    })
    .delete('/:id/permanent', requirePermission('trash', 'delete'), async (c) => {
      const outcome = await purgeOrganization(organizationContext(c), c.req.param('id'))
      return outcome.ok ? c.body(null, 204) : fail(c, outcome)
    })
}
