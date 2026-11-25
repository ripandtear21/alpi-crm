import type { Database } from '@alpi/db'
import { type FieldMoney, hasOptions, parseCustomRef } from '@alpi/shared'
import type { Kysely } from 'kysely'
import type { CatalogField } from '../filters/custom.ts'
import type { CsvValue, ExportLanguage } from './csv.ts'

// Колонки пользовательских полей в выгрузке CSV (тикет crm-fields/07): заголовок — название
// поля на языке выгрузки, значение — как в интерфейсе: варианты и пользователи — названиями,
// деньги — «сумма валюта», интервал дат — «с — по», да/нет — словом. Колонки только из
// каталога того, кто выгружает (filters/custom.ts): скрытое от роли поле в файл не попадает.

/** Названия вариантов и пользователей для значений выгрузки. */
export interface CustomNames {
  options: Map<string, { uk: string; ru: string | null }>
  users: Map<string, string>
}

const BOOLEAN_LABELS: Record<ExportLanguage, [string, string]> = {
  uk: ['Так', 'Ні'],
  ru: ['Да', 'Нет'],
}

/** Поле колонки `custom.<id>` из каталога; системная колонка — undefined. */
export function customColumnField(
  column: string,
  custom: readonly CatalogField[],
): CatalogField | undefined {
  const ref = parseCustomRef(column)
  return ref ? custom.find((field) => field.id === ref.key) : undefined
}

/** Заголовки колонок пользовательских полей: `custom.<id>` → название на языке выгрузки. */
export function customHeaders(
  columns: readonly string[],
  custom: readonly CatalogField[],
  language: ExportLanguage,
): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const column of columns) {
    const field = customColumnField(column, custom)
    if (field) headers[column] = language === 'ru' ? (field.nameRu ?? field.nameUk) : field.nameUk
  }
  return headers
}

/**
 * Названия для значений порции: варианты выбранных полей со списком и пользователи из значений
 * полей «пользователь».
 */
export async function loadCustomNames(
  db: Kysely<Database>,
  fields: readonly CatalogField[],
  values: readonly Record<string, unknown>[],
): Promise<CustomNames> {
  const optionFields = fields.filter((f) => hasOptions(f.type)).map((f) => f.id)
  const userIds = new Set<string>()
  for (const field of fields.filter((f) => f.type === 'user')) {
    for (const value of values) {
      const id = value[field.code]
      if (typeof id === 'string') userIds.add(id)
    }
  }
  const options =
    optionFields.length === 0
      ? []
      : await db
          .selectFrom('field_option')
          .select(['id', 'name_uk', 'name_ru'])
          .where('field_id', 'in', optionFields)
          .execute()
  const users =
    userIds.size === 0
      ? []
      : await db
          .selectFrom('user')
          .select(['id', 'name'])
          .where('id', 'in', [...userIds])
          .execute()
  return {
    options: new Map(options.map((o) => [o.id, { uk: o.name_uk, ru: o.name_ru }])),
    users: new Map(users.map((u) => [u.id, u.name])),
  }
}

/** Значение пользовательского поля `field` в ячейке выгрузки. */
export function customCell(
  field: CatalogField,
  value: unknown,
  names: CustomNames,
  language: ExportLanguage,
): CsvValue {
  if (value === undefined || value === null) return null
  const option = (id: unknown) => {
    const found = typeof id === 'string' ? names.options.get(id) : undefined
    if (!found) return null
    return language === 'ru' ? (found.ru ?? found.uk) : found.uk
  }
  switch (field.type) {
    case 'number':
      return typeof value === 'number' ? value : null
    case 'money': {
      const money = value as FieldMoney
      return `${money.amount} ${money.currency}`
    }
    case 'date_range': {
      const range = value as { from: string; to: string }
      return `${range.from} — ${range.to}`
    }
    case 'single_option':
      return option(value)
    case 'multi_option':
      return Array.isArray(value)
        ? value
            .map(option)
            .filter((name): name is string => name !== null)
            .join(', ')
        : null
    case 'boolean':
      return BOOLEAN_LABELS[language][value === true ? 0 : 1]
    case 'user':
      return typeof value === 'string' ? (names.users.get(value) ?? null) : null
    default:
      return typeof value === 'string' ? value : null
  }
}
