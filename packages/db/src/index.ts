import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Database } from './schema.ts'

export { createMigrator, migrateToLatest } from './migrate.ts'
export { createProject, withProject } from './project.ts'
export type {
  AccountTable,
  Database,
  ExternalLinkTable,
  ProjectMemberTable,
  ProjectTable,
  RateLimitTable,
  SessionTable,
  TwoFactorTable,
  UserTable,
  VerificationTable,
} from './schema.ts'

/** Подключение к PostgreSQL через пул `pg`. Закрывать — `db.destroy()`. */
export function createDb(connectionString: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString }),
    }),
  })
}
