import { type Kysely, sql } from 'kysely'

// Каталог товаров и строки товаров в сделке (тикет crm-deals/06; spec.md MVP, раздел 3.2 —
// `product`, `deal_product`; ответ владельца 13.0.4 — строки сумму сделки не меняют; GLOSSARY.md —
// «Товар»).
//
// - product — товар проекта: название и цены в EUR, UAH и USD, любая может быть пустой. Без
//   вариаций и скидок. Не удаляется, а уходит в архив (archived_at): у роли приложения нет
//   DELETE, а старые строки сделок ссылаются на товар.
// - deal_product — строка товара в сделке: товар своего проекта (составной ключ), количество
//   больше нуля, цена за единицу в валюте сделки. Валюта у строки не хранится: смена валюты
//   сделки цены строк не пересчитывает (решено без владельца — подтвердить). Строка уходит
//   вместе со сделкой при окончательном удалении (каскад; purge_from_trash не меняется).
// - Архивный товар в новую строку не ставится (триггер deal_product_active): товар блокируется
//   FOR SHARE, так что одновременная архивация ждёт вставки, а вставка после архивации получает
//   отказ. Старые строки с товаром, ушедшим в архив, остаются.
// - История строк — change_log сделки (поле products), пишет API.

const projectTables = ['product', 'deal_product'] as const

/** SQLSTATE: товар в архиве. */
const PRODUCT_ARCHIVED = 'DP001'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table product (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references project (id) on delete cascade,
      name text not null check (btrim(name) <> '' and char_length(name) <= 200),
      price_eur numeric(14, 2) check (price_eur >= 0),
      price_uah numeric(14, 2) check (price_uah >= 0),
      price_usd numeric(14, 2) check (price_usd >= 0),
      archived_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by text,
      unique (project_id, id)
    )
  `.execute(db)

  await sql`
    create table deal_product (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references project (id) on delete cascade,
      deal_id uuid not null,
      product_id uuid not null,
      quantity integer not null check (quantity > 0),
      unit_price numeric(14, 2) not null check (unit_price >= 0),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by text,
      foreign key (project_id, deal_id) references deal (project_id, id) on delete cascade,
      foreign key (project_id, product_id) references product (project_id, id)
    )
  `.execute(db)
  await sql`create index deal_product_deal_idx on deal_product (project_id, deal_id)`.execute(db)
  await sql`
    create index deal_product_product_idx on deal_product (project_id, product_id)
  `.execute(db)

  await sql
    .raw(`
      create function public.deal_product_active()
        returns trigger
        language plpgsql
      as $$
      begin
        perform 1 from public.product p
          where p.id = new.product_id and p.archived_at is null
          for share;
        if not found then
          raise exception 'товар в архиве' using errcode = '${PRODUCT_ARCHIVED}';
        end if;
        return new;
      end
      $$
    `)
    .execute(db)
  await sql`
    create trigger deal_product_active before insert or update of product_id on deal_product
      for each row execute function public.deal_product_active()
  `.execute(db)

  for (const table of projectTables) {
    await sql`alter table ${sql.table(table)} enable row level security`.execute(db)
    await sql`
      create policy project_isolation on ${sql.table(table)}
        using (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
        with check (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
    `.execute(db)
  }
  await sql`grant select, insert, update on product to alpi_app`.execute(db)
  // Товар строки не меняется (убрать строку и добавить новую): UPDATE — только количество и цена.
  await sql`grant select, insert, delete on deal_product to alpi_app`.execute(db)
  await sql`grant update (quantity, unit_price, updated_at) on deal_product to alpi_app`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // История строк (change_log, поле products) остаётся: сделки не удаляются, а записи
  // «было → стало» — уже случившиеся изменения.
  for (const table of [...projectTables].reverse()) {
    await sql`drop table ${sql.table(table)}`.execute(db)
  }
  await sql`drop function public.deal_product_active()`.execute(db)
}
