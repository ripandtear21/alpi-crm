import {
  FILTER_FIELDS,
  type FieldDefinitionSummary,
  type FilterCondition,
  type FilterEntity,
  type FilterFieldSpec,
  type FilterGroup,
  type FilterNode,
  type FilterOperator,
  type FilterValue,
  groupParts,
  isFilterGroup,
  operatorsOf,
  parseFilter,
  VALUELESS_OPERATORS,
} from '@alpi/shared'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../ui/button.tsx'
import { SidePanel } from '../../../ui/dialog.tsx'
import { Notice } from '../../../ui/feedback.tsx'
import { Field, Input, Select } from '../../../ui/field.tsx'
import {
  customConditionKeys,
  customFieldName,
  customFieldOf,
  customFieldOperators,
} from './custom-values.ts'
import './lists.css'

// Редактор фильтра списков и канбана (тикет crm-deals/12): условия «поле — оператор —
// значение», связка всего фильтра И/ИЛИ и группы условий со своей связкой внутри. Поля и
// операторы — те же белые списки, что проверяет сервер (packages/shared/src/filters), поэтому
// собранный здесь фильтр проходит parseFilter без сюрпризов. Пользовательские поля (тикет
// crm-fields/07) — условия `custom.<id>` с операторами по типу поля; поля приходят из
// `/v1/fields` (только видимые пользователю).

/** Вариант значения поля-справочника (воронка, этап, ответственный…). */
export interface FilterOption {
  value: string
  label: string
}

/** Варианты значений по полям; поле без вариантов — ввод текстом. */
export type FilterOptions = Partial<Record<string, FilterOption[]>>

interface DraftCondition {
  kind: 'condition'
  key: number
  field: string
  op: FilterOperator
  value: FilterValue | undefined
}

interface DraftGroup {
  kind: 'group'
  key: number
  op: 'and' | 'or'
  items: DraftCondition[]
}

interface Draft {
  op: 'and' | 'or'
  items: (DraftCondition | DraftGroup)[]
}

let keys = 0
const nextKey = () => {
  keys += 1
  return keys
}

function specOf(entity: FilterEntity, field: string): FilterFieldSpec {
  return (FILTER_FIELDS[entity] as Record<string, FilterFieldSpec>)[field] ?? { type: 'text' }
}

/** Операторы поля условия: системного — по описанию, пользовательского — по типу. */
function operatorsFor(
  entity: FilterEntity,
  field: string,
  custom: readonly FieldDefinitionSummary[],
): readonly FilterOperator[] {
  return customFieldOf(field, custom)
    ? customFieldOperators(field, custom)
    : operatorsOf(specOf(entity, field))
}

const isList = (op: FilterOperator) => op === 'in' || op === 'not_in'

function newCondition(entity: FilterEntity): DraftCondition {
  const field = Object.keys(FILTER_FIELDS[entity])[0] ?? ''
  const op = operatorsOf(specOf(entity, field))[0] ?? 'eq'
  return { kind: 'condition', key: nextKey(), field, op, value: undefined }
}

function toDraftCondition(node: FilterCondition): DraftCondition {
  return { kind: 'condition', key: nextKey(), field: node.field, op: node.op, value: node.value }
}

/** Фильтр → черновик редактора: группы глубже второго уровня редактор раскрывает в условия. */
function toDraft(filter: FilterGroup): Draft {
  const flatten = (node: FilterNode): DraftCondition[] =>
    isFilterGroup(node) ? groupParts(node).items.flatMap(flatten) : [toDraftCondition(node)]
  const { op, items } = groupParts(filter)
  return {
    op,
    items: items.map((item) => {
      if (!isFilterGroup(item)) return toDraftCondition(item)
      const group = groupParts(item)
      return { kind: 'group', key: nextKey(), op: group.op, items: group.items.flatMap(flatten) }
    }),
  }
}

function conditionOf(draft: DraftCondition): FilterCondition {
  return VALUELESS_OPERATORS.includes(draft.op)
    ? { field: draft.field, op: draft.op }
    : {
        field: draft.field,
        op: draft.op,
        ...(draft.value === undefined ? {} : { value: draft.value }),
      }
}

function fromDraft(draft: Draft): FilterGroup {
  const items: FilterNode[] = draft.items.map((item) => {
    if (item.kind === 'condition') return conditionOf(item)
    const conditions = item.items.map(conditionOf)
    return item.op === 'and' ? { and: conditions } : { or: conditions }
  })
  return draft.op === 'and' ? { and: items } : { or: items }
}

/** Число условий фильтра — для кнопки «Фільтр (N)». */
export function conditionCount(filter: FilterGroup): number {
  const count = (node: FilterNode): number =>
    isFilterGroup(node) ? groupParts(node).items.reduce((sum, item) => sum + count(item), 0) : 1
  return count(filter)
}

/** Дата ISO → значение поля type="date" в часовом поясе браузера. */
function toDateInput(value: FilterValue | undefined): string {
  if (typeof value !== 'string') return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Значение поля type="date" → полночь этого дня в часовом поясе браузера, ISO 8601. */
function fromDateInput(value: string): string | undefined {
  if (!value) return undefined
  const date = new Date(`${value}T00:00:00`)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

export function FilterEditor({
  entity,
  open,
  value,
  options,
  customFields = [],
  onApply,
  onClose,
}: {
  entity: FilterEntity
  open: boolean
  value: FilterGroup
  options: FilterOptions
  /** Пользовательские поля сущности, видимые пользователю (не в архиве). */
  customFields?: readonly FieldDefinitionSummary[]
  onApply: (filter: FilterGroup) => void
  onClose: () => void
}) {
  const { t, i18n } = useTranslation('lists')
  const [draft, setDraft] = useState<Draft>(() => toDraft(value))
  const [invalid, setInvalid] = useState(false)

  function update(change: (draft: Draft) => Draft) {
    setInvalid(false)
    setDraft(change)
  }

  function editCondition(key: number, change: Partial<DraftCondition>) {
    const apply = (item: DraftCondition) => {
      if (item.key !== key) return item
      const next = { ...item, ...change }
      // Новое поле — первый оператор этого поля и пустое значение.
      if (change.field !== undefined && change.field !== item.field) {
        next.op = operatorsFor(entity, change.field, customFields)[0] ?? 'eq'
        next.value = undefined
      }
      if (change.op !== undefined && change.op !== item.op) {
        const shapeChanged =
          isList(item.op) !== isList(change.op) ||
          (item.op === 'between') !== (change.op === 'between')
        if (shapeChanged || VALUELESS_OPERATORS.includes(change.op)) next.value = undefined
      }
      return next
    }
    update((current) => ({
      ...current,
      items: current.items.map((item) =>
        item.kind === 'condition' ? apply(item) : { ...item, items: item.items.map(apply) },
      ),
    }))
  }

  function removeCondition(key: number) {
    update((current) => ({
      ...current,
      items: current.items
        .filter((item) => item.key !== key)
        .map((item) =>
          item.kind === 'group'
            ? { ...item, items: item.items.filter((c) => c.key !== key) }
            : item,
        )
        .filter((item) => item.kind === 'condition' || item.items.length > 0),
    }))
  }

  function apply() {
    const filter = fromDraft(draft)
    const parsed = parseFilter(entity, filter, customFields)
    if (!parsed.ok) {
      setInvalid(true)
      return
    }
    onApply(parsed.filter)
  }

  const fieldLabel = (field: string) => {
    const custom = customFieldOf(field, customFields)
    if (!custom) {
      return t(`fields.${entity}.${field}` as 'fields.deals.title', { defaultValue: field })
    }
    const name = customFieldName(custom.field, i18n.language)
    return custom.part === undefined ? name : t(`filter.range.${custom.part}`, { name })
  }

  /** «Так» / «Ні»: значение условия — true или false. */
  function booleanControl(condition: DraftCondition) {
    return (
      <Field label={t('filter.value')} className="filter-condition__value">
        <Select
          size="sm"
          value={condition.value === undefined ? '' : String(condition.value)}
          onChange={(event) =>
            editCondition(condition.key, {
              value: event.target.value === '' ? undefined : event.target.value === 'true',
            })
          }
        >
          <option value="">{t('filter.choose')}</option>
          <option value="true">{t('filter.yes')}</option>
          <option value="false">{t('filter.no')}</option>
        </Select>
      </Field>
    )
  }

  /** Выбор из вариантов: «одне з» / «жодне з» — несколько, иначе один. */
  function choiceControl(condition: DraftCondition, choices: FilterOption[]) {
    const label = t('filter.value')
    const set = (value: FilterValue | undefined) => editCondition(condition.key, { value })
    if (isList(condition.op)) {
      const selected = Array.isArray(condition.value) ? condition.value.map(String) : []
      return (
        <Field label={label} className="filter-condition__value">
          <Select
            size="sm"
            multiple
            value={selected}
            onChange={(event) => {
              const values = Array.from(event.target.selectedOptions, (o) => o.value)
              set(values.length === 0 ? undefined : values)
            }}
          >
            {choices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </Select>
        </Field>
      )
    }
    return (
      <Field label={label} className="filter-condition__value">
        <Select
          size="sm"
          value={typeof condition.value === 'string' ? condition.value : ''}
          onChange={(event) => set(event.target.value === '' ? undefined : event.target.value)}
        >
          <option value="">{t('filter.choose')}</option>
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </Select>
      </Field>
    )
  }

  /** Значение условия по пользовательскому полю; «між» — два поля, «від» и «до». */
  function customValueControl(condition: DraftCondition, field: FieldDefinitionSummary) {
    const set = (value: FilterValue | undefined) => editCondition(condition.key, { value })
    const numeric = field.type === 'number' || field.type === 'money'
    const inputType =
      field.type === 'date' || field.type === 'date_range'
        ? 'date'
        : field.type === 'time'
          ? 'time'
          : numeric
            ? 'number'
            : 'text'
    // Незаполненная граница «між»: у числа — NaN, у даты и времени — пустая строка; такой
    // фильтр не проходит parseFilter, и редактор показывает «фільтр заповнено не повністю».
    const blank = numeric ? Number.NaN : ''
    const read = (raw: string): string | number =>
      raw === '' ? blank : numeric ? Number(raw) : raw
    const shown = (value: unknown) =>
      typeof value === 'number'
        ? Number.isNaN(value)
          ? ''
          : String(value)
        : typeof value === 'string'
          ? value
          : ''
    const input = (label: string, value: unknown, onChange: (raw: string) => void) => (
      <Field label={label} className="filter-condition__value">
        <Input
          size="sm"
          type={inputType}
          {...(numeric ? { step: 'any' } : {})}
          value={shown(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      </Field>
    )

    if (condition.op === 'between') {
      const pair = Array.isArray(condition.value) ? condition.value : []
      const setPart = (index: 0 | 1, raw: string) => {
        const next = [pair[0] ?? blank, pair[1] ?? blank]
        next[index] = read(raw)
        set(next as string[] | number[])
      }
      return (
        <>
          {input(t('filter.from'), pair[0], (raw) => setPart(0, raw))}
          {input(t('filter.to'), pair[1], (raw) => setPart(1, raw))}
        </>
      )
    }
    if (field.type === 'boolean') return booleanControl(condition)
    if (field.type === 'single_option' || field.type === 'multi_option') {
      return choiceControl(
        condition,
        field.options.map((o) => ({ value: o.id, label: customFieldName(o, i18n.language) })),
      )
    }
    if (field.type === 'user') {
      return choiceControl(condition, [
        { value: 'me', label: t('filter.me') },
        ...(options.owner ?? options.createdBy ?? []),
      ])
    }
    return input(t('filter.value'), condition.value, (raw) =>
      set(raw === '' ? undefined : read(raw)),
    )
  }

  function valueControl(condition: DraftCondition) {
    if (VALUELESS_OPERATORS.includes(condition.op)) return null
    const custom = customFieldOf(condition.field, customFields)
    if (custom) return customValueControl(condition, custom.field)
    const spec = specOf(entity, condition.field)
    const label = t('filter.value')
    const set = (value: FilterValue | undefined) => editCondition(condition.key, { value })
    let choices: FilterOption[] | undefined = options[condition.field]
    if (spec.type === 'enum') {
      choices = (spec.values ?? []).map((v) => ({
        value: v,
        label: t(`values.${condition.field}.${v}` as 'values.status.open', { defaultValue: v }),
      }))
    }
    if (spec.type === 'user') {
      choices = [{ value: 'me', label: t('filter.me') }, ...(options[condition.field] ?? [])]
    }
    if (spec.type === 'boolean') return booleanControl(condition)
    if (choices) return choiceControl(condition, choices)
    if (spec.type === 'date') {
      return (
        <Field label={label} className="filter-condition__value">
          <Input
            size="sm"
            type="date"
            value={toDateInput(condition.value)}
            onChange={(event) => set(fromDateInput(event.target.value))}
          />
        </Field>
      )
    }
    if (spec.type === 'number') {
      return (
        <Field label={label} className="filter-condition__value">
          <Input
            size="sm"
            type="number"
            min={0}
            step="0.01"
            value={typeof condition.value === 'number' ? String(condition.value) : ''}
            onChange={(event) =>
              set(event.target.value === '' ? undefined : Number(event.target.value))
            }
          />
        </Field>
      )
    }
    return (
      <Field label={label} className="filter-condition__value">
        <Input
          size="sm"
          value={typeof condition.value === 'string' ? condition.value : ''}
          onChange={(event) => set(event.target.value === '' ? undefined : event.target.value)}
        />
      </Field>
    )
  }

  function conditionRow(condition: DraftCondition) {
    const customKeys = customConditionKeys(customFields)
    return (
      <fieldset key={condition.key} className="filter-condition">
        <legend className="visually-hidden">{fieldLabel(condition.field)}</legend>
        <Field label={t('filter.field')} className="filter-condition__field">
          <Select
            size="sm"
            value={condition.field}
            onChange={(event) => editCondition(condition.key, { field: event.target.value })}
          >
            {Object.keys(FILTER_FIELDS[entity]).map((field) => (
              <option key={field} value={field}>
                {fieldLabel(field)}
              </option>
            ))}
            {customKeys.length > 0 && (
              <optgroup label={t('filter.customFields')}>
                {customKeys.map((field) => (
                  <option key={field} value={field}>
                    {fieldLabel(field)}
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
        </Field>
        <Field label={t('filter.operator')} className="filter-condition__op">
          <Select
            size="sm"
            value={condition.op}
            onChange={(event) =>
              editCondition(condition.key, { op: event.target.value as FilterOperator })
            }
          >
            {operatorsFor(entity, condition.field, customFields).map((op) => (
              <option key={op} value={op}>
                {t(`ops.${op}`)}
              </option>
            ))}
          </Select>
        </Field>
        {valueControl(condition)}
        <Button
          size="sm"
          variant="quiet"
          className="filter-condition__remove"
          onClick={() => removeCondition(condition.key)}
        >
          {t('filter.remove')}
        </Button>
      </fieldset>
    )
  }

  const matchSelect = (op: 'and' | 'or', onChange: (op: 'and' | 'or') => void) => (
    <Field label={t('filter.match')}>
      <Select
        size="sm"
        value={op}
        onChange={(event) => onChange(event.target.value as 'and' | 'or')}
      >
        <option value="and">{t('filter.and')}</option>
        <option value="or">{t('filter.or')}</option>
      </Select>
    </Field>
  )

  return (
    <SidePanel
      open={open}
      onClose={onClose}
      className="filter-panel"
      title={t('filter.title')}
      footer={
        <>
          <Button
            variant="quiet"
            onClick={() => {
              setDraft({ op: 'and', items: [] })
              onApply({ and: [] })
            }}
          >
            {t('filter.clear')}
          </Button>
          <Button variant="primary" onClick={apply}>
            {t('filter.apply')}
          </Button>
        </>
      }
    >
      <div className="filter-editor">
        {matchSelect(draft.op, (op) => update((current) => ({ ...current, op })))}
        {draft.items.map((item) =>
          item.kind === 'condition' ? (
            conditionRow(item)
          ) : (
            <section key={item.key} className="filter-group" aria-label={t('filter.group')}>
              {matchSelect(item.op, (op) =>
                update((current) => ({
                  ...current,
                  items: current.items.map((other) =>
                    other.key === item.key && other.kind === 'group' ? { ...other, op } : other,
                  ),
                })),
              )}
              {item.items.map(conditionRow)}
              <div className="filter-editor__actions">
                <Button
                  size="sm"
                  onClick={() =>
                    update((current) => ({
                      ...current,
                      items: current.items.map((other) =>
                        other.key === item.key && other.kind === 'group'
                          ? { ...other, items: [...other.items, newCondition(entity)] }
                          : other,
                      ),
                    }))
                  }
                >
                  {t('filter.addCondition')}
                </Button>
                <Button
                  size="sm"
                  variant="quiet"
                  onClick={() =>
                    update((current) => ({
                      ...current,
                      items: current.items.filter((other) => other.key !== item.key),
                    }))
                  }
                >
                  {t('filter.removeGroup')}
                </Button>
              </div>
            </section>
          ),
        )}
        <div className="filter-editor__actions">
          <Button
            size="sm"
            onClick={() =>
              update((current) => ({ ...current, items: [...current.items, newCondition(entity)] }))
            }
          >
            {t('filter.addCondition')}
          </Button>
          <Button
            size="sm"
            onClick={() =>
              update((current) => ({
                ...current,
                items: [
                  ...current.items,
                  { kind: 'group', key: nextKey(), op: 'and', items: [newCondition(entity)] },
                ],
              }))
            }
          >
            {t('filter.addGroup')}
          </Button>
        </div>
        {invalid && <Notice kind="alert">{t('filter.invalid')}</Notice>}
      </div>
    </SidePanel>
  )
}
