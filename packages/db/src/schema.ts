import type { ColumnType, Generated } from 'kysely'

// Типы таблиц описаны вручную по migrations/0001_project_isolation.ts и 0002_auth.ts; меняются вместе с
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
  /** Роль проекта; таблица ролей — тикет 05. */
  role_id: string | null
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

/** Таблицы базы для типов Kysely. */
export interface Database {
  project: ProjectTable
  project_member: ProjectMemberTable
  external_link: ExternalLinkTable
  user: UserTable
  session: SessionTable
  account: AccountTable
  verification: VerificationTable
  two_factor: TwoFactorTable
  rate_limit: RateLimitTable
}
