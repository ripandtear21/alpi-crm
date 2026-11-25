import type { Database } from '@alpi/db'
import {
  type FieldEntity,
  type FieldGroupAccess,
  fieldGroupAccess,
  type RolePermissions,
} from '@alpi/shared'
import type { Kysely } from 'kysely'

// Доступ роли к группам пользовательских полей (тикет crm-fields/03; spec.md MVP, раздел 4) —
// одно место сервера, где права роли превращаются в «какие группы и коды поля роль видит и может
// менять». Правило доступа к одной группе — fieldGroupAccess (packages/shared): его же
// показывает редактор ролей. Отсюда читают:
// - описания полей и групп (groups.ts, fields.ts) — скрытые группы и их поля не отдаются;
// - значения (values.ts) — коды скрытых полей убираются из `custom`, запись в поле группы
//   «только чтение» — 403, в поле скрытой группы — 422 как неизвестный код;
// - историю записи (deals/deals.ts, timeline/timeline.ts) — строки change_log по полям, которые
//   роль не видит, не отдаются;
// - проверку прав ролей (roles/guard.ts) — группы проекта с их сущностями.
// Администратор действует с fullPermissions(): записей о группах нет, всё «изменять».

/** Группа полей проекта: id и сущность (от сущности зависит доступ без записи). */
export interface FieldGroupRef {
  id: string
  entity: FieldEntity
}

/** Права и транзакция проекта того, кто читает или пишет записи. */
export interface FieldViewer {
  db: Kysely<Database>
  permissions: RolePermissions
}

/** Группы полей проекта (`ids` — только эти). Транзакция проекта: RLS отдаёт только свои. */
export async function loadFieldGroupRefs(
  db: Kysely<Database>,
  ids?: readonly string[],
): Promise<FieldGroupRef[]> {
  if (ids?.length === 0) return []
  let query = db.selectFrom('field_group').select(['id', 'entity']).orderBy('id')
  if (ids) query = query.where('id', 'in', ids)
  return query.execute()
}

/** Видит ли роль группу. */
export function groupVisible(permissions: RolePermissions, group: FieldGroupRef): boolean {
  return fieldGroupAccess(permissions, group) !== 'hidden'
}

/** Видит ли роль поле: поле видно, пока видна его группа. */
export function fieldVisible(
  permissions: RolePermissions,
  field: { groupId: string; entity: FieldEntity },
): boolean {
  return groupVisible(permissions, { id: field.groupId, entity: field.entity })
}

/**
 * Доступ роли к каждому полю сущности по коду — по всем описаниям, и архивным тоже. Кода нет в
 * ответе — поля с таким кодом у сущности нет.
 */
export async function fieldCodeAccess(
  { db, permissions }: FieldViewer,
  entity: FieldEntity,
): Promise<Map<string, FieldGroupAccess>> {
  const fields = await db
    .selectFrom('field_definition')
    .select(['code', 'group_id'])
    .where('entity', '=', entity)
    .execute()
  return new Map(
    fields.map((f) => [f.code, fieldGroupAccess(permissions, { id: f.group_id, entity })]),
  )
}

/**
 * Значения поля `change_log.field`, которые роль видит из пользовательских полей сущности:
 * `custom.<код>` каждого поля не скрытой группы. Строки истории `custom.*` вне этого списка не
 * отдаются — и по скрытым полям, и по окончательно удалённым: у удалённого поля не узнать,
 * в какой группе оно было (решено без владельца, подтвердить).
 */
export async function visibleHistoryFields(
  viewer: FieldViewer,
  entity: FieldEntity,
): Promise<string[]> {
  const access = await fieldCodeAccess(viewer, entity)
  return [...access].filter(([, a]) => a !== 'hidden').map(([code]) => `custom.${code}`)
}

/** Префикс `change_log.field` у пользовательских полей. */
export const CUSTOM_HISTORY_PREFIX = 'custom.'
