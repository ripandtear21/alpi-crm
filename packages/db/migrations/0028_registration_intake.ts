import { type Kysely, sql } from 'kysely'

// Приём регистраций и журнал входящих (тикет crm-intake/06; .scratch/crm-intake/spec.md;
// GLOSSARY.md, «Регистрация», «Журнал входящих»; ADR 0006).
//
// - registration — регистрация с формы или лендинга: источник, `event_id` (уникален в пределах
//   источника), контакт и сделка, в которые она легла, и поля заметки Pipedrive «Информация из
//   формы» (пункт 12 ответов владельца); всё остальное из тела — в `extra`. Регистрация
//   принадлежит контакту и сделке: окончательное удаление любого из них из корзины
//   (purge_from_trash) удаляет и её — в ней персональные данные (внешние ключи on delete cascade;
//   решено без владельца — подтвердить). Слияние контактов и сделок переносит её (UPDATE
//   contact_id, deal_id — реестры apps/api/src/merge).
// - intake_event — пара «источник, event_id» хранится вечно (пункт 4), без персональных данных:
//   повтор события, чьи записи уже удалены окончательно, отвечает 200 без id и ничего не
//   создаёт. Вставка сюда — точка повтора: одновременный второй запрос с тем же event_id ждёт
//   первый на первичном ключе. `kind` — вид входящего (просмотры вебинара — тикет 08).
// - inbound_request — журнал входящих, общий для всех каналов приёма: сырое тело запроса,
//   итог (принят, повтор, ошибка), код ответа и ошибки, найденные или созданные id,
//   предупреждения; `replay_of` — строка, которую провели заново. Ночная задача удаляет строки
//   старше 30 дней (роли приложения — DELETE). Строка не меняется.
// Все три — с меткой проекта и row-level security, как в 0001_project_isolation; ссылки — только
// на записи своего проекта (составные внешние ключи).

const ISOLATION = (table: string) => sql`
  create policy project_isolation on ${sql.id(table)}
    using (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
    with check (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
`

/** Строковые поля регистрации из заметки Pipedrive и их наибольшая длина. */
const TEXT_COLUMNS = [
  'name',
  'phone_raw',
  'dial_code',
  'email',
  'form',
  'webinar',
  'plan_name',
  'page_url',
  'referrer',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'ad_id',
  'gclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'fbp',
  'fbc',
  'user_agent',
]

/** Наибольшая длина строкового поля регистрации (адрес страницы, user_agent — самые длинные). */
const MAX_TEXT = 2000

export async function up(db: Kysely<unknown>): Promise<void> {
  const textColumns = TEXT_COLUMNS.map(
    (column) => `${column} text check (char_length(${column}) <= ${MAX_TEXT}),`,
  ).join('\n      ')
  await sql
    .raw(`
    create table registration (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references project (id) on delete cascade,
      intake_source_id uuid not null,
      event_id text not null check (char_length(event_id) between 1 and 255),
      contact_id uuid not null,
      deal_id uuid not null,
      created_at timestamptz not null default now(),
      phone text check (phone ~ '^\\+[1-9][0-9]{6,14}$'),
      ${textColumns}
      registered_at timestamptz,
      extra jsonb not null default '{}' check (jsonb_typeof(extra) = 'object'),
      unique (project_id, id),
      unique (project_id, intake_source_id, event_id),
      foreign key (project_id, intake_source_id) references intake_source (project_id, id),
      foreign key (project_id, contact_id) references contact (project_id, id) on delete cascade,
      foreign key (project_id, deal_id) references deal (project_id, id) on delete cascade
    )
  `)
    .execute(db)
  await sql`
    create index registration_deal_idx on registration (project_id, deal_id, created_at desc, id)
  `.execute(db)
  await sql`
    create index registration_contact_idx
      on registration (project_id, contact_id, created_at desc, id)
  `.execute(db)

  await sql`
    create table intake_event (
      project_id uuid not null references project (id) on delete cascade,
      intake_source_id uuid not null,
      kind text not null check (kind in ('registration')),
      event_id text not null check (char_length(event_id) between 1 and 255),
      registration_id uuid,
      created_at timestamptz not null default now(),
      primary key (project_id, intake_source_id, kind, event_id),
      foreign key (project_id, intake_source_id) references intake_source (project_id, id),
      foreign key (project_id, registration_id) references registration (project_id, id)
        on delete set null (registration_id)
    )
  `.execute(db)
  await sql`
    create index intake_event_registration_idx on intake_event (project_id, registration_id)
      where registration_id is not null
  `.execute(db)

  await sql`
    create table inbound_request (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references project (id) on delete cascade,
      channel text not null check (channel ~ '^[a-z][a-z_]*\\.[a-z][a-z_]*$'),
      intake_source_id uuid,
      received_at timestamptz not null default clock_timestamp(),
      status_code integer not null check (status_code between 100 and 599),
      outcome text not null check (outcome in ('accepted', 'repeat', 'error')),
      error_code text check (char_length(error_code) <= 60),
      event_id text check (char_length(event_id) <= 255),
      body text not null,
      result jsonb,
      warnings text[] not null default '{}',
      replay_of uuid,
      unique (project_id, id),
      check ((outcome = 'error') = (error_code is not null)),
      foreign key (project_id, intake_source_id) references intake_source (project_id, id),
      foreign key (project_id, replay_of) references inbound_request (project_id, id)
        on delete set null (replay_of)
    )
  `.execute(db)
  // «Провести заново с момента T» и ночная очистка — по времени прихода; экран источника —
  // новые сверху.
  await sql`
    create index inbound_request_received_idx on inbound_request (project_id, received_at, id)
  `.execute(db)
  await sql`
    create index inbound_request_source_idx
      on inbound_request (project_id, intake_source_id, received_at desc, id desc)
  `.execute(db)
  await sql`
    create index inbound_request_replay_idx on inbound_request (project_id, replay_of)
      where replay_of is not null
  `.execute(db)

  for (const table of ['registration', 'intake_event', 'inbound_request']) {
    await sql`alter table ${sql.id(table)} enable row level security`.execute(db)
    await ISOLATION(table).execute(db)
  }
  await sql`grant select, insert on registration to alpi_app`.execute(db)
  await sql`grant update (contact_id, deal_id) on registration to alpi_app`.execute(db)
  await sql`grant select, insert on intake_event to alpi_app`.execute(db)
  await sql`grant update (registration_id) on intake_event to alpi_app`.execute(db)
  await sql`grant select, insert, delete on inbound_request to alpi_app`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table inbound_request`.execute(db)
  await sql`drop table intake_event`.execute(db)
  await sql`drop table registration`.execute(db)
}
