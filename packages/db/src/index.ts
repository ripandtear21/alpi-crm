import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Database } from './schema.ts'

export { APP_GROUP_ROLE, assertRestrictedRole, ensureAppLoginRole } from './app-role.ts'
export { FAILED_SIGN_IN_RETENTION_DAYS, purgeExpiredFailedSignIns } from './audit.ts'
export { createMigrator, migrateToLatest } from './migrate.ts'
export { createProject, withProject } from './project.ts'
export type {
  AccountTable,
  AuditLogTable,
  Database,
  ExternalLinkTable,
  ProjectMemberTable,
  ProjectTable,
  RateLimitTable,
  RoleTable,
  SessionTable,
  SystemAuditLogTable,
  TeamTable,
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
