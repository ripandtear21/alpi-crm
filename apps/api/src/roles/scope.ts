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
// Записи без ответственного (общая очередь) этот предикат пропускает только в «все». Общую
// очередь будет показывать отдельное условие эпика сделок, а не этот предикат: её видит каждый,
// кто может смотреть сделки воронки, независимо от охвата (решение владельца 2026-11-04).

/** Кто в команде пользователя: от этого зависит охват «команда». */
export interface TeamResolver {
  /** id пользователей команды `userId` в текущем проекте (`db` — транзакция проекта). */
  teamUserIds(db: Kysely<Database>, userId: string): Promise<string[]>
}

/**
 * Команды проекта (migrations/0006_teams.ts, тикет crm-foundation/06). Тимлид состоит в своей
 * команде, поэтому правило одно для тимлида и менеджера: команда пользователя — все участники
 * его команды, тимлид среди них. Тимлид видит записи своих менеджеров, менеджер с охватом
 * «команда» — записи коллег и тимлида (spec.md, раздел 4: «своей команды» — где ответственный
 * из команды, которую ведёт тимлид). Не в команде — только сам пользователь, как «свои».
 * Отключённые участники остаются в команде: их закрытые сделки — история команды.
 */
export const PROJECT_TEAMS: TeamResolver = {
  async teamUserIds(db, userId) {
    const rows = await db
      .selectFrom('project_member as me')
      .innerJoin('project_member as mate', (join) =>
        join
          .onRef('mate.project_id', '=', 'me.project_id')
          .onRef('mate.team_id', '=', 'me.team_id'),
      )
      .select('mate.user_id')
      .where('me.user_id', '=', userId)
      .where('mate.user_id', '<>', userId)
      .orderBy('mate.user_id')
      .execute()
    return rows.map((r) => r.user_id)
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
