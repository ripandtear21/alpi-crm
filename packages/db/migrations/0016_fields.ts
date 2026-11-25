import { type Kysely, sql } from 'kysely'

// Конструктор полей (тикет crm-fields/01; spec.md MVP, разделы 3.2 и 3.3): группы полей,
// описания пользовательских полей, варианты списков и колонка `custom` у сделки, контакта и
// организации. Все таблицы — данные проекта: project_id и row-level security по
// app.project_id, как в 0001_project_isolation.ts; ссылки — составные внешние ключи
// (project_id, id), так что группа, поле, вариант, воронка и этап другого проекта недоступны.
//
// - field_group — группа одной сущности (deal / contact / organization). Группу с полями (в том
//   числе архивными) удалить нельзя: внешний ключ поля без каскада.
// - field_definition — поле в группе той же сущности (ключ (project_id, group_id, entity)).
//   Код — формат, запрет кодов системных полей (снимок списка packages/shared/src/fields) и
//   уникальность в проекте и сущности среди живых и архивных полей. Триггер field_definition_guard:
//   код не меняется после первого значения (first_value_at, ставит тикет 02) и пока поле
//   отмечено «часто фильтруют»; тип не меняется после первого значения; поле с данными
//   удаляется окончательно не раньше чем через 30 дней после архивирования.
// - field_pipeline — воронки, в которых видно поле сделки (pipeline_visibility = 'selected');
//   'all' — во всех воронках проекта, строк нет. Ключ (project_id, field_id, visibility)
//   допускает строки только у поля с видимостью 'selected', а она — только у полей сделки.
// - field_required_stage — правило «обязательно с этапа» по воронкам (required = 'stages',
//   только у полей сделки): этап этой воронки или null — «выигрыш». Воронка правила — из тех,
//   где поле видно (триггеры field_required_stage_check, field_pipeline_keep_rules и проверка
//   в field_definition_guard); этап — действующий. Удалить этап с правилами нельзя (триггер
//   stage_keep_required_rules): API сначала переводит правила на следующий этап воронки
//   (apps/api/src/pipelines/pipelines.ts).
// - field_option — вариант списка со стабильным id; только у типов single_option и
//   multi_option. Удаления нет — только архив: у роли приложения нет DELETE (варианты уходят
//   каскадом вместе с полем при окончательном удалении).
// - custom jsonb у deal, contact, organization — значения полей по коду; здесь только колонка
//   и проверка «объект JSON» (решено без владельца, подтвердить): GIN-индекс и проверку значений
//   по типу добавляет тикет crm-fields/02. Окончательное удаление поля убирает его ключ из
//   custom всех записей (apps/api/src/fields/purge.ts).

/** SQLSTATE: код поля не меняется. */
const CODE_LOCKED = 'FD001'
/** SQLSTATE: тип поля не меняется. */
const TYPE_LOCKED = 'FD002'
/** SQLSTATE: правило «с этапа» для воронки, где поле не видно. */
const PIPELINE_HIDDEN = 'FD003'
/** SQLSTATE: правило на удалённом этапе / удаление этапа, на который ссылается правило. */
const STAGE_HAS_RULES = 'FD004'
/** SQLSTATE: варианты у поля без списка. */
const OPTIONS_NOT_ALLOWED = 'FD005'
/** SQLSTATE: окончательное удаление поля с данными раньше 30 дней после архивирования. */
const PURGE_TOO_EARLY = 'FD006'

const FIELD_TYPES = [
  'text',
  'long_text',
  'number',
  'money',
  'date',
  'time',
  'date_range',
  'single_option',
  'multi_option',
  'boolean',
  'phone',
  'email',
  'url',
  'address',
  'user',
]

// Снимок SYSTEM_FIELD_CODES из packages/shared/src/fields (миграция не импортирует пакет; что
// снимок не отстал, проверяет apps/api/src/fields/fields.test.ts).
const COMMON_SYSTEM_CODES = [
  'id',
  'project',
  'project_id',
  'custom',
  'created_at',
  'created_by',
  'updated_at',
  'deleted_at',
  'deleted_by',
  'archived',
  'archived_at',
  'notes',
  'files',
  'timeline',
  'history',
]
const SYSTEM_CODES: Record<string, string[]> = {
  deal: [
    ...COMMON_SYSTEM_CODES,
    'title',
    'pipeline',
    'pipeline_id',
    'stage',
    'stage_id',
    'status',
    'amount',
    'currency',
    'owner',
    'owner_id',
    'lost_reason',
    'lost_reason_id',
    'contact',
    'primary_contact',
    'primary_contact_id',
    'organization',
    'organization_id',
    'participants',
    'products',
    'won_at',
    'lost_at',
    'stage_changed_at',
    'expected_close_date',
  ],
  contact: [
    ...COMMON_SYSTEM_CODES,
    'name',
    'first_name',
    'last_name',
    'phone',
    'phones',
    'email',
    'emails',
    'organization',
    'organization_id',
    'language',
    'owner',
    'possible_duplicate',
    'deals',
  ],
  organization: [
    ...COMMON_SYSTEM_CODES,
    'name',
    'address',
    'website',
    'owner',
    'contacts',
    'deals',
  ],
}

const list = (values: string[]) => values.map((v) => `'${v}'`).join(', ')

/** Условие «код не системный для своей сущности». */
const notSystemCode = Object.entries(SYSTEM_CODES)
  .map(([entity, codes]) => `not (entity = '${entity}' and code in (${list(codes)}))`)
  .join(' and ')

/** Проверка названия: украинское обязательно, русское — нет. */
const NAMES = `
  name_uk text not null check (btrim(name_uk) <> '' and char_length(name_uk) <= 100),
  name_ru text check (name_ru is null or (btrim(name_ru) <> '' and char_length(name_ru) <= 100))
`

const projectTables = [
  'field_group',
  'field_definition',
  'field_pipeline',
  'field_required_stage',
  'field_option',
] as const

const recordTables = ['deal', 'contact', 'organization'] as const

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const table of recordTables) {
    await sql
      .raw(`
        alter table ${table}
          add column custom jsonb not null default '{}'
            constraint ${table}_custom_object check (jsonb_typeof(custom) = 'object')
      `)
      .execute(db)
    // Значения полей пишет API (тикет 02), окончательное удаление поля убирает ключи.
    await sql.raw(`grant insert (custom), update (custom) on ${table} to alpi_app`).execute(db)
  }

  await sql
    .raw(`
      create table field_group (
        id uuid primary key default gen_random_uuid(),
        project_id uuid not null references project (id) on delete cascade,
        entity text not null check (entity in ('deal', 'contact', 'organization')),
        ${NAMES},
        position integer not null default 0,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        created_by text,
        unique (project_id, id, entity)
      )
    `)
    .execute(db)
  await sql`create index field_group_entity_idx on field_group (project_id, entity, position)`.execute(
    db,
  )

  await sql
    .raw(`
      create table field_definition (
        id uuid primary key default gen_random_uuid(),
        project_id uuid not null references project (id) on delete cascade,
        entity text not null check (entity in ('deal', 'contact', 'organization')),
        group_id uuid not null,
        code text not null,
        ${NAMES},
        type text not null check (type in (${list(FIELD_TYPES)})),
        position integer not null default 0,
        pipeline_visibility text not null default 'all'
          check (pipeline_visibility in ('all', 'selected')),
        required text not null default 'none' check (required in ('none', 'always', 'stages')),
        is_important boolean not null default false,
        is_frequently_filtered boolean not null default false,
        first_value_at timestamptz,
        archived_at timestamptz,
        purge_requested_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        created_by text,
        constraint field_definition_code_format check (code ~ '^[a-z][a-z0-9_]{0,62}$'),
        constraint field_definition_code_not_system check (${notSystemCode}),
        constraint field_definition_code_key unique (project_id, entity, code),
        constraint field_definition_deal_only
          check (entity = 'deal' or (pipeline_visibility = 'all' and required <> 'stages')),
        constraint field_definition_purge_archived
          check (purge_requested_at is null or archived_at is not null),
        unique (project_id, id),
        unique (project_id, id, pipeline_visibility),
        unique (project_id, id, required),
        foreign key (project_id, group_id, entity) references field_group (project_id, id, entity)
      )
    `)
    .execute(db)
  await sql`create index field_definition_group_idx on field_definition (project_id, group_id, position)`.execute(
    db,
  )

  await sql`
    create table field_pipeline (
      project_id uuid not null references project (id) on delete cascade,
      field_id uuid not null,
      pipeline_id uuid not null,
      visibility text not null default 'selected' check (visibility = 'selected'),
      primary key (field_id, pipeline_id),
      foreign key (project_id, field_id, visibility)
        references field_definition (project_id, id, pipeline_visibility) on delete cascade,
      foreign key (project_id, pipeline_id) references pipeline (project_id, id) on delete cascade
    )
  `.execute(db)

  await sql`
    create table field_required_stage (
      project_id uuid not null references project (id) on delete cascade,
      field_id uuid not null,
      pipeline_id uuid not null,
      -- Этап, с которого поле обязательно; null — только при выигрыше.
      stage_id uuid,
      required text not null default 'stages' check (required = 'stages'),
      primary key (field_id, pipeline_id),
      foreign key (project_id, field_id, required)
        references field_definition (project_id, id, required) on delete cascade,
      foreign key (project_id, pipeline_id) references pipeline (project_id, id) on delete cascade,
      foreign key (project_id, pipeline_id, stage_id)
        references stage (project_id, pipeline_id, id) on delete cascade
    )
  `.execute(db)
  await sql`create index field_required_stage_stage_idx on field_required_stage (stage_id)`.execute(
    db,
  )

  await sql
    .raw(`
      create table field_option (
        id uuid primary key default gen_random_uuid(),
        project_id uuid not null references project (id) on delete cascade,
        field_id uuid not null,
        ${NAMES},
        position integer not null default 0,
        archived_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        created_by text,
        foreign key (project_id, field_id) references field_definition (project_id, id)
          on delete cascade
      )
    `)
    .execute(db)
  await sql`create index field_option_field_idx on field_option (field_id, position)`.execute(db)

  // Поле: код, тип, окончательное удаление, видимость при правилах «с этапа».
  await sql
    .raw(`
      create function public.field_definition_guard()
        returns trigger
        language plpgsql
        set search_path = pg_catalog, pg_temp
      as $$
      begin
        if tg_op = 'DELETE' then
          -- Удаление вместе с проектом (каскад) разрешено.
          if old.first_value_at is not null
            and (old.archived_at is null or old.archived_at > now() - interval '30 days')
            and exists (select from public.project p where p.id = old.project_id) then
            raise exception 'поле с данными удаляется окончательно не раньше чем через 30 дней после архивирования'
              using errcode = '${PURGE_TOO_EARLY}';
          end if;
          return old;
        end if;
        if new.code is distinct from old.code
          and (old.first_value_at is not null or old.is_frequently_filtered) then
          raise exception 'код поля не меняется после первого значения и при отметке «часто фильтруют»'
            using errcode = '${CODE_LOCKED}';
        end if;
        if new.type is distinct from old.type then
          if old.first_value_at is not null then
            raise exception 'тип поля со значениями не меняется' using errcode = '${TYPE_LOCKED}';
          end if;
          if new.type not in ('single_option', 'multi_option')
            and exists (select from public.field_option o where o.field_id = new.id) then
            raise exception 'у поля есть варианты: тип без вариантов не ставится'
              using errcode = '${OPTIONS_NOT_ALLOWED}';
          end if;
        end if;
        if new.pipeline_visibility = 'selected' and old.pipeline_visibility <> 'selected'
          and exists (select from public.field_required_stage r where r.field_id = new.id) then
          raise exception 'правило «с этапа» — только для воронки, где поле видно'
            using errcode = '${PIPELINE_HIDDEN}';
        end if;
        return new;
      end
      $$
    `)
    .execute(db)
  await sql`
    create trigger field_definition_guard before update or delete on field_definition
      for each row execute function public.field_definition_guard()
  `.execute(db)

  await sql
    .raw(`
      create function public.field_option_type()
        returns trigger
        language plpgsql
        set search_path = pg_catalog, pg_temp
      as $$
      begin
        if not exists (
          select from public.field_definition f
          where f.id = new.field_id and f.type in ('single_option', 'multi_option')
        ) then
          raise exception 'варианты есть только у полей «один вариант» и «несколько вариантов»'
            using errcode = '${OPTIONS_NOT_ALLOWED}';
        end if;
        return new;
      end
      $$
    `)
    .execute(db)
  await sql`
    create trigger field_option_type before insert or update of field_id on field_option
      for each row execute function public.field_option_type()
  `.execute(db)

  await sql
    .raw(`
      create function public.field_required_stage_check()
        returns trigger
        language plpgsql
        set search_path = pg_catalog, pg_temp
      as $$
      begin
        if new.stage_id is not null and not exists (
          select from public.stage s where s.id = new.stage_id and s.deleted_at is null
        ) then
          raise exception 'этап правила удалён' using errcode = '${STAGE_HAS_RULES}';
        end if;
        if exists (
          select from public.field_definition f
          where f.id = new.field_id and f.pipeline_visibility = 'selected'
        ) and not exists (
          select from public.field_pipeline p
          where p.field_id = new.field_id and p.pipeline_id = new.pipeline_id
        ) then
          raise exception 'правило «с этапа» — только для воронки, где поле видно'
            using errcode = '${PIPELINE_HIDDEN}';
        end if;
        return new;
      end
      $$
    `)
    .execute(db)
  await sql`
    create trigger field_required_stage_check before insert or update on field_required_stage
      for each row execute function public.field_required_stage_check()
  `.execute(db)

  // Воронка уходит из видимости поля, а правило на неё осталось. Каскад (удаление поля или
  // воронки) разрешён: тогда поля или воронки уже нет.
  await sql
    .raw(`
      create function public.field_pipeline_keep_rules()
        returns trigger
        language plpgsql
        set search_path = pg_catalog, pg_temp
      as $$
      begin
        if exists (
          select from public.field_required_stage r
          where r.field_id = old.field_id and r.pipeline_id = old.pipeline_id
        )
          and exists (select from public.field_definition f where f.id = old.field_id)
          and exists (select from public.pipeline p where p.id = old.pipeline_id) then
          raise exception 'правило «с этапа» — только для воронки, где поле видно'
            using errcode = '${PIPELINE_HIDDEN}';
        end if;
        return case when tg_op = 'DELETE' then old else new end;
      end
      $$
    `)
    .execute(db)
  await sql`
    create trigger field_pipeline_keep_rules before update or delete on field_pipeline
      for each row execute function public.field_pipeline_keep_rules()
  `.execute(db)

  await sql
    .raw(`
      create function public.stage_keep_required_rules()
        returns trigger
        language plpgsql
        set search_path = pg_catalog, pg_temp
      as $$
      begin
        if new.deleted_at is not null and old.deleted_at is null and exists (
          select from public.field_required_stage r where r.stage_id = new.id
        ) then
          raise exception 'на этап ссылается правило обязательности поля: сначала перенесите правило'
            using errcode = '${STAGE_HAS_RULES}';
        end if;
        return new;
      end
      $$
    `)
    .execute(db)
  await sql`
    create trigger stage_keep_required_rules before update of deleted_at on stage
      for each row execute function public.stage_keep_required_rules()
  `.execute(db)

  for (const table of projectTables) {
    await sql`alter table ${sql.table(table)} enable row level security`.execute(db)
    await sql`
      create policy project_isolation on ${sql.table(table)}
        using (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
        with check (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
    `.execute(db)
  }
  await sql`grant select, insert, update, delete on field_group, field_definition, field_pipeline, field_required_stage to alpi_app`.execute(
    db,
  )
  // Вариант не удаляется — только архив.
  await sql`grant select, insert, update on field_option to alpi_app`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop trigger stage_keep_required_rules on stage`.execute(db)
  for (const table of [...projectTables].reverse()) {
    await sql`drop table ${sql.table(table)}`.execute(db)
  }
  for (const fn of [
    'stage_keep_required_rules',
    'field_pipeline_keep_rules',
    'field_required_stage_check',
    'field_option_type',
    'field_definition_guard',
  ]) {
    await sql.raw(`drop function public.${fn}()`).execute(db)
  }
  for (const table of [...recordTables].reverse()) {
    await sql.raw(`alter table ${table} drop column custom`).execute(db)
  }
}
