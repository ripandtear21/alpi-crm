import { type Kysely, sql } from 'kysely'

// Доставка событий на адреса автоматизации (тикет crm-api/06; .scratch/crm-api/spec.md, раздел
// «Доставка»; GLOSSARY.md, «Событие»). Три таблицы проекта, у каждой — метка проекта и
// row-level security, как в 0001_project_isolation:
//
// - webhook_endpoint — адрес автоматизации: URL, на какие типы событий подписан, секрет подписи
//   (зашифрован AES-256-GCM ключом из окружения — его нужно читать, чтобы подписывать; открытым
//   текстом секрет в базе не лежит), предыдущий секрет на 24 часа после смены, состояние и
//   причина отключения. `failing_since` — время первой неудачной попытки текущей серии (после
//   последнего успеха или включения адреса); успех и включение её сбрасывают. От неё считаются
//   «5 суток без успешной доставки»: адрес, на который давно ничего не отправлялось, первая
//   неудача не отключает.
// - webhook_delivery — событие × адрес: одна строка на пару, попытки копятся в ней.
// - webhook_delivery_attempt — одна попытка: код ответа или ошибка сети, длительность, первые
//   1 КБ тела ответа. Только добавление.
//
// Доставки ссылаются на событие и адрес своего же проекта (составные внешние ключи с
// project_id): доставка не свяжет событие проекта A с адресом проекта B даже при ошибке в коде.
// Удаление адреса удаляет его доставки и попытки; удаление события (ночная очистка, 30 дней) —
// тоже. Для очистки роли приложения выдаётся DELETE на webhook_event: в 0021 его не было.

const ISOLATION = (table: string) => sql`
  create policy project_isolation on ${sql.id(table)}
    using (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
    with check (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
`

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table webhook_event add constraint webhook_event_project_id_key unique (project_id, id)
  `.execute(db)

  await sql`
    create table webhook_endpoint (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references project (id) on delete cascade,
      url text not null check (char_length(url) between 1 and 2048),
      description text check (description is null or char_length(description) between 1 and 500),
      event_types text[] not null
        check (cardinality(event_types) between 1 and 100 and array_position(event_types, null) is null),
      secret_encrypted text not null check (secret_encrypted <> ''),
      previous_secret_encrypted text,
      previous_secret_expires_at timestamptz,
      state text not null default 'active' check (state in ('active', 'disabled')),
      disabled_reason text check (disabled_reason in ('gone_410', 'failing_5_days', 'manual')),
      disabled_at timestamptz,
      failing_since timestamptz,
      last_success_at timestamptz,
      created_by text not null references "user" (id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (project_id, id),
      check ((previous_secret_encrypted is null) = (previous_secret_expires_at is null)),
      check ((state = 'disabled') = (disabled_reason is not null)),
      check ((state = 'disabled') = (disabled_at is not null))
    )
  `.execute(db)
  await sql`create index webhook_endpoint_project_idx on webhook_endpoint (project_id, created_at)`.execute(
    db,
  )

  await sql`
    create table webhook_delivery (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references project (id) on delete cascade,
      event_id text not null,
      endpoint_id uuid not null,
      state text not null default 'pending'
        check (state in ('pending', 'succeeded', 'failed', 'cancelled')),
      attempts integer not null default 0 check (attempts >= 0),
      next_attempt_at timestamptz,
      succeeded_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (event_id, endpoint_id),
      unique (project_id, id),
      foreign key (project_id, event_id) references webhook_event (project_id, id) on delete cascade,
      foreign key (project_id, endpoint_id) references webhook_endpoint (project_id, id)
        on delete cascade
    )
  `.execute(db)
  await sql`
    create index webhook_delivery_endpoint_idx
      on webhook_delivery (project_id, endpoint_id, created_at desc, id desc)
  `.execute(db)

  await sql`
    create table webhook_delivery_attempt (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references project (id) on delete cascade,
      delivery_id uuid not null,
      attempted_at timestamptz not null default now(),
      status_code integer check (status_code between 100 and 599),
      error text check (error in ('timeout', 'tls', 'dns', 'forbidden_address', 'network')),
      duration_ms integer not null check (duration_ms >= 0),
      response_body text check (octet_length(response_body) <= 1024),
      check ((status_code is null) <> (error is null)),
      foreign key (project_id, delivery_id) references webhook_delivery (project_id, id)
        on delete cascade
    )
  `.execute(db)
  await sql`
    create index webhook_delivery_attempt_delivery_idx
      on webhook_delivery_attempt (project_id, delivery_id, attempted_at)
  `.execute(db)

  for (const table of ['webhook_endpoint', 'webhook_delivery', 'webhook_delivery_attempt']) {
    await sql`alter table ${sql.id(table)} enable row level security`.execute(db)
    await ISOLATION(table).execute(db)
  }
  await sql`grant select, insert, update, delete on webhook_endpoint to alpi_app`.execute(db)
  await sql`grant select, insert, update on webhook_delivery to alpi_app`.execute(db)
  await sql`grant select, insert on webhook_delivery_attempt to alpi_app`.execute(db)
  // Ночная очистка событий старше 30 дней (apps/api/src/jobs/webhook-purge.ts); доставки и
  // попытки уходят вместе с событием.
  await sql`grant delete on webhook_event to alpi_app`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`revoke delete on webhook_event from alpi_app`.execute(db)
  await sql`drop table webhook_delivery_attempt`.execute(db)
  await sql`drop table webhook_delivery`.execute(db)
  await sql`drop table webhook_endpoint`.execute(db)
  await sql`alter table webhook_event drop constraint webhook_event_project_id_key`.execute(db)
}
