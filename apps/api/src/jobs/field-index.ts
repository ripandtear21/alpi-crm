import { type Database, withProject } from '@alpi/db'
import { type Kysely, sql } from 'kysely'

// Ускорение «часто фильтруют» (тикет crm-fields/07; таблица и триггеры —
// packages/db/migrations/0018_field_filters.ts). Отметка у действующего поля ставит ему
// index_state = 'building' (триггер базы) и эту задачу pg-boss field-index (jobs.ts). Задача
// под ролью приложения, порциями в своих транзакциях проекта, копирует значения поля из
// `custom` всех записей сущности в custom_value, потом ставит 'ready' — с этого момента фильтр
// ищет по копии (filters/custom.ts). Новые записи и изменения копирует триггер
// custom_value_sync, поэтому задаче хватает одного прохода по id.
//
// - Порция блокирует строку поля (FOR UPDATE): снятие отметки, архив и смена поля ждут конца
//   порции, а задача после них видит новое состояние и останавливается. Копия, для которой
//   задача начата, — index_token: сняли отметку и поставили снова — новая копия, прежняя
//   задача «готово» не поставит.
// - Записи порции читаются FOR SHARE: запись, которая меняет `custom` прямо сейчас, сначала
//   закончится, и порция возьмёт её новое значение.
// - Порция сначала убирает строки поля своих записей, потом вставляет заново: повтор задачи
//   (после сбоя или второй постановки) не размножает строки; база их тоже не примет
//   (уникальный индекс custom_value_text_idx).
// - Ошибка ставит полю 'failed' с текстом (index_error): конструктор (тикет 05) её показывает,
//   задача не повторяется — снять и снова поставить отметку.
// Задача не меняет записей (ADR 0003): пишет только копию и состояние поля.

export interface FieldIndexMessage {
  projectId: string
  fieldId: string
}

/** Записей в одной порции (одна транзакция проекта). */
export const FIELD_INDEX_BATCH_SIZE = 1000

/** Наибольшая длина текста ошибки в index_error. */
const MAX_ERROR_LENGTH = 500

const TABLE = { deal: 'deal', contact: 'contact', organization: 'organization' } as const

export type FieldIndexOutcome = 'ready' | 'skipped' | 'failed'

/** Строит копию значений поля; что вышло — для журнала и тестов. */
export async function buildFieldIndex(
  db: Kysely<Database>,
  { projectId, fieldId }: FieldIndexMessage,
  batchSize = FIELD_INDEX_BATCH_SIZE,
): Promise<FieldIndexOutcome> {
  const field = await withProject(db, projectId, (trx) =>
    trx
      .selectFrom('field_definition')
      .select(['entity', 'code', 'index_token'])
      .where('id', '=', fieldId)
      .where('index_state', '=', 'building')
      .executeTakeFirst(),
  )
  if (!field?.index_token) return 'skipped'
  const token = field.index_token
  const table = sql.table(TABLE[field.entity])

  try {
    let after: string | null = null
    for (;;) {
      const step: { last: string | null } | 'stop' = await withProject(
        db,
        projectId,
        async (trx) => {
          const current = await trx
            .selectFrom('field_definition')
            .select(['code'])
            .where('id', '=', fieldId)
            .where('index_state', '=', 'building')
            .where('index_token', '=', token)
            .forUpdate()
            .executeTakeFirst()
          if (!current) return 'stop'
          const { rows } = await sql<{ id: string }>`
            select id from ${table}
            where ${after === null ? sql`true` : sql`id > ${after}`}
            order by id
            limit ${batchSize}
            for share
          `.execute(trx)
          if (rows.length === 0) return { last: null }
          const ids = rows.map((r) => r.id)
          await sql`
            delete from custom_value
            where field_id = ${fieldId} and record_id = any(${ids}::uuid[])
          `.execute(trx)
          await sql`
            insert into custom_value (project_id, field_id, record_id, part, value_text, value_number)
            select t.project_id, ${fieldId}::uuid, t.id, r.part, r.value_text, r.value_number
            from ${table} t
            cross join lateral custom_value_rows(t.custom -> ${current.code}::text) r
            where t.id = any(${ids}::uuid[]) and t.custom ? ${current.code}::text
            on conflict do nothing
          `.execute(trx)
          return { last: ids[ids.length - 1] ?? null }
        },
      )
      if (step === 'stop') return 'skipped'
      if (step.last === null) break
      after = step.last
    }
    const done = await withProject(db, projectId, (trx) =>
      trx
        .updateTable('field_definition')
        .set({ index_state: 'ready' })
        .where('id', '=', fieldId)
        .where('index_state', '=', 'building')
        .where('index_token', '=', token)
        .executeTakeFirst(),
    )
    return done.numUpdatedRows > 0n ? 'ready' : 'skipped'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`field-index: поле ${fieldId} проекта ${projectId}:`, error)
    await withProject(db, projectId, (trx) =>
      trx
        .updateTable('field_definition')
        .set({ index_state: 'failed', index_error: message.slice(0, MAX_ERROR_LENGTH) })
        .where('id', '=', fieldId)
        .where('index_state', '=', 'building')
        .where('index_token', '=', token)
        .execute(),
    )
    return 'failed'
  }
}

/**
 * Поля всех проектов, у которых копия строится, а задачи может не быть: отмеченные до
 * миграции 0018, заведённые служебными скриптами (стартовые поля ALPI) или потерявшие задачу.
 * Проекты по одному, каждый в своей транзакции проекта.
 */
export async function pendingFieldIndexes(db: Kysely<Database>): Promise<FieldIndexMessage[]> {
  const projects = await db.selectFrom('project').select('id').orderBy('id').execute()
  const pending: FieldIndexMessage[] = []
  for (const project of projects) {
    const fields = await withProject(db, project.id, (trx) =>
      trx
        .selectFrom('field_definition')
        .select('id')
        .where('index_state', '=', 'building')
        .orderBy('id')
        .execute(),
    )
    for (const field of fields) pending.push({ projectId: project.id, fieldId: field.id })
  }
  return pending
}
