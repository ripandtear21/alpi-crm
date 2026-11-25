import { type Kysely, sql } from 'kysely'

// Пользовательские поля в фильтрах и на карточке канбана (тикет crm-fields/07).
//
// Ускорение «часто фильтруют» — отдельная таблица значений custom_value, а не индекс по
// выражению над `custom` (решено без владельца, подтвердить). Причина — row-level security:
// под ролью приложения alpi_app условие запроса, функции которого не помечены LEAKPROOF,
// PostgreSQL применяет только после политики проекта и не берёт для него индекс. Не LEAKPROOF
// `->>`, `@>` и даже сравнение numeric; LEAKPROOF — сравнения text, uuid, float8, date, bool.
// Пометить свою функцию LEAKPROOF может только суперпользователь, а строить индекс по выражению
// над deal (CREATE INDEX CONCURRENTLY) — только владелец таблиц, и процессу API пришлось бы
// держать его пароль. Поэтому:
// - custom_value — копия значений полей с индексом: по строке на значение (у «несколько
//   вариантов» — на каждый вариант; у интервала дат — начало и конец отдельными строками),
//   текст в value_text, число и сумма денег в value_number (float8). Фильтр ищет по ней
//   сравнениями text / float8 / uuid — их PostgreSQL применяет по индексу и под RLS, а
//   условие по `custom` (источник правды) проверяет найденные строки ещё раз
//   (apps/api/src/filters/custom.ts);
// - копию держит триггер custom_value_sync на deal, contact, organization: любая запись
//   `custom` (API, массовые операции, фоновые задачи) обновляет строки своей записи;
// - field_definition.index_state — состояние копии у поля: building — фоновая задача
//   (apps/api/src/jobs/field-index.ts) заполняет её для старых записей; ready — готова,
//   фильтр ею пользуется; failed — задача упала, текст ошибки в index_error. Ставит и снимает
//   состояние триггер field_definition_index: отметка «часто фильтруют» у действующего поля —
//   building, снятие отметки, архив и запрос окончательного удаления — null и строки поля
//   удаляются; окончательное удаление уносит их каскадом;
// - index_token — новая копия при каждой постановке building: задача, начатая для прежней,
//   свою работу не продолжает и «готово» не ставит.
//
// Карточка канбана: pipeline_card_field — до 3 полей сделки, которые карточка показывает в
// этой воронке (позиция 1…3: четвёртое поле база не примет).

/** Наибольшая длина текста в копии: длиннее значение «равно» фильтра не бывает (FILTER_LIMITS). */
const MAX_TEXT = 200

const recordTables = ['deal', 'contact', 'organization'] as const

const projectTables = ['custom_value', 'pipeline_card_field'] as const

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table field_definition
      add column index_state text
        constraint field_definition_index_state
          check (index_state in ('building', 'ready', 'failed')),
      add column index_error text,
      add column index_token uuid
  `.execute(db)

  await sql`
    create table custom_value (
      project_id uuid not null references project (id) on delete cascade,
      field_id uuid not null,
      record_id uuid not null,
      -- 0 — значение; 1 — начало интервала дат; 2 — его конец.
      part smallint not null default 0 check (part in (0, 1, 2)),
      value_text text,
      value_number double precision,
      check ((value_text is null) <> (value_number is null)),
      foreign key (project_id, field_id) references field_definition (project_id, id)
        on delete cascade
    )
  `.execute(db)
  // Поиск «поле, часть, текст» и защита от повторов одной и той же строки.
  await sql`
    create unique index custom_value_text_idx
      on custom_value (field_id, part, value_text, value_number, record_id) nulls not distinct
  `.execute(db)
  await sql`
    create index custom_value_number_idx on custom_value (field_id, part, value_number)
      where value_number is not null
  `.execute(db)
  await sql`create index custom_value_record_idx on custom_value (record_id)`.execute(db)

  // Строки копии из значения поля — по виду JSON, без типа поля: смена типа с переписыванием
  // значений (число → текст) сама даёт строки нового вида. Приведение к числу — только внутри
  // case: PostgreSQL 18 планирует тело функции с подставленным значением и вычислил бы
  // приведение строки к числу заранее, несмотря на where.
  await sql
    .raw(`
      create function public.custom_value_rows(v jsonb)
        returns table (part smallint, value_text text, value_number double precision)
        language sql
        immutable
        set search_path = pg_catalog, pg_temp
      as $$
        select 0::smallint, v #>> '{}', null::double precision
          where jsonb_typeof(v) in ('string', 'boolean') and char_length(v #>> '{}') <= ${MAX_TEXT}
        union all
        select 0::smallint, null,
            case when jsonb_typeof(v) = 'number' then v::double precision end
          where jsonb_typeof(v) = 'number'
        union all
        select 0::smallint, e #>> '{}', null
          from jsonb_array_elements(case when jsonb_typeof(v) = 'array' then v else '[]' end) e
          where jsonb_typeof(e) = 'string' and char_length(e #>> '{}') <= ${MAX_TEXT}
        union all
        select 0::smallint, null,
            case when jsonb_typeof(v -> 'amount') = 'number'
              then (v -> 'amount')::double precision end
          where jsonb_typeof(v) = 'object' and jsonb_typeof(v -> 'amount') = 'number'
        union all
        select 1::smallint, v ->> 'from', null
          where jsonb_typeof(v) = 'object' and jsonb_typeof(v -> 'from') = 'string'
        union all
        select 2::smallint, v ->> 'to', null
          where jsonb_typeof(v) = 'object' and jsonb_typeof(v -> 'to') = 'string'
      $$
    `)
    .execute(db)

  // Триггер записи: строки записи — заново по полям с копией (building и ready). Работает с
  // правами того, кто пишет: под alpi_app политики проекта действуют и здесь.
  await sql
    .raw(`
      create function public.custom_value_sync()
        returns trigger
        language plpgsql
        set search_path = pg_catalog, pg_temp
      as $$
      begin
        if tg_op <> 'INSERT' then
          delete from public.custom_value where record_id = old.id;
        end if;
        if tg_op <> 'DELETE' and new.custom <> '{}'::jsonb then
          insert into public.custom_value (project_id, field_id, record_id, part, value_text, value_number)
          select new.project_id, f.id, new.id, r.part, r.value_text, r.value_number
          from public.field_definition f
          cross join lateral public.custom_value_rows(new.custom -> f.code) r
          where f.project_id = new.project_id
            and f.entity = tg_argv[0]
            and f.index_state is not null
            and new.custom ? f.code
          on conflict do nothing;
        end if;
        return null;
      end
      $$
    `)
    .execute(db)
  for (const table of recordTables) {
    await sql
      .raw(`
        create trigger ${table}_custom_value_insert after insert on ${table}
          for each row execute function public.custom_value_sync('${table}');
        create trigger ${table}_custom_value_update after update of custom on ${table}
          for each row when (old.custom is distinct from new.custom)
          execute function public.custom_value_sync('${table}');
        create trigger ${table}_custom_value_delete after delete on ${table}
          for each row execute function public.custom_value_sync('${table}');
      `)
      .execute(db)
  }

  // Состояние копии у поля: нужна — пока поле отмечено, не в архиве и не удаляется.
  await sql
    .raw(`
      create function public.field_definition_index()
        returns trigger
        language plpgsql
        set search_path = pg_catalog, pg_temp
      as $$
      begin
        if tg_op = 'UPDATE' and tg_when = 'AFTER' then
          if old.index_state is not null and new.index_state is null then
            delete from public.custom_value where field_id = new.id;
          end if;
          return null;
        end if;
        if not new.is_frequently_filtered or new.archived_at is not null
          or new.purge_requested_at is not null then
          new.index_state := null;
          new.index_error := null;
          new.index_token := null;
        elsif tg_op = 'INSERT' or old.index_state is null then
          new.index_state := 'building';
          new.index_error := null;
          new.index_token := gen_random_uuid();
        end if;
        return new;
      end
      $$
    `)
    .execute(db)
  await sql`
    create trigger field_definition_index before insert or update on field_definition
      for each row execute function public.field_definition_index()
  `.execute(db)
  await sql`
    create trigger field_definition_index_cleanup after update on field_definition
      for each row when (old.index_state is not null and new.index_state is null)
      execute function public.field_definition_index()
  `.execute(db)
  // Поля, отмеченные до этой миграции (стартовые поля ALPI): любое изменение строки проводит
  // её через триггер, и она получает building. Копию построит задача, которую API ставит при
  // старте (apps/api/src/jobs/field-index.ts).
  await sql`update field_definition set index_error = null where is_frequently_filtered`.execute(db)

  await sql`
    create table pipeline_card_field (
      project_id uuid not null references project (id) on delete cascade,
      pipeline_id uuid not null,
      field_id uuid not null,
      position smallint not null check (position between 1 and 3),
      primary key (pipeline_id, field_id),
      unique (pipeline_id, position),
      foreign key (project_id, pipeline_id) references pipeline (project_id, id) on delete cascade,
      foreign key (project_id, field_id) references field_definition (project_id, id)
        on delete cascade
    )
  `.execute(db)

  for (const table of projectTables) {
    await sql`alter table ${sql.table(table)} enable row level security`.execute(db)
    await sql`
      create policy project_isolation on ${sql.table(table)}
        using (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
        with check (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
    `.execute(db)
  }
  await sql`grant select, insert, delete on custom_value, pipeline_card_field to alpi_app`.execute(
    db,
  )
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table pipeline_card_field`.execute(db)
  await sql`drop trigger field_definition_index_cleanup on field_definition`.execute(db)
  await sql`drop trigger field_definition_index on field_definition`.execute(db)
  await sql`drop function public.field_definition_index()`.execute(db)
  for (const table of [...recordTables].reverse()) {
    for (const op of ['delete', 'update', 'insert']) {
      await sql.raw(`drop trigger ${table}_custom_value_${op} on ${table}`).execute(db)
    }
  }
  await sql`drop function public.custom_value_sync()`.execute(db)
  await sql`drop function public.custom_value_rows(jsonb)`.execute(db)
  await sql`drop table custom_value`.execute(db)
  await sql`
    alter table field_definition
      drop column index_token,
      drop column index_error,
      drop column index_state
  `.execute(db)
}
