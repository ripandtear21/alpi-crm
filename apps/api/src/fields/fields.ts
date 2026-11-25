import type { Database } from '@alpi/db'
import {
  FIELD_PURGE_AFTER_DAYS,
  FIELD_TYPES,
  type FieldDefinitionSummary,
  type FieldEntity,
  type FieldOptionSummary,
  type FieldPipelines,
  type FieldRequiredStage,
  type FieldRequirement,
  type FieldType,
  fieldCodeEditable,
  fieldCodeFromName,
  fieldCodeProblem,
  fieldCodeWithSuffix,
  hasOptions,
  typeChangeWithValues,
} from '@alpi/shared'
import { Hono } from 'hono'
import { type Kysely, sql } from 'kysely'
import { recordInRequest } from '../audit/record.ts'
import { type Ctx, fail, readBody, refuse, UUID } from '../contacts/http.ts'
import { type PermissionsEnv, requirePermission } from '../middleware/permissions.ts'
import { isoOrNull, readIds, reorder } from '../pipelines/directory.ts'
import { inSavepoint, sqlState } from '../roles/roles.ts'
import {
  canViewEntity,
  type FieldsDeps,
  type FieldsRefusal,
  invalid,
  isFieldEntity,
  notFound,
  readNames,
  unknownKey,
} from './common.ts'

// Описания пользовательских полей и варианты списков (тикет crm-fields/01; spec.md MVP, раздел
// 3.3): `/api/v1/fields?entity=deal|contact|organization`, `/api/v1/fields/:id/options`.
// Читает каждый с правом смотреть сущность (решено без владельца, подтвердить); меняет — право
// «поля» (fields: создавать, изменять, удалять). Каждое изменение пишется в журнал проекта той
// же транзакцией. Правила проверяются здесь (ответ с кодом) и держатся базой
// (migrations/0016_fields.ts) на случай записи в обход API.
//
// - Код: формат и запрет системных кодов — packages/shared/src/fields; по умолчанию — из
//   украинского названия, с суффиксом _2, _3…, если занят. Меняется, пока у поля не было
//   значений (first_value_at) и оно не отмечено «часто фильтруют»; потом — 409.
// - Тип меняется, пока не было значений. У поля с данными — только безопасно (тикет 02,
//   typeChangeWithValues): текст → большой текст сразу; число → текст и один вариант →
//   несколько — фоновой задачей (retype.ts), ответ 202, пока она идёт, поле только для чтения
//   (convertingTo); любая другая смена — 409 FIELD_TYPE_LOCKED («создайте новое поле»).
// - Видимость по воронкам и правило «с этапа» — только у полей сделки; воронки и этапы — своего
//   проекта; правило — для воронки, где поле видно.
// - Удаление: поле без значений удаляется сразу; со значениями — уходит в архив; архивное со
//   значениями удаляется окончательно не раньше чем через 30 дней после архивирования —
//   фоновой задачей (purge.ts), которая убирает ключ поля из `custom` всех записей.
// - Создание поля не меняет ни одной записи.

const UNIQUE_VIOLATION = '23505'
const DAY_MS = 24 * 60 * 60 * 1000

const FIELD_KEYS = [
  'groupId',
  'nameUk',
  'nameRu',
  'code',
  'type',
  'pipelines',
  'required',
  'isImportant',
  'isFrequentlyFiltered',
] as const

interface FieldRow {
  id: string
  entity: FieldEntity
  group_id: string
  code: string
  name_uk: string
  name_ru: string | null
  type: string
  position: number
  pipeline_visibility: 'all' | 'selected'
  required: 'none' | 'always' | 'stages'
  is_important: boolean
  is_frequently_filtered: boolean
  first_value_at: Date | string | null
  archived_at: Date | string | null
  purge_requested_at: Date | string | null
  converting_to: string | null
}

const FIELD_COLUMNS = [
  'id',
  'entity',
  'group_id',
  'code',
  'name_uk',
  'name_ru',
  'type',
  'position',
  'pipeline_visibility',
  'required',
  'is_important',
  'is_frequently_filtered',
  'first_value_at',
  'archived_at',
  'purge_requested_at',
  'converting_to',
] as const

const OPTION_COLUMNS = ['id', 'field_id', 'name_uk', 'name_ru', 'position', 'archived_at'] as const

interface OptionRow {
  id: string
  field_id: string
  name_uk: string
  name_ru: string | null
  position: number
  archived_at: Date | string | null
}

function optionSummary(row: OptionRow): FieldOptionSummary {
  return {
    id: row.id,
    nameUk: row.name_uk,
    nameRu: row.name_ru,
    position: row.position,
    archivedAt: isoOrNull(row.archived_at),
  }
}

const isFieldType = (value: unknown): value is FieldType => FIELD_TYPES.some((t) => t === value)

/** Описания полей с видимостью, правилами и вариантами; порядок — группа, потом поле. */
async function loadFields(
  db: Kysely<Database>,
  filter: { entity?: FieldEntity; ids?: string[]; includeArchived?: boolean },
): Promise<FieldDefinitionSummary[]> {
  let query = db
    .selectFrom('field_definition as f')
    .innerJoin('field_group as g', 'g.id', 'f.group_id')
    .select(FIELD_COLUMNS.map((column) => `f.${column}` as const))
    .orderBy('g.position')
    .orderBy('g.created_at')
    .orderBy('f.position')
    .orderBy('f.created_at')
    .orderBy('f.id')
  if (filter.entity !== undefined) query = query.where('f.entity', '=', filter.entity)
  if (filter.ids !== undefined) {
    if (filter.ids.length === 0) return []
    query = query.where('f.id', 'in', filter.ids)
  }
  if (!filter.includeArchived) query = query.where('f.archived_at', 'is', null)
  const rows: FieldRow[] = await query.execute()
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  // Запросы по очереди: транзакция проекта — одно соединение.
  const pipelines = await db
    .selectFrom('field_pipeline as fp')
    .innerJoin('pipeline as p', 'p.id', 'fp.pipeline_id')
    .select(['fp.field_id', 'fp.pipeline_id'])
    .where('fp.field_id', 'in', ids)
    .orderBy('p.position')
    .orderBy('p.id')
    .execute()
  const rules = await db
    .selectFrom('field_required_stage as r')
    .innerJoin('pipeline as p', 'p.id', 'r.pipeline_id')
    .select(['r.field_id', 'r.pipeline_id', 'r.stage_id'])
    .where('r.field_id', 'in', ids)
    .orderBy('p.position')
    .orderBy('p.id')
    .execute()
  const options = await db
    .selectFrom('field_option')
    .select(OPTION_COLUMNS)
    .where('field_id', 'in', ids)
    .orderBy('position')
    .orderBy('created_at')
    .orderBy('id')
    .execute()
  return rows.map((row) => {
    const stages = rules
      .filter((r) => r.field_id === row.id)
      .map((r) => ({ pipelineId: r.pipeline_id, stageId: r.stage_id }))
    const required: FieldRequirement =
      row.required === 'stages' ? { mode: 'stages', stages } : { mode: row.required }
    return {
      id: row.id,
      entity: row.entity,
      groupId: row.group_id,
      code: row.code,
      nameUk: row.name_uk,
      nameRu: row.name_ru,
      type: row.type as FieldType,
      position: row.position,
      pipelines:
        row.pipeline_visibility === 'all'
          ? 'all'
          : pipelines.filter((p) => p.field_id === row.id).map((p) => p.pipeline_id),
      required,
      isImportant: row.is_important,
      isFrequentlyFiltered: row.is_frequently_filtered,
      firstValueAt: isoOrNull(row.first_value_at),
      archivedAt: isoOrNull(row.archived_at),
      purgeRequestedAt: isoOrNull(row.purge_requested_at),
      convertingTo: row.converting_to as FieldType | null,
      options: options.filter((o) => o.field_id === row.id).map(optionSummary),
    }
  })
}

async function fieldSummary(db: Kysely<Database>, id: string): Promise<FieldDefinitionSummary> {
  const [field] = await loadFields(db, { ids: [id], includeArchived: true })
  if (!field) throw new Error('поле пропало в той же транзакции')
  return field
}

/** Поле текущего проекта, заблокированное до конца транзакции; undefined — нет такого. */
async function lockField(db: Kysely<Database>, id: string): Promise<FieldRow | undefined> {
  if (!UUID.test(id)) return undefined
  return db
    .selectFrom('field_definition')
    .select(FIELD_COLUMNS)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
}

async function groupOf(db: Kysely<Database>, id: unknown) {
  if (typeof id !== 'string' || !UUID.test(id)) return undefined
  return db
    .selectFrom('field_group')
    .select(['id', 'entity'])
    .where('id', '=', id)
    .executeTakeFirst()
}

async function nextPosition(
  db: Kysely<Database>,
  table: 'field_definition' | 'field_option',
  column: 'group_id' | 'field_id',
  parentId: string,
): Promise<number> {
  const row = await db
    .selectFrom(table)
    .select((eb) => eb.fn.max('position').as('max'))
    .where(column, '=', parentId)
    .executeTakeFirst()
  return Number(row?.max ?? 0) + 1
}

/** Видимость из тела: 'all' или непустой список разных uuid. */
function readPipelines(value: unknown): FieldPipelines | null {
  if (value === 'all') return 'all'
  const ids = readIds({ ids: value })
  return ids && ids.length > 0 ? ids : null
}

/** Обязательность из тела; null — не по форме. */
function readRequirement(value: unknown): FieldRequirement | null {
  if (typeof value !== 'object' || value === null) return null
  const { mode, stages } = value as { mode?: unknown; stages?: unknown }
  if (mode === 'none' || mode === 'always') return stages === undefined ? { mode } : null
  if (mode !== 'stages' || !Array.isArray(stages) || stages.length === 0) return null
  const rules: FieldRequiredStage[] = []
  for (const item of stages as unknown[]) {
    if (typeof item !== 'object' || item === null) return null
    const { pipelineId, stageId } = item as { pipelineId?: unknown; stageId?: unknown }
    if (typeof pipelineId !== 'string' || !UUID.test(pipelineId)) return null
    if (stageId !== null && (typeof stageId !== 'string' || !UUID.test(stageId))) return null
    rules.push({
      pipelineId: pipelineId.toLowerCase(),
      stageId: stageId === null ? null : stageId.toLowerCase(),
    })
  }
  const pipelines = new Set(rules.map((r) => r.pipelineId))
  return pipelines.size === rules.length ? { mode: 'stages', stages: rules } : null
}

/**
 * Видимость и обязательность ссылаются только на воронки и этапы своего проекта, только у
 * полей сделки (кроме «всегда»); правило «с этапа» — для воронки, где поле видно.
 */
async function checkPipelinesAndRequirement(
  db: Kysely<Database>,
  entity: FieldEntity,
  pipelines: FieldPipelines,
  required: FieldRequirement,
): Promise<FieldsRefusal | null> {
  if (entity !== 'deal') {
    if (pipelines !== 'all') return refuse(422, 'FIELD_DEAL_ONLY', { path: 'pipelines' })
    if (required.mode === 'stages') return refuse(422, 'FIELD_DEAL_ONLY', { path: 'required' })
    return null
  }
  const rules = required.mode === 'stages' ? required.stages : []
  const mentioned = [
    ...new Set([...(pipelines === 'all' ? [] : pipelines), ...rules.map((r) => r.pipelineId)]),
  ]
  if (mentioned.length > 0) {
    const found = await db
      .selectFrom('pipeline')
      .select('id')
      .where('id', 'in', mentioned)
      .execute()
    if (found.length !== mentioned.length) return refuse(422, 'FIELD_PIPELINE_NOT_FOUND')
  }
  for (const rule of rules) {
    if (pipelines !== 'all' && !pipelines.includes(rule.pipelineId)) {
      return refuse(422, 'FIELD_PIPELINE_HIDDEN', { pipelineId: rule.pipelineId })
    }
    if (rule.stageId === null) continue
    const stage = await db
      .selectFrom('stage')
      .select('id')
      .where('id', '=', rule.stageId)
      .where('pipeline_id', '=', rule.pipelineId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()
    if (!stage) return refuse(422, 'FIELD_STAGE_NOT_FOUND', { stageId: rule.stageId })
  }
  return null
}

/**
 * Пишет видимость и правила поля заново. Порядок держит ограничения базы: сначала уходят
 * правила и строки видимости, потом меняется поле, потом добавляются новые строки.
 */
async function writePipelinesAndRequirement(
  db: Kysely<Database>,
  projectId: string,
  fieldId: string,
  pipelines: FieldPipelines,
  required: FieldRequirement,
): Promise<void> {
  await db.deleteFrom('field_required_stage').where('field_id', '=', fieldId).execute()
  await db.deleteFrom('field_pipeline').where('field_id', '=', fieldId).execute()
  await db
    .updateTable('field_definition')
    .set({ pipeline_visibility: pipelines === 'all' ? 'all' : 'selected', required: required.mode })
    .where('id', '=', fieldId)
    .execute()
  if (pipelines !== 'all') {
    await db
      .insertInto('field_pipeline')
      .values(
        pipelines.map((pipelineId) => ({
          project_id: projectId,
          field_id: fieldId,
          pipeline_id: pipelineId,
        })),
      )
      .execute()
  }
  if (required.mode === 'stages') {
    await db
      .insertInto('field_required_stage')
      .values(
        required.stages.map((rule) => ({
          project_id: projectId,
          field_id: fieldId,
          pipeline_id: rule.pipelineId,
          stage_id: rule.stageId,
        })),
      )
      .execute()
  }
}

/** Код, заданный пользователем: формат и системные коды — 422. */
function codeRefusal(entity: FieldEntity, code: unknown): FieldsRefusal | null {
  if (typeof code !== 'string') return refuse(422, 'FIELD_CODE_INVALID', { path: 'code' })
  const problem = fieldCodeProblem(entity, code)
  if (problem === 'format') return refuse(422, 'FIELD_CODE_INVALID', { path: 'code' })
  if (problem === 'system') return refuse(422, 'FIELD_CODE_RESERVED', { path: 'code' })
  return null
}

/** Код по умолчанию из украинского названия: первый свободный из base, base_2, base_3… */
async function defaultCode(db: Kysely<Database>, entity: FieldEntity, nameUk: string) {
  const base = fieldCodeFromName(nameUk)
  const taken = new Set(
    (
      await db
        .selectFrom('field_definition')
        .select('code')
        .where('entity', '=', entity)
        .where('code', 'like', `${base.slice(0, 50).replace(/_/g, '\\_')}%`)
        .execute()
    ).map((r) => r.code),
  )
  for (let n = 1; ; n += 1) {
    const code = n === 1 ? base : fieldCodeWithSuffix(base, n)
    if (!taken.has(code) && fieldCodeProblem(entity, code) === null) return code
  }
}

/** Нарушение уникальности кода → 422 FIELD_CODE_TAKEN; другие ошибки — null. */
function codeTaken(error: unknown): FieldsRefusal | null {
  if (sqlState(error) !== UNIQUE_VIOLATION) return null
  const constraint = (error as { constraint?: unknown }).constraint
  return constraint === 'field_definition_code_key'
    ? refuse(422, 'FIELD_CODE_TAKEN', { path: 'code' })
    : null
}

interface OptionInput {
  nameUk: string
  nameRu: string | null
}

function readOptions(value: unknown): OptionInput[] | null {
  if (!Array.isArray(value)) return null
  const options: OptionInput[] = []
  for (const item of value as unknown[]) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
    const names = readNames(item as Record<string, unknown>, false)
    if (typeof names === 'string') return null
    options.push({ nameUk: names.nameUk ?? '', nameRu: names.nameRu ?? null })
  }
  return options
}

function readFlag(body: Record<string, unknown>, key: string): boolean | undefined | null {
  const value = body[key]
  if (value === undefined) return undefined
  return typeof value === 'boolean' ? value : null
}

async function createField(c: Ctx) {
  const body = await readBody(c)
  if (!body) return fail(c, invalid(''))
  const extra = unknownKey(body, [...FIELD_KEYS, 'options'])
  if (extra !== undefined) return fail(c, invalid(extra))
  const names = readNames(body, false)
  if (typeof names === 'string') return fail(c, invalid(names))
  if (!isFieldType(body.type)) return fail(c, invalid('type'))
  const type = body.type
  const pipelines = body.pipelines === undefined ? 'all' : readPipelines(body.pipelines)
  if (pipelines === null) return fail(c, invalid('pipelines'))
  const required =
    body.required === undefined ? { mode: 'none' as const } : readRequirement(body.required)
  if (required === null) return fail(c, invalid('required'))
  const isImportant = readFlag(body, 'isImportant')
  if (isImportant === null) return fail(c, invalid('isImportant'))
  const isFrequentlyFiltered = readFlag(body, 'isFrequentlyFiltered')
  if (isFrequentlyFiltered === null) return fail(c, invalid('isFrequentlyFiltered'))
  const options = body.options === undefined ? [] : readOptions(body.options)
  if (options === null) return fail(c, invalid('options'))

  const db = c.get('db')
  const group = await groupOf(db, body.groupId)
  if (!group) return fail(c, refuse(422, 'FIELD_GROUP_NOT_FOUND', { path: 'groupId' }))
  const entity = group.entity
  if (options.length > 0 && !hasOptions(type)) {
    return fail(c, refuse(422, 'FIELD_OPTIONS_NOT_ALLOWED', { path: 'options' }))
  }
  if (body.code !== undefined) {
    const refusal = codeRefusal(entity, body.code)
    if (refusal) return fail(c, refusal)
  }
  const checked = await checkPipelinesAndRequirement(db, entity, pipelines, required)
  if (checked) return fail(c, checked)

  const nameUk = names.nameUk ?? ''
  const code = typeof body.code === 'string' ? body.code : await defaultCode(db, entity, nameUk)
  const projectId = c.get('projectId')
  const userId = c.get('session').user.id
  let id: string
  try {
    id = await inSavepoint(db, async () => {
      const row = await db
        .insertInto('field_definition')
        .values({
          project_id: projectId,
          entity,
          group_id: group.id,
          code,
          name_uk: nameUk,
          name_ru: names.nameRu ?? null,
          type,
          position: await nextPosition(db, 'field_definition', 'group_id', group.id),
          is_important: isImportant ?? false,
          is_frequently_filtered: isFrequentlyFiltered ?? false,
          created_by: userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      return row.id
    })
  } catch (error) {
    const refusal = codeTaken(error)
    if (refusal) return fail(c, refusal)
    throw error
  }
  await writePipelinesAndRequirement(db, projectId, id, pipelines, required)
  if (options.length > 0) {
    await db
      .insertInto('field_option')
      .values(
        options.map((option, index) => ({
          project_id: projectId,
          field_id: id,
          name_uk: option.nameUk,
          name_ru: option.nameRu,
          position: index + 1,
          created_by: userId,
        })),
      )
      .execute()
  }
  const field = await fieldSummary(db, id)
  await recordInRequest(c, {
    action: 'field.created',
    entity: { type: 'field', id },
    details: {
      name: field.nameUk,
      code: field.code,
      entity,
      after: { type, pipelines, required, options: options.map((o) => o.nameUk) },
    },
  })
  return c.json<FieldDefinitionSummary>(field, 201)
}

async function updateField(c: Ctx, deps: FieldsDeps) {
  const body = await readBody(c)
  if (!body) return fail(c, invalid(''))
  const extra = unknownKey(body, [...FIELD_KEYS])
  if (extra !== undefined) return fail(c, invalid(extra))
  const names = readNames(body, true)
  if (typeof names === 'string') return fail(c, invalid(names))
  if (body.type !== undefined && !isFieldType(body.type)) return fail(c, invalid('type'))
  const pipelinesInput = body.pipelines === undefined ? undefined : readPipelines(body.pipelines)
  if (pipelinesInput === null) return fail(c, invalid('pipelines'))
  const requiredInput = body.required === undefined ? undefined : readRequirement(body.required)
  if (requiredInput === null) return fail(c, invalid('required'))
  const isImportant = readFlag(body, 'isImportant')
  if (isImportant === null) return fail(c, invalid('isImportant'))
  const isFrequentlyFiltered = readFlag(body, 'isFrequentlyFiltered')
  if (isFrequentlyFiltered === null) return fail(c, invalid('isFrequentlyFiltered'))

  const db = c.get('db')
  const row = await lockField(db, c.req.param('id') ?? '')
  if (!row) return fail(c, notFound())
  if (row.purge_requested_at !== null) return fail(c, refuse(409, 'FIELD_PURGE_PENDING'))
  const current = await fieldSummary(db, row.id)

  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  const set: Record<string, unknown> = {}
  const change = (key: string, column: string, from: unknown, to: unknown) => {
    if (to === undefined || to === from) return
    before[key] = from
    after[key] = to
    set[column] = to
  }

  if (body.groupId !== undefined && body.groupId !== row.group_id) {
    const group = await groupOf(db, body.groupId)
    if (!group || group.entity !== row.entity) {
      return fail(c, refuse(422, 'FIELD_GROUP_NOT_FOUND', { path: 'groupId' }))
    }
    change('groupId', 'group_id', row.group_id, group.id)
    set.position = await nextPosition(db, 'field_definition', 'group_id', group.id)
  }
  change('nameUk', 'name_uk', row.name_uk, names.nameUk)
  change('nameRu', 'name_ru', row.name_ru, names.nameRu)
  if (body.code !== undefined && body.code !== row.code) {
    if (!fieldCodeEditable(current)) return fail(c, refuse(409, 'FIELD_CODE_LOCKED'))
    const refusal = codeRefusal(row.entity, body.code)
    if (refusal) return fail(c, refusal)
    change('code', 'code', row.code, body.code)
  }
  // Смена типа поля с данными, которая переписывает значения: тип меняет фоновая задача.
  let convertTo: FieldType | null = null
  if (body.type !== undefined && body.type !== row.type && row.converting_to !== null) {
    // Повтор той же смены снова ставит задачу (если очередь исчерпала повторы, поле не
    // останется только для чтения навсегда; singletonKey не даст двух задач); другая — 409.
    if (body.type !== row.converting_to) return fail(c, refuse(409, 'FIELD_CONVERTING'))
    convertTo = row.converting_to as FieldType
  } else if (body.type !== undefined && body.type !== row.type) {
    const to = body.type as FieldType
    const mode =
      row.first_value_at === null ? 'keep' : typeChangeWithValues(row.type as FieldType, to)
    if (mode === null) return fail(c, refuse(409, 'FIELD_TYPE_LOCKED'))
    if (!hasOptions(to) && current.options.length > 0) {
      return fail(c, refuse(409, 'FIELD_HAS_OPTIONS'))
    }
    if (mode === 'keep') {
      change('type', 'type', row.type, to)
    } else {
      convertTo = to
      change('convertingTo', 'converting_to', null, to)
    }
  }
  change('isImportant', 'is_important', row.is_important, isImportant)
  change(
    'isFrequentlyFiltered',
    'is_frequently_filtered',
    row.is_frequently_filtered,
    isFrequentlyFiltered,
  )

  const pipelines = pipelinesInput ?? current.pipelines
  const required = requiredInput ?? current.required
  const rulesChanged =
    JSON.stringify(pipelines) !== JSON.stringify(current.pipelines) ||
    JSON.stringify(required) !== JSON.stringify(current.required)
  if (rulesChanged) {
    const checked = await checkPipelinesAndRequirement(db, row.entity, pipelines, required)
    if (checked) return fail(c, checked)
  }

  if (Object.keys(set).length > 0) {
    try {
      await inSavepoint(db, () =>
        db
          .updateTable('field_definition')
          .set({ ...set, updated_at: sql`now()` })
          .where('id', '=', row.id)
          .execute(),
      )
    } catch (error) {
      const refusal = codeTaken(error)
      if (refusal) return fail(c, refusal)
      throw error
    }
  }
  if (rulesChanged) {
    await writePipelinesAndRequirement(db, c.get('projectId'), row.id, pipelines, required)
    before.pipelines = current.pipelines
    before.required = current.required
    after.pipelines = pipelines
    after.required = required
  }
  if (Object.keys(after).length > 0) {
    await recordInRequest(c, {
      action: 'field.updated',
      entity: { type: 'field', id: row.id },
      details: {
        name: names.nameUk ?? row.name_uk,
        code: (after.code as string) ?? row.code,
        before,
        after,
      },
    })
  }
  if (convertTo !== null) {
    // Задача — в той же транзакции: откатится запрос — не будет и задачи.
    await deps.enqueueRetype(db, {
      projectId: c.get('projectId'),
      fieldId: row.id,
      actorId: c.get('session').user.id,
    })
    return c.json<FieldDefinitionSummary>(await fieldSummary(db, row.id), 202)
  }
  return c.json<FieldDefinitionSummary>(await fieldSummary(db, row.id))
}

async function reorderFields(c: Ctx) {
  const body = await readBody(c)
  const db = c.get('db')
  const group = await groupOf(db, body?.groupId)
  if (!group) return fail(c, invalid('groupId'))
  const ids = readIds(body)
  if (!ids) return fail(c, invalid('ids'))
  // Порядок — среди действующих полей группы; архивные хранят свою позицию.
  const current = await db
    .selectFrom('field_definition')
    .select('id')
    .where('group_id', '=', group.id)
    .where('archived_at', 'is', null)
    .forUpdate()
    .execute()
  if (
    !(await reorder(
      db,
      'field_definition',
      current.map((r) => r.id),
      ids,
    ))
  ) {
    return fail(c, refuse(400, 'INVALID_ORDER'))
  }
  await recordInRequest(c, {
    action: 'field.reordered',
    entity: { type: 'field_group', id: group.id },
    details: { entity: group.entity, after: { ids } },
  })
  return c.json<FieldDefinitionSummary[]>(
    (await loadFields(db, { entity: group.entity })).filter((f) => f.groupId === group.id),
  )
}

async function archiveField(c: Ctx, deps: FieldsDeps, archived: boolean) {
  const db = c.get('db')
  const row = await lockField(db, c.req.param('id') ?? '')
  if (!row) return fail(c, notFound())
  if (row.purge_requested_at !== null) return fail(c, refuse(409, 'FIELD_PURGE_PENDING'))
  if ((row.archived_at !== null) !== archived) {
    await setArchived(c, row, archived ? deps.now() : null)
  }
  return c.json<FieldDefinitionSummary>(await fieldSummary(db, row.id))
}

async function setArchived(c: Ctx, row: FieldRow, at: Date | null) {
  await c
    .get('db')
    .updateTable('field_definition')
    .set({ archived_at: at, updated_at: sql`now()` })
    .where('id', '=', row.id)
    .execute()
  await recordInRequest(c, {
    action: at === null ? 'field.restored' : 'field.archived',
    entity: { type: 'field', id: row.id },
    details: { name: row.name_uk, code: row.code },
  })
}

/**
 * Удаление: без значений — сразу (204); со значениями — архив (200); архивное со значениями —
 * окончательное удаление фоновой задачей (202), не раньше чем через 30 дней после архивирования
 * (решено без владельца, подтвердить), иначе 409.
 */
async function deleteField(c: Ctx, deps: FieldsDeps) {
  const db = c.get('db')
  const row = await lockField(db, c.req.param('id') ?? '')
  if (!row) return fail(c, notFound())
  if (row.first_value_at === null) {
    await db.deleteFrom('field_definition').where('id', '=', row.id).execute()
    await recordInRequest(c, {
      action: 'field.deleted',
      entity: { type: 'field', id: row.id },
      details: { name: row.name_uk, code: row.code, entity: row.entity },
    })
    return c.body(null, 204)
  }
  if (row.archived_at === null) {
    await setArchived(c, row, deps.now())
    return c.json<FieldDefinitionSummary>(await fieldSummary(db, row.id))
  }
  if (row.purge_requested_at === null) {
    const availableAt = new Date(
      new Date(row.archived_at).getTime() + FIELD_PURGE_AFTER_DAYS * DAY_MS,
    )
    if (deps.now() < availableAt) {
      return fail(
        c,
        refuse(409, 'FIELD_PURGE_TOO_EARLY', { availableAt: availableAt.toISOString() }),
      )
    }
    await db
      .updateTable('field_definition')
      .set({ purge_requested_at: deps.now(), updated_at: sql`now()` })
      .where('id', '=', row.id)
      .execute()
    await deps.enqueuePurge(db, {
      projectId: c.get('projectId'),
      fieldId: row.id,
      actorId: c.get('session').user.id,
    })
    await recordInRequest(c, {
      action: 'field.purge_requested',
      entity: { type: 'field', id: row.id },
      details: { name: row.name_uk, code: row.code, entity: row.entity },
    })
  }
  return c.json<FieldDefinitionSummary>(await fieldSummary(db, row.id), 202)
}

async function readField(c: Ctx) {
  const id = c.req.param('id') ?? ''
  if (!UUID.test(id)) return fail(c, notFound())
  const [field] = await loadFields(c.get('db'), { ids: [id], includeArchived: true })
  if (!field) return fail(c, notFound())
  if (!(await canViewEntity(c, field.entity))) return fail(c, refuse(403, 'PERMISSION_DENIED'))
  return c.json<FieldDefinitionSummary>(field)
}

async function lockOptionField(c: Ctx): Promise<FieldRow | FieldsRefusal> {
  const row = await lockField(c.get('db'), c.req.param('id') ?? '')
  if (!row) return notFound()
  if (row.purge_requested_at !== null) return refuse(409, 'FIELD_PURGE_PENDING')
  if (!hasOptions(row.type as FieldType)) return refuse(422, 'FIELD_OPTIONS_NOT_ALLOWED')
  return row
}

const isRefusal = (value: FieldRow | FieldsRefusal): value is FieldsRefusal =>
  'ok' in value && value.ok === false

async function createOption(c: Ctx) {
  const body = await readBody(c)
  if (!body) return fail(c, invalid(''))
  const extra = unknownKey(body, ['nameUk', 'nameRu'])
  if (extra !== undefined) return fail(c, invalid(extra))
  const names = readNames(body, false)
  if (typeof names === 'string') return fail(c, invalid(names))
  const field = await lockOptionField(c)
  if (isRefusal(field)) return fail(c, field)
  const db = c.get('db')
  const row = await db
    .insertInto('field_option')
    .values({
      project_id: c.get('projectId'),
      field_id: field.id,
      name_uk: names.nameUk ?? '',
      name_ru: names.nameRu ?? null,
      position: await nextPosition(db, 'field_option', 'field_id', field.id),
      created_by: c.get('session').user.id,
    })
    .returning(OPTION_COLUMNS)
    .executeTakeFirstOrThrow()
  await recordInRequest(c, {
    action: 'field_option.created',
    entity: { type: 'field_option', id: row.id },
    details: { name: field.name_uk, code: field.code, after: { nameUk: row.name_uk } },
  })
  return c.json<FieldOptionSummary>(optionSummary(row), 201)
}

/** Переименование и архив варианта: id и значения записей не меняются. */
async function updateOption(c: Ctx, deps: FieldsDeps) {
  const body = await readBody(c)
  if (!body) return fail(c, invalid(''))
  const extra = unknownKey(body, ['nameUk', 'nameRu', 'archived'])
  if (extra !== undefined) return fail(c, invalid(extra))
  const names = readNames(body, true)
  if (typeof names === 'string') return fail(c, invalid(names))
  const archived = readFlag(body, 'archived')
  if (archived === null) return fail(c, invalid('archived'))
  const field = await lockOptionField(c)
  if (isRefusal(field)) return fail(c, field)
  const db = c.get('db')
  const optionId = c.req.param('optionId') ?? ''
  const option = UUID.test(optionId)
    ? await db
        .selectFrom('field_option')
        .select(OPTION_COLUMNS)
        .where('id', '=', optionId)
        .where('field_id', '=', field.id)
        .forUpdate()
        .executeTakeFirst()
    : undefined
  if (!option) return fail(c, notFound())

  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  const set: Record<string, unknown> = {}
  if (names.nameUk !== undefined && names.nameUk !== option.name_uk) {
    before.nameUk = option.name_uk
    after.nameUk = names.nameUk
    set.name_uk = names.nameUk
  }
  if (names.nameRu !== undefined && names.nameRu !== option.name_ru) {
    before.nameRu = option.name_ru
    after.nameRu = names.nameRu
    set.name_ru = names.nameRu
  }
  if (archived !== undefined && archived !== (option.archived_at !== null)) {
    before.archived = !archived
    after.archived = archived
    set.archived_at = archived ? deps.now() : null
  }
  if (Object.keys(set).length === 0) return c.json<FieldOptionSummary>(optionSummary(option))
  const row = await db
    .updateTable('field_option')
    .set({ ...set, updated_at: sql`now()` })
    .where('id', '=', option.id)
    .returning(OPTION_COLUMNS)
    .executeTakeFirstOrThrow()
  await recordInRequest(c, {
    action: 'field_option.updated',
    entity: { type: 'field_option', id: option.id },
    details: { name: field.name_uk, code: field.code, before, after },
  })
  return c.json<FieldOptionSummary>(optionSummary(row))
}

async function reorderOptions(c: Ctx) {
  const ids = readIds(await readBody(c))
  if (!ids) return fail(c, invalid('ids'))
  const field = await lockOptionField(c)
  if (isRefusal(field)) return fail(c, field)
  const db = c.get('db')
  const current = await db
    .selectFrom('field_option')
    .select('id')
    .where('field_id', '=', field.id)
    .forUpdate()
    .execute()
  if (
    !(await reorder(
      db,
      'field_option',
      current.map((r) => r.id),
      ids,
    ))
  ) {
    return fail(c, refuse(400, 'INVALID_ORDER'))
  }
  await recordInRequest(c, {
    action: 'field_option.reordered',
    entity: { type: 'field', id: field.id },
    details: { name: field.name_uk, code: field.code, after: { ids } },
  })
  return c.json<FieldOptionSummary[]>((await fieldSummary(db, field.id)).options)
}

/** Маршруты описаний полей и вариантов: `/api/v1/fields`. */
export function fieldsRoutes(deps: FieldsDeps) {
  return (
    new Hono<PermissionsEnv>()
      .get('/', async (c) => {
        const entity = c.req.query('entity')
        if (!isFieldEntity(entity)) return fail(c, invalid('entity'))
        const archived = c.req.query('includeArchived')
        if (archived !== undefined && archived !== 'true' && archived !== 'false') {
          return fail(c, invalid('includeArchived'))
        }
        if (!(await canViewEntity(c, entity))) return fail(c, refuse(403, 'PERMISSION_DENIED'))
        return c.json<FieldDefinitionSummary[]>(
          await loadFields(c.get('db'), { entity, includeArchived: archived === 'true' }),
        )
      })
      .post('/', requirePermission('fields', 'create'), createField)
      // /order — до /:id: иначе «order» читался бы как id поля.
      .put('/order', requirePermission('fields', 'edit'), reorderFields)
      .get('/:id', readField)
      .put('/:id', requirePermission('fields', 'edit'), (c) => updateField(c, deps))
      .post('/:id/archive', requirePermission('fields', 'edit'), (c) => archiveField(c, deps, true))
      .post('/:id/restore', requirePermission('fields', 'edit'), (c) =>
        archiveField(c, deps, false),
      )
      .delete('/:id', requirePermission('fields', 'delete'), (c) => deleteField(c, deps))
      .post('/:id/options', requirePermission('fields', 'edit'), createOption)
      .put('/:id/options/order', requirePermission('fields', 'edit'), reorderOptions)
      .put('/:id/options/:optionId', requirePermission('fields', 'edit'), (c) =>
        updateOption(c, deps),
      )
  )
}
