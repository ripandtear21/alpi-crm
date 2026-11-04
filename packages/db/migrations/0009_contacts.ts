import { type Kysely, sql } from 'kysely'

// Контакты, организации и журнал изменений (тикет crm-deals/03; spec.md, разделы 3.2 и 4).
//
// - organization — компания проекта. Удаляется в корзину (deleted_at); её контакты сохраняют
//   связь, пока организация не удалена окончательно (ответ владельца, пункт 35).
// - contact — человек в проекте. Организация не больше одной: contact.organization_id — один
//   столбец, связи «многие ко многим» нет. Организация — только своего проекта (составной
//   внешний ключ); окончательное удаление организации обнуляет у контактов только
//   organization_id. «Возможный дубль» — отметка, слияние контактов — в эпике приёма.
//   Ответственного у контакта нет: охват «свои» считается от created_by (apps/api/src/contacts).
// - contact_phone, contact_email — несколько на контакт, не больше одного «основного»
//   (частичный уникальный индекс). Телефон хранится в E.164, email — в нижнем регистре
//   (нормализует packages/shared/src/phone.ts, база проверяет форму). Индексы (project_id,
//   phone) и (project_id, email) — ключи поиска контакта. Один номер у разных контактов база не
//   запрещает: совпадение проверяет API, а дубли, пришедшие из приёма, сливает эпик приёма.
// - change_log — журнал изменений «сущность, id, кто, когда, поле, было → стало» для
//   контактов и организаций, дальше — сделок и платежей. Только добавление: у роли приложения
//   нет UPDATE, DELETE и TRUNCATE. Единственный путь удаления — purge_from_trash ниже.
// - Окончательное удаление контакта и организации — только функцией purge_from_trash, вместе
//   с историей записи. История остаётся привязана к id, поэтому роль приложения не выбирает id
//   сама: INSERT в contact и organization — по списку столбцов без id (id даёт default), UPDATE —
//   только столбцов данных (не id и не project_id), DELETE нет. Иначе запись можно было бы
//   отправить в корзину, удалить с историей и вставить заново с тем же id — живая запись без
//   истории. Удалить запись с историей можно, вернуть её с тем же id — нет.
//
// У всех таблиц project_id и политика row-level security, как в 0001_project_isolation.

const projectTables = [
  'organization',
  'contact',
  'contact_phone',
  'contact_email',
  'change_log',
] as const

/** SQLSTATE: окончательно удаляют запись, которой нет в корзине текущего проекта. */
const NOT_IN_TRASH = 'CL001'

/** Столбцы, которые роль приложения задаёт при вставке: без id, времени и отметки корзины. */
const INSERTABLE = {
  organization: 'project_id, name, address, website, created_by',
  contact:
    'project_id, first_name, last_name, language, organization_id, possible_duplicate, created_by',
} as const

/** Столбцы, которые роль приложения может менять (id и project_id — нет). */
const UPDATABLE = {
  organization: 'name, address, website, updated_at, deleted_at, deleted_by',
  contact:
    'first_name, last_name, language, organization_id, possible_duplicate, updated_at, deleted_at, deleted_by',
} as const

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table organization (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references project (id) on delete cascade,
      name text not null check (btrim(name) <> '' and char_length(name) <= 200),
      address text check (char_length(address) <= 500),
      website text check (char_length(website) <= 500),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by text,
      deleted_at timestamptz,
      deleted_by text,
      unique (project_id, id)
    )
  `.execute(db)
  await sql`create index organization_list_idx on organization (project_id, name)`.execute(db)

  await sql`
    create table contact (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references project (id) on delete cascade,
      first_name text not null check (btrim(first_name) <> '' and char_length(first_name) <= 100),
      last_name text check (char_length(last_name) <= 100),
      -- Язык общения с клиентом; null — не указан.
      language text check (language in ('uk', 'ru')),
      organization_id uuid,
      possible_duplicate boolean not null default false,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      -- Кто создал: от него считается охват «свои» и «команда».
      created_by text,
      deleted_at timestamptz,
      deleted_by text,
      unique (project_id, id),
      constraint contact_organization_fkey foreign key (project_id, organization_id)
        references organization (project_id, id) on delete set null (organization_id)
    )
  `.execute(db)
  await sql`create index contact_list_idx on contact (project_id, created_at desc, id desc)`.execute(
    db,
  )
  await sql`create index contact_created_by_idx on contact (project_id, created_by)`.execute(db)
  await sql`create index contact_organization_idx on contact (project_id, organization_id)`.execute(
    db,
  )

  await sql`
    create table contact_phone (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references project (id) on delete cascade,
      contact_id uuid not null,
      -- E.164: «+», код страны, до 15 цифр.
      phone text not null check (phone ~ '^\\+[1-9][0-9]{6,14}$'),
      is_primary boolean not null default false,
      created_at timestamptz not null default now(),
      unique (contact_id, phone),
      foreign key (project_id, contact_id) references contact (project_id, id) on delete cascade
    )
  `.execute(db)
  await sql`
    create unique index contact_phone_primary_idx on contact_phone (contact_id) where is_primary
  `.execute(db)
  await sql`create index contact_phone_search_idx on contact_phone (project_id, phone)`.execute(db)

  await sql`
    create table contact_email (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references project (id) on delete cascade,
      contact_id uuid not null,
      email text not null check (email = lower(btrim(email)) and char_length(email) <= 254
        and email like '%_@_%'),
      is_primary boolean not null default false,
      created_at timestamptz not null default now(),
      unique (contact_id, email),
      foreign key (project_id, contact_id) references contact (project_id, id) on delete cascade
    )
  `.execute(db)
  await sql`
    create unique index contact_email_primary_idx on contact_email (contact_id) where is_primary
  `.execute(db)
  await sql`create index contact_email_search_idx on contact_email (project_id, email)`.execute(db)

  await sql`
    create table change_log (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references project (id) on delete cascade,
      occurred_at timestamptz not null default now(),
      -- Кто изменил. null — система. Пользователей не удаляют, а банят: ссылка не обрывается.
      actor_id text references "user" (id),
      entity_type text not null check (entity_type ~ '^[a-z][a-z_]*$'
        and char_length(entity_type) <= 40),
      entity_id uuid not null,
      -- Поле в именах API: firstName, phones, deletedAt…
      field text not null check (field ~ '^[a-zA-Z][a-zA-Z0-9_]*$' and char_length(field) <= 60),
      -- Было и стало: значение JSON (строка, число, список, null).
      before jsonb,
      after jsonb
    )
  `.execute(db)
  // История записи: новые сверху.
  await sql`
    create index change_log_entity_idx
      on change_log (project_id, entity_type, entity_id, occurred_at desc, id desc)
  `.execute(db)

  for (const table of projectTables) {
    await sql`alter table ${sql.table(table)} enable row level security`.execute(db)
    await sql`
      create policy project_isolation on ${sql.table(table)}
        using (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
        with check (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
    `.execute(db)
  }
  // contact и organization: чтение, вставка и изменение только столбцов данных (id не задать и не
  // сменить); удаление — только purge_from_trash. Телефоны и email контакт заменяет удалением и
  // вставкой: их id ни с чем не связаны.
  for (const table of ['organization', 'contact'] as const) {
    await sql`grant select on ${sql.table(table)} to alpi_app`.execute(db)
    await sql.raw(`grant insert (${INSERTABLE[table]}) on ${table} to alpi_app`).execute(db)
    await sql.raw(`grant update (${UPDATABLE[table]}) on ${table} to alpi_app`).execute(db)
  }
  for (const table of ['contact_phone', 'contact_email'] as const) {
    await sql`grant select, insert, update, delete on ${sql.table(table)} to alpi_app`.execute(db)
  }
  await sql`grant select, insert on change_log to alpi_app`.execute(db)

  // Окончательное удаление контакта или организации из корзины (в том числе по запросу
  // человека, spec.md, раздел 9.5) — одним действием вместе с её историей: в «было → стало»
  // лежат имена, телефоны и email. Удаляет только запись текущего проекта, уже лежащую в
  // корзине; телефоны и email уходят каскадом, у контактов удалённой организации обнуляется
  // organization_id. Удалить живую запись или стереть историю отдельно от записи нельзя.
  // SECURITY DEFINER — правила как у system_audit_events (0005_audit): закреплённый
  // search_path, права выполнения только у alpi_app.
  await sql
    .raw(`
      create function public.purge_from_trash(p_entity_type text, p_id uuid)
        returns void
        language plpgsql
        security definer
        set search_path = pg_catalog, pg_temp
      as $$
      declare
        current_project uuid := nullif(current_setting('app.project_id', true), '')::uuid;
      begin
        if current_project is null then
          raise exception 'проект не выставлен' using errcode = 'insufficient_privilege';
        end if;
        if p_entity_type = 'contact' then
          delete from public.contact c
            where c.id = p_id and c.project_id = current_project and c.deleted_at is not null;
        elsif p_entity_type = 'organization' then
          delete from public.organization o
            where o.id = p_id and o.project_id = current_project and o.deleted_at is not null;
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
    `)
    .execute(db)
  await sql`revoke all on function public.purge_from_trash(text, uuid) from public`.execute(db)
  await sql`grant execute on function public.purge_from_trash(text, uuid) to alpi_app`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop function public.purge_from_trash(text, uuid)`.execute(db)
  for (const table of [...projectTables].reverse()) {
    await sql`drop table ${sql.table(table)}`.execute(db)
  }
}
