import { normalizeEmail, normalizePhone } from '../phone.ts'
import type { FieldType } from './index.ts'

// Значения пользовательских полей (эпик crm-fields, тикет 02; spec.md MVP, раздел 3.3):
// проверка и приведение значения по типу поля. Одна функция для API (запись `custom` сделки,
// контакта, организации), форм интерфейса и приёма регистраций (эпик приёма).
//
// Значение лежит в `custom` записи под кодом поля; пустое значение — отсутствие ключа (решено
// без владельца, подтвердить): null, пустая строка, пустой список приводятся к null — «убрать».

/** Наибольшая длина текста и адреса (решено без владельца, подтвердить). */
export const FIELD_TEXT_MAX_LENGTH = 500
/** Наибольшая длина большого текста (решено без владельца, подтвердить). */
export const FIELD_LONG_TEXT_MAX_LENGTH = 10_000
/** Наибольшая длина ссылки (решено без владельца, подтвердить): предел адреса в браузерах. */
export const FIELD_URL_MAX_LENGTH = 2048
/** Наибольшая сумма поля «деньги»: как у суммы сделки, numeric(14, 2). */
export const FIELD_MONEY_MAX_AMOUNT = 999_999_999_999.99
/** Валюты поля «деньги»: те же, что у сделки. */
export const FIELD_MONEY_CURRENCIES = ['EUR', 'UAH', 'USD'] as const
export type FieldMoneyCurrency = (typeof FIELD_MONEY_CURRENCIES)[number]

/** Деньги: сумма с двумя знаками и валюта. */
export interface FieldMoney {
  amount: number
  currency: FieldMoneyCurrency
}

/** Интервал дат `YYYY-MM-DD`, `from` ≤ `to`. */
export interface FieldDateRange {
  from: string
  to: string
}

/** Приведённое значение поля, как оно лежит в `custom`. */
export type FieldValue = string | number | boolean | string[] | FieldMoney | FieldDateRange

/** Что не так со значением: причина в ответе 422. */
export type FieldValueProblem =
  /** Не тот вид значения (строка вместо числа, лишние ключи объекта…). */
  | 'type'
  /** Длиннее предела типа. */
  | 'too_long'
  /** Не по формату: дата, время, телефон, email, ссылка. */
  | 'format'
  /** Ссылка не http:// и не https://. */
  | 'scheme'
  /** Сумма меньше нуля или больше предела; интервал «с» позже «по». */
  | 'range'
  /** Больше двух знаков после запятой. */
  | 'precision'
  /** Валюта не из списка. */
  | 'currency'
  /** Варианта нет у поля. */
  | 'unknown_option'
  /** Вариант в архиве: для нового значения не годится. */
  | 'archived_option'
  /** Не участник проекта. */
  | 'unknown_user'
  /** Участие отключено: для нового значения не годится. */
  | 'disabled_user'

/** Что о поле нужно проверке: тип и варианты (у типов со списком). */
export interface FieldValueRules {
  type: FieldType
  /** Варианты по порядку, с архивными; у типов без списка не нужны. */
  options?: readonly { id: string; archivedAt: string | null }[]
}

/** Что проверке нужно знать о записи и проекте. */
export interface FieldValueContext {
  /**
   * Участники проекта среди id в значении: `disabled` — участие отключено; нет id — не участник.
   * Не передан — проверяется только вид значения (форма, у которой нет списка участников);
   * сервер передаёт всегда.
   */
  users?: ReadonlyMap<string, { disabled: boolean }>
  /**
   * Значение, которое уже лежит в записи: архивный вариант и отключённый пользователь, которые
   * в нём уже есть, остаются допустимыми — запрещены они только для нового значения.
   */
  previous?: unknown
}

export type FieldValueResult =
  | { ok: true; value: FieldValue | null }
  | { ok: false; problem: FieldValueProblem }

const good = (value: FieldValue | null): FieldValueResult => ({ ok: true, value })
const bad = (problem: FieldValueProblem): FieldValueResult => ({ ok: false, problem })

const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
/** Ссылка http(s): непустой хост, без пробелов (пакет общий для браузера и сервера, без URL). */
const HTTP_URL = /^https?:\/\/[^\s/?#@]+(?:[/?#]\S*)?$/i
/** Любая другая схема (`javascript:`, `ftp:`, `mailto:`…) — не ссылка для этого поля. */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i

function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Объект ровно с этими ключами. */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every((key) => own.includes(key))
}

function text(raw: unknown, max: number, trim: boolean): FieldValueResult {
  if (typeof raw !== 'string') return bad('type')
  const value = trim ? raw.trim() : raw
  if (value.trim() === '') return good(null)
  return value.length > max ? bad('too_long') : good(value)
}

function money(raw: unknown): FieldValueResult {
  if (!isPlainObject(raw) || !hasExactKeys(raw, ['amount', 'currency'])) return bad('type')
  const { amount, currency } = raw
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return bad('type')
  if (amount < 0 || amount > FIELD_MONEY_MAX_AMOUNT) return bad('range')
  const cents = Math.round(amount * 100)
  if (Math.abs(cents - amount * 100) > 1e-6) return bad('precision')
  const known = FIELD_MONEY_CURRENCIES.find((c) => c === currency)
  if (known === undefined) return bad('currency')
  return good({ amount: cents / 100, currency: known })
}

function dateRange(raw: unknown): FieldValueResult {
  if (!isPlainObject(raw) || !hasExactKeys(raw, ['from', 'to'])) return bad('type')
  const { from, to } = raw
  if (!isDate(from) || !isDate(to)) return bad('format')
  return from <= to ? good({ from, to }) : bad('range')
}

function url(raw: unknown): FieldValueResult {
  if (typeof raw !== 'string') return bad('type')
  const value = raw.trim()
  if (value === '') return good(null)
  if (value.length > FIELD_URL_MAX_LENGTH) return bad('too_long')
  if (HTTP_URL.test(value)) return good(value)
  return URL_SCHEME.test(value) && !/^https?:/i.test(value) ? bad('scheme') : bad('format')
}

/** id вариантов `ids` по правилам поля: есть у поля; архивный — только если уже был. */
function optionIds(
  rules: FieldValueRules,
  ids: readonly unknown[],
  previous: readonly unknown[],
): FieldValueResult | string[] {
  const options = rules.options ?? []
  const chosen = new Set<string>()
  for (const id of ids) {
    if (typeof id !== 'string') return bad('type')
    const option = options.find((o) => o.id === id)
    if (!option) return bad('unknown_option')
    if (option.archivedAt !== null && !previous.includes(id)) return bad('archived_option')
    chosen.add(id)
  }
  // Порядок — порядок вариантов поля: тот же набор всегда даёт то же значение.
  return options.filter((o) => chosen.has(o.id)).map((o) => o.id)
}

/**
 * Проверяет и приводит значение `raw` поля по его типу. Результат — то, что ложится в `custom`
 * (null — убрать ключ), или причина отказа.
 */
export function normalizeFieldValue(
  rules: FieldValueRules,
  raw: unknown,
  context: FieldValueContext = {},
): FieldValueResult {
  if (raw === null) return good(null)
  const { previous } = context
  switch (rules.type) {
    case 'text':
    case 'address':
      return text(raw, FIELD_TEXT_MAX_LENGTH, true)
    case 'long_text':
      return text(raw, FIELD_LONG_TEXT_MAX_LENGTH, false)
    case 'number':
      return typeof raw === 'number' && Number.isFinite(raw) ? good(raw) : bad('type')
    case 'money':
      return money(raw)
    case 'date':
      if (typeof raw !== 'string') return bad('type')
      return isDate(raw) ? good(raw) : bad('format')
    case 'time':
      if (typeof raw !== 'string') return bad('type')
      return TIME.test(raw) ? good(raw) : bad('format')
    case 'date_range':
      return dateRange(raw)
    case 'single_option': {
      if (typeof raw !== 'string') return bad('type')
      const ids = optionIds(rules, [raw], [previous])
      return Array.isArray(ids) ? good(ids[0] ?? null) : ids
    }
    case 'multi_option': {
      if (!Array.isArray(raw)) return bad('type')
      const ids = optionIds(rules, raw, Array.isArray(previous) ? previous : [])
      if (!Array.isArray(ids)) return ids
      return good(ids.length === 0 ? null : ids)
    }
    case 'boolean':
      return typeof raw === 'boolean' ? good(raw) : bad('type')
    case 'phone': {
      if (typeof raw !== 'string') return bad('type')
      if (raw.trim() === '') return good(null)
      const phone = normalizePhone(raw)
      return phone === null ? bad('format') : good(phone)
    }
    case 'email': {
      if (typeof raw !== 'string') return bad('type')
      if (raw.trim() === '') return good(null)
      const email = normalizeEmail(raw)
      return email === null ? bad('format') : good(email)
    }
    case 'url':
      return url(raw)
    case 'user': {
      if (typeof raw !== 'string' || raw === '') return bad('type')
      if (context.users === undefined) return good(raw)
      const member = context.users.get(raw)
      if (!member) return bad('unknown_user')
      if (member.disabled && previous !== raw) return bad('disabled_user')
      return good(raw)
    }
  }
}

/**
 * Безопасная смена типа поля, у которого уже были значения (тикет 02): 'keep' — значения
 * годятся как есть (текст → большой текст), 'rewrite' — фоновая задача переписывает их
 * (число → текст: строкой; один вариант → несколько: массивом из одного id); null — смена с
 * данными запрещена («создайте новое поле»). База держит тот же список
 * (packages/db/migrations/0017_field_values.ts).
 */
export function typeChangeWithValues(from: FieldType, to: FieldType): 'keep' | 'rewrite' | null {
  if (from === 'text' && to === 'long_text') return 'keep'
  if (from === 'number' && to === 'text') return 'rewrite'
  if (from === 'single_option' && to === 'multi_option') return 'rewrite'
  return null
}
