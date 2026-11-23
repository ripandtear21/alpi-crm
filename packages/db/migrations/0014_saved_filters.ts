import { type Kysely, sql } from 'kysely'

// Сохранённые фильтры списков и право «общие фильтры» (тикет crm-deals/12; spec.md MVP,
// раздел 3.2 — saved_filter; ответ владельца, пункт 32).
//
// - saved_filter — фильтр списка сделок, контактов или организаций (формат — packages/shared/
//   src/filters). Видимость: personal — только автор, team — участники команды team_id,
//   project — весь проект. Кто что может сохранить, решает API (apps/api/src/filters/saved.ts):
//   для команды и проекта нужно отдельное право shared_filters. Таблица держит форму: у
//   фильтра команды есть команда, у остальных — нет; команда — своего проекта (составной ключ)
//   и уходит вместе с её фильтрами.
// - Право shared_filters в шаблонах: руководитель и тимлид (администратор действует со всеми
//   правами каталога и так). Новые проекты получают шаблоны из функции
//   project_role_templates — её снимок обновляется здесь; у существующих проектов право
//   добавляется ролям из шаблонов «руководитель» и «тимлид». Роль, которую пользователь создал
//   сам, не меняется.
//
// Номер 0014: 0013 занят тикетом crm-deals/08 (быстрый поиск); если 08 сольётся позже, его
// миграция переименуется в 0015 (Kysely Migrator требует порядка имён).

/** Наибольший размер дерева условий в байтах (jsonb): защита от мусора в обход API. */
const MAX_FILTER_BYTES = 20_000

// Снимок шаблонов (как в 0004_roles): миграция не импортирует каталог прав из packages/shared.
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

/** Шаблоны ролей; `shared` — с правом shared_filters (после этой миграции) или без (до неё). */
function templates(shared: boolean) {
  const withShared = (list: string[]) => (shared ? [...list, 'shared_filters'] : list)
  return [
    template(
      'admin',
      'Адміністратор',
      Object.fromEntries(RESOURCES.map((r) => [r, ALL])),
      'all',
      withShared(['export', 'bulk_operations', 'transfer_deals', 'project_settings']),
    ),
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
      withShared(['bulk_operations', 'transfer_deals']),
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
      withShared(['transfer_deals']),
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
}

/** Функция триггера шаблонов нового проекта (тот же текст, что в 0004_roles, другой снимок). */
function templatesFunction(shared: boolean): string {
  const json = JSON.stringify(templates(shared)).replaceAll("'", "''")
  return `
    create or replace function public.project_role_templates()
      returns trigger
      language plpgsql
      set search_path = pg_catalog, pg_temp
    as $$
    begin
      insert into public.role (project_id, name, template_key, is_admin, permissions)
      select p.id, t.name, t.key, t.key = 'admin', t.permissions
      from (select new.id) p
      cross join jsonb_to_recordset('${json}'::jsonb) as t(key text, name text, permissions jsonb);
      return null;
    end
    $$
  `
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(`
      create table saved_filter (
        id uuid primary key default gen_random_uuid(),
        project_id uuid not null references project (id) on delete cascade,
        entity text not null check (entity in ('deals', 'contacts', 'organizations')),
        name text not null check (btrim(name) <> '' and char_length(name) <= 100),
        visibility text not null check (visibility in ('personal', 'team', 'project')),
        team_id uuid,
        owner_id text not null references "user" (id),
        filter jsonb not null
          check (jsonb_typeof(filter) = 'object' and pg_column_size(filter) <= ${MAX_FILTER_BYTES}),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint saved_filter_team check ((visibility = 'team') = (team_id is not null)),
        constraint saved_filter_team_fkey foreign key (project_id, team_id)
          references team (project_id, id) on delete cascade
      )
    `)
    .execute(db)
  await sql`create index saved_filter_entity_idx on saved_filter (project_id, entity, name)`.execute(
    db,
  )
  await sql`alter table saved_filter enable row level security`.execute(db)
  await sql`
    create policy project_isolation on saved_filter
      using (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
      with check (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
  `.execute(db)
  await sql`grant select, insert, update, delete on saved_filter to alpi_app`.execute(db)

  await sql.raw(templatesFunction(true)).execute(db)
  // Роль администратора не трогаем: её строку менять запрещает база (role_guard), а действует
  // она со всеми правами каталога.
  await sql`
    update role
    set permissions = jsonb_set(
      permissions,
      '{standalone}',
      coalesce(permissions -> 'standalone', '[]'::jsonb) || '["shared_filters"]'::jsonb
    )
    where template_key in ('head', 'teamlead')
      and not is_admin
      and not coalesce(permissions -> 'standalone', '[]'::jsonb) ? 'shared_filters'
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    update role
    set permissions = jsonb_set(
      permissions,
      '{standalone}',
      coalesce(permissions -> 'standalone', '[]'::jsonb) - 'shared_filters'
    )
    where not is_admin and coalesce(permissions -> 'standalone', '[]'::jsonb) ? 'shared_filters'
  `.execute(db)
  await sql.raw(templatesFunction(false)).execute(db)
  await sql`drop table saved_filter`.execute(db)
}
