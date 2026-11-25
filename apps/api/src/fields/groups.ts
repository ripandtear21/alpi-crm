import type { Database } from '@alpi/db'
import type { FieldEntity, FieldGroupSummary } from '@alpi/shared'
import { Hono } from 'hono'
import { type Kysely, sql } from 'kysely'
import { recordInRequest } from '../audit/record.ts'
import { type Ctx, fail, readBody, refuse, UUID } from '../contacts/http.ts'
import { type PermissionsEnv, requirePermission } from '../middleware/permissions.ts'
import { readIds, reorder } from '../pipelines/directory.ts'
import { inSavepoint, sqlState } from '../roles/roles.ts'
import { groupVisible } from './access.ts'
import { entityReader, invalid, isFieldEntity, notFound, readNames, unknownKey } from './common.ts'

// Группы полей (тикет crm-fields/01): `/api/v1/field-groups?entity=deal|contact|organization`.
// Группа принадлежит одной сущности (решено без владельца, подтвердить). Читает каждый с правом
// смотреть сущность; меняет — право «поля» (fields). Группу с полями, в том числе архивными,
// удалить нельзя — 409 (решено без владельца, подтвердить; держит и база внешним ключом).
// Каждое изменение пишется в журнал проекта той же транзакцией. Скрытая от роли группа и для
// изменяющих запросов — как несуществующая (тикет crm-fields/03).

const FOREIGN_KEY_VIOLATION = '23503'

interface GroupRow {
  id: string
  entity: FieldEntity
  name_uk: string
  name_ru: string | null
  position: number
}

const COLUMNS = ['id', 'entity', 'name_uk', 'name_ru', 'position'] as const

function summary(row: GroupRow): FieldGroupSummary {
  return {
    id: row.id,
    entity: row.entity,
    nameUk: row.name_uk,
    nameRu: row.name_ru,
    position: row.position,
  }
}

export async function listGroups(
  db: Kysely<Database>,
  entity: FieldEntity,
): Promise<FieldGroupSummary[]> {
  const rows = await db
    .selectFrom('field_group')
    .select(COLUMNS)
    .where('entity', '=', entity)
    .orderBy('position')
    .orderBy('created_at')
    .orderBy('id')
    .execute()
  return rows.map(summary)
}

/**
 * Группа `:id` текущего проекта, заблокированная до конца транзакции; undefined — нет такой или
 * она скрыта от роли: ответ — как на несуществующую (тикет crm-fields/03).
 */
async function lockGroup(c: Ctx): Promise<GroupRow | undefined> {
  const id = c.req.param('id') ?? ''
  if (!UUID.test(id)) return undefined
  const group = await c
    .get('db')
    .selectFrom('field_group')
    .select(COLUMNS)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  return group && groupVisible(c.get('access').permissions, group) ? group : undefined
}

async function createGroup(c: Ctx) {
  const body = await readBody(c)
  if (!body) return fail(c, invalid(''))
  const extra = unknownKey(body, ['entity', 'nameUk', 'nameRu'])
  if (extra !== undefined) return fail(c, invalid(extra))
  if (!isFieldEntity(body.entity)) return fail(c, invalid('entity'))
  const names = readNames(body, false)
  if (typeof names === 'string') return fail(c, invalid(names))
  const db = c.get('db')
  const max = await db
    .selectFrom('field_group')
    .select((eb) => eb.fn.max('position').as('max'))
    .where('entity', '=', body.entity)
    .executeTakeFirst()
  const row = await db
    .insertInto('field_group')
    .values({
      project_id: c.get('projectId'),
      entity: body.entity,
      name_uk: names.nameUk ?? '',
      name_ru: names.nameRu ?? null,
      position: Number(max?.max ?? 0) + 1,
      created_by: c.get('session').user.id,
    })
    .returning(COLUMNS)
    .executeTakeFirstOrThrow()
  await recordInRequest(c, {
    action: 'field_group.created',
    entity: { type: 'field_group', id: row.id },
    details: { name: row.name_uk, entity: row.entity, after: { nameUk: row.name_uk } },
  })
  return c.json<FieldGroupSummary>(summary(row), 201)
}

async function updateGroup(c: Ctx) {
  const body = await readBody(c)
  if (!body) return fail(c, invalid(''))
  const extra = unknownKey(body, ['nameUk', 'nameRu'])
  if (extra !== undefined) return fail(c, invalid(extra))
  const names = readNames(body, true)
  if (typeof names === 'string') return fail(c, invalid(names))
  const db = c.get('db')
  const group = await lockGroup(c)
  if (!group) return fail(c, notFound())
  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  const set: { name_uk?: string; name_ru?: string | null } = {}
  if (names.nameUk !== undefined && names.nameUk !== group.name_uk) {
    before.nameUk = group.name_uk
    after.nameUk = names.nameUk
    set.name_uk = names.nameUk
  }
  if (names.nameRu !== undefined && names.nameRu !== group.name_ru) {
    before.nameRu = group.name_ru
    after.nameRu = names.nameRu
    set.name_ru = names.nameRu
  }
  if (Object.keys(set).length === 0) return c.json<FieldGroupSummary>(summary(group))
  const row = await db
    .updateTable('field_group')
    .set({ ...set, updated_at: sql`now()` })
    .where('id', '=', group.id)
    .returning(COLUMNS)
    .executeTakeFirstOrThrow()
  await recordInRequest(c, {
    action: 'field_group.updated',
    entity: { type: 'field_group', id: group.id },
    details: { name: row.name_uk, before, after },
  })
  return c.json<FieldGroupSummary>(summary(row))
}

async function reorderGroups(c: Ctx) {
  const body = await readBody(c)
  if (!body || !isFieldEntity(body.entity)) return fail(c, invalid('entity'))
  const ids = readIds(body)
  if (!ids) return fail(c, invalid('ids'))
  const db = c.get('db')
  const permissions = c.get('access').permissions
  const current = await db
    .selectFrom('field_group')
    .select(['id', 'entity'])
    .where('entity', '=', body.entity)
    .orderBy('position')
    .orderBy('created_at')
    .orderBy('id')
    .forUpdate()
    .execute()
  // Роль переставляет только видимые ей группы (тикет crm-fields/03): id скрытой группы — как
  // неизвестный (400 INVALID_ORDER), скрытые группы остаются на своих местах в порядке — иначе
  // отказ на список без них выдал бы, что они есть. Администратору видны все: порядок — ids.
  const visible = new Set(current.filter((g) => groupVisible(permissions, g)).map((g) => g.id))
  if (ids.length !== visible.size || !ids.every((id) => visible.has(id))) {
    return fail(c, refuse(400, 'INVALID_ORDER'))
  }
  const queue = [...ids]
  const order = current.map((g) => (visible.has(g.id) ? (queue.shift() as string) : g.id))
  await reorder(
    db,
    'field_group',
    current.map((g) => g.id),
    order,
  )
  await recordInRequest(c, {
    action: 'field_group.reordered',
    details: { entity: body.entity, after: { ids } },
  })
  const groups = await listGroups(db, body.entity)
  return c.json<FieldGroupSummary[]>(groups.filter((g) => groupVisible(permissions, g)))
}

async function deleteGroup(c: Ctx) {
  const db = c.get('db')
  const group = await lockGroup(c)
  if (!group) return fail(c, notFound())
  const field = await db
    .selectFrom('field_definition')
    .select('id')
    .where('group_id', '=', group.id)
    .limit(1)
    .executeTakeFirst()
  if (field) return fail(c, refuse(409, 'FIELD_GROUP_NOT_EMPTY'))
  try {
    await inSavepoint(db, () => db.deleteFrom('field_group').where('id', '=', group.id).execute())
  } catch (error) {
    // Поле успели создать в группе между проверкой и удалением: держит внешний ключ.
    if (sqlState(error) === FOREIGN_KEY_VIOLATION) {
      return fail(c, refuse(409, 'FIELD_GROUP_NOT_EMPTY'))
    }
    throw error
  }
  // Удалённая группа уходит из прав всех ролей той же транзакцией (тикет 03): иначе её id
  // остался бы в правах ролей висячей ссылкой. У роли администратора записей о группах нет
  // (её строку не меняет и база).
  const roles = await db
    .updateTable('role')
    .set({
      permissions: sql`jsonb_set(permissions, '{fieldGroups}', (permissions -> 'fieldGroups') - ${group.id}::text)`,
      updated_at: sql`now()`,
    })
    .where('is_admin', '=', false)
    .where(sql<boolean>`permissions -> 'fieldGroups' ? ${group.id}::text`)
    .returning('id')
    .execute()
  await recordInRequest(c, {
    action: 'field_group.deleted',
    entity: { type: 'field_group', id: group.id },
    details: {
      name: group.name_uk,
      entity: group.entity,
      ...(roles.length > 0 ? { roles: roles.map((r) => r.id) } : {}),
    },
  })
  return c.body(null, 204)
}

/** Маршруты групп полей: `/api/v1/field-groups`. */
export function fieldGroupsRoutes() {
  return (
    new Hono<PermissionsEnv>()
      .get('/', async (c) => {
        const entity = c.req.query('entity')
        if (!isFieldEntity(entity)) return fail(c, invalid('entity'))
        const permissions = await entityReader(c, entity)
        if (!permissions) return fail(c, refuse(403, 'PERMISSION_DENIED'))
        // Скрытые от роли группы не отдаются (тикет 03).
        const groups = await listGroups(c.get('db'), entity)
        return c.json<FieldGroupSummary[]>(groups.filter((g) => groupVisible(permissions, g)))
      })
      .post('/', requirePermission('fields', 'create'), createGroup)
      // /order — до /:id: иначе «order» читался бы как id группы.
      .put('/order', requirePermission('fields', 'edit'), reorderGroups)
      .put('/:id', requirePermission('fields', 'edit'), updateGroup)
      .delete('/:id', requirePermission('fields', 'delete'), deleteGroup)
  )
}
