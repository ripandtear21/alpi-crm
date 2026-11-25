import {
  CUSTOM_FIELD_PREFIX,
  customOperators,
  customSortable,
  type DateRangePart,
  type FieldDefinitionSummary,
  type FieldNames,
  type FilterOperator,
  fieldName,
  parseCustomRef,
} from '@alpi/shared'
import { formatMoney } from '../../../components/deal-card/deal-card.tsx'

// Пользовательские поля в списках, фильтре и на карточке канбана (тикет crm-fields/07):
// ключи колонок и условий `custom.<id>` (у интервала дат в условии — `.start` / `.end`) и
// значение поля строкой для ячейки списка и карточки канбана. Сервер отдаёт в `custom` только
// видимые пользователю поля и проверяет условия сам — здесь только показ.

/** Значения пользовательских полей записи: код поля → значение (форма — тикет 02). */
export type CustomValues = Readonly<Record<string, unknown>>

/** Поля, которые можно выбрать в фильтре, колонке и на карточке: не в архиве, не удаляются. */
export function liveFields(
  fields: readonly FieldDefinitionSummary[] | undefined,
): FieldDefinitionSummary[] {
  return (fields ?? []).filter((f) => f.archivedAt === null && f.purgeRequestedAt === null)
}

/** Ключ колонки и сортировки по полю. */
export const customColumn = (field: Pick<FieldDefinitionSummary, 'id'>) =>
  `${CUSTOM_FIELD_PREFIX}${field.id}`

/** Поле колонки или условия `custom.<id>[.start|.end]` и часть интервала; не поле — null. */
export function customFieldOf(
  key: string,
  fields: readonly FieldDefinitionSummary[],
): { field: FieldDefinitionSummary; part?: DateRangePart } | null {
  const ref = parseCustomRef(key)
  if (!ref) return null
  const field = fields.find((f) => f.id === ref.key || f.code === ref.key)
  if (!field) return null
  return ref.part === undefined ? { field } : { field, part: ref.part }
}

/** Ключи условий по полям: у интервала дат — начало и конец отдельно. */
export function customConditionKeys(fields: readonly FieldDefinitionSummary[]): string[] {
  return fields.flatMap((field) =>
    field.type === 'date_range'
      ? [`${customColumn(field)}.start`, `${customColumn(field)}.end`]
      : [customColumn(field)],
  )
}

/** Операторы условия по полю (тот же белый список, что проверяет сервер). */
export function customFieldOperators(
  key: string,
  fields: readonly FieldDefinitionSummary[],
): readonly FilterOperator[] {
  const found = customFieldOf(key, fields)
  return found ? customOperators(found.field.type, found.part) : []
}

/** Можно ли сортировать список по колонке-полю. */
export function customColumnSortable(key: string, fields: readonly FieldDefinitionSummary[]) {
  const found = customFieldOf(key, fields)
  return found !== null && customSortable(found.field.type)
}

export interface CustomFormat {
  language: string
  /** Имена пользователей по id — для полей типа «пользователь». */
  users: ReadonlyMap<string, string>
  yes: string
  no: string
}

const locale = (language: string): 'uk' | 'ru' => (language === 'ru' ? 'ru' : 'uk')

function formatDate(value: unknown, language: string): string {
  if (typeof value !== 'string') return ''
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(language, { dateStyle: 'short' }).format(date)
}

function optionName(field: FieldDefinitionSummary, id: unknown, language: string): string {
  const option = field.options.find((o) => o.id === id)
  return option ? fieldName(option, locale(language)) : ''
}

/** Значение поля строкой; пустое значение — пустая строка (на карточке поле не показывается). */
export function formatCustomValue(
  field: FieldDefinitionSummary,
  value: unknown,
  format: CustomFormat,
): string {
  if (value === undefined || value === null) return ''
  const { language } = format
  switch (field.type) {
    case 'number':
      return typeof value === 'number' ? new Intl.NumberFormat(language).format(value) : ''
    case 'money': {
      const money = value as { amount?: unknown; currency?: unknown }
      return typeof money.amount === 'number' && typeof money.currency === 'string'
        ? formatMoney(money.amount, money.currency, language)
        : ''
    }
    case 'date':
      return formatDate(value, language)
    case 'date_range': {
      const range = value as { from?: unknown; to?: unknown }
      const from = formatDate(range.from, language)
      const to = formatDate(range.to, language)
      return from || to ? `${from} — ${to}` : ''
    }
    case 'single_option':
      return optionName(field, value, language)
    case 'multi_option':
      return Array.isArray(value)
        ? value
            .map((id) => optionName(field, id, language))
            .filter((name) => name !== '')
            .join(', ')
        : ''
    case 'boolean':
      return value === true ? format.yes : value === false ? format.no : ''
    case 'user':
      return typeof value === 'string' ? (format.users.get(value) ?? '') : ''
    default:
      return typeof value === 'string' ? value : ''
  }
}

/** Название поля или варианта на языке интерфейса. */
export const customFieldName = (field: FieldNames, language: string) =>
  fieldName(field, locale(language))
