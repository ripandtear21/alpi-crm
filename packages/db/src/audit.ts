import { type Kysely, sql } from 'kysely'
import type { Database } from './schema.ts'

/** Сколько дней хранятся записи о неудачных входах (решение владельца). */
export const FAILED_SIGN_IN_RETENTION_DAYS = 90

/**
 * Удаляет из системного журнала записи о неудачных входах старше
 * FAILED_SIGN_IN_RETENTION_DAYS дней; возвращает число удалённых. Остальные записи журнала не
 * удаляются никогда.
 *
 * Удаляет служебная функция базы purge_expired_failed_sign_ins (migrations/0009_jobs_bulk.ts)
 * с правами владельца журнала, поэтому годится любое подключение — и роль приложения, под
 * которой её зовёт ежедневная задача (apps/api/src/jobs/jobs.ts). Сама роль приложения права
 * DELETE на журнал не имеет: удалить другую запись или запись моложе срока она не может.
 */
export async function purgeExpiredFailedSignIns(db: Kysely<Database>): Promise<number> {
  const { rows } = await sql<{
    deleted: number
  }>`select public.purge_expired_failed_sign_ins() as deleted`.execute(db)
  return rows[0]?.deleted ?? 0
}
