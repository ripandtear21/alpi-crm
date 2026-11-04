import type { Database } from '@alpi/db'
import type { Scope } from '@alpi/shared'
import {
  type Expression,
  type ExpressionBuilder,
  type Kysely,
  type SqlBool,
  type StringReference,
  sql,
} from 'kysely'

// Охват записей (spec.md, раздел 4): «свои» — пользователь ответственный; «своей команды» —
// ответственный из команды пользователя; «все» — все записи проекта. Охват — условие WHERE
// по столбцу ответственного, а не по столбцу команды записи: сделка принадлежит команде,
// пока её ответственный в команде, и уходит вместе с ним при переводе в другую команду.
// Записи без ответственного (общая очередь) попадают только в «все» — общую очередь разделы
// показывают отдельным правилом.

/**
 * Кто в команде пользователя. Команды появятся в тикете crm-foundation/06: он заменит
 * `NO_TEAMS` реализацией по таблице команд (тимлид — все менеджеры его команды; менеджер —
 * участники своей команды).
 */
export interface TeamResolver {
  /** id пользователей команды `userId` в текущем проекте (`db` — транзакция проекта). */
  teamUserIds(db: Kysely<Database>, userId: string): Promise<string[]>
}

/** Пока команд нет: команда пользователя — он сам, охват «команда» равен «свои». */
export const NO_TEAMS: TeamResolver = {
  async teamUserIds() {
    return []
  },
}

/** Тот, для кого строится охват. */
export interface Viewer {
  userId: string
  /** Пользователи его команды; сам пользователь в охват «команда» входит всегда. */
  teamUserIds: readonly string[]
}

export async function resolveViewer(
  db: Kysely<Database>,
  userId: string,
  teams: TeamResolver,
): Promise<Viewer> {
  return { userId, teamUserIds: await teams.teamUserIds(db, userId) }
}

/**
 * Условие WHERE для охвата `scope` по столбцу ответственного `ownerColumn`:
 *   .where((eb) => scopePredicate(eb, scope, viewer, 'deal.owner_user_id'))
 */
export function scopePredicate<DB, TB extends keyof DB>(
  eb: ExpressionBuilder<DB, TB>,
  scope: Scope,
  viewer: Viewer,
  ownerColumn: StringReference<DB, TB>,
): Expression<SqlBool> {
  const owner = eb.ref(ownerColumn)
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
