import {
  type FieldDefinitionSummary,
  type FieldEntity,
  type FieldGroupSummary,
  fieldCodeEditable,
  hasOptions,
  type PipelineSummary,
  type RoleSummary,
  typeChangeWithValues,
} from '@alpi/shared'
import { type FormEvent, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '../../../ui/badge.tsx'
import { Button } from '../../../ui/button.tsx'
import { Checkbox } from '../../../ui/checkbox.tsx'
import { Dialog } from '../../../ui/dialog.tsx'
import { Notice } from '../../../ui/feedback.tsx'
import { Field, Input, Select } from '../../../ui/field.tsx'
import { moved } from '../directory-controls.tsx'
import {
  adoptSavedOptions,
  allowedTypes,
  createInput,
  emptyForm,
  errorTarget,
  type FieldForm,
  type FormErrors,
  fieldChange,
  formFromField,
  newDraftKey,
  type OptionDraft,
  rolesBlockedByGroup,
  STAGE_WON,
  scopedPipelineIds,
  unsavedOptions,
  validateForm,
  withNameUk,
} from './field-form.ts'
import { FieldsApiError, type FieldsSettingsApi } from './fields-api.ts'
import { useErrorText, useLocalName } from './fields-data.ts'

// Диалог создания и изменения поля (тикет crm-fields/05). Варианты существующего поля
// сохраняются вместе с полем: сначала поле, потом новые варианты, переименования и архив,
// потом порядок (запросы вариантов тикета 01 — по одному). Запросы не в одной транзакции:
// если один из них не прошёл после уже сохранённых, диалог перечитывает поле, отдаёт созданным
// вариантам их id и говорит, что сохранено частично и что осталось, — повтор досохраняет только
// остаток, без дублей.

/** Что уже записано за попытку сохранения: было ли изменение и id созданных вариантов. */
interface SaveProgress {
  wrote: boolean
  created: Map<string, string>
}

export function FieldDialog({
  api,
  projectId,
  entity,
  groups,
  field,
  initialGroupId,
  pipelines,
  roles,
  onClose,
  onSaved,
  onPartlySaved,
}: {
  api: FieldsSettingsApi
  projectId: string
  entity: FieldEntity
  groups: FieldGroupSummary[]
  /** null — новое поле. */
  field: FieldDefinitionSummary | null
  initialGroupId: string
  pipelines: PipelineSummary[]
  /** Роли проекта, если пользователю их можно читать: для предупреждения о скрытой группе. */
  roles: RoleSummary[] | undefined
  onClose: () => void
  onSaved: () => void
  /** Часть изменений уже на сервере, диалог остаётся открытым: обновить экран за ним. */
  onPartlySaved: () => void
}) {
  const { t } = useTranslation('fields-settings')
  const { t: tTypes } = useTranslation('custom-fields')
  const errorText = useErrorText()
  const localName = useLocalName()
  const formId = useId()
  const [form, setForm] = useState<FieldForm>(() =>
    field ? formFromField(field) : emptyForm(initialGroupId),
  )
  const [errors, setErrors] = useState<FormErrors>({})
  const [pending, setPending] = useState(false)
  // Поле, каким его знает сервер: после частичного сохранения — перечитанное, чтобы повтор
  // не отправлял уже сохранённое ещё раз.
  const [base, setBase] = useState(field)

  const activePipelines = pipelines.filter((p) => p.archivedAt === null)
  const activeIds = activePipelines.map((p) => p.id)
  const codeEditable = field === null || fieldCodeEditable(field)
  const types = allowedTypes(field)
  const update = (patch: Partial<FieldForm>) => setForm((current) => ({ ...current, ...patch }))
  const errorOf = (key: keyof FormErrors) => errors[key]

  async function saveOptions(saved: FieldDefinitionSummary, progress: SaveProgress) {
    const ids = new Map<string, string>()
    for (const draft of form.options) {
      if (draft.id !== null) {
        ids.set(draft.key, draft.id)
        const before = saved.options.find((o) => o.id === draft.id)
        if (!before) continue
        const nameUk = draft.nameUk.trim()
        const nameRu = draft.nameRu.trim() === '' ? null : draft.nameRu.trim()
        const change = {
          ...(nameUk !== before.nameUk ? { nameUk } : {}),
          ...(nameRu !== before.nameRu ? { nameRu } : {}),
          ...(draft.archived !== (before.archivedAt !== null) ? { archived: draft.archived } : {}),
        }
        if (Object.keys(change).length > 0) {
          await api.updateOption(projectId, saved.id, draft.id, change)
          progress.wrote = true
        }
      } else if (!draft.archived) {
        const created = await api.createOption(projectId, saved.id, {
          nameUk: draft.nameUk.trim(),
          nameRu: draft.nameRu.trim() === '' ? null : draft.nameRu.trim(),
        })
        ids.set(draft.key, created.id)
        progress.created.set(draft.key, created.id)
        progress.wrote = true
      }
    }
    const desired = [
      ...form.options.filter((o) => !o.archived),
      ...form.options.filter((o) => o.archived),
    ]
      .map((o) => ids.get(o.key))
      .filter((id): id is string => id !== undefined)
    // Порядок на сервере после создания: прежние варианты, новые — в конце. Архивные показаны
    // отдельно, поэтому сравнивается только порядок действующих.
    const active = new Set(
      form.options.filter((o) => !o.archived).map((o) => ids.get(o.key) as string),
    )
    const current = [
      ...saved.options.map((o) => o.id),
      ...desired.filter((id) => !saved.options.some((o) => o.id === id)),
    ]
    const activeOrder = (list: string[]) => list.filter((id) => active.has(id)).join()
    if (activeOrder(desired) !== activeOrder(current)) {
      await api.reorderOptions(projectId, saved.id, desired)
    }
  }

  /**
   * Сохранение оборвалось, а на сервере уже что-то есть (или могло появиться — ответ не дошёл):
   * сверка с сервером, созданным вариантам — их id, и сообщение, что сохранено и что осталось.
   */
  async function recover(fieldId: string, progress: SaveProgress, error: unknown) {
    let fresh: FieldDefinitionSummary | null = null
    try {
      fresh = await api.field(projectId, fieldId)
    } catch {
      fresh = null
    }
    const next = adoptSavedOptions(form, progress.created, fresh)
    setForm((current) => adoptSavedOptions(current, progress.created, fresh))
    onPartlySaved()
    if (fresh) setBase(fresh)
    if (!progress.wrote) {
      setErrors({ form: errorText(error) })
      return
    }
    if (!fresh) {
      setErrors({ form: t('field.savedPartlyUnknown') })
      return
    }
    const left = unsavedOptions(next, fresh)
    setErrors({
      form:
        left.length > 0
          ? t('field.savedPartly', { options: left.map((name) => `«${name}»`).join(', ') })
          : t('field.savedPartlyOrder'),
    })
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    const found = validateForm(form, entity, activeIds, codeEditable)
    setErrors(
      Object.fromEntries(
        Object.entries(found).map(([key, code]) => [key, t(`errors.${code}` as 'errors.unknown')]),
      ),
    )
    if (Object.keys(found).length > 0) return
    setPending(true)
    const progress: SaveProgress = { wrote: false, created: new Map() }
    try {
      if (field === null || base === null) {
        await api.createField(projectId, createInput(form, entity, activeIds))
      } else {
        const change = fieldChange(form, base, activeIds)
        let saved = base
        if (Object.keys(change).length > 0) {
          saved = await api.updateField(projectId, base.id, change)
          progress.wrote = true
        }
        if (hasOptions(form.type)) await saveOptions(saved, progress)
      }
      onSaved()
    } catch (error) {
      // Отказ сервера (4xx) на первый же запрос — ничего не записано, ошибка у своего поля.
      const refused = error instanceof FieldsApiError && error.status >= 400 && error.status < 500
      if (field !== null && (progress.wrote || !refused)) {
        await recover(field.id, progress, error)
      } else {
        const target = error instanceof FieldsApiError ? errorTarget(error) : 'form'
        setErrors({ [target]: errorText(error) })
      }
      setPending(false)
    }
  }

  const group = groups.find((g) => g.id === form.groupId)
  const blocked = rolesBlockedByGroup(roles ?? [], group, form.requiredMode)
  const scoped = activePipelines.filter((p) => scopedPipelineIds(form, activeIds).includes(p.id))
  const backgroundChange =
    field !== null &&
    field.firstValueAt !== null &&
    form.type !== field.type &&
    typeChangeWithValues(field.type, form.type) === 'rewrite'
  const title = field ? t('field.editTitle', { name: localName(field) }) : t('field.createTitle')

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      className="fields-dialog"
      footer={
        <>
          <Button type="button" variant="quiet" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" variant="primary" form={formId} disabled={pending}>
            {field ? t('field.save') : t('field.create')}
          </Button>
        </>
      }
    >
      <form id={formId} className="fields-form" onSubmit={submit} noValidate>
        <Field label={t('names.uk')} error={errorOf('nameUk')}>
          <Input
            value={form.nameUk}
            required
            maxLength={100}
            onChange={(e) => setForm((current) => withNameUk(current, e.target.value))}
          />
        </Field>
        <Field label={t('names.ru')} hint={t('names.ruHint')} error={errorOf('nameRu')}>
          <Input
            value={form.nameRu}
            maxLength={100}
            onChange={(e) => update({ nameRu: e.target.value })}
          />
        </Field>
        <Field
          label={t('field.code')}
          error={errorOf('code')}
          hint={
            codeEditable
              ? t('field.codeHint')
              : field?.firstValueAt
                ? t('field.codeLockedValues')
                : t('field.codeLockedFiltered')
          }
        >
          <Input
            value={form.code}
            disabled={!codeEditable}
            maxLength={63}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => update({ code: e.target.value, codeTouched: true })}
          />
        </Field>
        <Field
          label={t('field.type')}
          error={errorOf('type')}
          hint={
            field?.convertingTo
              ? t('field.converting', { type: tTypes(`types.${field.convertingTo}`) })
              : backgroundChange
                ? t('field.typeBackground')
                : field?.firstValueAt
                  ? t('field.typeLocked')
                  : undefined
          }
        >
          <Select
            value={form.type}
            onChange={(e) => update({ type: e.target.value as FieldForm['type'] })}
          >
            {types.map((type) => (
              <option key={type} value={type}>
                {tTypes(`types.${type}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('field.group')} error={errorOf('groupId')}>
          <Select value={form.groupId} onChange={(e) => update({ groupId: e.target.value })}>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {localName(g)}
              </option>
            ))}
          </Select>
        </Field>

        {hasOptions(form.type) && (
          <OptionsEditor
            options={form.options}
            error={errorOf('options')}
            onChange={(options) => update({ options })}
          />
        )}

        {entity === 'deal' && (
          <fieldset className="fields-form__set">
            <legend>{t('field.pipelines')}</legend>
            <label className="ui-check">
              <input
                type="radio"
                name={`${formId}-pipelines`}
                checked={form.pipelinesMode === 'all'}
                onChange={() => update({ pipelinesMode: 'all' })}
              />
              <span>{t('field.pipelinesAll')}</span>
            </label>
            <label className="ui-check">
              <input
                type="radio"
                name={`${formId}-pipelines`}
                checked={form.pipelinesMode === 'selected'}
                onChange={() => update({ pipelinesMode: 'selected' })}
              />
              <span>{t('field.pipelinesSelected')}</span>
            </label>
            {form.pipelinesMode === 'selected' && (
              <div className="fields-form__nested">
                {activePipelines.map((pipeline) => (
                  <Checkbox
                    key={pipeline.id}
                    label={pipeline.name}
                    checked={form.pipelineIds.includes(pipeline.id)}
                    onChange={(e) =>
                      update({
                        pipelineIds: e.target.checked
                          ? [...form.pipelineIds, pipeline.id]
                          : form.pipelineIds.filter((id) => id !== pipeline.id),
                      })
                    }
                  />
                ))}
              </div>
            )}
            {errors.pipelines && <FieldError text={errorOf('pipelines')} />}
          </fieldset>
        )}

        <fieldset className="fields-form__set">
          <legend>{t('field.required')}</legend>
          {(entity === 'deal'
            ? (['none', 'always', 'stages'] as const)
            : (['none', 'always'] as const)
          ).map((mode) => (
            <label key={mode} className="ui-check">
              <input
                type="radio"
                name={`${formId}-required`}
                checked={form.requiredMode === mode}
                onChange={() => update({ requiredMode: mode })}
              />
              <span>
                {t(
                  mode === 'none'
                    ? 'field.requiredNone'
                    : mode === 'always'
                      ? 'field.requiredAlways'
                      : 'field.requiredStages',
                )}
              </span>
            </label>
          ))}
          {form.requiredMode === 'stages' && (
            <div className="fields-form__nested">
              {scoped.map((pipeline) => (
                <Field key={pipeline.id} label={t('field.stageFor', { name: pipeline.name })}>
                  <Select
                    value={form.stageByPipeline[pipeline.id] ?? ''}
                    onChange={(e) =>
                      update({
                        stageByPipeline: { ...form.stageByPipeline, [pipeline.id]: e.target.value },
                      })
                    }
                  >
                    <option value="">{t('field.stageNone')}</option>
                    {[...pipeline.stages]
                      .sort((a, b) => a.position - b.position)
                      .map((stage) => (
                        <option key={stage.id} value={stage.id}>
                          {stage.name}
                        </option>
                      ))}
                    <option value={STAGE_WON}>{t('field.stageWon')}</option>
                  </Select>
                </Field>
              ))}
            </div>
          )}
          {errors.required && <FieldError text={errorOf('required')} />}
        </fieldset>

        {blocked.length > 0 && group && (
          <p className="fields-form__warning">
            {t('field.requiredWarning', {
              group: localName(group),
              roles: blocked.map((r) => r.name).join(', '),
            })}
          </p>
        )}

        <div className="fields-form__flags">
          <Checkbox
            label={t('field.important')}
            title={t('field.importantHint')}
            checked={form.isImportant}
            onChange={(e) => update({ isImportant: e.target.checked })}
          />
          <span className="fields-form__flag">
            <Checkbox
              label={t('field.frequentlyFiltered')}
              title={t('field.frequentlyFilteredHint')}
              checked={form.isFrequentlyFiltered}
              onChange={(e) => update({ isFrequentlyFiltered: e.target.checked })}
            />
            {field?.indexState && <IndexBadge state={field.indexState} error={field.indexError} />}
          </span>
        </div>

        {errors.form && <Notice kind="alert">{errors.form}</Notice>}
      </form>
    </Dialog>
  )
}

function FieldError({ text }: { text: string | undefined }) {
  return (
    <span className="ui-field__error" role="alert">
      {text}
    </span>
  )
}

/** Состояние индекса «часто фільтрують» (тикет 07): будується / готовий / помилка. */
export function IndexBadge({
  state,
  error,
}: {
  state: 'building' | 'ready' | 'failed'
  error?: string | null | undefined
}) {
  const { t } = useTranslation('fields-settings')
  const tone = state === 'ready' ? 'win' : state === 'failed' ? 'danger' : 'neutral'
  return (
    <span title={error ?? undefined}>
      <Badge tone={tone}>{t(`field.index.${state}`)}</Badge>
    </span>
  )
}

function OptionsEditor({
  options,
  error,
  onChange,
}: {
  options: OptionDraft[]
  error: string | undefined
  onChange: (options: OptionDraft[]) => void
}) {
  const { t } = useTranslation('fields-settings')
  const active = options.filter((o) => !o.archived)
  const archived = options.filter((o) => o.archived)
  const set = (key: string, patch: Partial<OptionDraft>) =>
    onChange(options.map((o) => (o.key === key ? { ...o, ...patch } : o)))
  const move = (index: number, delta: -1 | 1) => {
    const keys = moved(
      active.map((o) => o.key),
      index,
      delta,
    )
    onChange([...keys.map((key) => active.find((o) => o.key === key) as OptionDraft), ...archived])
  }
  const label = (o: OptionDraft, n: number) => o.nameUk.trim() || String(n)

  return (
    <fieldset className="fields-form__set">
      <legend>{t('options.title')}</legend>
      {active.length === 0 && <p className="fields-form__hint">{t('options.none')}</p>}
      <ol className="fields-options">
        {active.map((option, index) => {
          const n = index + 1
          return (
            <li key={option.key} className="fields-options__row">
              <Input
                aria-label={t('options.nameUk', { n })}
                value={option.nameUk}
                maxLength={100}
                onChange={(e) => set(option.key, { nameUk: e.target.value })}
              />
              <Input
                aria-label={t('options.nameRu', { n })}
                value={option.nameRu}
                maxLength={100}
                onChange={(e) => set(option.key, { nameRu: e.target.value })}
              />
              <span className="fields-options__actions">
                <Button
                  type="button"
                  size="sm"
                  aria-label={t('options.up', { name: label(option, n) })}
                  title={t('options.up', { name: label(option, n) })}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </Button>
                <Button
                  type="button"
                  size="sm"
                  aria-label={t('options.down', { name: label(option, n) })}
                  title={t('options.down', { name: label(option, n) })}
                  disabled={index === active.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </Button>
                {option.id === null ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="quiet"
                    aria-label={t('options.removeLabel', { name: label(option, n) })}
                    onClick={() => onChange(options.filter((o) => o.key !== option.key))}
                  >
                    {t('options.remove')}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="quiet"
                    aria-label={t('options.archiveLabel', { name: label(option, n) })}
                    onClick={() => set(option.key, { archived: true })}
                  >
                    {t('options.archive')}
                  </Button>
                )}
              </span>
            </li>
          )
        })}
      </ol>
      <Button
        type="button"
        size="sm"
        onClick={() =>
          onChange([
            ...active,
            { key: newDraftKey(), id: null, nameUk: '', nameRu: '', archived: false },
            ...archived,
          ])
        }
      >
        {t('options.add')}
      </Button>
      {error && <FieldError text={error} />}
      {archived.length > 0 && (
        <div className="fields-options__archived">
          <h3>{t('options.archived')}</h3>
          <ul>
            {archived.map((option) => (
              <li key={option.key} className="fields-options__row">
                <span>{option.nameUk}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="quiet"
                  aria-label={t('options.restoreLabel', { name: option.nameUk })}
                  onClick={() => {
                    const rest = options.filter((o) => o.key !== option.key)
                    onChange([
                      ...rest.filter((o) => !o.archived),
                      { ...option, archived: false },
                      ...rest.filter((o) => o.archived),
                    ])
                  }}
                >
                  {t('options.restore')}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </fieldset>
  )
}
