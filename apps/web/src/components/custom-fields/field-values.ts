import {
  FIELD_MONEY_CURRENCIES,
  type FieldDefinitionSummary,
  type FieldMoneyCurrency,
  type FieldType,
  type FieldValueContext,
  type FieldValueProblem,
  type FieldValueResult,
  normalizeFieldValue,
} from '@alpi/shared'

// Черновик значения пользовательского поля в редакторе (тикет crm-fields/06) и его перевод в
// значение запроса. Поля ввода держат строки — «1,5» или недописанную дату; значение в формате
// тикета 02 (packages/shared/src/fields/values.ts) получается только при сохранении, и его
// проверяет та же normalizeFieldValue, что и сервер. Этим же пользуется форма заполнения
// обязательных полей (тикет 04).

export interface MoneyDraft {
  amount: string
  currency: FieldMoneyCurrency
}

export interface RangeDraft {
  from: string
  to: string
}

/**
 * Черновик по типу: список id — у «несколько вариантов», сумма и валюта — у «денег», две даты —
 * у интервала, у остальных — строка (у «да/нет» — '', 'true' или 'false').
 */
export type FieldDraft = string | string[] | MoneyDraft | RangeDraft

/** Поле, каким его видит редактор: тип и варианты (с архивными). */
export type EditorField = Pick<FieldDefinitionSummary, 'type' | 'options'>

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Пустое значение: ключа нет в `custom` (null, пустая строка и пустой список — тоже). */
export function isEmptyFieldValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  )
}

/** Черновик из значения записи; пустое значение — пустой черновик. */
export function initialDraft(type: FieldType, value: unknown): FieldDraft {
  switch (type) {
    case 'money': {
      const currency = FIELD_MONEY_CURRENCIES.find((c) => isObject(value) && value.currency === c)
      return isObject(value) && typeof value.amount === 'number' && currency
        ? { amount: String(value.amount), currency }
        : { amount: '', currency: FIELD_MONEY_CURRENCIES[0] }
    }
    case 'date_range':
      return isObject(value) && typeof value.from === 'string' && typeof value.to === 'string'
        ? { from: value.from, to: value.to }
        : { from: '', to: '' }
    case 'multi_option':
      return Array.isArray(value) ? value.filter((id) => typeof id === 'string') : []
    case 'boolean':
      return typeof value === 'boolean' ? String(value) : ''
    case 'number':
      return typeof value === 'number' ? String(value) : ''
    default:
      return typeof value === 'string' ? value : ''
  }
}

const asText = (draft: FieldDraft): string => (typeof draft === 'string' ? draft : '')

/** Число из поля ввода: запятая — тоже разделитель; не число — NaN (проверка ответит 'type'). */
function parseNumber(text: string): number {
  return Number(text.trim().replace(',', '.'))
}

/**
 * Значение запроса из черновика: null — убрать значение. Вид значения не проверяется — это
 * делает checkDraft.
 */
export function draftToRaw(type: FieldType, draft: FieldDraft): unknown {
  switch (type) {
    case 'number': {
      const text = asText(draft)
      return text.trim() === '' ? null : parseNumber(text)
    }
    case 'money': {
      if (!isObject(draft) || !('amount' in draft)) return null
      const { amount, currency } = draft as MoneyDraft
      return amount.trim() === '' ? null : { amount: parseNumber(amount), currency }
    }
    case 'date_range': {
      if (!isObject(draft) || !('from' in draft)) return null
      const { from, to } = draft as RangeDraft
      return from === '' && to === '' ? null : { from, to }
    }
    case 'multi_option':
      return Array.isArray(draft) ? draft : []
    case 'boolean': {
      const text = asText(draft)
      return text === '' ? null : text === 'true'
    }
    case 'date':
    case 'time':
    case 'single_option':
    case 'user': {
      const text = asText(draft)
      return text === '' ? null : text
    }
    default:
      return asText(draft)
  }
}

/**
 * Проверка черновика перед отправкой — той же функцией, что на сервере. `context.previous` —
 * значение записи: уже выбранные архивный вариант и отключённый пользователь остаются
 * допустимыми.
 */
export function checkDraft(
  field: EditorField,
  draft: FieldDraft,
  context: FieldValueContext = {},
): FieldValueResult {
  return normalizeFieldValue(
    { type: field.type, options: field.options },
    draftToRaw(field.type, draft),
    context,
  )
}

/** Ключ текста ошибки в `custom-fields:problems` по типу поля и причине отказа. */
export function problemKey(type: FieldType, problem: FieldValueProblem) {
  if (problem === 'type' && (type === 'number' || type === 'money')) return 'number' as const
  if (problem === 'format') {
    switch (type) {
      case 'date':
      case 'time':
      case 'date_range':
      case 'phone':
      case 'email':
      case 'url':
        return `format_${type}` as const
      default:
        return 'format' as const
    }
  }
  if (problem === 'range' && type === 'date_range') return 'range_date_range' as const
  return problem
}

/** Ссылка http(s), которую можно открыть: другие схемы (`javascript:` и т. п.) — не ссылка. */
export function safeHttpUrl(value: unknown): string | null {
  return typeof value === 'string' && /^https?:\/\/[^\s]+$/i.test(value) ? value : null
}
