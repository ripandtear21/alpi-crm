import { type Database, withProject } from '@alpi/db'
import { WEBHOOK_RETENTION_DAYS } from '@alpi/shared'
import type { Kysely } from 'kysely'

// Ночная очистка журнала доставки (тикет crm-api/06): события старше 30 дней удаляются, их
// доставки и попытки уходят вместе с ними (внешние ключи on delete cascade, миграция 0024).
// Проекты — по одному, каждый в своём withProject (row-level security показывает только его
// строки). Сбой одного проекта не останавливает остальные; после обхода он пробрасывается, и
// задача повторится.

const DAY_MS = 24 * 60 * 60 * 1000

/** Удаляет события старше 30 дней от `now` во всех проектах; возвращает их число. */
export async function purgeWebhookLog(
  db: Kysely<Database>,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - WEBHOOK_RETENTION_DAYS * DAY_MS)
  const projects = await db.selectFrom('project').select('id').orderBy('id').execute()
  const failures: unknown[] = []
  let deleted = 0
  for (const { id } of projects) {
    try {
      const result = await withProject(db, id, (trx) =>
        trx.deleteFrom('webhook_event').where('created_at', '<', cutoff).executeTakeFirst(),
      )
      deleted += Number(result.numDeletedRows)
    } catch (error) {
      console.error(`журнал доставки событий проекта ${id} не очищен`, error)
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `журнал доставки не очищен в ${failures.length} проектах`)
  }
  return deleted
}
