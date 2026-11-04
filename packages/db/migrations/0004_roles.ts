import { type Kysely, sql } from 'kysely'

// Роли проекта и их права (тикет crm-foundation/05; spec.md, раздел 4).
//
// - role — роль проекта (row-level security по проекту, как project_member). Права роли —
//   один JSONB в форме RolePermissions из packages/shared/src/permissions.ts. Форму проверяет
//   API (parseRolePermissions) перед каждой записью; база проверяет только, что это объект.
// - У участника проекта ровно одна роль: project_member.role_id NOT NULL, роль — того же
//   проекта (составной внешний ключ).
// - Четыре роли-шаблона создаются триггером на вставку проекта: их получает любой путь
//   создания проекта — create_project, служебный createProject, ручной insert.
// - Защиты — в базе, а не в коде API, чтобы их не обошёл ни один путь записи (API, служебный
//   скрипт, будущий импорт):
//   * роль «администратор» (is_admin) не удаляется и не меняется — ни права, ни название;
//     признак is_admin не снимается и не ставится другой роли (одна на проект);
//   * у проекта, где есть участники-администраторы, нельзя снять роль администратора или
//     участие с последнего из них.
//   Ошибки защит — свои SQLSTATE: API превращает их в 409.
//
// Плюс долг тикета 04: роль приложения больше не может менять "user".role (роль владельца
// системы в плагине admin), см. конец up().

/** SQLSTATE защит ролей: API (apps/api/src/roles/roles.ts) различает их по коду. */
const ADMIN_ROLE_LOCKED = 'AR001'
const LAST_ADMIN = 'AR002'

// Снимок шаблонов на момент миграции. Миграция не импортирует ROLE_TEMPLATES из
// packages/shared: старая миграция не должна менять поведение, когда меняется каталог прав.
// Новые значения шаблонов — новой миграцией; тест apps/api/src/roles/roles.test.ts сверяет
// роли нового проекта с ROLE_TEMPLATES.
const ALL = ['view', 'create', 'edit', 'delete']
const VCE = ['view', 'create', 'edit']
const RESOURCES = [
  'deals',
  'contacts',
  'organizations',
  'tasks',
  'payments',
  'products',
  'reports',
  'pipelines',
  'fields',
  'users_roles',
  'integrations',
  'trash',
]
const SCOPED = ['deals', 'contacts', 'tasks', 'payments']

function template(
  key: string,
  name: string,
  actions: Record<string, string[]>,
  scope: string,
  standalone: string[],
) {
  return {
    key,
    name,
    permissions: {
      actions: Object.fromEntries(RESOURCES.map((r) => [r, actions[r] ?? []])),
      scopes: Object.fromEntries(SCOPED.map((r) => [r, { read: scope, write: scope }])),
      standalone,
      fieldGroups: {},
    },
  }
}

const TEMPLATES = [
  template('admin', 'Адміністратор', Object.fromEntries(RESOURCES.map((r) => [r, ALL])), 'all', [
    'export',
    'bulk_operations',
    'transfer_deals',
    'project_settings',
  ]),
  template(
    'head',
    'Керівник',
    {
      deals: ALL,
      contacts: ALL,
      tasks: ALL,
      payments: ALL,
      organizations: ALL,
      products: ['view'],
      reports: ['view'],
      trash: ['view', 'edit'],
    },
    'all',
    ['bulk_operations', 'transfer_deals'],
  ),
  template(
    'teamlead',
    'Тімлід',
    {
      deals: VCE,
      contacts: VCE,
      tasks: VCE,
      payments: VCE,
      organizations: VCE,
      products: ['view'],
      reports: ['view'],
    },
    'team',
    ['transfer_deals'],
  ),
  template(
    'manager',
    'Менеджер',
    {
      deals: VCE,
      contacts: VCE,
      tasks: VCE,
      payments: VCE,
      organizations: VCE,
      products: ['view'],
    },
    'own',
    [],
  ),
]

/** Вставка ролей-шаблонов для проектов из `projects` (выражение со столбцом id). */
function insertTemplates(projects: string): string {
  const json = JSON.stringify(TEMPLATES).replaceAll("'", "''")
  return `
    insert into public.role (project_id, name, template_key, is_admin, permissions)
    select p.id, t.name, t.key, t.key = 'admin', t.permissions
    from ${projects} p
    cross join jsonb_to_recordset('${json}'::jsonb) as t(key text, name text, permissions jsonb)
  `
}

/** Столбцы "user", которые роль приложения может менять (всё, кроме id и role). */
const USER_UPDATABLE_COLUMNS = [
  'name',
  'email',
  'email_verified',
  'image',
  'created_at',
  'updated_at',
  'two_factor_enabled',
  'banned',
  'ban_reason',
  'ban_expires',
]

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table role (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references project (id) on delete cascade,
      name text not null check (btrim(name) <> '' and char_length(name) <= 60),
      -- Шаблон-источник: интерфейс переводит название шаблона по ключу.
      template_key text check (template_key in ('admin', 'head', 'teamlead', 'manager')),
      is_admin boolean not null default false,
      permissions jsonb not null check (jsonb_typeof(permissions) = 'object'),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by text,
      unique (project_id, id),
      unique (project_id, name),
      check (not is_admin or template_key = 'admin')
    )
  `.execute(db)
  await sql`create unique index role_one_admin_per_project on role (project_id) where is_admin`.execute(
    db,
  )

  await sql`alter table role enable row level security`.execute(db)
  await sql`
    create policy project_isolation on role
      using (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
      with check (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
  `.execute(db)
  await sql`grant select, insert, update, delete on role to alpi_app`.execute(db)

  // Шаблоны для каждого нового проекта. Проекты вставляет только владелец таблиц (служебная
  // роль или функция create_project с его правами), поэтому функция триггера — обычная.
  await sql
    .raw(`
      create function public.project_role_templates()
        returns trigger
        language plpgsql
        set search_path = pg_catalog, pg_temp
      as $$
      begin
        ${insertTemplates('(select new.id) ')};
        return null;
      end
      $$
    `)
    .execute(db)
  await sql`
    create trigger project_role_templates after insert on project
      for each row execute function public.project_role_templates()
  `.execute(db)

  // Перенос: у существующих проектов появляются шаблоны, у существующих участников (создатели
  // проектов) — роль администратора своего проекта.
  await sql.raw(insertTemplates('public.project')).execute(db)
  await sql`
    update project_member m set role_id = r.id
    from role r
    where r.project_id = m.project_id and r.is_admin and m.role_id is null
  `.execute(db)
  await sql`alter table project_member alter column role_id set not null`.execute(db)
  // Роль участника — только роль его проекта. Удалить роль, у которой есть участники, нельзя
  // (NO ACTION: при удалении проекта каскад убирает и участников, и роли — проверка в конце).
  await sql`
    alter table project_member
      add constraint project_member_role_fkey foreign key (project_id, role_id)
        references role (project_id, id)
  `.execute(db)
  await sql`create index project_member_role_idx on project_member (project_id, role_id)`.execute(
    db,
  )

  // Роль «администратор» не удаляется и не меняется. Признак is_admin, шаблон и проект роли не
  // меняются ни у какой роли. Удаление вместе с проектом (каскад) разрешено.
  await sql`
    create function public.role_guard()
      returns trigger
      language plpgsql
      set search_path = pg_catalog, pg_temp
    as $$
    begin
      if tg_op = 'DELETE' then
        if old.is_admin and exists (select from public.project p where p.id = old.project_id) then
          raise exception 'роль «администратор» нельзя удалить'
            using errcode = ${sql.lit(ADMIN_ROLE_LOCKED)};
        end if;
        return old;
      end if;
      if new.is_admin is distinct from old.is_admin
        or new.template_key is distinct from old.template_key
        or new.project_id is distinct from old.project_id then
        raise exception 'признак администратора, шаблон и проект роли не меняются'
          using errcode = ${sql.lit(ADMIN_ROLE_LOCKED)};
      end if;
      if old.is_admin and (new.permissions is distinct from old.permissions
        or new.name is distinct from old.name) then
        raise exception 'роль «администратор» нельзя изменить'
          using errcode = ${sql.lit(ADMIN_ROLE_LOCKED)};
      end if;
      return new;
    end
    $$
  `.execute(db)
  await sql`
    create trigger role_guard before update or delete on role
      for each row execute function public.role_guard()
  `.execute(db)

  // Последний администратор проекта не теряет роль и участие. Проверка после изменения строки:
  // перестановка ролей одним запросом (A — администратор, B — нет, затем наоборот) проходит.
  // Блокировка строки роли администратора выстраивает в очередь параллельные снятия в одном
  // проекте: без неё две транзакции сняли бы двух последних администраторов, и каждая видела
  // бы второго ещё на месте. FOR NO KEY UPDATE не мешает проверкам внешних ключей (KEY SHARE).
  // Обычная функция (не SECURITY DEFINER): изменяют участников только в контексте их проекта,
  // и row-level security показывает ей как раз участников этого проекта.
  await sql`
    create function public.project_member_keep_admin()
      returns trigger
      language plpgsql
      set search_path = pg_catalog, pg_temp
    as $$
    declare
      admin_role uuid;
    begin
      -- Проект удаляется целиком — защищать нечего.
      if not exists (select from public.project p where p.id = old.project_id) then
        return null;
      end if;
      select r.id into admin_role
        from public.role r
        where r.project_id = old.project_id and r.is_admin
        for no key update;
      if admin_role is null or old.role_id is distinct from admin_role then
        return null;
      end if;
      if not exists (
        select from public.project_member m
        where m.project_id = old.project_id and m.role_id = admin_role
      ) then
        raise exception 'в проекте должен остаться хотя бы один администратор'
          using errcode = ${sql.lit(LAST_ADMIN)};
      end if;
      return null;
    end
    $$
  `.execute(db)
  await sql`
    create trigger project_member_keep_admin after update or delete on project_member
      for each row execute function public.project_member_keep_admin()
  `.execute(db)

  // Создатель проекта получает роль администратора; шаблоны уже создал триггер на project.
  // Остальное — как в 0003_projects: проверка владельца системы, search_path, имена со схемой.
  await sql`
    create or replace function public.create_project(p_code text, p_name text, p_creator_id text)
      returns public.project
      language plpgsql
      security definer
      set search_path = pg_catalog, pg_temp
    as $$
    declare
      created public.project;
      admin_role uuid;
    begin
      if not exists (
        select from public."user" u
        where u.id = p_creator_id
          and not u.banned
          and 'admin' = any (
            select btrim(r) from unnest(string_to_array(coalesce(u.role, ''), ',')) r
          )
      ) then
        raise exception 'создавать проекты может только владелец системы'
          using errcode = 'insufficient_privilege';
      end if;

      insert into public.project (code, name)
        values (p_code, p_name)
        returning * into created;
      select r.id into strict admin_role
        from public.role r
        where r.project_id = created.id and r.is_admin;
      insert into public.project_member (project_id, user_id, role_id, created_by)
        values (created.id, p_creator_id, admin_role, p_creator_id);
      return created;
    end
    $$
  `.execute(db)
  await sql`revoke all on function public.create_project(text, text, text) from public`.execute(db)
  await sql`grant execute on function public.create_project(text, text, text) to alpi_app`.execute(
    db,
  )

  // Долг тикета 04: с правом update на "user".role ошибка в API (например, SQL-инъекция) дала
  // бы сделать любого пользователя владельцем системы. Better Auth в наших сценариях роль не
  // меняет: владельца создаёт CLI вставкой (insert остаётся), бан и его снятие по сроку пишут
  // banned/ban_reason/ban_expires — они остаются. Эндпоинт плагина admin set-role роли
  // приложения теперь недоступен: роль владельца выдаёт служебный доступ.
  await sql`revoke update on "user" from alpi_app`.execute(db)
  await sql
    .raw(`grant update (${USER_UPDATABLE_COLUMNS.join(', ')}) on "user" to alpi_app`)
    .execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(`revoke update (${USER_UPDATABLE_COLUMNS.join(', ')}) on "user" from alpi_app`)
    .execute(db)
  await sql`grant update on "user" to alpi_app`.execute(db)

  // create_project из 0003_projects: участник без роли.
  await sql`
    create or replace function public.create_project(p_code text, p_name text, p_creator_id text)
      returns public.project
      language plpgsql
      security definer
      set search_path = pg_catalog, pg_temp
    as $$
    declare
      created public.project;
    begin
      if not exists (
        select from public."user" u
        where u.id = p_creator_id
          and not u.banned
          and 'admin' = any (
            select btrim(r) from unnest(string_to_array(coalesce(u.role, ''), ',')) r
          )
      ) then
        raise exception 'создавать проекты может только владелец системы'
          using errcode = 'insufficient_privilege';
      end if;

      insert into public.project (code, name)
        values (p_code, p_name)
        returning * into created;
      insert into public.project_member (project_id, user_id, created_by)
        values (created.id, p_creator_id, p_creator_id);
      return created;
    end
    $$
  `.execute(db)

  await sql`drop trigger project_member_keep_admin on project_member`.execute(db)
  await sql`drop function public.project_member_keep_admin()`.execute(db)
  await sql`drop trigger project_role_templates on project`.execute(db)
  await sql`drop function public.project_role_templates()`.execute(db)
  await sql`drop index project_member_role_idx`.execute(db)
  await sql`alter table project_member drop constraint project_member_role_fkey`.execute(db)
  await sql`alter table project_member alter column role_id drop not null`.execute(db)
  await sql`update project_member set role_id = null`.execute(db)
  await sql`drop table role`.execute(db)
  await sql`drop function public.role_guard()`.execute(db)
}
