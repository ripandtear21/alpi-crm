import {
  FIELD_TYPES,
  type FieldDefinitionSummary,
  type FieldEntity,
  type FieldGroupSummary,
  type FieldPipelines,
  type FieldRequirement,
  type FieldType,
  fieldCodeFromName,
  fieldCodeProblem,
  fieldGroupAccess,
  hasOptions,
  OPTION_FIELD_TYPES,
  type RoleSummary,
  typeChangeWithValues,
} from '@alpi/shared'
import type { FieldChange, FieldInput, FieldsApiError } from './fields-api.ts'

// Форма диалога поля (тикет crm-fields/05) без React: состояние формы из поля и обратно в тело
// запроса, допустимые типы, проверка до отправки и куда показать отказ сервера. Правила кода и
// безопасной смены типа — общие с сервером (packages/shared/src/fields).

/** Вариант списка в форме; id null — новый, создаётся при сохранении. */
export interface OptionDraft {
  key: string
  id: string | null
  nameUk: string
  nameRu: string
  archived: boolean
}

/** Выбор этапа для воронки: '' — правила нет, 'won' — только при выигрыше, иначе id этапа. */
export const STAGE_WON = 'won'

export interface FieldForm {
  nameUk: string
  nameRu: string
  code: string
  /** Код правили руками: дальше он не следует за украинским названием. */
  codeTouched: boolean
  type: FieldType
  groupId: string
  options: OptionDraft[]
  pipelinesMode: 'all' | 'selected'
  pipelineIds: string[]
  requiredMode: FieldRequirement['mode']
  stageByPipeline: Record<string, string>
  isImportant: boolean
  isFrequentlyFiltered: boolean
}

/** Поля формы, у которых показывается ошибка; 'form' — общая ошибка внизу диалога. */
export type FormKey =
  | 'nameUk'
  | 'nameRu'
  | 'code'
  | 'type'
  | 'groupId'
  | 'options'
  | 'pipelines'
  | 'required'

export type FormErrors = Partial<Record<FormKey | 'form', string>>

let draftKey = 0
export const newDraftKey = () => `draft-${++draftKey}`

export function emptyForm(groupId: string): FieldForm {
  return {
    nameUk: '',
    nameRu: '',
    code: '',
    codeTouched: false,
    type: 'text',
    groupId,
    options: [],
    pipelinesMode: 'all',
    pipelineIds: [],
    requiredMode: 'none',
    stageByPipeline: {},
    isImportant: false,
    isFrequentlyFiltered: false,
  }
}

export function formFromField(field: FieldDefinitionSummary): FieldForm {
  const stageByPipeline: Record<string, string> = {}
  if (field.required.mode === 'stages') {
    for (const rule of field.required.stages) {
      stageByPipeline[rule.pipelineId] = rule.stageId ?? STAGE_WON
    }
  }
  return {
    nameUk: field.nameUk,
    nameRu: field.nameRu ?? '',
    code: field.code,
    codeTouched: true,
    type: field.type,
    groupId: field.groupId,
    options: field.options.map((option) => ({
      key: option.id,
      id: option.id,
      nameUk: option.nameUk,
      nameRu: option.nameRu ?? '',
      archived: option.archivedAt !== null,
    })),
    pipelinesMode: field.pipelines === 'all' ? 'all' : 'selected',
    pipelineIds: field.pipelines === 'all' ? [] : field.pipelines,
    requiredMode: field.required.mode,
    stageByPipeline,
    isImportant: field.isImportant,
    isFrequentlyFiltered: field.isFrequentlyFiltered,
  }
}

/** Новое украинское название: код следует за ним, пока его не правили руками. */
export function withNameUk(form: FieldForm, nameUk: string): FieldForm {
  return form.codeTouched
    ? { ...form, nameUk }
    : { ...form, nameUk, code: nameUk.trim() === '' ? '' : fieldCodeFromName(nameUk) }
}

/**
 * Типы, которые можно выбрать. Новое поле — все 15. У поля с данными — его тип и безопасные
 * смены (typeChangeWithValues). У поля без данных, но с вариантами — только типы со списком:
 * вариант не удаляется, а тип без вариантов сервер не поставит (FIELD_HAS_OPTIONS).
 */
export function allowedTypes(field: FieldDefinitionSummary | null): FieldType[] {
  if (!field) return [...FIELD_TYPES]
  if (field.firstValueAt !== null) {
    return FIELD_TYPES.filter(
      (type) => type === field.type || typeChangeWithValues(field.type, type) !== null,
    )
  }
  if (field.options.length > 0) return [...OPTION_FIELD_TYPES]
  return [...FIELD_TYPES]
}

/** Воронки, для которых задаётся этап: видимые полю (все активные или выбранные). */
export function scopedPipelineIds(form: FieldForm, activePipelineIds: string[]): string[] {
  return form.pipelinesMode === 'all'
    ? activePipelineIds
    : activePipelineIds.filter((id) => form.pipelineIds.includes(id))
}

export function pipelinesOf(form: FieldForm): FieldPipelines {
  return form.pipelinesMode === 'all' ? 'all' : form.pipelineIds
}

/**
 * Воронки с правилом «з етапу», которых форма не показывает (архивные): правило пришло с поля,
 * пользователь его не видит и не меняет, поэтому оно остаётся, пока воронка в видимости поля.
 */
function hiddenRulePipelineIds(form: FieldForm, activePipelineIds: string[]): string[] {
  return Object.keys(form.stageByPipeline).filter(
    (id) =>
      !activePipelineIds.includes(id) &&
      (form.pipelinesMode === 'all' || form.pipelineIds.includes(id)),
  )
}

export function requirementOf(form: FieldForm, activePipelineIds: string[]): FieldRequirement {
  if (form.requiredMode !== 'stages') return { mode: form.requiredMode }
  const stages = [
    ...scopedPipelineIds(form, activePipelineIds),
    ...hiddenRulePipelineIds(form, activePipelineIds),
  ]
    .filter((id) => (form.stageByPipeline[id] ?? '') !== '')
    .map((pipelineId) => {
      const choice = form.stageByPipeline[pipelineId] as string
      return { pipelineId, stageId: choice === STAGE_WON ? null : choice }
    })
  return { mode: 'stages', stages }
}

/** Проверка до отправки: значения — ключи переводов `errors.*`. */
export function validateForm(
  form: FieldForm,
  entity: FieldEntity,
  activePipelineIds: string[],
  codeEditable: boolean,
): FormErrors {
  const errors: FormErrors = {}
  if (form.nameUk.trim() === '') errors.nameUk = 'nameRequired'
  if (codeEditable && form.codeTouched) {
    const problem = fieldCodeProblem(entity, form.code)
    if (problem === 'format') errors.code = 'FIELD_CODE_INVALID'
    if (problem === 'system') errors.code = 'FIELD_CODE_RESERVED'
  }
  if (!form.groupId) errors.groupId = 'FIELD_GROUP_NOT_FOUND'
  if (hasOptions(form.type) && form.options.some((o) => o.nameUk.trim() === '')) {
    errors.options = 'optionNameRequired'
  }
  if (entity === 'deal' && form.pipelinesMode === 'selected' && form.pipelineIds.length === 0) {
    errors.pipelines = 'pipelinesRequired'
  }
  const required = requirementOf(form, activePipelineIds)
  if (required.mode === 'stages' && required.stages.length === 0) errors.required = 'stagesRequired'
  return errors
}

const names = (draft: { nameUk: string; nameRu: string }) => ({
  nameUk: draft.nameUk.trim(),
  nameRu: draft.nameRu.trim() === '' ? null : draft.nameRu.trim(),
})

/** Тело создания поля. Код не правили руками — не передаётся: сервер подберёт свободный. */
export function createInput(
  form: FieldForm,
  entity: FieldEntity,
  activePipelineIds: string[],
): FieldInput {
  return {
    ...names(form),
    groupId: form.groupId,
    ...(form.codeTouched ? { code: form.code } : {}),
    type: form.type,
    ...(entity === 'deal' ? { pipelines: pipelinesOf(form) } : {}),
    required: requirementOf(form, activePipelineIds),
    isImportant: form.isImportant,
    isFrequentlyFiltered: form.isFrequentlyFiltered,
    ...(hasOptions(form.type)
      ? { options: form.options.filter((o) => !o.archived).map((o) => names(o)) }
      : {}),
  }
}

/** Одинаковые требования: правила «з етапу» сравниваются без учёта порядка воронок. */
function sameRequirement(a: FieldRequirement, b: FieldRequirement): boolean {
  const rules = (r: FieldRequirement) =>
    r.mode === 'stages'
      ? JSON.stringify(
          r.stages
            .map((s) => [s.pipelineId, s.stageId] as const)
            .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
        )
      : ''
  return a.mode === b.mode && rules(a) === rules(b)
}

/** Изменение поля: только то, что отличается от сохранённого. */
export function fieldChange(
  form: FieldForm,
  field: FieldDefinitionSummary,
  activePipelineIds: string[],
): FieldChange {
  const change: FieldChange = {}
  const next = names(form)
  if (next.nameUk !== field.nameUk) change.nameUk = next.nameUk
  if (next.nameRu !== field.nameRu) change.nameRu = next.nameRu
  if (form.code !== field.code) change.code = form.code
  if (form.type !== field.type && form.type !== field.convertingTo) change.type = form.type
  if (form.groupId !== field.groupId) change.groupId = form.groupId
  if (field.entity === 'deal') {
    const pipelines = pipelinesOf(form)
    if (JSON.stringify(pipelines) !== JSON.stringify(field.pipelines)) change.pipelines = pipelines
  }
  const required = requirementOf(form, activePipelineIds)
  if (!sameRequirement(required, field.required)) change.required = required
  if (form.isImportant !== field.isImportant) change.isImportant = form.isImportant
  if (form.isFrequentlyFiltered !== field.isFrequentlyFiltered) {
    change.isFrequentlyFiltered = form.isFrequentlyFiltered
  }
  return change
}

/**
 * После частичного сохранения: новым вариантам, которые сервер уже создал, — их id, чтобы
 * повторное «Зберегти» не создало их ещё раз. `created` — ответы на создание (ключ черновика →
 * id); `fresh` — поле, перечитанное с сервера: вариант, ответ на создание которого потерялся,
 * узнаётся по названию среди вариантов сервера, на которые не ссылается ни один черновик.
 */
export function adoptSavedOptions(
  form: FieldForm,
  created: ReadonlyMap<string, string>,
  fresh: FieldDefinitionSummary | null,
): FieldForm {
  const options = form.options.map((o) => {
    const id = o.id === null ? created.get(o.key) : undefined
    return id === undefined ? o : { ...o, id }
  })
  if (fresh) {
    const taken = new Set(options.map((o) => o.id))
    for (const [index, draft] of options.entries()) {
      if (draft.id !== null || draft.archived) continue
      const wanted = names(draft)
      const match = fresh.options.find(
        (o) =>
          !taken.has(o.id) &&
          o.archivedAt === null &&
          o.nameUk === wanted.nameUk &&
          o.nameRu === wanted.nameRu,
      )
      if (!match) continue
      taken.add(match.id)
      options[index] = { ...draft, id: match.id }
    }
  }
  return { ...form, options }
}

/**
 * Варианты, которые ещё не совпадают с сервером: новые без id и с другим названием или
 * архивом. Названия — для сообщения о частичном сохранении.
 */
export function unsavedOptions(form: FieldForm, saved: FieldDefinitionSummary): string[] {
  return form.options
    .filter((draft) => {
      if (draft.id === null) return !draft.archived
      const before = saved.options.find((o) => o.id === draft.id)
      if (!before) return false
      const next = names(draft)
      return (
        next.nameUk !== before.nameUk ||
        next.nameRu !== before.nameRu ||
        draft.archived !== (before.archivedAt !== null)
      )
    })
    .map((draft) => draft.nameUk.trim())
}

const ERROR_TARGET: Record<string, FormKey> = {
  FIELD_CODE_INVALID: 'code',
  FIELD_CODE_RESERVED: 'code',
  FIELD_CODE_TAKEN: 'code',
  FIELD_CODE_LOCKED: 'code',
  FIELD_TYPE_LOCKED: 'type',
  FIELD_HAS_OPTIONS: 'type',
  FIELD_CONVERTING: 'type',
  FIELD_GROUP_NOT_FOUND: 'groupId',
  EXCEEDS_OWN_PERMISSIONS: 'groupId',
  FIELD_PIPELINE_NOT_FOUND: 'pipelines',
  FIELD_STAGE_NOT_FOUND: 'required',
  FIELD_PIPELINE_HIDDEN: 'required',
  FIELD_OPTIONS_NOT_ALLOWED: 'options',
}

const FORM_KEYS: readonly string[] = [
  'nameUk',
  'nameRu',
  'code',
  'type',
  'groupId',
  'options',
  'pipelines',
  'required',
]

/** У какого поля формы показать отказ сервера: по коду ошибки, потом по `details.path`. */
export function errorTarget(error: FieldsApiError): FormKey | 'form' {
  const byCode = ERROR_TARGET[error.code]
  if (byCode) return byCode
  const path = error.details?.path
  if (typeof path === 'string' && FORM_KEYS.includes(path)) return path as FormKey
  return 'form'
}

/**
 * Роли, у которых группа обязательного поля скрыта или только для чтения: их менеджеры не
 * заполнят поле и не переведут запись дальше. Администратор видит и меняет всё.
 */
export function rolesBlockedByGroup(
  roles: RoleSummary[],
  group: Pick<FieldGroupSummary, 'id' | 'entity'> | undefined,
  requiredMode: FieldRequirement['mode'],
): RoleSummary[] {
  if (!group || requiredMode === 'none') return []
  return roles.filter(
    (role) => !role.isAdmin && fieldGroupAccess(role.permissions, group) !== 'edit',
  )
}

/** Когда можно удалить архивное поле окончательно: через 30 дней; без значений — сразу. */
export function purgeAvailableAt(
  field: Pick<FieldDefinitionSummary, 'archivedAt' | 'firstValueAt'>,
  purgeAfterDays: number,
): Date | null {
  if (field.archivedAt === null) return null
  if (field.firstValueAt === null) return new Date(field.archivedAt)
  return new Date(new Date(field.archivedAt).getTime() + purgeAfterDays * 24 * 60 * 60 * 1000)
}
