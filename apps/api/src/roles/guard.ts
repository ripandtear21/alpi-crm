import {
  ACTIONS,
  RESOURCES,
  type RolePermissions,
  SCOPED_RESOURCES,
  SCOPES,
  type Scope,
  STANDALONE_PERMISSIONS,
} from '@alpi/shared'
import type { MemberAccess } from './access.ts'

// Кто какие роли может выдавать (решение без владельца, тикет crm-foundation/05 — подтвердить).
// Право «пользователи и роли» само по себе не должно давать захвата проекта:
//   (а) роль администратора назначает, а роль участника-администратора меняет или снимает
//       только администратор проекта;
//   (б) не-администратор, создавая, меняя или назначая роль, не выдаёт прав, которых нет у него
//       самого: действий, более широкого охвата, отдельных прав;
//   (в) не-администратор не меняет свою роль участника и не правит роль, назначенную ему;
//   (г) роль участника, у которого прав больше, чем у действующего пользователя, меняет или
//       снимает только администратор; то же для участия такого участника — команды, приёма
//       сделок, отключения (решение владельца 2026-11-04, тикет crm-foundation/06).
//
// Проверка — здесь, в коде API, а не в триггере: правила зависят от того, кто делает
// изменение, а база этого не знает (подключение одно на всё приложение, пользователь —
// в сессии API). Все пути записи ролей и участников ролью приложения — маршруты
// apps/api/src/roles/roles.ts, и каждый зовёт функцию отсюда. Правила, не зависящие от
// пользователя (роль администратора неизменна, последний администратор), держит база
// (migrations/0004_roles.ts).

export type GuardFailure =
  /** Действие доступно только администратору проекта. */
  | 'ADMIN_ONLY'
  /** Роль даёт права, которых нет у того, кто её выдаёт. */
  | 'EXCEEDS_OWN_PERMISSIONS'
  /** Не-администратор трогает свою роль. */
  | 'OWN_ROLE'
  /** У участника прав больше, чем у того, кто меняет его роль или участие (г). */
  | 'TARGET_EXCEEDS_OWN_PERMISSIONS'
  /** Не-администратор меняет своё участие или состав своей команды. */
  | 'OWN_MEMBERSHIP'

const scopeRank = (scope: Scope) => SCOPES.indexOf(scope)

/**
 * Не выдаёт ли изменение `before → after` прав сверх прав `actor`. Проверяется только то, что
 * добавляется: права, которые у роли уже были, не-администратор может оставить (например,
 * переименовать роль «керівник», у которой прав больше, чем у него) или убрать.
 * `before` null — новая роль.
 */
export function grantsBeyondOwn(
  actor: RolePermissions,
  before: RolePermissions | null,
  after: RolePermissions,
): boolean {
  for (const resource of RESOURCES) {
    for (const action of ACTIONS) {
      const added =
        after.actions[resource].includes(action) && !before?.actions[resource].includes(action)
      if (added && !actor.actions[resource].includes(action)) return true
    }
  }
  for (const resource of SCOPED_RESOURCES) {
    for (const kind of ['read', 'write'] as const) {
      const next = scopeRank(after.scopes[resource][kind])
      const widened = before === null || next > scopeRank(before.scopes[resource][kind])
      if (widened && next > scopeRank(actor.scopes[resource][kind])) return true
    }
  }
  for (const permission of STANDALONE_PERMISSIONS) {
    const added = after.standalone.includes(permission) && !before?.standalone.includes(permission)
    if (added && !actor.standalone.includes(permission)) return true
  }
  return false
}

/** Создание роли. */
export function checkRoleCreate(actor: MemberAccess, after: RolePermissions): GuardFailure | null {
  if (actor.isAdmin) return null
  return grantsBeyondOwn(actor.permissions, null, after) ? 'EXCEEDS_OWN_PERMISSIONS' : null
}

/** Изменение роли `role`; `after` — новые права, undefined — права не меняются. */
export function checkRoleEdit(
  actor: MemberAccess,
  role: { id: string; permissions: RolePermissions },
  after: RolePermissions | undefined,
): GuardFailure | null {
  if (actor.isAdmin) return null
  if (role.id === actor.roleId) return 'OWN_ROLE'
  if (after && grantsBeyondOwn(actor.permissions, role.permissions, after)) {
    return 'EXCEEDS_OWN_PERMISSIONS'
  }
  return null
}

/** Участник, чью роль или участие меняют: его нынешняя роль. */
export interface GuardTarget {
  userId: string
  roleIsAdmin: boolean
  permissions: RolePermissions
}

/**
 * Назначение участнику `target` роли `next`. Новый участник (добавление в проект) — `target`
 * с пустыми правами: у него ещё нет роли.
 */
export function checkAssignment(
  actor: MemberAccess & { userId: string },
  target: GuardTarget,
  next: { isAdmin: boolean; permissions: RolePermissions },
): GuardFailure | null {
  if (actor.isAdmin) return null
  if (next.isAdmin || target.roleIsAdmin) return 'ADMIN_ONLY'
  if (target.userId === actor.userId) return 'OWN_ROLE'
  if (grantsBeyondOwn(actor.permissions, null, target.permissions)) {
    return 'TARGET_EXCEEDS_OWN_PERMISSIONS'
  }
  // Назначить роль шире своей — то же, что выдать эти права (б).
  return grantsBeyondOwn(actor.permissions, null, next.permissions)
    ? 'EXCEEDS_OWN_PERMISSIONS'
    : null
}

/**
 * Изменение участия `target` — команда, приём новых сделок, отключение и включение (тикет
 * crm-foundation/06). Правила (а), (в) и (г) распространяются на участие: участие
 * администратора и участника с правами шире своих меняет только администратор, своё участие
 * не-администратор не меняет. Команда меняет охват
 * «команда» (apps/api/src/roles/scope.ts): привести участника в свою команду или увести из неё —
 * то же, что расширить или сузить себе видимость записей, поэтому состав своей команды
 * не-администратор не меняет. `team` — смена команды: прежняя и новая команда цели и команда
 * того, кто меняет (null — ни в одной).
 */
export function checkMemberChange(
  actor: MemberAccess & { userId: string },
  target: GuardTarget,
  team?: { from: string | null; to: string | null; actorTeam: string | null },
): GuardFailure | null {
  if (actor.isAdmin) return null
  if (target.roleIsAdmin) return 'ADMIN_ONLY'
  if (target.userId === actor.userId) return 'OWN_MEMBERSHIP'
  if (grantsBeyondOwn(actor.permissions, null, target.permissions)) {
    return 'TARGET_EXCEEDS_OWN_PERMISSIONS'
  }
  if (team?.actorTeam && (team.from === team.actorTeam || team.to === team.actorTeam)) {
    return 'OWN_MEMBERSHIP'
  }
  return null
}
