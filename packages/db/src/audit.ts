import { type Kysely, sql } from 'kysely'
import type { Database } from './schema.ts'

/** Сколько дней хранятся записи о неудачных входах (решение владельца). */
export const FAILED_SIGN_IN_RETENTION_DAYS = 90

/**
 * Удаляет из системного журнала записи о неудачных входах старше
 * FAILED_SIGN_IN_RETENTION_DAYS дней; возвращает число удалённых. Остальные записи журнала не
 * удаляются никогда.
 *
 * `serviceDb` — служебная роль (владелец таблиц): у роли приложения права DELETE на журнал
 * нет, и под ней функция отказывает с `permission denied for table system_audit_log`.
 *
 * shortcut: запускается только вручную или из теста, регулярного запуска нет — подключить к
 * планировщику (pg-boss или cron), когда он появится.
 */
export async function purgeExpiredFailedSignIns(serviceDb: Kysely<Database>): Promise<number> {
  const result = await serviceDb
    .deleteFrom('system_audit_log')
    .where('action', '=', 'auth.sign_in_failed')
    .where(
      'occurred_at',
      '<',
      sql<Date>`now() - make_interval(days => ${FAILED_SIGN_IN_RETENTION_DAYS})`,
    )
    .executeTakeFirst()
  return Number(result.numDeletedRows)
}
