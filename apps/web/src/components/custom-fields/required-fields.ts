import {
  type FieldDefinitionSummary,
  type FieldValueProblem,
  fieldGroupAccess,
  type PipelineSummary,
  type RequiredFieldName,
  type RequiredFieldsMissing,
  type RolePermissions,
} from '@alpi/shared'
import { visibleInPipeline } from './custom-field-groups.tsx'
import type { CustomValues } from './custom-fields-api.tsx'
import { checkDraft, type FieldDraft, initialDraft, isEmptyFieldValue } from './field-values.ts'

// Обязательные пользовательские поля на экране (тикет crm-fields/04): какие поля показать в
// форме создания записи и как собрать значения формы заполнения в `custom` запроса. Решает
// сервер (apps/api/src/fields/requirements.ts): экран лишь заранее показывает те же поля, а на
// ответ 422 открывает форму со списком из ответа.

/** Отказ API о незаполненных обязательных полях: STAGE_REQUIREMENTS_MISSING, REQUIRED_FIELDS_MISSING. */
export const REQUIRED_FIELDS_CODES = ['STAGE_REQUIREMENTS_MISSING', 'REQUIRED_FIELDS_MISSING']

/** `details` ответа 422 об обязательных полях; не тот вид — null. */
export function readRequiredFieldsMissing(
  code: string,
  details: Record<string, unknown> | null | undefined,
): RequiredFieldsMissing | null {
  if (!REQUIRED_FIELDS_CODES.includes(code) || !details) return null
  const fields = Array.isArray(details.fields)
    ? details.fields.filter((f): f is string => typeof f === 'string')
    : []
  const names = Array.isArray(details.names)
    ? details.names.filter(
        (n): n is RequiredFieldName =>
          typeof n === 'object' && n !== null && typeof (n as RequiredFieldName).code === 'string',
      )
    : []
  const hiddenCount = typeof details.hiddenCount === 'number' ? details.hiddenCount : 0
  return { fields, names, hiddenCount }
}

/**
 * Поля сделки, обязательные, чтобы поставить её в воронку `pipeline` на этап `stageId`: «всегда»
 * и «с этапа X», где X не позже выбранного этапа. Только видимые в воронке и не архивные.
 */
export function requiredOnStage(
  fields: readonly FieldDefinitionSummary[],
  pipeline: PipelineSummary,
  stageId: string,
): FieldDefinitionSummary[] {
  const order = (id: string | null) => pipeline.stages.findIndex((stage) => stage.id === id)
  const target = order(stageId)
  return fields.filter((field) => {
    if (field.archivedAt !== null || field.purgeRequestedAt !== null) return false
    if (!visibleInPipeline(field, pipeline.id)) return false
    if (field.required.mode === 'always') return true
    if (field.required.mode !== 'stages') return false
    const rule = field.required.stages.find((s) => s.pipelineId === pipeline.id)
    if (!rule || rule.stageId === null) return false
    const from = order(rule.stageId)
    return from !== -1 && target !== -1 && from <= target
  })
}

/** Поля «всегда» контакта или организации: их форма создания показывает сразу. */
export function requiredAlways(
  fields: readonly FieldDefinitionSummary[],
): FieldDefinitionSummary[] {
  return fields.filter(
    (field) =>
      field.archivedAt === null &&
      field.purgeRequestedAt === null &&
      field.required.mode === 'always',
  )
}

/**
 * Поля, которые роль заполняет сама (группа «изменять»), и поля групп «только чтение»: их
 * значение сервер не примет (403 CUSTOM_FIELD_READ_ONLY), форма показывает их без правки и не
 * отправляет. `permissions` ещё не загружены (null) — все поля заполняемые: решит сервер.
 */
export function splitByAccess(
  fields: readonly FieldDefinitionSummary[],
  permissions: RolePermissions | null,
): { editable: FieldDefinitionSummary[]; readOnly: FieldDefinitionSummary[] } {
  if (permissions === null) return { editable: [...fields], readOnly: [] }
  const editable: FieldDefinitionSummary[] = []
  const readOnly: FieldDefinitionSummary[] = []
  for (const field of fields) {
    const access = fieldGroupAccess(permissions, { id: field.groupId, entity: field.entity })
    if (access === 'edit') editable.push(field)
    else readOnly.push(field)
  }
  return { editable, readOnly }
}

/** Черновики полей формы: из значений записи (`values`) или пустые. */
export function requiredDrafts(
  fields: readonly FieldDefinitionSummary[],
  values: CustomValues = {},
): Record<string, FieldDraft> {
  return Object.fromEntries(fields.map((f) => [f.code, initialDraft(f.type, values[f.code])]))
}

/** Почему поле формы не годится: пусто или значение не по типу. */
export type RequiredFieldProblem = 'required' | FieldValueProblem

export type CollectedValues =
  | { ok: true; custom: CustomValues }
  | { ok: false; problems: Record<string, RequiredFieldProblem> }

/**
 * Значения формы для `custom` запроса: каждое поле заполнено и проходит ту же проверку, что на
 * сервере. `values` — значения записи (уже выбранные архивный вариант и отключённый участник
 * остаются допустимыми).
 */
export function collectRequired(
  fields: readonly FieldDefinitionSummary[],
  drafts: Readonly<Record<string, FieldDraft>>,
  values: CustomValues = {},
): CollectedValues {
  const custom: CustomValues = {}
  const problems: Record<string, RequiredFieldProblem> = {}
  for (const field of fields) {
    const draft = drafts[field.code] ?? initialDraft(field.type, undefined)
    const checked = checkDraft(field, draft, { previous: values[field.code] ?? null })
    if (!checked.ok) problems[field.code] = checked.problem
    else if (isEmptyFieldValue(checked.value)) problems[field.code] = 'required'
    else custom[field.code] = checked.value
  }
  return Object.keys(problems).length > 0 ? { ok: false, problems } : { ok: true, custom }
}
