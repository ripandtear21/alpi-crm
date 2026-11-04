import { type Kysely, sql } from 'kysely'

// Первая схема: проекты, участники проектов, внешние ссылки и изоляция проектов через
// row-level security (docs/adr/0001-izolyatsiya-proektov.md).
//
// Роли базы:
// - владелец таблиц — роль, под которой идут миграции (DATABASE_URL мигратора). Политики на
//   владельца не действуют (FORCE ROW LEVEL SECURITY не включён), поэтому служебный доступ
//   без проекта (миграции, курсы НБУ, фоновые задачи) — подключение этой ролью;
// - alpi_app — групповая роль приложения без LOGIN, без BYPASSRLS и без владения таблицами.
//   Приложение входит своей ролью с паролем, членом alpi_app:
//   CREATE ROLE <имя> LOGIN PASSWORD '...' IN ROLE alpi_app;
//
// Пользователи живут в таблицах Better Auth (тикет 03), которых ещё нет: user_id и created_by
// хранят id пользователя как text, без внешнего ключа.

/** Таблицы с project_id: у каждой включён RLS и политика «только строки текущего проекта». */
const projectTables = ['project_member', 'external_link'] as const

const appTables = ['project', ...projectTables] as const

export async function up(db: Kysely<unknown>): Promise<void> {
  // Роль общая на весь кластер PostgreSQL: она может уже существовать от другой базы.
  await sql`
    do $$
    begin
      if not exists (select from pg_roles where rolname = 'alpi_app') then
        create role alpi_app nologin nosuperuser nobypassrls;
      end if;
    end
    $$
  `.execute(db)

  // Проект — глобальная сущность (сам является меткой изоляции), поэтому без RLS.
  await sql`
    create table project (
      id uuid primary key default gen_random_uuid(),
      code text not null unique,
      name text not null,
      default_locale text not null default 'uk',
      timezone text not null default 'Europe/Kyiv',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db)

  // role_id — ссылка на роль проекта; таблица ролей появится в тикете 05, до тех пор nullable
  // и без внешнего ключа.
  await sql`
    create table project_member (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references project (id) on delete cascade,
      user_id text not null,
      role_id uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by text,
      unique (project_id, user_id)
    )
  `.execute(db)

  // entity_id — text: внешние ссылки бывают и у пользователей, а их id в Better Auth — text.
  await sql`
    create table external_link (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references project (id) on delete cascade,
      entity_type text not null,
      entity_id text not null,
      source text not null,
      external_id text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by text,
      unique (project_id, entity_type, source, external_id)
    )
  `.execute(db)

  for (const table of projectTables) {
    await sql`alter table ${sql.table(table)} enable row level security`.execute(db)
    // Проект не выставлен (нет set_config или транзакция withProject закончилась, и значение
    // стало пустой строкой) — nullif даёт NULL, сравнение ложно, строк ноль.
    // Политика без TO действует на все роли, кроме владельца таблицы и ролей с BYPASSRLS.
    await sql`
      create policy project_isolation on ${sql.table(table)}
        using (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
        with check (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
    `.execute(db)
  }

  // Права выдаются явно на каждую таблицу: новая таблица без строки здесь недоступна приложению.
  await sql`grant usage on schema public to alpi_app`.execute(db)
  // project приложение только читает: на ней нет RLS, и delete или update из withProject(A)
  // задел бы проект B, а delete — ещё и каскадом все строки B (каскад идёт мимо политик).
  // Проекты создаёт, меняет и удаляет служебная роль (createProject в src/project.ts).
  await sql`grant select on project to alpi_app`.execute(db)
  for (const table of projectTables) {
    await sql`grant select, insert, update, delete on ${sql.table(table)} to alpi_app`.execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [...appTables].reverse()) {
    await sql`drop table ${sql.table(table)}`.execute(db)
  }
  await sql`revoke usage on schema public from alpi_app`.execute(db)
  // Роль удаляется, только если её не держат права в других базах кластера.
  await sql`
    do $$
    begin
      drop role alpi_app;
    exception
      when dependent_objects_still_exist then
        raise notice 'роль alpi_app используется в другой базе и не удалена';
    end
    $$
  `.execute(db)
}
