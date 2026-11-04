import type { Kysely } from 'kysely'
import type { Database } from '../schema.ts'

// Стартовая настройка проекта (тикет crm-deals/02): воронки с этапами и справочник причин
// проигрыша. Названия — из docs/research/our-pipedrive.md (раздел 1) и
// docs/research/pipedrive-fields-audit.md (поле «Якість ліда»); состав воронок и причин решён
// без владельца — подтвердить (.scratch/crm-deals/spec.md, «Решения эпика»). Старые и пустые
// воронки Pipedrive («Курс», «Авторіа», «Франч воронка») не переносятся.
//
// Повторный запуск ничего не дублирует: воронка ищется по коду, группа причин — по названию.
// Уже существующая воронка или группа не трогается совсем — ни этапы, ни причины, ни порядок:
// то, что администратор успел поменять, настройка не перезаписывает.

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
  },
}

/** Что создала настройка: коды воронок и названия групп причин (пусто — всё уже было). */
export interface PresetResult {
  pipelines: string[]
  lostReasonGroups: string[]
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
  const result: PresetResult = { pipelines: [], lostReasonGroups: [] }

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
  return result
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
