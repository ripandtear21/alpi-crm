import type { ColumnType, Generated } from 'kysely'

// Типы таблиц описаны вручную по migrations/0001_project_isolation.ts, 0002_auth.ts, 0004_roles.ts, 0005_audit.ts, 0006_teams.ts и 0009_jobs_bulk.ts; меняются вместе с
// миграциями. shortcut: без kysely-codegen расхождение с базой ловят только тесты на настоящей
// базе, перейти на codegen, когда таблиц станет больше нескольких.

/** Метка времени: читается как Date, при вставке необязательна (default now()). */
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>

/**
 * Проект — отдельный бизнес. Глобальная таблица, без row-level security: приложение её только
 * читает, создаёт и меняет проекты служебная роль (`createProject`).
 */
export interface ProjectTable {
  id: Generated<string>
  code: string
  name: string
  default_locale: Generated<string>
  timezone: Generated<string>
  created_at: Timestamp
  updated_at: Timestamp
}

/** Доступ пользователя к проекту. Видна только в контексте своего проекта. */
export interface ProjectMemberTable {
  id: Generated<string>
  project_id: string
  /** id учётной записи (`user.id`). */
  user_id: string
  /** Роль проекта (`role.id` того же проекта); у участника ровно одна роль. */
  role_id: string
  /** Команда (`team.id` того же проекта); у участника не больше одной команды. */
  team_id: string | null
  /** «Принимает новые сделки»: по умолчанию да. */
  accepts_new_deals: Generated<boolean>
  /** Участие отключено: пользователь не входит в проект. null — действует. */
  disabled_at: Date | string | null
  disabled_by: string | null
  created_at: Timestamp
  updated_at: Timestamp
  created_by: string | null
}

/**
 * Команда проекта. Видна только в контексте своего проекта. Тимлид один (`lead_user_id`) и сам
 * состоит в команде — защищает база (migrations/0006_teams.ts).
 */
export interface TeamTable {
  id: Generated<string>
  project_id: string
  name: string
  /** id учётной записи тимлида: участник проекта с `team_id` этой команды. */
  lead_user_id: string
  created_at: Timestamp
  updated_at: Timestamp
  created_by: string | null
}

/**
 * Роль проекта. Видна только в контексте своего проекта. Роль «администратор» (`is_admin`)
 * не удаляется и не меняется — защищает база (migrations/0004_roles.ts).
 */
export interface RoleTable {
  id: Generated<string>
  project_id: string
  name: string
  /** Шаблон-источник: 'admin' | 'head' | 'teamlead' | 'manager'; null — своя роль. */
  template_key: string | null
  is_admin: Generated<boolean>
  /**
   * Права роли (RolePermissions из @alpi/shared). Читается объектом, пишется строкой JSON:
   * форму проверяет parseRolePermissions до записи.
   */
  permissions: ColumnType<unknown, string, string>
  created_at: Timestamp
  updated_at: Timestamp
  created_by: string | null
}

/** Внешняя ссылка: запись CRM ↔ запись во внешней системе (pipedrive, bitrix). */
export interface ExternalLinkTable {
  id: Generated<string>
  project_id: string
  entity_type: string
  entity_id: string
  source: string
  external_id: string
  created_at: Timestamp
  updated_at: Timestamp
  created_by: string | null
}

// Таблицы Better Auth: глобальные, без row-level security. Пишет в них Better Auth
// (apps/api/src/auth/auth.ts); id строк генерирует он же.

/** Учётная запись пользователя, одна на всю систему. */
export interface UserTable {
  id: string
  name: string
  email: string
  email_verified: Generated<boolean>
  image: string | null
  created_at: Timestamp
  updated_at: Timestamp
  two_factor_enabled: Generated<boolean>
  /** Роль плагина admin (вне проектов): 'admin' — владелец системы. */
  role: string | null
  banned: Generated<boolean>
  ban_reason: string | null
  ban_expires: Date | null
  /** Временный пароль: до его смены API пускает только к смене пароля и выходу. */
  must_change_password: Generated<boolean>
}

export interface SessionTable {
  id: string
  expires_at: Date
  token: string
  created_at: Timestamp
  updated_at: Timestamp
  ip_address: string | null
  user_agent: string | null
  user_id: string
  impersonated_by: string | null
  /** Сессия прошла второй фактор: только у таких доступ к API при включённой 2FA. */
  two_factor_verified: Generated<boolean>
}

export interface AccountTable {
  id: string
  account_id: string
  provider_id: string
  user_id: string
  access_token: string | null
  refresh_token: string | null
  id_token: string | null
  access_token_expires_at: Date | null
  refresh_token_expires_at: Date | null
  scope: string | null
  /** Хэш пароля. */
  password: string | null
  created_at: Timestamp
  updated_at: Timestamp
}

export interface VerificationTable {
  id: string
  identifier: string
  value: string
  expires_at: Date
  created_at: Timestamp
  updated_at: Timestamp
}

export interface TwoFactorTable {
  id: string
  /** Зашифрованный секрет TOTP. */
  secret: string
  /** Зашифрованные резервные коды. */
  backup_codes: string
  user_id: string
  verified: Generated<boolean | null>
  failed_verification_count: Generated<number | null>
  locked_until: Date | null
}

export interface RateLimitTable {
  id: string
  key: string
  count: number
  /** Миллисекунды Unix; bigint `pg` читает строкой. */
  last_request: ColumnType<string, number | string, number | string>
}

/**
 * Запись журнала (migrations/0005_audit.ts). Только добавление: роль приложения не может ни
 * изменить, ни удалить строку.
 */
interface AuditColumns {
  id: Generated<string>
  occurred_at: Timestamp
  /** Кто действовал (`user.id`); null — неизвестный пользователь или система. */
  actor_id: string | null
  /** Адрес клиента (inet; `pg` читает строкой). */
  ip: string | null
  /** Код действия из `@alpi/shared` (AuditAction). */
  action: string
  entity_type: string | null
  entity_id: string | null
  /** Подробности. Читается объектом, пишется строкой JSON. */
  details: ColumnType<Record<string, unknown>, string | undefined, never>
}

/** Журнал проекта: виден только в контексте своего проекта. */
export interface AuditLogTable extends AuditColumns {
  project_id: string
}

/**
 * Журнал событий вне проекта (входы, 2FA). Роль приложения только добавляет строки; читает их
 * владелец системы через функцию `system_audit_events`.
 */
export interface SystemAuditLogTable extends AuditColumns {
  /** Email, который вводили при неудачном входе; у остальных событий null. */
  attempted_email: string | null
}

/** Состояние массовой операции: в очереди, идёт, закончена, остановлена целиком. */
export type BulkJobStatus = 'queued' | 'running' | 'done' | 'failed'

/**
 * Массовая операция (migrations/0009_jobs_bulk.ts). Видна только в контексте своего проекта;
 * роль приложения строки не удаляет.
 */
export interface BulkJobTable {
  id: Generated<string>
  project_id: string
  /** Кто запустил (`user.id`). */
  initiator_id: string
  /** Код действия из реестра массовых действий. */
  action: string
  /** `{ ids: [...] }` или `{ filter: {...} }`. Читается объектом, пишется строкой JSON. */
  selection: ColumnType<Record<string, unknown>, string, never>
  params: ColumnType<Record<string, unknown>, string | undefined, never>
  /** Записи в порядке обработки; null — выбор ещё не развёрнут. */
  record_ids: string[] | null
  status: ColumnType<BulkJobStatus, BulkJobStatus | undefined, BulkJobStatus>
  total: number | null
  /** Обработано записей, с ошибкой — тоже. */
  processed: Generated<number>
  /** Записей с ошибкой. */
  failed: Generated<number>
  /** Почему операция остановилась целиком (`status = 'failed'`). */
  failure: string | null
  created_at: Timestamp
  started_at: Date | string | null
  finished_at: Date | string | null
}

/** Ошибка массовой операции по одной записи: запись не изменена. */
export interface BulkJobErrorTable {
  project_id: string
  bulk_job_id: string
  /** Место записи в `bulk_job.record_ids`. */
  position: number
  record_id: string
  code: string
  message: string | null
}

/** Таблицы базы для типов Kysely. */
export interface Database {
  project: ProjectTable
  project_member: ProjectMemberTable
  role: RoleTable
  team: TeamTable
  external_link: ExternalLinkTable
  user: UserTable
  session: SessionTable
  account: AccountTable
  verification: VerificationTable
  two_factor: TwoFactorTable
  rate_limit: RateLimitTable
  audit_log: AuditLogTable
  system_audit_log: SystemAuditLogTable
  bulk_job: BulkJobTable
  bulk_job_error: BulkJobErrorTable
}
