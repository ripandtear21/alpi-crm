import type { Scope } from '@alpi/shared'
import { type RawBuilder, type SqlBool, sql } from 'kysely'
import type { Viewer } from '../roles/scope.ts'

// Охват сделок (spec.md, раздел 4; ответ владельца, пункт 33). Сделка видна (или доступна для
// изменения), если её ответственный — в охвате пользователя (roles/scope.ts: свои / команда /
// все) или у неё нет ответственного: общую очередь видит и может взять каждый с правом на
// сделки, независимо от охвата. Сделку очереди меняет так же каждый с правом «сделки:
// изменять» (решено без владельца — подтвердить): иначе тимлид не раздал бы очередь команде.

/** Ответственный `owner` в охвате `scope` (без общей очереди). */
export function ownerInScope(owner: RawBuilder<unknown>, scope: Scope, viewer: Viewer) {
  switch (scope) {
    case 'all':
      return sql<SqlBool>`true`
    case 'own':
      return sql<SqlBool>`${owner} = ${viewer.userId}`
    case 'team': {
      const ids = [...new Set([viewer.userId, ...viewer.teamUserIds])]
      return sql<SqlBool>`${owner} in (${sql.join(ids)})`
    }
  }
}

/**
 * Условие охвата сделок по столбцу ответственного `owner` (например sql.ref('deal.owner_id')):
 * сделка в охвате или в общей очереди.
 */
export function dealInScope(owner: RawBuilder<unknown>, scope: Scope, viewer: Viewer) {
  if (scope === 'all') return sql<SqlBool>`true`
  return sql<SqlBool>`(${owner} is null or ${ownerInScope(owner, scope, viewer)})`
}

/** Тот же охват в коде — для строки, уже прочитанной из базы. */
export function ownerAllowed(ownerId: string | null, scope: Scope, viewer: Viewer): boolean {
  if (scope === 'all' || ownerId === null) return true
  if (scope === 'own') return ownerId === viewer.userId
  return ownerId === viewer.userId || viewer.teamUserIds.includes(ownerId)
}
