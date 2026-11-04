import { readFileSync } from 'node:fs'
import { type Kysely, sql } from 'kysely'

// Фоновые задачи, массовые операции и очистка журнала (тикет crm-deals/04).
//
// 1. Схема pg-boss (.scratch/crm-mvp/spec.md, раздел 3.1: служебные таблицы фоновых задач живут
//    вне проектов). Её создаёт эта миграция под служебной ролью, а не сам pg-boss при старте
//    API: роль приложения не владеет таблицами (assertRestrictedRole не даст API запуститься), и
//    права CREATE на схему у неё нет. API запускает pg-boss с migrate: false — он только
//    проверяет, что версия схемы совпадает со своей (apps/api/src/jobs/jobs.ts).
//    Роль приложения получает то, что нужно очереди: читать и писать строки таблиц pgboss и звать
//    её функции. Менять схему (создавать, удалять таблицы) она не может.
//    SQL установки заморожен текстом в 0007_jobs_bulk.pgboss-v46.sql (pg-boss 12.38.0, схема
//    версии 46), а не берётся из установленного пакета: иначе результат уже написанной миграции
//    менялся бы вместе с версией пакета. Обновление pg-boss до версии с другой схемой — новая
//    миграция с getMigrationPlans и теми же правами для alpi_app; тест
//    apps/api/src/jobs/jobs.test.ts падает, если установленный pg-boss ждёт другую версию схемы.
//    Row-level security на таблицах pgboss нет, и это допустимо: в задаче лежат только
//    { projectId, bulkJobId } (без данных проекта), обработчик перечитывает операцию в
//    withProject под политикой проекта и заново проверяет права инициатора. Подставленный id
//    чужого проекта не даст ничего: роль приложения видит строки проекта только в его контексте,
//    а операция чужого проекта выполняется с правами её инициатора.
// 2. bulk_job и bulk_job_error — массовая операция и журнал её ошибок по записям. Данные
//    проекта: project_id и row-level security, как в 0001_project_isolation.
// 3. purge_expired_failed_sign_ins — служебная функция: удаляет из системного журнала записи о
//    неудачных входах старше 90 дней (решение владельца, 0005_audit). Журнал для роли
//    приложения только на добавление, поэтому удаление — функцией с правами владельца
//    (SECURITY DEFINER), которая удаляет только этот вид записей; её зовёт ежедневная задача.

/** Схема таблиц pg-boss; та же константа — PGBOSS_SCHEMA в apps/api/src/jobs/jobs.ts. */
const PGBOSS_SCHEMA = 'pgboss'

/** Сколько дней хранятся записи о неудачных входах. Снимок на момент миграции. */
const FAILED_SIGN_IN_RETENTION_DAYS = 90

/**
 * SQL установки pg-boss — getConstructionPlans('pgboss') версии 12.38.0 без обёртки BEGIN …
 * COMMIT: миграция Kysely уже идёт в транзакции, и COMMIT из середины зафиксировал бы её раньше
 * времени.
 */
const PGBOSS_INSTALL = new URL('./0007_jobs_bulk.pgboss-v46.sql', import.meta.url)

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(readFileSync(PGBOSS_INSTALL, 'utf8')).execute(db)
  const schema = sql.id(PGBOSS_SCHEMA)
  await sql`grant usage on schema ${schema} to alpi_app`.execute(db)
  await sql`grant select, insert, update, delete on all tables in schema ${schema} to alpi_app`.execute(
    db,
  )
  await sql`grant usage, select on all sequences in schema ${schema} to alpi_app`.execute(db)
  await sql`grant execute on all functions in schema ${schema} to alpi_app`.execute(db)

  await sql`
    create table bulk_job (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references project (id) on delete cascade,
      -- Кто запустил: права и охват проверяются по его текущей роли на каждой порции.
      initiator_id text not null references "user" (id),
      -- Код действия из реестра (apps/api/src/bulk/registry.ts): «раздел.действие».
      action text not null check (action ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
      -- Выбор: {"ids": [...]} или {"filter": {...}} — как его прислал клиент.
      selection jsonb not null check (jsonb_typeof(selection) = 'object'),
      -- Параметры действия (новый ответственный, этап…).
      params jsonb not null default '{}' check (jsonb_typeof(params) = 'object'),
      -- Записи, которые обрабатываются, в порядке обработки: выбор, развёрнутый при старте.
      -- null — ещё не развёрнут.
      record_ids text[],
      status text not null default 'queued'
        check (status in ('queued', 'running', 'done', 'failed')),
      total integer check (total >= 0),
      -- Обработано записей (с ошибкой — тоже); ошибок из них.
      processed integer not null default 0 check (processed >= 0),
      failed integer not null default 0 check (failed >= 0 and failed <= processed),
      -- Почему операция остановилась целиком (status = 'failed').
      failure text check (char_length(failure) <= 500),
      created_at timestamptz not null default now(),
      started_at timestamptz,
      finished_at timestamptz,
      unique (project_id, id),
      check (total is null or processed <= total),
      check ((status = 'failed') = (failure is not null))
    )
  `.execute(db)
  // Список «мои операции» и «все в проекте»: новые сверху.
  await sql`
    create index bulk_job_list_idx on bulk_job (project_id, initiator_id, created_at desc)
  `.execute(db)

  await sql`
    create table bulk_job_error (
      project_id uuid not null,
      bulk_job_id uuid not null,
      -- Место записи в bulk_job.record_ids: журнал читается в порядке обработки.
      position integer not null check (position >= 0),
      record_id text not null check (char_length(record_id) <= 100),
      -- OUT_OF_SCOPE, PERMISSION_DENIED, код ошибки действия или FAILED.
      code text not null check (code ~ '^[A-Z][A-Z0-9_]*$' and char_length(code) <= 60),
      message text check (char_length(message) <= 500),
      primary key (bulk_job_id, position),
      foreign key (project_id, bulk_job_id) references bulk_job (project_id, id) on delete cascade
    )
  `.execute(db)

  for (const table of ['bulk_job', 'bulk_job_error']) {
    await sql`alter table ${sql.table(table)} enable row level security`.execute(db)
    await sql`
      create policy project_isolation on ${sql.table(table)}
        using (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
        with check (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
    `.execute(db)
  }
  // Операции не удаляются: это след того, кто и что менял массово. Ошибки только добавляются.
  await sql`grant select, insert, update on bulk_job to alpi_app`.execute(db)
  await sql`grant select, insert on bulk_job_error to alpi_app`.execute(db)

  await sql
    .raw(`
      create function public.purge_expired_failed_sign_ins()
        returns integer
        language sql
        security definer
        set search_path = pg_catalog, pg_temp
      as $$
        with deleted as (
          delete from public.system_audit_log
          where action = 'auth.sign_in_failed'
            and occurred_at < now() - make_interval(days => ${FAILED_SIGN_IN_RETENTION_DAYS})
          returning 1
        )
        select count(*)::integer from deleted
      $$
    `)
    .execute(db)
  await sql`revoke all on function public.purge_expired_failed_sign_ins() from public`.execute(db)
  await sql`grant execute on function public.purge_expired_failed_sign_ins() to alpi_app`.execute(
    db,
  )
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop function public.purge_expired_failed_sign_ins()`.execute(db)
  await sql`drop table bulk_job_error`.execute(db)
  await sql`drop table bulk_job`.execute(db)
  await sql`drop schema ${sql.id(PGBOSS_SCHEMA)} cascade`.execute(db)
}
