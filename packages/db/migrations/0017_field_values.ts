import { type Kysely, sql } from 'kysely'

// Значения пользовательских полей (тикет crm-fields/02; spec.md MVP, разделы 3.3 и 10).
//
// - GIN-индекс `jsonb_path_ops` по `custom` у deal, contact, organization: фильтры списка по
//   значению (`custom @> '{"код": …}'`). Колонку и проверку «объект JSON» добавила
//   0016_fields; проверку значения по типу делает API (packages/shared/src/fields/values.ts).
//   Изоляция проектов — те же политики row-level security: индекс отдаёт строки только через
//   таблицу.
// - field_definition.converting_to — идёт безопасная смена типа поля с данными: фоновая задача
//   (apps/api/src/fields/retype.ts) переписывает значения в этот тип, потом ставит его полю.
//   Пока колонка не null, API не пишет значений поля (409).
// - Триггер field_definition_guard: тип поля с данными меняется только безопасно — текст →
//   большой текст, число → текст, один вариант → несколько вариантов (тот же список —
//   typeChangeWithValues в packages/shared/src/fields/values.ts); во время смены — только на
//   тип смены. Остальное — как в 0016_fields.
// - change_log.field допускает `custom.<код>`: история значений пользовательских полей
//   (apps/api/src/fields/values.ts).

/** SQLSTATE: код поля не меняется (как в 0016_fields). */
const CODE_LOCKED = 'FD001'
/** SQLSTATE: тип поля не меняется. */
const TYPE_LOCKED = 'FD002'
/** SQLSTATE: правило «с этапа» для воронки, где поле не видно. */
const PIPELINE_HIDDEN = 'FD003'
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

const recordTables = ['deal', 'contact', 'organization'] as const

/**
 * Тело field_definition_guard. `typeRule` — проверка смены типа; остальное — как в 0016_fields
 * (down возвращает прежнюю проверку типа).
 */
function guardFunction(typeRule: string): string {
  return `
    create or replace function public.field_definition_guard()
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
        ${typeRule}
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
  `
}

/** 0017: безопасные смены типа поля с данными; во время смены — только на её тип. */
const SAFE_TYPE_RULE = `
        if old.converting_to is not null and new.type is distinct from old.converting_to then
          raise exception 'идёт смена типа поля: тип меняется только на тип смены'
            using errcode = '${TYPE_LOCKED}';
        end if;
        if old.first_value_at is not null and (old.type, new.type) not in (
          ('text', 'long_text'), ('number', 'text'), ('single_option', 'multi_option')
        ) then
          raise exception 'тип поля со значениями меняется только безопасно: создайте новое поле'
            using errcode = '${TYPE_LOCKED}';
        end if;
`

/** 0016: тип поля со значениями не меняется. */
const LOCKED_TYPE_RULE = `
        if old.first_value_at is not null then
          raise exception 'тип поля со значениями не меняется' using errcode = '${TYPE_LOCKED}';
        end if;
`

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const table of recordTables) {
    await sql
      .raw(`create index ${table}_custom_idx on ${table} using gin (custom jsonb_path_ops)`)
      .execute(db)
  }
  await sql
    .raw(`
      alter table field_definition
        add column converting_to text
          constraint field_definition_converting_to_type
            check (converting_to is null or converting_to in (${FIELD_TYPES.map((t) => `'${t}'`).join(', ')}))
    `)
    .execute(db)
  await sql.raw(guardFunction(SAFE_TYPE_RULE)).execute(db)
  // История значений пишет поле `custom.<код>` (код — до 63 символов): точка и длина 71.
  await sql`alter table change_log drop constraint change_log_field_check`.execute(db)
  await sql`
    alter table change_log add constraint change_log_field_check check (
      (field ~ '^[a-zA-Z][a-zA-Z0-9_]*$' and char_length(field) <= 60)
      or field ~ '^custom\.[a-z][a-z0-9_]{0,62}$'
    )
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // История значений полей уходит вместе с проверкой, которая её допускала.
  await sql`delete from change_log where field like 'custom.%'`.execute(db)
  await sql`alter table change_log drop constraint change_log_field_check`.execute(db)
  await sql`
    alter table change_log add constraint change_log_field_check
      check (field ~ '^[a-zA-Z][a-zA-Z0-9_]*$' and char_length(field) <= 60)
  `.execute(db)
  await sql.raw(guardFunction(LOCKED_TYPE_RULE)).execute(db)
  await sql`alter table field_definition drop column converting_to`.execute(db)
  for (const table of [...recordTables].reverse()) {
    await sql.raw(`drop index ${table}_custom_idx`).execute(db)
  }
}
