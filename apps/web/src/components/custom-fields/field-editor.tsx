import {
  FIELD_MONEY_CURRENCIES,
  type FieldDefinitionSummary,
  type FieldOptionSummary,
  type FieldType,
  fieldName,
  formatPhone,
  type MemberSummary,
} from '@alpi/shared'
import { useTranslation } from 'react-i18next'
import { Badge } from '../../ui/badge.tsx'
import { Checkbox } from '../../ui/checkbox.tsx'
import { Input, Select, Textarea } from '../../ui/field.tsx'
import {
  type FieldDraft,
  isEmptyFieldValue,
  type MoneyDraft,
  type RangeDraft,
  safeHttpUrl,
} from './field-values.ts'

// Общие редакторы и показ значений пользовательских полей по 15 типам (тикет crm-fields/06):
// карточки сделки, контакта и организации, форма заполнения обязательных полей (тикет 04).
// Варианты для выбора — без архивных; уже выбранный архивный вариант и отключённый участник
// показываются с пометкой. Ссылка открывается в новой вкладке и только если она http(s).

/** Участник проекта для поля «пользователь». */
export type FieldMember = Pick<MemberSummary, 'userId' | 'name' | 'disabled'>

/** Язык названий полей и вариантов: русского названия нет — украинское. */
export function useFieldLocale(): 'uk' | 'ru' {
  const { i18n } = useTranslation()
  return i18n.language === 'ru' ? 'ru' : 'uk'
}

/** Название типа поля на языке интерфейса: карточки, экран настроек полей (тикет 05). */
export function useFieldTypeLabel(): (type: FieldType) => string {
  const { t } = useTranslation('custom-fields')
  return (type) => t(`types.${type}`)
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Вариант значения по id (с архивными); нет у поля — undefined. */
function optionOf(field: Pick<FieldDefinitionSummary, 'options'>, id: unknown) {
  return field.options.find((option) => option.id === id)
}

/** id вариантов в значении — для «один вариант» и «несколько вариантов». */
function optionIds(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
}

/**
 * Значение поля одной строкой: карточка (вместе с FieldValueView) и лента «було → стало».
 * Пустое — '—'.
 */
export function useFormatFieldValue(): (
  field: Pick<FieldDefinitionSummary, 'type' | 'options'>,
  value: unknown,
  members: readonly FieldMember[] | null,
) => string {
  const { t, i18n } = useTranslation('custom-fields')
  const locale = useFieldLocale()
  const language = i18n.language
  const day = (text: string) =>
    new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeZone: 'UTC' }).format(
      new Date(`${text}T00:00:00Z`),
    )
  const optionName = (field: Pick<FieldDefinitionSummary, 'options'>, id: string) => {
    const option = optionOf(field, id)
    return option ? fieldName(option, locale) : t('value.unknownOption')
  }

  return (field, value, members) => {
    if (isEmptyFieldValue(value)) return t('value.none')
    switch (field.type) {
      case 'number':
        return typeof value === 'number' ? new Intl.NumberFormat(language).format(value) : '?'
      case 'money':
        return isObject(value) && typeof value.amount === 'number'
          ? new Intl.NumberFormat(language, {
              style: 'currency',
              currency: String(value.currency),
            }).format(value.amount)
          : '?'
      case 'date':
        return typeof value === 'string' ? day(value) : '?'
      case 'date_range':
        return isObject(value) && typeof value.from === 'string' && typeof value.to === 'string'
          ? `${day(value.from)} – ${day(value.to)}`
          : '?'
      case 'single_option':
      case 'multi_option':
        return optionIds(value)
          .map((id) => optionName(field, id))
          .join(', ')
      case 'boolean':
        return value === true ? t('value.yes') : t('value.no')
      case 'user':
        return members?.find((member) => member.userId === value)?.name ?? t('value.hiddenUser')
      case 'phone':
        return typeof value === 'string' ? formatPhone(value) : '?'
      default:
        return typeof value === 'string' ? value : '?'
    }
  }
}

/** Значение поля в карточке: телефон — `tel:`, email — `mailto:`, ссылка — новая вкладка. */
export function FieldValueView({
  field,
  value,
  members,
}: {
  field: Pick<FieldDefinitionSummary, 'type' | 'options'>
  value: unknown
  members: readonly FieldMember[] | null
}) {
  const { t } = useTranslation('custom-fields')
  const format = useFormatFieldValue()
  const locale = useFieldLocale()
  if (isEmptyFieldValue(value)) {
    return <span className="custom-field__empty">{t('value.empty')}</span>
  }
  const text = format(field, value, members)
  switch (field.type) {
    case 'phone':
      return <a href={`tel:${String(value)}`}>{text}</a>
    case 'email':
      return <a href={`mailto:${String(value)}`}>{text}</a>
    case 'url': {
      const href = safeHttpUrl(value)
      return href ? (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {text}
        </a>
      ) : (
        <span>{text}</span>
      )
    }
    case 'single_option':
    case 'multi_option':
      return (
        <span className="custom-field__options">
          {optionIds(value).map((id) => {
            const option = optionOf(field, id)
            return (
              <span key={id} className="custom-field__option">
                {option ? fieldName(option, locale) : t('value.unknownOption')}
                {option?.archivedAt && <Badge>{t('value.archived')}</Badge>}
              </span>
            )
          })}
        </span>
      )
    case 'user': {
      const member = members?.find((item) => item.userId === value)
      return (
        <span>
          {text}
          {member?.disabled && <Badge>{t('value.disabled')}</Badge>}
        </span>
      )
    }
    case 'long_text':
      return <span className="custom-field__long">{text}</span>
    default:
      return <span>{text}</span>
  }
}

/**
 * Варианты для выбора: действующие и те архивные, что уже выбраны в значении записи (с
 * пометкой) — их можно оставить, но не выбрать заново.
 */
function choosableOptions(field: Pick<FieldDefinitionSummary, 'options'>, value: unknown) {
  const chosen = optionIds(value)
  return field.options.filter((option) => option.archivedAt === null || chosen.includes(option.id))
}

/**
 * Редактор значения по типу поля. Управляемый: черновик держит вызывающий (initialDraft,
 * checkDraft, draftToRaw — field-values.ts). `value` — значение записи: по нему остаются в
 * списке уже выбранные архивный вариант и отключённый участник.
 */
export function FieldEditor({
  field,
  label,
  draft,
  onDraft,
  value,
  members,
  invalid,
  autoFocus,
}: {
  field: Pick<FieldDefinitionSummary, 'type' | 'options'>
  /** Подпись для чтения с экрана: название поля. */
  label: string
  draft: FieldDraft
  onDraft: (draft: FieldDraft) => void
  value: unknown
  /** Участники проекта для «пользователя». */
  members: readonly FieldMember[]
  invalid?: boolean
  autoFocus?: boolean
}) {
  const { t } = useTranslation('custom-fields')
  const locale = useFieldLocale()
  const text = typeof draft === 'string' ? draft : ''
  const common = {
    'aria-label': label,
    'aria-invalid': invalid || undefined,
    autoFocus,
  }
  const optionLabel = (option: FieldOptionSummary) =>
    option.archivedAt
      ? `${fieldName(option, locale)} (${t('value.archived')})`
      : fieldName(option, locale)

  switch (field.type) {
    case 'long_text':
      return (
        <Textarea
          {...common}
          rows={3}
          value={text}
          onChange={(event) => onDraft(event.target.value)}
        />
      )
    case 'number':
      return (
        <Input
          {...common}
          size="sm"
          inputMode="decimal"
          value={text}
          onChange={(event) => onDraft(event.target.value)}
        />
      )
    case 'money': {
      const money = draft as MoneyDraft
      return (
        <span className="custom-field__pair">
          <Input
            {...common}
            size="sm"
            inputMode="decimal"
            value={money.amount}
            onChange={(event) => onDraft({ ...money, amount: event.target.value })}
          />
          <Select
            size="sm"
            aria-label={`${label}: ${t('value.currency')}`}
            value={money.currency}
            onChange={(event) => {
              const currency = FIELD_MONEY_CURRENCIES.find((c) => c === event.target.value)
              if (currency) onDraft({ ...money, currency })
            }}
          >
            {FIELD_MONEY_CURRENCIES.map((currency) => (
              <option key={currency} value={currency}>
                {currency}
              </option>
            ))}
          </Select>
        </span>
      )
    }
    case 'date':
    case 'time':
      return (
        <Input
          {...common}
          size="sm"
          type={field.type}
          value={text}
          onChange={(event) => onDraft(event.target.value)}
        />
      )
    case 'date_range': {
      const range = draft as RangeDraft
      return (
        <span className="custom-field__pair">
          <Input
            {...common}
            size="sm"
            type="date"
            aria-label={`${label}: ${t('value.rangeFrom')}`}
            value={range.from}
            onChange={(event) => onDraft({ ...range, from: event.target.value })}
          />
          <Input
            size="sm"
            type="date"
            aria-label={`${label}: ${t('value.rangeTo')}`}
            aria-invalid={invalid || undefined}
            value={range.to}
            onChange={(event) => onDraft({ ...range, to: event.target.value })}
          />
        </span>
      )
    }
    case 'single_option':
      return (
        <Select
          {...common}
          size="sm"
          value={text}
          onChange={(event) => onDraft(event.target.value)}
        >
          <option value="">{t('value.none')}</option>
          {choosableOptions(field, value).map((option) => (
            <option key={option.id} value={option.id}>
              {optionLabel(option)}
            </option>
          ))}
        </Select>
      )
    case 'multi_option': {
      const chosen = Array.isArray(draft) ? draft : []
      return (
        <fieldset className="custom-field__checks" aria-label={label}>
          {choosableOptions(field, value).map((option) => (
            <Checkbox
              key={option.id}
              label={optionLabel(option)}
              checked={chosen.includes(option.id)}
              onChange={(event) =>
                onDraft(
                  event.target.checked
                    ? [...chosen, option.id]
                    : chosen.filter((id) => id !== option.id),
                )
              }
            />
          ))}
        </fieldset>
      )
    }
    case 'boolean':
      return (
        <Select
          {...common}
          size="sm"
          value={text}
          onChange={(event) => onDraft(event.target.value)}
        >
          <option value="">{t('value.none')}</option>
          <option value="true">{t('value.yes')}</option>
          <option value="false">{t('value.no')}</option>
        </Select>
      )
    case 'user': {
      const choosable = members.filter((member) => !member.disabled || member.userId === value)
      return (
        <Select
          {...common}
          size="sm"
          value={text}
          onChange={(event) => onDraft(event.target.value)}
        >
          <option value="">{t('value.none')}</option>
          {choosable.map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.disabled ? `${member.name} (${t('value.disabled')})` : member.name}
            </option>
          ))}
        </Select>
      )
    }
    default:
      return (
        <Input
          {...common}
          size="sm"
          type={
            field.type === 'phone'
              ? 'tel'
              : field.type === 'email'
                ? 'email'
                : field.type === 'url'
                  ? 'url'
                  : 'text'
          }
          value={text}
          onChange={(event) => onDraft(event.target.value)}
        />
      )
  }
}
