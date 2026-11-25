import {
  type Action,
  can,
  hasStandalone,
  type Resource,
  type StandalonePermission,
} from '@alpi/shared'
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { problem } from '../http/problem.ts'
import { loadApiKeyAccess, loadMemberAccess, type MemberAccess } from '../roles/access.ts'
import type { ProjectEnv } from './project-context.ts'

// Проверка прав роли (spec.md, раздел 4). Ставится на маршрут после projectContext:
//   .get('/', requirePermission('deals', 'view'), handler)
// Права пользователя — по его роли в текущем проекте; владелец системы (роль admin плагина
// Better Auth) прав в проекте сверх своей роли участника не получает. Права запроса по ключу
// API — по роли ключа (тикет crm-api/01), тем же путём.

/** Переменные контекста Hono после проверки прав. */
export type PermissionsEnv = {
  Variables: ProjectEnv['Variables'] & {
    /** Роль и права пользователя в текущем проекте: загружаются один раз на запрос. */
    access: MemberAccess
  }
}

/**
 * Роль автора запроса — участника или ключа API — в текущем проекте; читается в транзакции
 * проекта один раз на запрос (на каждом запросе заново: смена прав роли действует сразу) и
 * кладётся в `c.var.access`. null — участие или ключ пропали в этой же транзакции.
 */
async function requestAccess(c: Context<PermissionsEnv>): Promise<MemberAccess | null> {
  const cached = c.get('access') as MemberAccess | undefined
  if (cached) return cached
  const actor = c.get('actor')
  const loaded =
    actor.type === 'user'
      ? await loadMemberAccess(c.get('db'), actor.userId)
      : await loadApiKeyAccess(c.get('db'), actor.apiKeyId)
  if (loaded) c.set('access', loaded)
  return loaded
}

/**
 * Пропускает запрос, если роль пользователя (или ключа API) в текущем проекте разрешает
 * `action` с `resource`; иначе — 403 PERMISSION_DENIED. Роль кладётся в `c.var.access` для
 * обработчика.
 */
export function requirePermission(resource: Resource, action: Action) {
  return createMiddleware<PermissionsEnv>(async (c, next) => {
    const access = await requestAccess(c)
    if (!access || !can(access.permissions, resource, action)) {
      return problem(c, 403, 'PERMISSION_DENIED')
    }
    await next()
  })
}

/**
 * Пропускает запрос, если у роли пользователя в текущем проекте включено отдельное право
 * `permission` (выгрузка, массовые операции, настройки проекта…); иначе — 403
 * PERMISSION_DENIED. Как requirePermission, кладёт роль в `c.var.access`.
 */
export function requireStandalone(permission: StandalonePermission) {
  return createMiddleware<PermissionsEnv>(async (c, next) => {
    const access = await requestAccess(c)
    if (!access || !hasStandalone(access.permissions, permission)) {
      return problem(c, 403, 'PERMISSION_DENIED')
    }
    await next()
  })
}
