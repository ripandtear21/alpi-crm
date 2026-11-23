import {
  FILTER_FIELDS,
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
import './lists.css'

// Редактор фильтра списков и канбана (тикет crm-deals/12): условия «поле — оператор —
// значение», связка всего фильтра И/ИЛИ и группы условий со своей связкой внутри. Поля и
// операторы — те же белые списки, что проверяет сервер (packages/shared/src/filters), поэтому
// собранный здесь фильтр проходит parseFilter без сюрпризов.

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
  onApply,
  onClose,
}: {
  entity: FilterEntity
  open: boolean
  value: FilterGroup
  options: FilterOptions
  onApply: (filter: FilterGroup) => void
  onClose: () => void
}) {
  const { t } = useTranslation('lists')
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
        next.op = operatorsOf(specOf(entity, change.field))[0] ?? 'eq'
        next.value = undefined
      }
      if (change.op !== undefined && change.op !== item.op) {
        const wasList = item.op === 'in' || item.op === 'not_in'
        const isList = change.op === 'in' || change.op === 'not_in'
        if (wasList !== isList || VALUELESS_OPERATORS.includes(change.op)) next.value = undefined
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
    const parsed = parseFilter(entity, filter)
    if (!parsed.ok) {
      setInvalid(true)
      return
    }
    onApply(parsed.filter)
  }

  const fieldLabel = (field: string) =>
    t(`fields.${entity}.${field}` as 'fields.deals.title', { defaultValue: field })

  function valueControl(condition: DraftCondition) {
    if (VALUELESS_OPERATORS.includes(condition.op)) return null
    const spec = specOf(entity, condition.field)
    const label = t('filter.value')
    const set = (value: FilterValue | undefined) => editCondition(condition.key, { value })
    const list = condition.op === 'in' || condition.op === 'not_in'
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
    if (spec.type === 'boolean') {
      return (
        <Field label={label} className="filter-condition__value">
          <Select
            size="sm"
            value={condition.value === undefined ? '' : String(condition.value)}
            onChange={(event) =>
              set(event.target.value === '' ? undefined : event.target.value === 'true')
            }
          >
            <option value="">{t('filter.choose')}</option>
            <option value="true">{t('filter.yes')}</option>
            <option value="false">{t('filter.no')}</option>
          </Select>
        </Field>
      )
    }
    if (choices) {
      if (list) {
        const selected = Array.isArray(condition.value) ? condition.value : []
        return (
          <Field label={label} className="filter-condition__value">
            <Select
              size="sm"
              multiple
              value={[...selected]}
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
    const spec = specOf(entity, condition.field)
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
            {operatorsOf(spec).map((op) => (
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
