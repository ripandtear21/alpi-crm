import { type Kysely, sql } from 'kysely'

// Слияние контактов с откатом (тикет crm-intake/01; docs/adr/0005-sliyanie-s-otkatom.md). Общие
// таблицы слияния (merge_record, merge_moved_item) и сделки — в 0026_merge (тикет crm-intake/02).
//
// - contact.merged_into_id, contact.merged_at — контакт слит с другим и скрыт: его нет в
//   списках, поиске, поиске совпадения, корзине и выборках охвата (apps/api/src/contacts/scope.ts).
//   Скрытый контакт не стирается и после 30 дней: запрос по его id отвечает 404 CONTACT_MERGED с
//   id оставшегося. Ссылка — только на контакт своего проекта (составной внешний ключ).
// - contact.possible_duplicate_of — с каким контактом связана отметка «возможный дубль»; уходит
//   в null, когда тот контакт удалён окончательно.
// - Окончательное удаление контакта из корзины (purge_from_trash) удаляет и скрытые контакты,
//   слитые в него (по всей цепочке), их историю и записи слияний этих контактов: в
//   «было → стало» и в заполненных полях лежат персональные данные. Корень блокируется
//   (FOR UPDATE ждёт восстановления из корзины и после него перечитывает условие), удаление
//   корня — снова с условием «в корзине», проверка — по числу удалённых строк: фоновая очистка
//   корзины (apps/api/src/trash/purgers.ts) не сотрёт контакт, восстановленный в тот же момент.
//   Ветка сделки — как в 0026_merge, без изменений.
// - Слияние переносит заметки и файлы второго контакта: роли приложения — UPDATE (contact_id).

/** SQLSTATE: окончательно удаляют запись, которой нет в корзине текущего проекта (0009). */
const NOT_IN_TRASH = 'CL001'

/** Ветка контакта purge_from_trash, как в 0009/0026: без скрытых контактов. */
const CONTACT_BRANCH_0026 = `
      if p_entity_type = 'contact' then
        delete from public.contact c
          where c.id = p_id and c.project_id = current_project and c.deleted_at is not null;`

/**
 * Ветка контакта со скрытыми контактами: корень в корзине блокируется, цепочка слитых в него —
 * по merged_into_id, всё удаляется одним запросом, корень — снова с условием «в корзине».
 */
const CONTACT_BRANCH_MERGE = `
      if p_entity_type = 'contact' then
        perform 1 from public.contact c
          where c.id = p_id and c.project_id = current_project and c.deleted_at is not null
          for update;
        if not found then
          raise exception 'записи нет в корзине проекта' using errcode = '${NOT_IN_TRASH}';
        end if;
        with recursive chain(id) as (
          select p_id
          union
          select c.id from public.contact c
            join chain on c.merged_into_id = chain.id
            where c.project_id = current_project
        )
        select array_agg(chain.id) into ids from chain;
        delete from public.merge_record m
          where m.project_id = current_project
            and m.entity_type = 'contact'
            and (m.survivor_id = any (ids) or m.merged_id = any (ids));
        with removed as (
          delete from public.contact c
            where c.project_id = current_project
              and c.id = any (ids)
              and (c.id <> p_id or c.deleted_at is not null)
            returning c.id
        )
        select coalesce(bool_or(removed.id = p_id), false) into root_removed from removed;
        if not root_removed then
          raise exception 'записи нет в корзине проекта' using errcode = '${NOT_IN_TRASH}';
        end if;
        delete from public.change_log l
          where l.project_id = current_project
            and l.entity_type = 'contact'
            and l.entity_id = any (ids);
        return;`

/** Ветка сделки со скрытыми сделками — байт в байт как DEAL_BRANCH_MERGE в 0026_merge. */
const DEAL_BRANCH_0026 = `
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

/** purge_from_trash; `withMerge` — ветка контакта со скрытыми контактами, без него — как в 0026. */
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
      end if;${withMerge ? CONTACT_BRANCH_MERGE : CONTACT_BRANCH_0026}
      elsif p_entity_type = 'organization' then
        delete from public.organization o
          where o.id = p_id and o.project_id = current_project and o.deleted_at is not null;${DEAL_BRANCH_0026}
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

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table contact
      add column merged_into_id uuid,
      add column merged_at timestamptz,
      add column possible_duplicate_of uuid,
      add constraint contact_merged_into_fkey foreign key (project_id, merged_into_id)
        references contact (project_id, id),
      add constraint contact_possible_duplicate_of_fkey foreign key (project_id, possible_duplicate_of)
        references contact (project_id, id) on delete set null (possible_duplicate_of),
      add constraint contact_merged_pair check ((merged_into_id is null) = (merged_at is null)),
      add constraint contact_merged_not_self check (merged_into_id <> id),
      add constraint contact_duplicate_not_self check (possible_duplicate_of <> id)
  `.execute(db)
  await sql`
    create index contact_merged_into_idx on contact (project_id, merged_into_id)
      where merged_into_id is not null
  `.execute(db)
  await sql`grant insert (possible_duplicate_of) on contact to alpi_app`.execute(db)
  await sql`
    grant update (merged_into_id, merged_at, possible_duplicate_of) on contact to alpi_app
  `.execute(db)
  await sql`grant update (contact_id) on note to alpi_app`.execute(db)
  await sql`grant update (contact_id) on file to alpi_app`.execute(db)

  await sql.raw(purgeFunction(true)).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(purgeFunction(false)).execute(db)
  await sql`revoke update (contact_id) on file from alpi_app`.execute(db)
  await sql`revoke update (contact_id) on note from alpi_app`.execute(db)
  // Права на столбцы уходят вместе со столбцами.
  await sql`
    alter table contact
      drop column possible_duplicate_of,
      drop column merged_at,
      drop column merged_into_id
  `.execute(db)
}
