import type { Database } from '@alpi/db'
import {
  parseRolePermissions,
  ROLE_TEMPLATE_KEYS,
  type RolePermissions,
  type RoleSummary,
  type RolesErrorCode,
  type RoleTemplateKey,
} from '@alpi/shared'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { type Kysely, sql } from 'kysely'
import { recordInRequest } from '../audit/record.ts'
import { type FieldGroupRef, loadFieldGroupRefs } from '../fields/access.ts'
import { type PermissionsEnv, requirePermission } from '../middleware/permissions.ts'
import { effectivePermissions } from './access.ts'
import { checkRoleCreate, checkRoleEdit, type GuardFailure } from './guard.ts'

// Роли проекта (тикет crm-foundation/05); назначение роли участнику — в
// apps/api/src/members/ (все изменения участников — в одном модуле, тикет crm-foundation/06). Все маршруты — в контексте проекта
// (после projectContext) и под правом «пользователи и роли» на соответствующее действие.
// Защиты роли администратора и последнего администратора держит база
// (packages/db/migrations/0004_roles.ts); здесь их ошибки становятся ответами 409.
// Кто какие роли может выдавать — guard.ts: каждый маршрут записи зовёт его проверку до записи,
// отказ — 403 с кодом правила. Каждое изменение пишется в журнал проекта (audit/record.ts) той
// же транзакцией, с «было → стало».

const MAX_NAME_LENGTH = 60
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** SQLSTATE: стандартные PostgreSQL и свои — из триггеров 0004_roles. */
const UNIQUE_VIOLATION = '23505'
const FOREIGN_KEY_VIOLATION = '23503'
const ADMIN_ROLE_LOCKED = 'AR001'
const LAST_ADMIN = 'AR002'

type Ctx = Context<PermissionsEnv>

function fail(
  c: Ctx,
  status: 400 | 403 | 404 | 409 | 422,
  code: RolesErrorCode,
  details?: unknown,
) {
  return c.json(details === undefined ? { code } : { code, details }, status)
}

export function sqlState(error: unknown): unknown {
  return (error as { code?: unknown }).code
}

/**
 * Изменение в точке сохранения: ошибка базы (отказ защиты, повтор названия) откатывает только
 * его, а транзакция проекта остаётся рабочей — обработчик отвечает 409, а не 500.
 */
export async function inSavepoint<T>(db: Kysely<Database>, fn: () => Promise<T>): Promise<T> {
  await sql`savepoint role_change`.execute(db)
  try {
    const result = await fn()
    await sql`release savepoint role_change`.execute(db)
    return result
  } catch (error) {
    await sql`rollback to savepoint role_change`.execute(db)
    throw error
  }
}

/** Ответ на ошибку защиты из базы; другие ошибки пробрасываются (500). */
function protectionFailure(c: Ctx, error: unknown) {
  switch (sqlState(error)) {
    case ADMIN_ROLE_LOCKED:
      return fail(c, 409, 'ADMIN_ROLE_LOCKED')
    case LAST_ADMIN:
      return fail(c, 409, 'LAST_ADMIN')
    case UNIQUE_VIOLATION:
      return fail(c, 409, 'ROLE_NAME_TAKEN')
    default:
      throw error
  }
}

function denied(c: Ctx, failure: GuardFailure) {
  return fail(c, 403, failure)
}

/**
 * Каждый id в `fieldGroups` — группа полей этого проекта (row-level security показывает только
 * свои группы, так что id чужого проекта здесь не найдётся). Группы блокируются FOR KEY SHARE до
 * конца транзакции: удаление группы (fields/groups.ts, FOR UPDATE) ждёт записи роли и потом
 * убирает группу из её прав. Путь первого чужого id; undefined — все свои.
 */
async function unknownFieldGroup(
  db: Kysely<Database>,
  permissions: RolePermissions,
): Promise<string | undefined> {
  const ids = Object.keys(permissions.fieldGroups)
  if (ids.length === 0) return undefined
  const found = await db
    .selectFrom('field_group')
    .select('id')
    .where('id', 'in', ids)
    .orderBy('id')
    .forKeyShare()
    .execute()
  const known = new Set(found.map((g) => g.id))
  const missing = ids.find((id) => !known.has(id))
  return missing === undefined ? undefined : `permissions.fieldGroups.${missing}`
}

/** Группы полей проекта для проверки guard.ts; администратору проверка не нужна. */
function guardGroups(c: Ctx): Promise<FieldGroupRef[]> {
  return c.get('access').isAdmin ? Promise.resolve([]) : loadFieldGroupRefs(c.get('db'))
}

function isTemplateKey(value: unknown): value is RoleTemplateKey {
  return ROLE_TEMPLATE_KEYS.some((key) => key === value)
}

/** Роли проекта с числом участников: администратор, шаблоны в их порядке, затем свои. */
export async function listRoles(db: Kysely<Database>, roleId?: string): Promise<RoleSummary[]> {
  let query = db
    .selectFrom('role as r')
    .leftJoin('project_member as m', (join) =>
      join.onRef('m.role_id', '=', 'r.id').onRef('m.project_id', '=', 'r.project_id'),
    )
    .select((eb) => [
      'r.id',
      'r.name',
      'r.template_key',
      'r.is_admin',
      'r.permissions',
      eb.fn.count<string>('m.id').as('member_count'),
    ])
    .groupBy('r.id')
    .orderBy(
      sql`array_position(array['admin', 'head', 'teamlead', 'manager'], r.template_key)`,
      sql`asc nulls last`,
    )
    .orderBy('r.name')
  if (roleId !== undefined) query = query.where('r.id', '=', roleId)
  const rows = await query.execute()
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    templateKey: isTemplateKey(row.template_key) ? row.template_key : null,
    isAdmin: row.is_admin,
    permissions: effectivePermissions(row),
    memberCount: Number(row.member_count),
  }))
}

interface RoleInput {
  name?: string
  /** Права в каноническом виде (прошли parseRolePermissions). */
  permissions?: RolePermissions
}

/** Значения для записи в role: права — строкой JSON для JSONB. */
function roleValues({ name, permissions }: RoleInput) {
  return {
    ...(name === undefined ? {} : { name }),
    ...(permissions === undefined ? {} : { permissions: JSON.stringify(permissions) }),
  }
}

/** Тело запроса роли; `partial` — для изменения, где поля необязательны. */
async function readRoleInput(
  c: Ctx,
  partial: boolean,
): Promise<{ ok: true; value: RoleInput } | { ok: false; details: unknown }> {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (typeof body !== 'object' || body === null) return { ok: false, details: 'ожидается JSON' }
  const value: RoleInput = {}
  if (body.name !== undefined || !partial) {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
      return { ok: false, details: { path: 'name', message: 'пустое или длинное название' } }
    }
    value.name = name
  }
  if (body.permissions !== undefined || !partial) {
    const parsed = parseRolePermissions(body.permissions)
    if (!parsed.ok) return { ok: false, details: parsed.error }
    value.permissions = parsed.permissions
  }
  if (value.name === undefined && value.permissions === undefined) {
    return { ok: false, details: 'нечего менять' }
  }
  return { ok: true, value }
}

/** Маршруты ролей: `/roles`. */
export function rolesRoutes() {
  return new Hono<PermissionsEnv>()
    .get('/', requirePermission('users_roles', 'view'), async (c) =>
      c.json<RoleSummary[]>(await listRoles(c.get('db'))),
    )
    .post('/', requirePermission('users_roles', 'create'), async (c) => {
      const input = await readRoleInput(c, false)
      if (!input.ok) return fail(c, 400, 'INVALID_ROLE', input.details)
      const { name = '', permissions } = input.value
      if (!permissions) return fail(c, 400, 'INVALID_ROLE')
      const db = c.get('db')
      const unknownGroup = await unknownFieldGroup(db, permissions)
      if (unknownGroup) return fail(c, 422, 'FIELD_GROUP_NOT_FOUND', { path: unknownGroup })
      const failure = checkRoleCreate(c.get('access'), permissions, await guardGroups(c))
      if (failure) return denied(c, failure)
      try {
        const { id } = await inSavepoint(db, () =>
          db
            .insertInto('role')
            .values({
              project_id: c.get('projectId'),
              name,
              permissions: JSON.stringify(permissions),
              created_by: c.get('session').user.id,
            })
            .returning('id')
            .executeTakeFirstOrThrow(),
        )
        await recordInRequest(c, {
          action: 'role.created',
          entity: { type: 'role', id },
          details: { after: { name, permissions } },
        })
        const [created] = await listRoles(db, id)
        return c.json<RoleSummary>(created as RoleSummary, 201)
      } catch (error) {
        return protectionFailure(c, error)
      }
    })
    .put('/:id', requirePermission('users_roles', 'edit'), async (c) => {
      const id = c.req.param('id')
      if (!UUID.test(id)) return fail(c, 404, 'ROLE_NOT_FOUND')
      const input = await readRoleInput(c, true)
      if (!input.ok) return fail(c, 400, 'INVALID_ROLE', input.details)
      const db = c.get('db')
      // Строка роли блокируется до конца транзакции: проверка и запись видят одни и те же права.
      const current = await db
        .selectFrom('role')
        .select(['id', 'name', 'is_admin', 'permissions'])
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!current) return fail(c, 404, 'ROLE_NOT_FOUND')
      const next = input.value.permissions
      if (next) {
        const unknownGroup = await unknownFieldGroup(db, next)
        if (unknownGroup) return fail(c, 422, 'FIELD_GROUP_NOT_FOUND', { path: unknownGroup })
      }
      const failure = checkRoleEdit(
        c.get('access'),
        { id: current.id, permissions: effectivePermissions(current) },
        next,
        await guardGroups(c),
      )
      if (failure) return denied(c, failure)
      // Администратор всегда «изменять» на все группы (тикет crm-fields/03): урезать его доступ
      // к группе — 422, а не общий отказ 409 «роль администратора неизменна» — ошибка в самом
      // запросе. Остальные изменения роли администратора отклоняет база (409).
      if (current.is_admin && next && Object.values(next.fieldGroups).some((a) => a !== 'edit')) {
        return fail(c, 422, 'ADMIN_FIELD_GROUPS_LOCKED')
      }
      try {
        const updated = await inSavepoint(db, () =>
          db
            .updateTable('role')
            .set({ ...roleValues(input.value), updated_at: sql`now()` })
            .where('id', '=', id)
            .returning('id')
            .executeTakeFirst(),
        )
        if (!updated) return fail(c, 404, 'ROLE_NOT_FOUND')
      } catch (error) {
        return protectionFailure(c, error)
      }
      const { name, permissions } = input.value
      await recordInRequest(c, {
        action: 'role.updated',
        entity: { type: 'role', id },
        details: {
          before: {
            ...(name === undefined ? {} : { name: current.name }),
            ...(permissions === undefined ? {} : { permissions: effectivePermissions(current) }),
          },
          after: input.value,
        },
      })
      const [role] = await listRoles(db, id)
      return c.json<RoleSummary>(role as RoleSummary)
    })
    .delete('/:id', requirePermission('users_roles', 'delete'), async (c) => {
      const id = c.req.param('id')
      if (!UUID.test(id)) return fail(c, 404, 'ROLE_NOT_FOUND')
      const db = c.get('db')
      let deleted: { name: string; is_admin: boolean; permissions: unknown } | undefined
      try {
        deleted = await inSavepoint(db, () =>
          db
            .deleteFrom('role')
            .where('id', '=', id)
            .returning(['name', 'is_admin', 'permissions'])
            .executeTakeFirst(),
        )
        if (!deleted) return fail(c, 404, 'ROLE_NOT_FOUND')
      } catch (error) {
        // Роль с участниками: внешний ключ project_member → role.
        if (sqlState(error) === FOREIGN_KEY_VIOLATION) return fail(c, 409, 'ROLE_IN_USE')
        return protectionFailure(c, error)
      }
      await recordInRequest(c, {
        action: 'role.deleted',
        entity: { type: 'role', id },
        details: {
          before: { name: deleted.name, permissions: effectivePermissions(deleted) },
        },
      })
      return c.body(null, 204)
    })
}
