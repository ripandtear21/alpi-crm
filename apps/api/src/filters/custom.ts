import type { Database } from '@alpi/db'
import {
  CUSTOM_FIELD_PREFIX,
  type CustomFilterField,
  type DateRangePart,
  type FieldEntity,
  type FieldType,
  type FilterCondition,
  fieldGroupAccess,
  findCustomField,
  parseCustomRef,
  type RolePermissions,
} from '@alpi/shared'
import { type Kysely, type RawBuilder, type SqlBool, sql } from 'kysely'
import { likePattern } from '../contacts/http.ts'
import type { SortKey } from './page.ts'

// Пользовательские поля в фильтре, колонках, сортировке и выгрузке списков (тикет
// crm-fields/07). Формат условия — packages/shared/src/filters/custom.ts.
//
// Каталог (loadFilterCatalog) — поля, которые пользователь видит: действующие (не в архиве, не
// удаляются) и из групп, не скрытых от его роли (fields/access.ts). Условие, колонка или
// сортировка по полю вне каталога — 422 CUSTOM_FIELD_UNKNOWN, тот же ответ, что на запись в
// неизвестный код: ответ не выдаёт, что скрытое поле есть.
//
// Условие строится по значению в `custom` (источник правды): код поля идёт параметром запроса,
// а не текстом SQL. Если у поля готово ускорение «часто фильтруют» (index_state = 'ready',
// migrations/0018_field_filters.ts), к условию добавляется отбор по копии значений
// custom_value: `id in (select record_id from custom_value where field_id = … and value_* …)`.
// Там только сравнения text, float8 и uuid — PostgreSQL помечает их LEAKPROOF и потому берёт
// индекс custom_value и под row-level security роли приложения. Условие по `custom` остаётся и
// проверяет найденные строки ещё раз.

/** Поле каталога: что фильтру, колонкам и выгрузке нужно знать о поле. */
export interface CatalogField extends CustomFilterField {
  nameUk: string
  nameRu: string | null
  /** Копия значений в custom_value готова: фильтр ею пользуется. */
  indexReady: boolean
}

/** Поля сущности, которые видит роль `permissions`: действующие, из видимых групп. */
export async function loadFilterCatalog(
  db: Kysely<Database>,
  permissions: RolePermissions,
  entity: FieldEntity,
): Promise<CatalogField[]> {
  const rows = await db
    .selectFrom('field_definition')
    .select(['id', 'code', 'type', 'group_id', 'name_uk', 'name_ru', 'index_state'])
    .where('entity', '=', entity)
    .where('archived_at', 'is', null)
    .where('purge_requested_at', 'is', null)
    .orderBy('position')
    .orderBy('id')
    .execute()
  return rows
    .filter((row) => fieldGroupAccess(permissions, { id: row.group_id, entity }) !== 'hidden')
    .map((row) => ({
      id: row.id,
      code: row.code,
      type: row.type as FieldType,
      nameUk: row.name_uk,
      nameRu: row.name_ru,
      indexReady: row.index_state === 'ready',
    }))
}

/** Таблица списка в запросе: deal, contact, organization — под своими именами. */
export type RecordTable = 'deal' | 'contact' | 'organization'

/** Выражения значения поля в строке `table`. */
function valueSql(table: RecordTable, field: CatalogField, part?: DateRangePart) {
  const custom = sql.ref(`${table}.custom`)
  const code = sql`cast(${field.code} as text)`
  const json = sql`(${custom} -> ${code})`
  const present = sql<SqlBool>`(${custom} ? ${code})`
  if (part) {
    const key = part === 'start' ? 'from' : 'to'
    return { json, present, text: sql`(${json} ->> ${sql.lit(key)})` }
  }
  const number =
    field.type === 'money'
      ? sql`(case when jsonb_typeof(${json} -> 'amount') = 'number' then (${json} -> 'amount')::float8 end)`
      : sql`(case when jsonb_typeof(${json}) = 'number' then (${json})::float8 end)`
  return { json, present, text: sql`(${custom} ->> ${code})`, number }
}

const isNumeric = (type: FieldType) => type === 'number' || type === 'money'

/** Часть значения в custom_value: 0 — значение, 1 — начало интервала, 2 — конец. */
const PART: Record<DateRangePart, number> = { start: 1, end: 2 }

const asText = (value: unknown) => sql`cast(${value} as text)`
const asFloat = (value: unknown) => sql`cast(${value} as double precision)`
const asTextArray = (values: readonly unknown[]) => sql`cast(${values} as text[])`

/**
 * Значение «я» у поля-пользователя: id того, кто смотрит. У ключа API «я» нет: фильтр с ним
 * отклоняет разбор (readFilterParam с `me: false`), сюда он дойти не должен.
 */
export function meOf(actorId: string | null): string {
  // NULL вместо «я» молча дал бы разные выборки для `= me` и `!= me` (тикет crm-api/03).
  if (actorId === null) throw new Error('значение «я» в фильтре без пользователя')
  return actorId
}

/**
 * Условие по пользовательскому полю `field` (условие уже проверено parseFilter с каталогом).
 * `me` — id того, кто смотрит список: значение «я» у поля «пользователь»; null — ключ API.
 */
export function compileCustomCondition(
  table: RecordTable,
  field: CatalogField,
  condition: FilterCondition,
  me: string | null,
): RawBuilder<SqlBool> {
  const ref = parseCustomRef(condition.field)
  const part = ref?.part
  const value = valueSql(table, field, part)
  const user = (v: unknown) => (field.type === 'user' && v === 'me' ? meOf(me) : v)
  const single = user(condition.value)
  const list = Array.isArray(condition.value) ? condition.value.map(user) : []
  const numeric = isNumeric(field.type) && !part
  const target = numeric && value.number ? value.number : value.text
  const cast = numeric ? asFloat : asText

  // Условие по `custom` и, где копия помогает, — по copy: что сравнивать в custom_value.
  let main: RawBuilder<SqlBool>
  let copy: RawBuilder<SqlBool> | null = null
  const column = numeric ? sql.ref('v.value_number') : sql.ref('v.value_text')
  switch (condition.op) {
    case 'empty':
      return sql<SqlBool>`(not ${value.present})`
    case 'not_empty':
      return value.present
    case 'contains':
      return sql<SqlBool>`(${value.text} ilike ${likePattern(String(single))})`
    case 'eq':
      main = sql<SqlBool>`(${target} = ${cast(single)})`
      copy = sql<SqlBool>`${column} = ${cast(single)}`
      break
    case 'lt':
      main = sql<SqlBool>`(${target} < ${cast(single)})`
      copy = sql<SqlBool>`${column} < ${cast(single)}`
      break
    case 'gt':
      main = sql<SqlBool>`(${target} > ${cast(single)})`
      copy = sql<SqlBool>`${column} > ${cast(single)}`
      break
    case 'between': {
      const [from, to] = list
      main = sql<SqlBool>`(${target} between ${cast(from)} and ${cast(to)})`
      copy = sql<SqlBool>`${column} between ${cast(from)} and ${cast(to)}`
      break
    }
    case 'in':
      // Варианты: строка (один вариант) или массив строк (несколько) — `?|` подходит к обоим.
      main =
        field.type === 'user'
          ? sql<SqlBool>`(${value.text} = any(${asTextArray(list)}))`
          : sql<SqlBool>`coalesce(${value.json} ?| ${asTextArray(list)}, false)`
      copy = sql<SqlBool>`${column} = any(${asTextArray(list)})`
      break
    case 'not_in':
      // «Ни один из» — и записи без значения.
      return sql<SqlBool>`(not coalesce(${value.json} ?| ${asTextArray(list)}, false))`
    default:
      throw new Error(`оператор ${condition.op} не описан для пользовательского поля`)
  }
  if (!field.indexReady) return main
  const partNumber = part ? PART[part] : 0
  return sql<SqlBool>`(${main} and ${sql.ref(`${table}.id`)} in (
    select v.record_id from custom_value v
    where v.field_id = ${sql`cast(${field.id} as uuid)`}
      and v.part = ${sql.lit(partNumber)}
      and ${copy}
  ))`
}

/**
 * Ключ сортировки по пользовательскому полю: пустое значение — в начале при возрастании (как
 * самое малое), поэтому курсор «значение, id» однозначен. Число и сумма — float8 (пустое —
 * -Infinity); один вариант — по порядку вариантов; пользователь — по имени; остальное — текст
 * (у интервала дат — начало).
 */
export function customSortKey(table: RecordTable, field: CatalogField): SortKey {
  const value = valueSql(table, field)
  if (isNumeric(field.type) && value.number) {
    const order = sql`coalesce(${value.number}, '-Infinity'::float8)`
    return { order, text: sql<string>`${order}::text`, cast: 'float8' }
  }
  if (field.type === 'single_option') {
    const order = sql`coalesce((
      select o.position::float8 from field_option o
      where o.field_id = ${sql`cast(${field.id} as uuid)`} and o.id::text = ${value.text}
    ), '-Infinity'::float8)`
    return { order, text: sql<string>`${order}::text`, cast: 'float8' }
  }
  if (field.type === 'user') {
    const order = sql`coalesce((select u.name from "user" u where u.id = ${value.text}), '')`
    return { order, text: sql<string>`${order}`, cast: 'text' }
  }
  const text = field.type === 'date_range' ? sql`(${value.json} ->> 'from')` : value.text
  const order = sql`coalesce(${text}, '')`
  return { order, text: sql<string>`${order}`, cast: 'text' }
}

/**
 * Упоминают ли параметры запроса (filter, sort, columns) пользовательское поле: каталог
 * читается только тогда — списки без пользовательских полей обходятся без лишнего запроса.
 */
export function mentionsCustom(...raws: (string | undefined)[]): boolean {
  return raws.some((raw) => raw?.includes(CUSTOM_FIELD_PREFIX))
}

/** Каталог, если параметры его упоминают, иначе пустой. */
export async function catalogFor(
  db: Kysely<Database>,
  permissions: RolePermissions,
  entity: FieldEntity,
  ...raws: (string | undefined)[]
): Promise<CatalogField[]> {
  return mentionsCustom(...raws) ? loadFilterCatalog(db, permissions, entity) : []
}

/**
 * Сортировка `sort=<колонка>:<asc|desc>` по пользовательскому полю вне каталога (скрытое,
 * архивное, неизвестный код): ответ 422 CUSTOM_FIELD_UNKNOWN, а не 400.
 */
export function unknownCustomSort(raw: string, custom: readonly CatalogField[]): string | null {
  const column = raw.split(':')[0] ?? ''
  const ref = parseCustomRef(column)
  return ref && !findCustomField(custom, ref.key) ? column : null
}

/**
 * Ключ сортировки списка: системная колонка из `keys` или пользовательское поле `custom.<id>` из
 * каталога (parseSort с тем же каталогом других не пропускает).
 */
export function listSortKey(
  column: string,
  keys: Readonly<Record<string, SortKey>>,
  table: RecordTable,
  custom: readonly CatalogField[],
): SortKey {
  const ref = parseCustomRef(column)
  if (!ref) {
    const key = keys[column]
    if (!key) throw new Error(`колонка сортировки ${column} не описана`)
    return key
  }
  const field = custom.find((f) => f.id === ref.key)
  if (!field) throw new Error(`сортировка по полю ${column} не из каталога`)
  return customSortKey(table, field)
}
