import { type Kysely, sql } from 'kysely'

// Таблицы Better Auth (apps/api/src/auth/auth.ts): учётные записи, сессии, пароли, служебные
// токены, 2FA и счётчики ограничителя попыток входа.
//
// Состав столбцов повторяет то, что сгенерировал бы `auth migrate` для нашей конфигурации
// (плагины twoFactor и admin, ограничитель с хранением в базе, имена в snake_case). Расхождение
// ловит тест apps/api/src/auth/auth.test.ts: он сверяет схему базы с ожиданиями Better Auth.
//
// Таблицы глобальные, без row-level security: учётная запись одна на всю систему, доступ к
// проектам — строки project_member (docs/adr/0001-izolyatsiya-proektov.md).

/** Таблицы в порядке создания (по внешним ключам). */
const authTables = ['user', 'session', 'account', 'verification', 'two_factor', 'rate_limit']

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table "user" (
      id text primary key,
      name text not null,
      email text not null unique,
      email_verified boolean not null default false,
      image text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      two_factor_enabled boolean not null default false,
      role text,
      banned boolean not null default false,
      ban_reason text,
      ban_expires timestamptz
    )
  `.execute(db)

  await sql`
    create table session (
      id text primary key,
      expires_at timestamptz not null,
      token text not null unique,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      ip_address text,
      user_agent text,
      user_id text not null references "user" (id) on delete cascade,
      impersonated_by text
    )
  `.execute(db)
  await sql`create index session_user_id_idx on session (user_id)`.execute(db)

  // password — хэш пароля (scrypt); провайдер входа по паролю — providerId = 'credential'.
  await sql`
    create table account (
      id text primary key,
      account_id text not null,
      provider_id text not null,
      user_id text not null references "user" (id) on delete cascade,
      access_token text,
      refresh_token text,
      id_token text,
      access_token_expires_at timestamptz,
      refresh_token_expires_at timestamptz,
      scope text,
      password text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db)
  await sql`create index account_user_id_idx on account (user_id)`.execute(db)

  // Служебные токены: в том числе шаг «пароль принят, ждём код 2FA».
  await sql`
    create table verification (
      id text primary key,
      identifier text not null,
      value text not null,
      expires_at timestamptz not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db)
  await sql`create index verification_identifier_idx on verification (identifier)`.execute(db)

  // secret и backup_codes зашифрованы ключом BETTER_AUTH_SECRET.
  await sql`
    create table two_factor (
      id text primary key,
      secret text not null,
      backup_codes text not null,
      user_id text not null references "user" (id) on delete cascade,
      verified boolean default true,
      failed_verification_count integer default 0,
      locked_until timestamptz
    )
  `.execute(db)
  await sql`create index two_factor_secret_idx on two_factor (secret)`.execute(db)
  await sql`create index two_factor_user_id_idx on two_factor (user_id)`.execute(db)

  // key — «адрес клиента|путь»; last_request — миллисекунды Unix.
  await sql`
    create table rate_limit (
      id text primary key,
      key text not null unique,
      count integer not null,
      last_request bigint not null
    )
  `.execute(db)

  // Участник проекта — существующая учётная запись. Учётные записи не удаляют, а отключают
  // (баном): удаление пользователя, у которого есть доступ к проекту, база отклонит.
  await sql`
    alter table project_member
      add constraint project_member_user_id_fkey foreign key (user_id) references "user" (id)
  `.execute(db)

  // Права роли приложения — только те, что нужны Better Auth в наших сценариях.
  // Пользователей не удаляют (см. выше), пароли и связи входа — тоже.
  await sql`grant select, insert, update on "user", account to alpi_app`.execute(db)
  await sql`
    grant select, insert, update, delete on session, verification, two_factor, rate_limit
    to alpi_app
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table project_member drop constraint project_member_user_id_fkey`.execute(db)
  for (const table of [...authTables].reverse()) {
    await sql`drop table ${sql.table(table)}`.execute(db)
  }
}
