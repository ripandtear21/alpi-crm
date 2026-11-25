import { type Kysely, sql } from 'kysely'

// Исходящие события (тикет crm-api/05; .scratch/crm-api/spec.md; GLOSSARY.md, «Событие»):
// таблица transactional outbox — событие пишется той же транзакцией проекта, что и изменение
// (apps/api/src/events/emit.ts), вместе с задачей pg-boss `webhook-fanout`. Откат изменения
// откатывает и событие, и задачу; зафиксированное изменение всегда оставляет событие.
//
// - id — `evt_` и UUID: тот же id уходит в заголовке `webhook-id` при каждой попытке доставки.
// - body — тело события целиком (тип, время, data), как его получит адрес автоматизации;
//   проверяется по схеме своего типа до записи (packages/shared/src/events).
// - Автор — тип и id без внешнего ключа, как в idempotency_record (0020): событие живёт
//   30 дней, удаление пользователя или ключа не должно на него натыкаться.
// - Только добавление: у роли приложения нет UPDATE и DELETE. Старые строки (30 дней) удаляет
//   ночная задача доставки (тикет 06) — она же добавит себе нужное право.
// - Метка проекта и row-level security, как в 0001_project_isolation.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table webhook_event (
      id text primary key
        check (id ~ '^evt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
      project_id uuid not null references project (id) on delete cascade,
      type text not null check (type ~ '^[a-z_]+[.][a-z_]+$'),
      occurred_at timestamptz not null,
      entity_type text not null check (entity_type ~ '^[a-z_]+$'),
      entity_id uuid not null,
      body jsonb not null check (jsonb_typeof(body) = 'object'),
      actor_type text not null check (actor_type in ('user', 'api_key')),
      actor_id text not null check (actor_id <> ''),
      created_at timestamptz not null default now()
    )
  `.execute(db)
  await sql`
    create index webhook_event_created_idx on webhook_event (project_id, created_at)
  `.execute(db)

  await sql`alter table webhook_event enable row level security`.execute(db)
  await sql`
    create policy project_isolation on webhook_event
      using (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
      with check (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
  `.execute(db)
  await sql`grant select, insert on webhook_event to alpi_app`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table webhook_event`.execute(db)
}
