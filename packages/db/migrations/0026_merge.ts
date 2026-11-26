import { type Kysely, sql } from 'kysely'

// Слияние с откатом (тикет crm-intake/02 — сделки; общие таблицы — для тикета crm-intake/01,
// контакты; docs/adr/0005-sliyanie-s-otkatom.md).
//
// - deal.merged_into_id, deal.merged_at — сделка слита с другой и скрыта: её нет в канбане,
//   списке, поиске, корзине, агрегатах колонок и выборках по контакту. Скрытая сделка не
//   стирается: запрос по её id отвечает 404 DEAL_MERGED с id оставшейся. Ссылка — только на
//   сделку своего проекта (составной внешний ключ).
// - Уникальный индекс deal_one_open_per_contact (0010_deals) скрытые сделки не считает: после
//   слияния у контакта можно открыть новую сделку в той же воронке.
// - merge_record — одно слияние: тип записи (контакт или сделка), оставшаяся и слитая запись,
//   родительское слияние (сделки, объединённые в том же действии, — тикет 04), кто и когда
//   объединил, до какого времени можно откатить, кто и когда откатил. Строка не удаляется: у
//   роли приложения нет DELETE, а UPDATE — только отметки отката. Ссылки на записи без внешнего
//   ключа: тип записи бывает разный.
// - merge_moved_item — что перешло: вид (`kind`, реестр apps/api/src/merge), id перешедшей
//   записи, поле и значение, которое поставило слияние. Только добавление.
// - Окончательное удаление сделки (purge_from_trash) удаляет и скрытые сделки, слитые в неё (по
//   всей цепочке), их историю и записи слияний этих сделок: в «было → стало» и в заполненных
//   полях лежат данные клиента. Корень — в корзине или сам скрытый (его стирают вместе с
//   основным контактом, apps/api/src/deals/dependents.ts); проверка корня — под блокировкой
//   строки и по числу удалённых строк: одновременное восстановление из корзины или откат
//   слияния не дадут стереть живую сделку.
// - Слияние переносит заметки, файлы, строки товаров и участников второй сделки: роли
//   приложения — UPDATE (deal_id) на note, file и deal_product (на deal_participant UPDATE уже
//   есть, 0010).
//
// У новых таблиц project_id и политика row-level security, как в 0001_project_isolation.
//
// Откат миграции возвращает скрытые сделки в выдачу; если у контакта окажутся две открытые
// сделки в воронке, старый индекс не создастся — сначала откатить слияния.

const ISOLATION = (table: string) => sql`
  create policy project_isolation on ${sql.id(table)}
    using (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
    with check (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
`

/** SQLSTATE: окончательно удаляют запись, которой нет в корзине текущего проекта (0009). */
const NOT_IN_TRASH = 'CL001'

/** Ветка сделки purge_from_trash, как в 0010_deals. */
const DEAL_BRANCH_0010 = `
      elsif p_entity_type = 'deal' then
        delete from public.deal d
          where d.id = p_id and d.project_id = current_project and d.deleted_at is not null;`

/**
 * Ветка сделки со скрытыми сделками: корень блокируется (FOR UPDATE ждёт восстановления из
 * корзины и отката слияния и после них перечитывает условие), цепочка слитых в него — по
 * merged_into_id, всё удаляется одним запросом (ссылки merged_into_id проверяются в конце
 * запроса), корень — снова с условием «в корзине или скрыт».
 */
const DEAL_BRANCH_MERGE = `
      elsif p_entity_type = 'deal' then
        perform 1 from public.deal d
          where d.id = p_id and d.project_id = current_project
            and (d.deleted_at is not null or d.merged_into_id is not null)
          for update;
        if not found then
          raise exception 'записи нет в корзине проекта' using errcode = '${NOT_IN_TRASH}';
        end if;
        with recursive chain(id) as (
          select p_id
          union
          select d.id from public.deal d
            join chain on d.merged_into_id = chain.id
            where d.project_id = current_project
        )
        select array_agg(chain.id) into ids from chain;
        delete from public.merge_record m
          where m.project_id = current_project
            and m.entity_type = 'deal'
            and (m.survivor_id = any (ids) or m.merged_id = any (ids));
        with removed as (
          delete from public.deal d
            where d.project_id = current_project
              and d.id = any (ids)
              and (d.id <> p_id or d.deleted_at is not null or d.merged_into_id is not null)
            returning d.id
        )
        select coalesce(bool_or(removed.id = p_id), false) into root_removed from removed;
        if not root_removed then
          raise exception 'записи нет в корзине проекта' using errcode = '${NOT_IN_TRASH}';
        end if;
        delete from public.change_log l
          where l.project_id = current_project
            and l.entity_type = 'deal'
            and l.entity_id = any (ids);
        return;`

/** purge_from_trash; `withMerge` — ветка сделки со скрытыми сделками, без него — как в 0010. */
function purgeFunction(withMerge: boolean): string {
  return `
    create or replace function public.purge_from_trash(p_entity_type text, p_id uuid)
      returns void
      language plpgsql
      security definer
      set search_path = pg_catalog, pg_temp
    as $$
    declare
      current_project uuid := nullif(current_setting('app.project_id', true), '')::uuid;
      ids uuid[];
      root_removed boolean;
    begin
      if current_project is null then
        raise exception 'проект не выставлен' using errcode = 'insufficient_privilege';
      end if;
      if p_entity_type = 'contact' then
        delete from public.contact c
          where c.id = p_id and c.project_id = current_project and c.deleted_at is not null;
      elsif p_entity_type = 'organization' then
        delete from public.organization o
          where o.id = p_id and o.project_id = current_project and o.deleted_at is not null;${
            withMerge ? DEAL_BRANCH_MERGE : DEAL_BRANCH_0010
          }
      else
        raise exception 'сущность % так не удаляется', p_entity_type
          using errcode = 'insufficient_privilege';
      end if;
      if not found then
        raise exception 'записи нет в корзине проекта' using errcode = '${NOT_IN_TRASH}';
      end if;
      delete from public.change_log l
        where l.project_id = current_project
          and l.entity_type = p_entity_type
          and l.entity_id = p_id;
    end
    $$
  `
}

/** Условие индекса «одна открытая сделка у человека в воронке» (0010_deals). */
const OPEN_DEAL_0010 = `status = 'open' and archived_at is null and deleted_at is null`

async function openDealIndex(db: Kysely<unknown>, where: string): Promise<void> {
  await sql`drop index deal_one_open_per_contact`.execute(db)
  await sql
    .raw(`
      create unique index deal_one_open_per_contact
        on deal (project_id, pipeline_id, primary_contact_id) where ${where}
    `)
    .execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table deal
      add column merged_into_id uuid,
      add column merged_at timestamptz,
      add constraint deal_merged_into_fkey foreign key (project_id, merged_into_id)
        references deal (project_id, id),
      add constraint deal_merged_pair check ((merged_into_id is null) = (merged_at is null)),
      add constraint deal_merged_not_self check (merged_into_id <> id)
  `.execute(db)
  await sql`
    create index deal_merged_into_idx on deal (project_id, merged_into_id)
      where merged_into_id is not null
  `.execute(db)
  await openDealIndex(db, `${OPEN_DEAL_0010} and merged_into_id is null`)
  await sql`grant update (merged_into_id, merged_at) on deal to alpi_app`.execute(db)
  for (const table of ['note', 'file', 'deal_product']) {
    await sql`grant update (deal_id) on ${sql.id(table)} to alpi_app`.execute(db)
  }

  await sql`
    create table merge_record (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references project (id) on delete cascade,
      entity_type text not null check (entity_type in ('contact', 'deal')),
      survivor_id uuid not null,
      merged_id uuid not null,
      parent_id uuid,
      merged_by text not null references "user" (id),
      merged_at timestamptz not null default now(),
      undo_until timestamptz not null,
      undone_by text references "user" (id),
      undone_at timestamptz,
      unique (project_id, id),
      check (survivor_id <> merged_id),
      check (undo_until > merged_at),
      check ((undone_at is null) = (undone_by is null)),
      foreign key (project_id, parent_id) references merge_record (project_id, id)
        on delete cascade
    )
  `.execute(db)
  await sql`
    create index merge_record_survivor_idx
      on merge_record (project_id, entity_type, survivor_id, merged_at desc)
  `.execute(db)
  await sql`
    create index merge_record_merged_idx
      on merge_record (project_id, entity_type, merged_id, merged_at desc)
  `.execute(db)

  await sql`
    create table merge_moved_item (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references project (id) on delete cascade,
      merge_id uuid not null,
      kind text not null check (kind ~ '^[a-z][a-z_]*$' and char_length(kind) <= 60),
      item_id uuid,
      field text check (char_length(field) between 1 and 100),
      value jsonb,
      foreign key (project_id, merge_id) references merge_record (project_id, id)
        on delete cascade
    )
  `.execute(db)
  await sql`create index merge_moved_item_merge_idx on merge_moved_item (project_id, merge_id)`.execute(
    db,
  )

  for (const table of ['merge_record', 'merge_moved_item']) {
    await sql`alter table ${sql.id(table)} enable row level security`.execute(db)
    await ISOLATION(table).execute(db)
  }
  await sql`grant select, insert on merge_record to alpi_app`.execute(db)
  await sql`grant update (undone_by, undone_at) on merge_record to alpi_app`.execute(db)
  await sql`grant select, insert on merge_moved_item to alpi_app`.execute(db)

  await sql.raw(purgeFunction(true)).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(purgeFunction(false)).execute(db)
  await sql`drop table merge_moved_item`.execute(db)
  await sql`drop table merge_record`.execute(db)
  for (const table of ['deal_product', 'file', 'note']) {
    await sql`revoke update (deal_id) on ${sql.id(table)} from alpi_app`.execute(db)
  }
  await openDealIndex(db, OPEN_DEAL_0010)
  // Права на столбцы уходят вместе со столбцами.
  await sql`
    alter table deal
      drop column merged_at,
      drop column merged_into_id
  `.execute(db)
}
