import { type Database, withProject } from '@alpi/db'
import { IDEMPOTENCY_RETENTION_HOURS } from '@alpi/shared'
import type { Kysely } from 'kysely'

// Ночная очистка ответов для повтора по `Idempotency-Key` (тикет crm-api/02;
// http/idempotency.ts): записи старше 24 часов больше не действуют и удаляются. Проекты — по
// одному, каждый в своём withProject (row-level security показывает только его строки). Сбой
// одного проекта не останавливает остальные; после обхода он пробрасывается, и задача
// повторится.

const HOUR_MS = 60 * 60 * 1000

/** Удаляет записи старше 24 часов от `now` во всех проектах; возвращает их число. */
export async function purgeIdempotencyRecords(
  db: Kysely<Database>,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - IDEMPOTENCY_RETENTION_HOURS * HOUR_MS)
  const projects = await db.selectFrom('project').select('id').orderBy('id').execute()
  const failures: unknown[] = []
  let deleted = 0
  for (const { id } of projects) {
    try {
      const result = await withProject(db, id, (trx) =>
        trx.deleteFrom('idempotency_record').where('created_at', '<', cutoff).executeTakeFirst(),
      )
      deleted += Number(result.numDeletedRows)
    } catch (error) {
      console.error(`ответы Idempotency-Key проекта ${id} не очищены`, error)
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `ответы Idempotency-Key не очищены в ${failures.length} проектах`,
    )
  }
  return deleted
}
