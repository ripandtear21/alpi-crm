import {
  type FieldDefinitionSummary,
  type FieldEntity,
  type FieldGroupSummary,
  type FieldValue,
  fieldGroupAccess,
  fieldName,
  type PipelineSummary,
  type RolePermissions,
} from '@alpi/shared'
import { useQuery } from '@tanstack/react-query'
import { type FormEvent, type ReactNode, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '../../ui/badge.tsx'
import { Button } from '../../ui/button.tsx'
import { cx } from '../../ui/cx.ts'
import { Skeleton } from '../../ui/feedback.tsx'
import { projectQueryKey } from '../project-switcher/current-project.tsx'
import { type CustomValues, useCustomFieldsApi } from './custom-fields-api.tsx'
import { FieldEditor, type FieldMember, FieldValueView, useFieldLocale } from './field-editor.tsx'
import {
  checkDraft,
  type FieldDraft,
  initialDraft,
  isEmptyFieldValue,
  problemKey,
} from './field-values.ts'
import { useSaveErrorText } from './save-error.ts'
import './custom-fields.css'

// Пользовательские поля в карточке сделки, контакта и организации (тикет crm-fields/06;
// spec.md MVP, раздел 5.2): блоки групп по порядку групп, внутри — поля по порядку. Пустые поля
// видны (чтобы их заполнить), группа без видимых полей — нет. Группа сворачивается, состояние
// запоминается у пользователя.
//
// - Скрытая от роли группа и её поля не приходят с сервера (тикет 03); группа «только чтение» —
//   значения без редактора.
// - Карточка сделки показывает только поля, видимые в воронке сделки; после переноса в другую
//   воронку невидимые поля пропадают, их значения сервер хранит.
// - Пустое «важное» поле подсвечено, запрета нет (решено без владельца, подтвердить).
// - Поле, обязательное в воронке сделки, помечено подсказкой «обов'язкове з етапу X».
// - Правка на месте: запрос изменения записи с одним кодом в `custom`; до ответа видно новое
//   значение, отказ возвращает прежнее и показывает ошибку у поля.

/** Ключи кэша описаний полей и групп: их же читает лента (custom-change.tsx). */
export const fieldsQueryKey = (projectId: string, entity: FieldEntity) =>
  projectQueryKey(projectId, 'fields', entity)
export const fieldGroupsQueryKey = (projectId: string, entity: FieldEntity) =>
  projectQueryKey(projectId, 'field-groups', entity)
/** Тот же ключ, что у списка участников в карточке сделки: ответ один и тот же. */
export const membersQueryKey = (projectId: string) => projectQueryKey(projectId, 'members')

/** Ключ localStorage со свёрнутыми группами пользователя. */
export const COLLAPSED_GROUPS_KEY = 'alpi.fieldGroups.collapsed.'

/**
 * Свёрнутые группы пользователя (id групп всех сущностей).
 * shortcut: состояние хранится в браузере (localStorage), а не на сервере — на другом
 * устройстве группы снова развёрнуты; переделать, когда у пользователя появятся настройки в API.
 */
function useCollapsedGroups(userId: string) {
  const key = `${COLLAPSED_GROUPS_KEY}${userId}`
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => {
    try {
      const stored: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]')
      return new Set(Array.isArray(stored) ? stored.filter((id) => typeof id === 'string') : [])
    } catch {
      return new Set()
    }
  })
  const toggle = (groupId: string) => {
    const next = new Set(collapsed)
    if (next.has(groupId)) next.delete(groupId)
    else next.add(groupId)
    setCollapsed(next)
    try {
      window.localStorage.setItem(key, JSON.stringify([...next]))
    } catch {
      // localStorage недоступен (приватный режим): состояние живёт до перезагрузки.
    }
  }
  return { collapsed, toggle }
}

/** Видно ли поле сделки в воронке. У контакта и организации `pipelines` всегда 'all'. */
export function visibleInPipeline(
  field: Pick<FieldDefinitionSummary, 'pipelines'>,
  pipelineId: string | undefined,
): boolean {
  return (
    field.pipelines === 'all' || pipelineId === undefined || field.pipelines.includes(pipelineId)
  )
}

export interface CustomFieldGroupsProps<T extends object> {
  entity: FieldEntity
  projectId: string
  /** Вошедший пользователь: свёрнутые группы запоминаются за ним. */
  user: FieldMember
  /** Запись: id и её `custom`. */
  record: { id: string; custom: CustomValues }
  /** Права роли в проекте: доступ к группам (fieldGroupAccess). */
  permissions: RolePermissions
  /** Право менять саму запись. Без него все поля только для чтения. */
  canEdit: boolean
  /** Сделка: её воронка — какие поля видны и какие обязательны. */
  deal?: { pipelineId: string }
  /** Воронки проекта: названия этапов в подсказке «обов'язкове з етапу X». */
  pipelines?: readonly PipelineSummary[]
  /** Фильтр полей колонки карточки по подписи. */
  matches?: (label: string) => boolean
  /** Ответ API на правку — запись целиком; карточка кладёт её в свой кэш. */
  onSaved: (record: T) => void
}

export function CustomFieldGroups<T extends object>(props: CustomFieldGroupsProps<T>) {
  const { entity, projectId, permissions, deal, matches } = props
  const { t } = useTranslation('custom-fields')
  const api = useCustomFieldsApi()
  const locale = useFieldLocale()
  const { collapsed, toggle } = useCollapsedGroups(props.user.userId)
  const groups = useQuery({
    queryKey: fieldGroupsQueryKey(projectId, entity),
    queryFn: () => api.groups(projectId, entity),
    retry: false,
  })
  const fields = useQuery({
    queryKey: fieldsQueryKey(projectId, entity),
    queryFn: () => api.fields(projectId, entity),
    retry: false,
  })
  const shown = (fields.data ?? []).filter(
    (field) =>
      field.archivedAt === null &&
      field.purgeRequestedAt === null &&
      visibleInPipeline(field, deal?.pipelineId) &&
      (matches?.(fieldName(field, locale)) ?? true),
  )
  const members = useQuery({
    queryKey: membersQueryKey(projectId),
    queryFn: () => api.members(projectId),
    enabled: shown.some((field) => field.type === 'user'),
    retry: false,
  })

  if (groups.isError || fields.isError) {
    return (
      <p className="ui-notice" role="alert">
        {t('groups.failed')}
      </p>
    )
  }
  if (groups.isPending || fields.isPending) {
    return <Skeleton lines={2} label={t('groups.loading')} />
  }

  const blocks = [...groups.data]
    .sort((a, b) => a.position - b.position)
    .map((group) => ({
      group,
      access: fieldGroupAccess(permissions, group),
      fields: shown
        .filter((field) => field.groupId === group.id)
        .sort((a, b) => a.position - b.position),
    }))
    .filter((block) => block.access !== 'hidden' && block.fields.length > 0)
  if (blocks.length === 0) return null

  return (
    <div className="custom-fields">
      {blocks.map(({ group, access, fields: groupFields }) => (
        <FieldGroupBlock
          key={group.id}
          {...props}
          group={group}
          readOnly={access !== 'edit'}
          fields={groupFields}
          collapsed={collapsed.has(group.id)}
          onToggle={() => toggle(group.id)}
          members={members.data ?? null}
        />
      ))}
    </div>
  )
}

function FieldGroupBlock<T extends object>({
  group,
  readOnly,
  fields,
  collapsed,
  onToggle,
  members,
  ...props
}: CustomFieldGroupsProps<T> & {
  group: FieldGroupSummary
  readOnly: boolean
  fields: FieldDefinitionSummary[]
  collapsed: boolean
  onToggle: () => void
  members: FieldMember[] | null
}) {
  const { t } = useTranslation('custom-fields')
  const api = useCustomFieldsApi()
  const locale = useFieldLocale()
  const bodyId = useId()
  const name = fieldName(group, locale)
  const requiredHint = useRequiredHint(props.deal?.pipelineId, props.pipelines ?? [])
  const save = async (field: FieldDefinitionSummary, value: FieldValue | null) => {
    const saved = await api.save<T>(props.projectId, props.entity, props.record.id, {
      [field.code]: value,
    })
    props.onSaved(saved)
  }
  // Без списка участников (нет права «пользователи и роли») в поле «пользователь» можно выбрать
  // только себя — и оставить уже выбранного.
  const choosable = members ?? [props.user]
  return (
    <section className="custom-fields__group" aria-label={name}>
      <h3 className="custom-fields__head">
        <button
          type="button"
          className="custom-fields__toggle"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          aria-label={t(collapsed ? 'groups.expand' : 'groups.collapse', { group: name })}
          onClick={onToggle}
        >
          <span aria-hidden="true" className="custom-fields__chevron">
            {collapsed ? '▸' : '▾'}
          </span>
          <span>{name}</span>
        </button>
        {readOnly && <Badge>{t('groups.readOnly')}</Badge>}
      </h3>
      {!collapsed && (
        <dl id={bodyId} className="custom-fields__rows">
          {fields.map((field) => (
            <CustomFieldRow
              key={field.id}
              field={field}
              value={props.record.custom[field.code]}
              editable={props.canEdit && !readOnly && field.convertingTo === null}
              requiredHint={requiredHint(field)}
              members={members}
              choosable={choosable}
              onSave={(value) => save(field, value)}
            />
          ))}
        </dl>
      )}
    </section>
  )
}

/** Подсказка об обязательности поля: «всегда» или правило «с этапа» воронки сделки. */
function useRequiredHint(pipelineId: string | undefined, pipelines: readonly PipelineSummary[]) {
  const { t } = useTranslation('custom-fields')
  return (field: FieldDefinitionSummary): string | null => {
    const { required } = field
    if (required.mode === 'always') return t('required.always')
    if (required.mode !== 'stages' || pipelineId === undefined) return null
    const rule = required.stages.find((item) => item.pipelineId === pipelineId)
    if (!rule) return null
    if (rule.stageId === null) return t('required.won')
    const stage = pipelines
      .find((pipeline) => pipeline.id === pipelineId)
      ?.stages.find((item) => item.id === rule.stageId)
    return stage ? t('required.stage', { stage: stage.name }) : null
  }
}

/** Одинаковые ли значения: пустые равны между собой. */
function sameValue(a: unknown, b: unknown): boolean {
  if (isEmptyFieldValue(a) && isEmptyFieldValue(b)) return true
  return JSON.stringify(a) === JSON.stringify(b)
}

const LINK_TYPES = new Set(['phone', 'email', 'url'])

function CustomFieldRow({
  field,
  value,
  editable,
  requiredHint,
  members,
  choosable,
  onSave,
}: {
  field: FieldDefinitionSummary
  value: unknown
  editable: boolean
  requiredHint: string | null
  members: FieldMember[] | null
  choosable: readonly FieldMember[]
  onSave: (value: FieldValue | null) => Promise<void>
}) {
  const { t } = useTranslation('custom-fields')
  const locale = useFieldLocale()
  const saveErrorText = useSaveErrorText()
  const name = fieldName(field, locale)
  const [draft, setDraft] = useState<FieldDraft | null>(null)
  /** Значение, которое ушло на сервер: видно до ответа. */
  const [pending, setPending] = useState<{ value: FieldValue | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const errorId = useId()
  const shown = pending ? pending.value : value
  const attention = field.isImportant && isEmptyFieldValue(shown)

  const open = () => {
    setError(null)
    setDraft(initialDraft(field.type, value))
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (draft === null) return
    const users = members
      ? new Map(members.map((member) => [member.userId, { disabled: member.disabled }]))
      : undefined
    const checked = checkDraft(
      field,
      draft,
      users ? { previous: value, users } : { previous: value },
    )
    if (!checked.ok) {
      setError(t(`problems.${problemKey(field.type, checked.problem)}`))
      return
    }
    setDraft(null)
    setError(null)
    if (sameValue(checked.value, value)) return
    setPending({ value: checked.value })
    try {
      await onSave(checked.value)
    } catch (failure) {
      setError(saveErrorText(failure, field.type))
    } finally {
      setPending(null)
    }
  }

  const view = <FieldValueView field={field} value={shown} members={members ?? choosable} />
  let body: ReactNode
  if (draft !== null) {
    body = (
      <form className="custom-field__form" aria-label={name} noValidate onSubmit={submit}>
        <FieldEditor
          field={field}
          label={name}
          draft={draft}
          onDraft={setDraft}
          value={value}
          members={choosable}
          invalid={error !== null}
          autoFocus
        />
        <span className="custom-field__actions">
          <Button type="submit" size="sm" variant="primary">
            {t('save')}
          </Button>
          <Button
            size="sm"
            variant="quiet"
            onClick={() => {
              setDraft(null)
              setError(null)
            }}
          >
            {t('cancel')}
          </Button>
        </span>
      </form>
    )
  } else if (!editable || pending) {
    body = view
  } else if (LINK_TYPES.has(field.type) && !isEmptyFieldValue(shown)) {
    // Ссылка остаётся ссылкой (звонок, письмо, сайт), править — отдельной кнопкой.
    body = (
      <span className="custom-field__linked">
        {view}
        <button
          type="button"
          className="custom-field__edit"
          aria-label={t('value.edit', { field: name })}
          onClick={open}
        >
          ✎
        </button>
      </span>
    )
  } else {
    body = (
      <button
        type="button"
        className="custom-field__value"
        aria-label={t('value.edit', { field: name })}
        onClick={open}
      >
        {view}
      </button>
    )
  }

  return (
    <div
      className={cx('custom-field', attention && 'custom-field--attention')}
      data-field={field.code}
    >
      <dt>
        <span className="custom-field__name">{name}</span>
        {requiredHint && <span className="custom-field__hint">{requiredHint}</span>}
      </dt>
      <dd aria-describedby={error ? errorId : undefined}>
        {body}
        {attention && (
          <span title={t('importantHint')}>
            <Badge tone="ask">{t('important')}</Badge>
          </span>
        )}
        {error && (
          <p id={errorId} className="ui-notice custom-field__error" role="alert">
            {error}
          </p>
        )}
      </dd>
    </div>
  )
}
