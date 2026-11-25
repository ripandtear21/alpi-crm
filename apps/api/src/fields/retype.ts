import { type Database, withProject } from '@alpi/db'
import { type Kysely, type RawBuilder, sql } from 'kysely'
import { audit } from '../audit/record.ts'

// Безопасная смена типа поля с данными (тикет crm-fields/02): администратор меняет тип
// (fields.ts) — поле получает converting_to и становится только для чтения (запись значения —
// 409, fields/values.ts), дальше — фоновая задача pg-boss field-retype (jobs/jobs.ts). Она
// порциями переписывает значение поля в `custom` всех записей сущности (каждая порция — в своей
// транзакции проекта), потом ставит полю новый тип, снимает converting_to и пишет журнал.
//
// - число → текст: число переписывается строкой;
// - один вариант → несколько: id переписывается массивом из одного id.
// Текст → большой текст значений не меняет и задачи не требует (fields.ts меняет тип сразу).
// Историю записей задача не пишет: значение то же, меняется только его запись в `custom`.
// Повтор после сбоя безопасен: переписываются только значения ещё старого вида.

export interface FieldRetypeMessage {
  projectId: string
  fieldId: string
  /** Кто сменил тип: автор записи журнала. */
  actorId: string
}

/** Записей в одной порции (одна транзакция проекта). */
export const FIELD_RETYPE_BATCH_SIZE = 500

const TABLE = { deal: 'deal', contact: 'contact', organization: 'organization' } as const

/**
 * Как переписать значение: вид значения старого типа в jsonb и выражение нового значения.
 * Только пары, для которых fields.ts ставит задачу (typeChangeWithValues → 'rewrite').
 */
function rewrite(
  from: string,
  to: string,
  code: string,
): { kind: string; value: RawBuilder<unknown> } {
  if (from === 'number' && to === 'text') {
    return { kind: 'number', value: sql`to_jsonb(custom ->> ${code}::text)` }
  }
  if (from === 'single_option' && to === 'multi_option') {
    return { kind: 'string', value: sql`jsonb_build_array(custom -> ${code}::text)` }
  }
  throw new Error(`смена типа ${from} → ${to} не переписывает значения`)
}

/** Меняет тип поля; false — поля нет или смена типа не запрошена (ничего не сделано). */
export async function retypeField(
  db: Kysely<Database>,
  message: FieldRetypeMessage,
  batchSize = FIELD_RETYPE_BATCH_SIZE,
): Promise<boolean> {
  const { projectId, fieldId } = message
  const field = await withProject(db, projectId, (trx) =>
    trx
      .selectFrom('field_definition')
      .select(['entity', 'code', 'name_uk', 'type', 'converting_to'])
      .where('id', '=', fieldId)
      .where('converting_to', 'is not', null)
      .executeTakeFirst(),
  )
  if (!field || field.converting_to === null) return false
  const table = TABLE[field.entity]
  const { kind, value } = rewrite(field.type, field.converting_to, field.code)

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
        update ${sql.table(table)}
        set custom = jsonb_set(custom, array[${field.code}::text], ${value})
        where id = any(${ids}::uuid[]) and jsonb_typeof(custom -> ${field.code}::text) = ${kind}
      `.execute(trx)
      return ids[ids.length - 1] ?? null
    })
    if (last === null) break
    after = last
  }

  await withProject(db, projectId, async (trx) => {
    const done = await trx
      .updateTable('field_definition')
      .set({ type: sql`converting_to`, converting_to: null, updated_at: sql`now()` })
      .where('id', '=', fieldId)
      .where('converting_to', 'is not', null)
      .executeTakeFirst()
    if (done.numUpdatedRows === 0n) return
    // Та же запись журнала, что у смены типа без данных: «тип: было → стало».
    await audit.record(trx, projectId, {
      action: 'field.updated',
      actorId: message.actorId,
      ip: null,
      entity: { type: 'field', id: fieldId },
      details: {
        name: field.name_uk,
        code: field.code,
        before: { type: field.type },
        after: { type: field.converting_to },
      },
    })
  })
  return true
}
