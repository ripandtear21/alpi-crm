import type { Database } from '@alpi/db'
import { fullPermissions, parseRolePermissions, type RolePermissions } from '@alpi/shared'
import { type Kysely, sql } from 'kysely'

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
 * участник, его участие отключено или учётная запись заблокирована.
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
    // Заблокированный владельцем системы пользователь прав не имеет нигде: сессии у него
    // отозваны, а фоновая задача (массовая операция) проверяет права через эту же функцию.
    .innerJoin('user as u', 'u.id', 'm.user_id')
    .select(['r.id', 'r.is_admin', 'r.permissions'])
    .where('m.user_id', '=', userId)
    .where('m.disabled_at', 'is', null)
    .where('u.banned', '=', false)
    .executeTakeFirst()
  if (!row) return null
  return { roleId: row.id, isAdmin: row.is_admin, permissions: effectivePermissions(row) }
}

/**
 * Роль ключа API в проекте, где выполняется запрос (тикет crm-api/01). `db` — транзакция
 * проекта; null — ключ отозван, истёк или его роль удалена (в том числе после проверки ключа в
 * начале запроса). Роль читается на каждом запросе: смена её прав действует сразу.
 */
export async function loadApiKeyAccess(
  db: Kysely<Database>,
  apiKeyId: string,
): Promise<MemberAccess | null> {
  const row = await db
    .selectFrom('api_key as k')
    .innerJoin('role as r', (join) =>
      join.onRef('r.id', '=', 'k.role_id').onRef('r.project_id', '=', 'k.project_id'),
    )
    .select(['r.id', 'r.is_admin', 'r.permissions'])
    .where('k.id', '=', apiKeyId)
    .where('k.revoked_at', 'is', null)
    .where((eb) =>
      eb.or([eb('k.expires_at', 'is', null), eb('k.expires_at', '>', sql<Date>`now()`)]),
    )
    .executeTakeFirst()
  if (!row) return null
  return { roleId: row.id, isAdmin: row.is_admin, permissions: effectivePermissions(row) }
}
