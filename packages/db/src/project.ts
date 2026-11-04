import { type Kysely, sql, type Transaction } from 'kysely'
import type { Database } from './schema.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Выполняет `fn` в транзакции в контексте одного проекта: выставляет `app.project_id`
 * локально для транзакции, и политики row-level security показывают только строки этого
 * проекта. После транзакции значение сбрасывается, соединение возвращается в пул без проекта.
 *
 * Изолирует только при подключении ролью приложения (член alpi_app); на владельца таблиц
 * политики не действуют.
 */
export async function withProject<T>(
  db: Kysely<Database>,
  projectId: string,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  if (!UUID.test(projectId)) {
    throw new Error(`id проекта должен быть uuid, получено: ${JSON.stringify(projectId)}`)
  }
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.project_id', ${projectId}, true)`.execute(trx)
    return fn(trx)
  })
}
