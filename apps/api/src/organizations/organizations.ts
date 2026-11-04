import type { Database, OrganizationTable } from '@alpi/db'
import { Hono } from 'hono'
import { type Kysely, type Selectable, sql } from 'kysely'
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
  refuse,
  requiredText,
  UUID,
} from '../contacts/http.ts'
import { type PermissionsEnv, requirePermission } from '../middleware/permissions.ts'

// Организации проекта (тикет crm-deals/03; spec.md, раздел 3.2): маршруты `/v1/organizations`
// (снаружи — /api/v1/organizations). Права — часть системы `organizations`; охвата у
// организаций нет (в каталоге прав он только у сделок, контактов, задач и платежей).
// Восстановить из корзины — «корзина: изменять», окончательно удалить — «корзина: удалять».
//
// Удаление (ответ владельца, пункт 35): организация уходит в корзину, а у её контактов связь
// остаётся до окончательного удаления; окончательное удаление обнуляет связь у контактов (и
// пишет это в их журнал изменений), историю самой организации стирает.

export type OrganizationsErrorCode =
  | 'PERMISSION_DENIED'
  | 'INVALID_ORGANIZATION'
  | 'ORGANIZATION_NOT_FOUND'
  | 'NOT_IN_TRASH'

type Result<T> = Outcome<T, OrganizationsErrorCode>

/** Организация в ответах API. */
export interface OrganizationView {
  id: string
  name: string
  address: string | null
  website: string | null
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
}

const INPUT_FIELDS = new Set(['name', 'address', 'website'])

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
  if (!create && Object.keys(input).length === 0) return invalid('')
  return ok(input)
}

interface OrganizationContext extends ChangeAuthor {
  actorId: string
  ip: string | null
}

function organizationContext(c: Ctx): OrganizationContext {
  return {
    db: c.get('db'),
    projectId: c.get('projectId'),
    actorId: c.get('session').user.id,
    ip: c.get('clientIp'),
  }
}

type OrganizationRow = Selectable<OrganizationTable>

function view(row: OrganizationRow): OrganizationView {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    website: row.website,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
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
  const updated = await ctx.db
    .updateTable('organization')
    .set({ ...input, updated_at: sql`now()` })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow()
  const after = view(updated)
  await recordChanges(
    ctx,
    { type: 'organization', id },
    diffFields(view(row), after, LOGGED_FIELDS),
  )
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
  return ok(view(restored))
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

/** Маршруты организаций: `/v1/organizations`. */
export function organizationsRoutes() {
  return new Hono<PermissionsEnv>()
    .get('/', requirePermission('organizations', 'view'), async (c) => {
      const limit = readLimit(c.req.query('limit'))
      if (limit === undefined)
        return fail(c, refuse(400, 'INVALID_ORGANIZATION', { path: 'limit' }))
      let query = c
        .get('db')
        .selectFrom('organization')
        .selectAll()
        .where('deleted_at', 'is', null)
        .orderBy('name')
        .orderBy('id')
        .limit(limit)
      const q = c.req.query('q')?.trim()
      if (q) query = query.where('name', 'ilike', likePattern(q))
      return c.json<OrganizationView[]>((await query.execute()).map(view))
    })
    .get('/:id', requirePermission('organizations', 'view'), async (c) => {
      const id = c.req.param('id')
      const row = UUID.test(id)
        ? await c
            .get('db')
            .selectFrom('organization')
            .selectAll()
            .where('id', '=', id)
            .where('deleted_at', 'is', null)
            .executeTakeFirst()
        : undefined
      if (!row) return fail(c, refuse(404, 'ORGANIZATION_NOT_FOUND'))
      return c.json<OrganizationView>(view(row))
    })
    .post('/', requirePermission('organizations', 'create'), async (c) => {
      const body = await readBody(c)
      if (!body) return fail(c, refuse(400, 'INVALID_ORGANIZATION', { path: '' }))
      const input = parseInput(body, true)
      if (!input.ok) return fail(c, input)
      const ctx = organizationContext(c)
      const row = await ctx.db
        .insertInto('organization')
        .values({
          project_id: ctx.projectId,
          name: input.value.name ?? '',
          address: input.value.address ?? null,
          website: input.value.website ?? null,
          created_by: ctx.actorId,
        })
        .returningAll()
        .executeTakeFirstOrThrow()
      return c.json<OrganizationView>(view(row), 201)
    })
    .put('/:id', requirePermission('organizations', 'edit'), async (c) => {
      const body = await readBody(c)
      if (!body) return fail(c, refuse(400, 'INVALID_ORGANIZATION', { path: '' }))
      const input = parseInput(body, false)
      if (!input.ok) return fail(c, input)
      const outcome = await updateOrganization(
        organizationContext(c),
        c.req.param('id'),
        input.value,
      )
      return outcome.ok ? c.json<OrganizationView>(outcome.value) : fail(c, outcome)
    })
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
