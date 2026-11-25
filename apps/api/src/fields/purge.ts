import { type Database, withProject } from '@alpi/db'
import { type Kysely, sql } from 'kysely'
import { audit } from '../audit/record.ts'

// Окончательное удаление поля со значениями (тикет crm-fields/01): администратор запрашивает
// его не раньше чем через 30 дней после архивирования (fields.ts), дальше — фоновая задача
// pg-boss field-purge (jobs/jobs.ts). Она порциями убирает ключ поля из `custom` всех записей
// сущности, каждая порция — в своей транзакции проекта, потом удаляет описание (варианты,
// видимость и правила уходят каскадом) — код освобождается — и пишет журнал.
// Задача ничего не делает сама по расписанию: только по запросу администратора (ADR 0003).
// Повтор после сбоя безопасен: порции идут по id заново, а записи без ключа не меняются.

export interface FieldPurgeMessage {
  projectId: string
  fieldId: string
  /** Кто запросил удаление: автор записи журнала. */
  actorId: string
}

/** Записей в одной порции (одна транзакция проекта). */
export const FIELD_PURGE_BATCH_SIZE = 500

const TABLE = { deal: 'deal', contact: 'contact', organization: 'organization' } as const

/** Удаляет поле; false — поля нет или удаление не запрошено (ничего не сделано). */
export async function purgeField(
  db: Kysely<Database>,
  message: FieldPurgeMessage,
  batchSize = FIELD_PURGE_BATCH_SIZE,
): Promise<boolean> {
  const { projectId, fieldId } = message
  const field = await withProject(db, projectId, (trx) =>
    trx
      .selectFrom('field_definition')
      .select(['entity', 'code', 'name_uk'])
      .where('id', '=', fieldId)
      .where('purge_requested_at', 'is not', null)
      .executeTakeFirst(),
  )
  if (!field) return false
  const table = TABLE[field.entity]

  let after: string | null = null
  for (;;) {
    const last: string | null = await withProject(db, projectId, async (trx) => {
      const { rows } = await sql<{ id: string }>`
        select id from ${sql.table(table)}
        where ${after === null ? sql`true` : sql`id > ${after}`}
        order by id
        limit ${batchSize}
      `.execute(trx)
      if (rows.length === 0) return null
      const ids = rows.map((r) => r.id)
      await sql`
        update ${sql.table(table)} set custom = custom - ${field.code}::text
        where id = any(${ids}::uuid[]) and custom ? ${field.code}::text
      `.execute(trx)
      return ids[ids.length - 1] ?? null
    })
    if (last === null) break
    after = last
  }

  await withProject(db, projectId, async (trx) => {
    const deleted = await trx
      .deleteFrom('field_definition')
      .where('id', '=', fieldId)
      .where('purge_requested_at', 'is not', null)
      .executeTakeFirst()
    if (deleted.numDeletedRows === 0n) return
    await audit.record(trx, projectId, {
      action: 'field.purged',
      actorId: message.actorId,
      ip: null,
      entity: { type: 'field', id: fieldId },
      details: { name: field.name_uk, code: field.code, entity: field.entity },
    })
  })
  return true
}
