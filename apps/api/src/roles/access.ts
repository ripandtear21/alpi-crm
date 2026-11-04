import type { Database } from '@alpi/db'
import { fullPermissions, parseRolePermissions, type RolePermissions } from '@alpi/shared'
import type { Kysely } from 'kysely'

/** Роль участника в текущем проекте и её права. */
export interface MemberAccess {
  roleId: string
  isAdmin: boolean
  permissions: RolePermissions
}

/**
 * Права, с которыми роль действует. Администратор — все права каталога, что бы ни лежало в
 * строке роли: так новая часть системы сразу доступна администратору, а «урезать» его роль
 * нечем (менять её строку запрещает база).
 */
export function effectivePermissions(role: { is_admin: boolean; permissions: unknown }) {
  if (role.is_admin) return fullPermissions()
  const parsed = parseRolePermissions(role.permissions)
  if (!parsed.ok) {
    // В базе права, не подходящие к каталогу: каталог поменяли без миграции данных. Молча
    // выдать «ничего» или «что разобралось» хуже, чем громкая ошибка.
    throw new Error(
      `права роли не подходят к каталогу: ${parsed.error.path} — ${parsed.error.message}`,
    )
  }
  return parsed.permissions
}

/**
 * Роль пользователя в проекте, где выполняется запрос. `db` — транзакция проекта
 * (row-level security показывает только его участников и роли); null — пользователь не
 * участник.
 */
export async function loadMemberAccess(
  db: Kysely<Database>,
  userId: string,
): Promise<MemberAccess | null> {
  const row = await db
    .selectFrom('project_member as m')
    .innerJoin('role as r', (join) =>
      join.onRef('r.id', '=', 'm.role_id').onRef('r.project_id', '=', 'm.project_id'),
    )
    .select(['r.id', 'r.is_admin', 'r.permissions'])
    .where('m.user_id', '=', userId)
    .executeTakeFirst()
  if (!row) return null
  return { roleId: row.id, isAdmin: row.is_admin, permissions: effectivePermissions(row) }
}
