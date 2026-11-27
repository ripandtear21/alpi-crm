import { type Database, withProject } from '@alpi/db'
import { INBOUND_RETENTION_DAYS } from '@alpi/shared'
import type { Kysely } from 'kysely'

// Ночная очистка журнала входящих (тикет crm-intake/06; пункт 38, ADR 0006): строки старше
// 30 дней удаляются вместе с сырыми телами. Проекты — по одному, каждый в своём withProject
// (row-level security показывает только его строки). Сбой одного проекта не останавливает
// остальные; после обхода он пробрасывается, и задача повторится. Регистрации и пары
// «источник, event_id» очистка не трогает.

const DAY_MS = 24 * 60 * 60 * 1000

/** Удаляет строки журнала входящих старше 30 дней от `now` во всех проектах; возвращает их число. */
export async function purgeInboundJournal(
  db: Kysely<Database>,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - INBOUND_RETENTION_DAYS * DAY_MS)
  const projects = await db.selectFrom('project').select('id').orderBy('id').execute()
  const failures: unknown[] = []
  let deleted = 0
  for (const { id } of projects) {
    try {
      const result = await withProject(db, id, (trx) =>
        trx.deleteFrom('inbound_request').where('received_at', '<', cutoff).executeTakeFirst(),
      )
      deleted += Number(result.numDeletedRows)
    } catch (error) {
      console.error(`журнал входящих проекта ${id} не очищен`, error)
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `журнал входящих не очищен в ${failures.length} проектах`)
  }
  return deleted
}
