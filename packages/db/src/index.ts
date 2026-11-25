import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Database } from './schema.ts'

export { APP_GROUP_ROLE, assertRestrictedRole, ensureAppLoginRole } from './app-role.ts'
export { FAILED_SIGN_IN_RETENTION_DAYS, purgeExpiredFailedSignIns } from './audit.ts'
export { createMigrator, migrateToLatest } from './migrate.ts'
export type {
  FieldGroupPreset,
  FieldPreset,
  FieldPresetEntity,
  FieldRequiredRulePreset,
} from './presets/alpi-fields.ts'
export {
  applyProjectPreset,
  isPresetKey,
  PRESET_KEYS,
  PROJECT_PRESETS,
  type PresetKey,
  type PresetResult,
  type ProjectPreset,
  presetCreatedAnything,
} from './presets/project-preset.ts'
export { createProject, withProject } from './project.ts'
export type {
  AccountTable,
  AuditLogTable,
  BulkJobErrorTable,
  BulkJobStatus,
  BulkJobTable,
  ChangeLogTable,
  ContactEmailTable,
  ContactPhoneTable,
  ContactTable,
  Database,
  DealParticipantTable,
  DealTable,
  ExternalLinkTable,
  LostReasonGroupTable,
  LostReasonTable,
  OrganizationTable,
  PipelineTable,
  ProjectMemberTable,
  ProjectTable,
  RateLimitTable,
  RoleTable,
  SavedFilterTable,
  SessionTable,
  StageTable,
  SystemAuditLogTable,
  TeamTable,
  TwoFactorTable,
  UserTable,
  VerificationTable,
} from './schema.ts'

/** Подключение к PostgreSQL через пул `pg`. Закрывать — `db.destroy()`. */
export function createDb(connectionString: string): Kysely<Database> {
  const pool = new pg.Pool({ connectionString })
  // Сервер может оборвать соединение сам (перезапуск, остановка): ошибка приходит событием
  // на соединении, и без обработчика роняет весь процесс. Запрос на таком соединении всё
  // равно получает ошибку, а пул выбрасывает соединение и откроет новое.
  const onConnectionError = (error: Error) => {
    console.warn(`PostgreSQL оборвал соединение: ${error.message}`)
  }
  pool.on('error', onConnectionError)
  pool.on('connect', (client) => client.on('error', onConnectionError))
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
}
