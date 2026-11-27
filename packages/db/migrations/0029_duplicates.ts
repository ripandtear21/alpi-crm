import { type Kysely, sql } from 'kysely'

// Надсмотрщик за дублями (тикет crm-intake/05; пункты 32–34 ответов владельца; ADR 0003 и 0005;
// GLOSSARY.md, «Дубль», «Возможный дубль»).
//
// - duplicate_pair — найденная пара похожих записей: тип (контакт или сделка), две записи в
//   порядке id (a_id < b_id), причина и когда найдена. Уникальна по (тип, записи, причина): у
//   одной пары может быть несколько причин. Пишет и удаляет только надсмотрщик
//   (apps/api/src/duplicates); записи пары — контакт или сделка по типу, поэтому внешних ключей
//   на них нет: пара записи, удалённой окончательно, живёт до следующего прохода, а списки
//   читают пары только вместе с живыми записями.
// - not_duplicate — пара с отметкой «не дубль»: кто и когда отметил. Такая пара больше не
//   предлагается ни по одной причине (решено без владельца — подтвердить). Строка не меняется и
//   не удаляется.
// - contact_phone_last9_idx — последние 9 цифр телефона: правило «одинаковые имя и фамилия и
//   последние 9 цифр телефона».
// Обе таблицы — с меткой проекта и row-level security, как в 0001_project_isolation.

const ISOLATION = (table: string) => sql`
  create policy project_isolation on ${sql.id(table)}
    using (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
    with check (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
`

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table duplicate_pair (
      project_id uuid not null references project (id) on delete cascade,
      entity_type text not null check (entity_type in ('contact', 'deal')),
      a_id uuid not null,
      b_id uuid not null,
      reason text not null
        check (reason in ('phone', 'email', 'mark', 'name_phone', 'open_deals')),
      found_at timestamptz not null default now(),
      primary key (project_id, entity_type, a_id, b_id, reason),
      check (a_id < b_id),
      check ((entity_type = 'deal') = (reason = 'open_deals'))
    )
  `.execute(db)
  // Пересчёт пар одной записи ищет её и как вторую запись пары.
  await sql`
    create index duplicate_pair_b_idx on duplicate_pair (project_id, entity_type, b_id)
  `.execute(db)

  await sql`
    create table not_duplicate (
      project_id uuid not null references project (id) on delete cascade,
      entity_type text not null check (entity_type in ('contact', 'deal')),
      a_id uuid not null,
      b_id uuid not null,
      marked_by text not null references "user" (id),
      marked_at timestamptz not null default now(),
      primary key (project_id, entity_type, a_id, b_id),
      check (a_id < b_id)
    )
  `.execute(db)

  await sql`
    create index contact_phone_last9_idx on contact_phone (project_id, right(phone, 9))
  `.execute(db)

  for (const table of ['duplicate_pair', 'not_duplicate']) {
    await sql`alter table ${sql.id(table)} enable row level security`.execute(db)
    await ISOLATION(table).execute(db)
  }
  await sql`grant select, insert, delete on duplicate_pair to alpi_app`.execute(db)
  await sql`grant select, insert on not_duplicate to alpi_app`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index contact_phone_last9_idx`.execute(db)
  await sql`drop table not_duplicate`.execute(db)
  await sql`drop table duplicate_pair`.execute(db)
}
