import { type Action, can, type Resource } from '@alpi/shared'
import { createMiddleware } from 'hono/factory'
import { loadMemberAccess, type MemberAccess } from '../roles/access.ts'
import type { ProjectEnv } from './project-context.ts'

// Проверка прав роли (spec.md, раздел 4). Ставится на маршрут после projectContext:
//   .get('/', requirePermission('deals', 'view'), handler)
// Права пользователя — по его роли в текущем проекте; владелец системы (роль admin плагина
// Better Auth) прав в проекте сверх своей роли участника не получает.

/** Переменные контекста Hono после проверки прав. */
export type PermissionsEnv = {
  Variables: ProjectEnv['Variables'] & {
    /** Роль и права пользователя в текущем проекте: загружаются один раз на запрос. */
    access: MemberAccess
  }
}

/**
 * Пропускает запрос, если роль пользователя в текущем проекте разрешает `action` с
 * `resource`; иначе — 403 PERMISSION_DENIED. Роль читается в транзакции проекта и
 * кладётся в `c.var.access` для обработчика.
 */
export function requirePermission(resource: Resource, action: Action) {
  return createMiddleware<PermissionsEnv>(async (c, next) => {
    let access = c.get('access') as MemberAccess | undefined
    if (!access) {
      const loaded = await loadMemberAccess(c.get('db'), c.get('session').user.id)
      // projectContext уже проверил участие; пропасть оно могло только в этой же транзакции.
      if (!loaded) return c.json({ code: 'PERMISSION_DENIED' }, 403)
      access = loaded
      c.set('access', access)
    }
    if (!can(access.permissions, resource, action)) {
      return c.json({ code: 'PERMISSION_DENIED' }, 403)
    }
    await next()
  })
}
