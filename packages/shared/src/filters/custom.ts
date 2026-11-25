import type { FieldEntity, FieldType } from '../fields/index.ts'
import { normalizeEmail, normalizePhone } from '../phone.ts'
import type { FilterEntity, FilterOperator } from './index.ts'
import { FILTER_LIMITS } from './limits.ts'

// Пользовательские поля в фильтрах, колонках и сортировке списков (тикет crm-fields/07).
//
// Условие ссылается на поле строкой `custom.<id>` — так фильтр хранится (сохранённые фильтры
// переживают смену кода). Запросы `/api/v1` принимают и код: `custom.<код>`; parseFilter
// приводит его к id. Код поля не содержит `-`, id — uuid, поэтому их не спутать. У интервала
// дат условие — на начало или конец: `custom.<id>.start`, `custom.<id>.end`.
//
// Поля, которых пользователь не видит (скрытая группа, архив, окончательное удаление), в
// каталог, переданный parseFilter, не попадают: условие по ним — как по неизвестному полю.

/** Префикс пользовательского поля в условии, колонке и сортировке. */
export const CUSTOM_FIELD_PREFIX = 'custom.'

/** Список фильтра → сущность пользовательских полей. */
export const FILTER_FIELD_ENTITY: Record<FilterEntity, FieldEntity> = {
  deals: 'deal',
  contacts: 'contact',
  organizations: 'organization',
}

/** Что фильтру, колонкам и сортировке нужно знать о пользовательском поле. */
export interface CustomFilterField {
  id: string
  code: string
  type: FieldType
}

/** Часть значения интервала дат. */
export type DateRangePart = 'start' | 'end'

/** Ссылка на пользовательское поле: id или код и часть интервала дат. */
export interface CustomFieldRef {
  /** id или код. */
  key: string
  part?: DateRangePart
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KEY =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z][a-z0-9_]{0,62})$/i

/** Ссылка из `custom.<id|код>[.start|.end]`; не ссылка на пользовательское поле — null. */
export function parseCustomRef(field: string): CustomFieldRef | null {
  if (!field.startsWith(CUSTOM_FIELD_PREFIX)) return null
  const [key, part, ...rest] = field.slice(CUSTOM_FIELD_PREFIX.length).split('.')
  if (key === undefined || !KEY.test(key) || rest.length > 0) return null
  if (part === undefined) return { key }
  return part === 'start' || part === 'end' ? { key, part } : null
}

/** Поле каталога по ссылке: по id (без учёта регистра) или коду; нет — undefined. */
export function findCustomField<F extends CustomFilterField>(
  catalog: readonly F[],
  key: string,
): F | undefined {
  if (UUID.test(key)) {
    const id = key.toLowerCase()
    return catalog.find((field) => field.id === id)
  }
  return catalog.find((field) => field.code === key)
}

/** Строка условия, колонки и сортировки для поля: `custom.<id>[.часть]`. */
export function customFieldKey(id: string, part?: DateRangePart): string {
  return `${CUSTOM_FIELD_PREFIX}${id}${part ? `.${part}` : ''}`
}

const TEXT_TYPES: readonly FieldType[] = ['text', 'long_text', 'phone', 'email', 'url', 'address']
const ORDERED_TYPES: readonly FieldType[] = ['number', 'money', 'date', 'time']

/**
 * Операторы пользовательского поля (тикет 07, таблица операций): текст — содержит, равно,
 * пусто, не пусто; число, деньги, дата, время — =, <, >, между, пусто, не пусто; начало и конец
 * интервала дат — <, >, между, пусто; варианты — любой из, ни один из, пусто, не пусто; да/нет —
 * да, нет, пусто; пользователь — я (eq «me»), любой из, пусто, не пусто. Интервал дат без части
 * и часть у другого типа — без операторов.
 */
export function customOperators(type: FieldType, part?: DateRangePart): readonly FilterOperator[] {
  if (type === 'date_range') return part ? ['lt', 'gt', 'between', 'empty'] : []
  if (part) return []
  if (TEXT_TYPES.includes(type)) return ['contains', 'eq', 'empty', 'not_empty']
  if (ORDERED_TYPES.includes(type)) return ['eq', 'lt', 'gt', 'between', 'empty', 'not_empty']
  switch (type) {
    case 'single_option':
    case 'multi_option':
      return ['in', 'not_in', 'empty', 'not_empty']
    case 'boolean':
      return ['eq', 'empty']
    case 'user':
      return ['eq', 'in', 'empty', 'not_empty']
    default:
      return []
  }
}

/** Можно ли сортировать список по полю: у «несколько вариантов» одного значения нет. */
export function customSortable(type: FieldType): boolean {
  return type !== 'multi_option'
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const MAX_USER_ID = 100

function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value)
}

/** Одиночное значение условия по полю `type` с оператором `op`: null — не годится. */
function readCustomScalar(
  type: FieldType,
  op: FilterOperator,
  value: unknown,
): string | number | boolean | null {
  if (TEXT_TYPES.includes(type)) {
    if (typeof value !== 'string') return null
    const text = value.trim()
    if (text === '' || text.length > FILTER_LIMITS.text) return null
    // «Равно» сравнивает приведённые значения (тикет 02): телефон — E.164, email — нижний регистр.
    if (op === 'eq' && type === 'phone') return normalizePhone(text)
    if (op === 'eq' && type === 'email') return normalizeEmail(text)
    return text
  }
  switch (type) {
    case 'number':
    case 'money':
      return typeof value === 'number' &&
        Number.isFinite(value) &&
        Math.abs(value) <= FILTER_LIMITS.number
        ? value
        : null
    case 'date':
    case 'date_range':
      return isDate(value) ? value : null
    case 'time':
      return typeof value === 'string' && TIME.test(value) ? value : null
    case 'single_option':
    case 'multi_option':
      return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null
    case 'boolean':
      return typeof value === 'boolean' ? value : null
    case 'user':
      return typeof value === 'string' && value !== '' && value.length <= MAX_USER_ID ? value : null
    default:
      return null
  }
}

export type CustomValueRead =
  | { ok: true; value?: string | number | boolean | readonly string[] | readonly number[] }
  | { ok: false; message: string }

/**
 * Значение условия по пользовательскому полю (оператор уже проверен customOperators):
 * у empty / not_empty значения нет; in / not_in — непустой список без повторов; between —
 * пара [от, до], от ≤ до; остальное — одно значение.
 */
export function readCustomValue(
  type: FieldType,
  op: FilterOperator,
  value: unknown,
): CustomValueRead {
  if (op === 'empty' || op === 'not_empty') {
    return value === undefined ? { ok: true } : { ok: false, message: 'у оператора нет значения' }
  }
  if (op === 'in' || op === 'not_in') {
    if (!Array.isArray(value) || value.length === 0 || value.length > FILTER_LIMITS.listValues) {
      return { ok: false, message: 'ожидается непустой список значений' }
    }
    const read: string[] = []
    for (const item of value) {
      const scalar = readCustomScalar(type, op, item)
      if (typeof scalar !== 'string') return { ok: false, message: 'значение не той формы' }
      read.push(scalar)
    }
    return { ok: true, value: [...new Set(read)] }
  }
  if (op === 'between') {
    if (!Array.isArray(value) || value.length !== 2) {
      return { ok: false, message: 'ожидается пара значений [от, до]' }
    }
    const from = readCustomScalar(type, op, value[0])
    const to = readCustomScalar(type, op, value[1])
    if (from === null || to === null || typeof from === 'boolean' || typeof to === 'boolean') {
      return { ok: false, message: 'значение не той формы' }
    }
    if (from > to) return { ok: false, message: '«от» больше «до»' }
    return { ok: true, value: [from, to] as readonly string[] | readonly number[] }
  }
  const scalar = readCustomScalar(type, op, value)
  return scalar === null
    ? { ok: false, message: 'значение не той формы' }
    : { ok: true, value: scalar }
}
