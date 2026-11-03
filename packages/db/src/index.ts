import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'

export { migrateToLatest } from './migrate.ts'

/**
 * Таблицы базы для типов Kysely. Пока пусто: первая миграция и её типы — тикет 02
 * эпика crm-foundation (схема и row-level security).
 */
export type Database = Record<string, never>

/** Подключение к PostgreSQL через пул `pg`. Закрывать — `db.destroy()`. */
export function createDb(connectionString: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString }),
    }),
  })
}
