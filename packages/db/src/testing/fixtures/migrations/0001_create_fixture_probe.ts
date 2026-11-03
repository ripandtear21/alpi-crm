import type { Kysely } from 'kysely'

// Миграция-образец для теста мигратора: создаёт таблицу, наличие которой тест проверяет.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('fixture_probe')
    .addColumn('id', 'integer', (col) => col.primaryKey())
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('fixture_probe').execute()
}
