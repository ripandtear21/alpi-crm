import { type Kysely, sql } from 'kysely'
import type { Database } from '../schema.ts'
import {
  ALPI_FIELD_GROUPS,
  ALPI_FIELDS,
  type FieldGroupPreset,
  type FieldPreset,
} from './alpi-fields.ts'

// Стартовая настройка проекта (тикет crm-deals/02): воронки с этапами и справочник причин
// проигрыша. Названия — из docs/research/our-pipedrive.md (раздел 1) и
// docs/research/pipedrive-fields-audit.md (поле «Якість ліда»); состав воронок и причин решён
// без владельца — подтвердить (.scratch/crm-deals/spec.md, «Решения эпика»). Старые и пустые
// воронки Pipedrive («Курс», «Авторіа», «Франч воронка») не переносятся.
//
// Пользовательские поля (тикет crm-fields/08): группы, поля, варианты, видимость по воронкам и
// правила обязательности — у ALPI из docs/setup/alpi-start-fields.md (alpi-fields.ts).
//
// Повторный запуск ничего не дублирует: воронка ищется по коду, группа причин — по названию,
// поле — по коду в своей сущности (в том числе архивное). Уже существующая воронка, группа
// причин или поле не трогается совсем — ни этапы, ни причины, ни название, группа, варианты и
// правила поля: то, что администратор успел поменять, настройка не перезаписывает.

export const PRESET_KEYS = ['alpi', 'franch'] as const
export type PresetKey = (typeof PRESET_KEYS)[number]

export function isPresetKey(value: unknown): value is PresetKey {
  return PRESET_KEYS.some((key) => key === value)
}

interface PipelinePreset {
  code: string
  name: string
  isUpsell?: boolean
  stages: string[]
}

interface LostReasonGroupPreset {
  name: string
  reasons: string[]
}

export interface ProjectPreset {
  pipelines: PipelinePreset[]
  lostReasonGroups: LostReasonGroupPreset[]
  fieldGroups: readonly FieldGroupPreset[]
  fields: readonly FieldPreset[]
}

export const PROJECT_PRESETS: Record<PresetKey, ProjectPreset> = {
  alpi: {
    pipelines: [
      {
        code: 'alpi',
        name: 'ALPI',
        stages: [
          'Новий лід',
          'Передано в роботу',
          'Був на вебінарі',
          'Не вийшов на звязок',
          'Дивиться запис вебінар',
          '!Приймає рішення',
          'Сплатив бронювання',
          'Виставили рахунок',
          'Відкладений попит',
        ],
      },
      {
        code: 'platform',
        name: 'Платформа (допродаж)',
        isUpsell: true,
        stages: [
          'Новий лід (Д)',
          'Передано в роботу (Д)',
          "Не вийшов на зв'язок (Д)",
          'Приймає рішення (Д)',
          'Сплатив бронювання (Д)',
          'Виставили рахунок (Д)',
          'Відкладений попит (Д)',
        ],
      },
      {
        code: 'autowebinars',
        name: 'Автовебінари',
        stages: [
          'Новий лід',
          'Був на вебі',
          'Взятий в роботу',
          'Лід не кваліфікован',
          'Дивиться запис',
          'Приймає рішення',
          'Відкладений попит',
          'Передплата',
          'Розстрочка',
          'Виставлений рахунок',
        ],
      },
    ],
    lostReasonGroups: [
      {
        name: 'Якість ліда',
        reasons: [
          'Контактні дані не вірні',
          'Не актуально',
          'Не дозвон',
          'Пенсіонер',
          'Держпрацівник',
          'Немає 18 років',
          'Агресивна поведінка',
          'Безробітні',
          'Декрет',
          'Військові',
          'Безкоштовне навчання',
          'Немає потреби',
        ],
      },
      { name: 'Інше', reasons: ['Інше'] },
    ],
    fieldGroups: ALPI_FIELD_GROUPS,
    fields: ALPI_FIELDS,
  },
  franch: {
    pipelines: [
      {
        code: 'franch',
        name: 'Франч',
        stages: [
          'Новый лид',
          'Первый контакт',
          'Не вышел на контакт',
          'Прошёл квалификацию',
          'Назначена встреча',
          'Встреча проведена',
          'Вторая встреча назначена',
          'Вторая встреча проведена',
          'Повторные встречи',
          'Подписание договора',
        ],
      },
    ],
    lostReasonGroups: [{ name: 'Франч', reasons: ['Нецелевой', 'Другое'] }],
    // Поля «Франча» заводятся при его переезде (docs/setup/alpi-start-fields.md, «Не заводится»).
    fieldGroups: [],
    fields: [],
  },
}

/**
 * Что создала настройка: коды воронок, названия групп причин и групп полей, коды полей (пусто —
 * всё уже было). `warnings` — что из настройки нового поля не завелось: воронки или этапа с таким
 * названием в проекте нет (администратор переименовал или удалил).
 */
export interface PresetResult {
  pipelines: string[]
  lostReasonGroups: string[]
  fieldGroups: string[]
  fields: string[]
  warnings: string[]
}

/** Создала ли настройка хоть что-то. */
export function presetCreatedAnything(result: PresetResult): boolean {
  return (
    result.pipelines.length +
      result.lostReasonGroups.length +
      result.fieldGroups.length +
      result.fields.length >
    0
  )
}

/**
 * Применяет стартовую настройку `key` к проекту `projectId`. `db` — транзакция служебной
 * ролью (владелец таблиц) или транзакция проекта (withProject): вызывающий отвечает за то,
 * чтобы всё создалось одной транзакцией. Новые воронки и группы встают в конец списка.
 * Одновременный второй запуск не дублирует: вставка с ON CONFLICT DO NOTHING по коду
 * воронки и названию группы, этапы и причины создаются только у только что вставленных строк.
 */
export async function applyProjectPreset(
  db: Kysely<Database>,
  projectId: string,
  key: PresetKey,
): Promise<PresetResult> {
  const preset = PROJECT_PRESETS[key]
  const result: PresetResult = {
    pipelines: [],
    lostReasonGroups: [],
    fieldGroups: [],
    fields: [],
    warnings: [],
  }

  let pipelinePosition = await nextPosition(db, 'pipeline', projectId)
  for (const pipeline of preset.pipelines) {
    // Вторую «воронку допродаж» база не примет: если она уже отмечена, новая — без отметки.
    const upsellTaken =
      pipeline.isUpsell === true &&
      (await db
        .selectFrom('pipeline')
        .select('id')
        .where('project_id', '=', projectId)
        .where('is_upsell', '=', true)
        .executeTakeFirst()) !== undefined
    const inserted = await db
      .insertInto('pipeline')
      .values({
        project_id: projectId,
        code: pipeline.code,
        name: pipeline.name,
        position: pipelinePosition,
        is_upsell: pipeline.isUpsell === true && !upsellTaken,
      })
      .onConflict((oc) => oc.columns(['project_id', 'code']).doNothing())
      .returning('id')
      .executeTakeFirst()
    if (!inserted) continue
    pipelinePosition += 1
    result.pipelines.push(pipeline.code)
    await db
      .insertInto('stage')
      .values(
        pipeline.stages.map((name, index) => ({
          project_id: projectId,
          pipeline_id: inserted.id,
          name,
          position: index + 1,
        })),
      )
      .execute()
  }

  let groupPosition = await nextPosition(db, 'lost_reason_group', projectId)
  for (const group of preset.lostReasonGroups) {
    const inserted = await db
      .insertInto('lost_reason_group')
      .values({ project_id: projectId, name: group.name, position: groupPosition })
      .onConflict((oc) => oc.columns(['project_id', 'name']).doNothing())
      .returning('id')
      .executeTakeFirst()
    if (!inserted) continue
    groupPosition += 1
    result.lostReasonGroups.push(group.name)
    await db
      .insertInto('lost_reason')
      .values(
        group.reasons.map((name, index) => ({
          project_id: projectId,
          group_id: inserted.id,
          name,
          position: index + 1,
        })),
      )
      .execute()
  }

  await applyFields(db, projectId, preset, result)
  return result
}

/**
 * Досоздаёт поля настройки, которых нет в проекте (по коду в сущности, архивные тоже считаются),
 * с группами, вариантами, видимостью и правилами. Существующее поле не трогается.
 */
async function applyFields(
  db: Kysely<Database>,
  projectId: string,
  preset: ProjectPreset,
  result: PresetResult,
): Promise<void> {
  if (preset.fields.length === 0) return
  // У группы полей нет кода: два одновременных запуска по проекту создали бы её дважды. Запуски
  // по одному проекту идут по очереди до конца транзакции.
  await sql`select pg_advisory_xact_lock(hashtextextended(${`project_preset_fields:${projectId}`}, 0))`.execute(
    db,
  )
  const existing = await db
    .selectFrom('field_definition')
    .select(['entity', 'code'])
    .where('project_id', '=', projectId)
    .execute()
  const taken = new Set(existing.map((f) => `${f.entity}:${f.code}`))
  const missing = preset.fields.filter((f) => !taken.has(`${f.entity}:${f.code}`))
  if (missing.length === 0) return

  const pipelines = await db
    .selectFrom('pipeline')
    .select(['id', 'code'])
    .where('project_id', '=', projectId)
    .execute()
  const pipelineIds = new Map(pipelines.map((p) => [p.code, p.id]))
  const stages = await db
    .selectFrom('stage')
    .select(['id', 'pipeline_id', 'name'])
    .where('project_id', '=', projectId)
    .where('deleted_at', 'is', null)
    .orderBy('position')
    .execute()
  const groupIds = new Map<string, string>()

  for (const field of missing) {
    const groupId = await fieldGroupId(db, projectId, preset, field, groupIds, result)

    const visible: string[] = []
    for (const code of field.pipelines ?? []) {
      const id = pipelineIds.get(code)
      if (id) visible.push(id)
      else result.warnings.push(`поле ${field.code}: нет воронки ${code} — поле в ней не видно`)
    }
    const rules: { pipeline_id: string; stage_id: string | null }[] = []
    for (const rule of field.required ?? []) {
      const pipelineId = pipelineIds.get(rule.pipeline)
      if (!pipelineId) {
        result.warnings.push(
          `поле ${field.code}: нет воронки ${rule.pipeline} — правило обязательности не заведено`,
        )
        continue
      }
      if (rule.stage === null) {
        rules.push({ pipeline_id: pipelineId, stage_id: null })
        continue
      }
      const stage = stages.find((s) => s.pipeline_id === pipelineId && s.name === rule.stage)
      if (stage) rules.push({ pipeline_id: pipelineId, stage_id: stage.id })
      else {
        result.warnings.push(
          `поле ${field.code}: в воронке ${rule.pipeline} нет этапа «${rule.stage}» — правило обязательности не заведено`,
        )
      }
    }

    const position = await db
      .selectFrom('field_definition')
      .select((eb) => eb.fn.max('position').as('max'))
      .where('project_id', '=', projectId)
      .where('group_id', '=', groupId)
      .executeTakeFirst()
    const inserted = await db
      .insertInto('field_definition')
      .values({
        project_id: projectId,
        entity: field.entity,
        group_id: groupId,
        code: field.code,
        name_uk: field.nameUk,
        name_ru: field.nameRu,
        type: field.type,
        position: Number(position?.max ?? 0) + 1,
        pipeline_visibility: field.pipelines === undefined ? 'all' : 'selected',
        required: rules.length > 0 ? 'stages' : 'none',
        is_important: field.important === true,
        is_frequently_filtered: field.frequentlyFiltered === true,
      })
      // Поле с этим кодом успели завести через конструктор — оно уже администратора.
      .onConflict((oc) => oc.columns(['project_id', 'entity', 'code']).doNothing())
      .returning('id')
      .executeTakeFirst()
    if (!inserted) continue
    result.fields.push(field.code)

    if (field.pipelines !== undefined && visible.length > 0) {
      await db
        .insertInto('field_pipeline')
        .values(
          visible.map((pipelineId) => ({
            project_id: projectId,
            field_id: inserted.id,
            pipeline_id: pipelineId,
          })),
        )
        .execute()
    }
    if (rules.length > 0) {
      await db
        .insertInto('field_required_stage')
        .values(rules.map((rule) => ({ project_id: projectId, field_id: inserted.id, ...rule })))
        .execute()
    }
    if (field.options && field.options.length > 0) {
      await db
        .insertInto('field_option')
        .values(
          field.options.map((name, index) => ({
            project_id: projectId,
            field_id: inserted.id,
            name_uk: name,
            position: index + 1,
          })),
        )
        .execute()
    }
  }
}

/**
 * Группа поля `field`: существующая группа сущности с тем же названием или новая — в конце
 * списка групп сущности.
 */
async function fieldGroupId(
  db: Kysely<Database>,
  projectId: string,
  preset: ProjectPreset,
  field: FieldPreset,
  cache: Map<string, string>,
  result: PresetResult,
): Promise<string> {
  const key = `${field.entity}:${field.group}`
  const cached = cache.get(key)
  if (cached) return cached
  const found = await db
    .selectFrom('field_group')
    .select('id')
    .where('project_id', '=', projectId)
    .where('entity', '=', field.entity)
    .where('name_uk', '=', field.group)
    .orderBy('position')
    .executeTakeFirst()
  let id = found?.id
  if (!id) {
    const group = preset.fieldGroups.find(
      (g) => g.entity === field.entity && g.nameUk === field.group,
    )
    if (!group) throw new Error(`в настройке нет группы «${field.group}» поля ${field.code}`)
    const position = await db
      .selectFrom('field_group')
      .select((eb) => eb.fn.max('position').as('max'))
      .where('project_id', '=', projectId)
      .where('entity', '=', field.entity)
      .executeTakeFirst()
    id = (
      await db
        .insertInto('field_group')
        .values({
          project_id: projectId,
          entity: group.entity,
          name_uk: group.nameUk,
          name_ru: group.nameRu,
          position: Number(position?.max ?? 0) + 1,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
    result.fieldGroups.push(group.nameUk)
  }
  cache.set(key, id)
  return id
}

async function nextPosition(
  db: Kysely<Database>,
  table: 'pipeline' | 'lost_reason_group',
  projectId: string,
): Promise<number> {
  const row = await db
    .selectFrom(table)
    .select((eb) => eb.fn.max('position').as('max'))
    .where('project_id', '=', projectId)
    .executeTakeFirst()
  return Number(row?.max ?? 0) + 1
}
