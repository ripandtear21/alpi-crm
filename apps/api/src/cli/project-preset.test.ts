import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  applyProjectPreset,
  createDb,
  createProject,
  type Database,
  type FieldPreset,
  type FieldRequiredRulePreset,
  migrateToLatest,
  PROJECT_PRESETS,
} from '@alpi/db'
import { startTestDatabase, type TestDatabase } from '@alpi/db/testing'
import {
  FIELD_NAME_MAX_LENGTH,
  FIELD_TYPES,
  type FieldEntity,
  fieldCodeProblem,
  hasOptions,
} from '@alpi/shared'
import type { Kysely } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runProjectPreset } from './project-preset.ts'

// `pnpm project-preset <alpi|franch> <id проекта>` (тикет crm-deals/02): стартовые воронки,
// этапы и причины проигрыша; повторный запуск ничего не дублирует. Пользовательские поля ALPI
// (тикет crm-fields/08): ровно поля таблицы docs/setup/alpi-start-fields.md, поиск по коду,
// правила обязательности — на этапах стартовых воронок.

const ALPI = PROJECT_PRESETS.alpi

/** Код воронки ALPI по названию. */
function pipelineCode(name: string): string {
  const pipeline = ALPI.pipelines.find((p) => p.name === name)
  if (!pipeline) throw new Error(`в настройке ALPI нет воронки «${name}»`)
  return pipeline.code
}

/** Правила поля в виде, удобном для сравнения: «воронка / этап», выигрыш — «воронка / Виграно». */
const ruleKeys = (rules: FieldPreset['required']) =>
  (rules ?? []).map((r) => `${r.pipeline} / ${r.stage ?? 'Виграно'}`).sort()

/**
 * Раздел 1 таблицы docs/setup/alpi-start-fields.md в виде настройки поля. Варианты: число
 * всегда, список — когда в ячейке перечислены все (не «1, 2, 3 … 26»).
 */
function tableFields() {
  const md = readFileSync(
    fileURLToPath(new URL('../../../../docs/setup/alpi-start-fields.md', import.meta.url)),
    'utf8',
  )
  const start = md.indexOf('\n## 1. ')
  const end = md.indexOf('\n## ', start + 1)
  if (start === -1 || end === -1) throw new Error('в таблице нет раздела 1')
  const entity: Record<string, FieldEntity> = {
    сделка: 'deal',
    контакт: 'contact',
    организация: 'organization',
  }
  const rows = md
    .slice(start, end)
    .split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| Название uk') && !l.startsWith('|---'))
    .map((l) => l.slice(2, -2).split(' | '))
  const fields = rows.map((c) => {
    const [nameUk, nameRu, code, ent, group, type, options, required, pipelines, imp, freq] = c
    const optionMatch = /^(\d+): (.+)$/.exec(options ?? '')
    const optionList = optionMatch?.[2]?.split(/, (?![^()]*\))/) ?? []
    const segments = required === '—' ? [] : (required ?? '').split('; ')
    const rules = segments.flatMap((segment): FieldRequiredRulePreset[] => {
      const from = /^з етапу «(.+)» воронки «(.+)»$/.exec(segment)
      if (from?.[1] && from[2]) return [{ pipeline: pipelineCode(from[2]), stage: from[1] }]
      const win = /^при виграші — воронк[аи] (.+)$/.exec(segment)
      if (!win?.[1]) throw new Error(`не разобрана обязательность «${segment}» поля ${code}`)
      return [...win[1].matchAll(/«([^»]+)»/g)].map((m) => ({
        pipeline: pipelineCode(m[1] ?? ''),
        stage: null,
      }))
    })
    return {
      entity: entity[ent ?? ''],
      group,
      code: /^`(\w+)`$/.exec(code ?? '')?.[1],
      nameUk,
      nameRu,
      type: /`(\w+)`/.exec(type ?? '')?.[1],
      optionCount: Number(optionMatch?.[1] ?? 0),
      options: optionList.length === Number(optionMatch?.[1]) ? optionList : undefined,
      pipelines: pipelines?.startsWith('все')
        ? undefined
        : (pipelines ?? '').split(', ').map(pipelineCode).sort(),
      required: ruleKeys(rules),
      important: imp === 'так',
      frequentlyFiltered: freq === 'так',
    }
  })
  const groups = [...md.matchAll(/^\| \d \| (.+?) \| (.+?) \|/gm)].map((m) => ({
    entity: 'deal',
    nameUk: m[1],
    nameRu: m[2],
  }))
  const contactGroup = /Группа контакта: «(.+?)» \/ «(.+?)»/.exec(md)
  groups.push({ entity: 'contact', nameUk: contactGroup?.[1], nameRu: contactGroup?.[2] })
  return { fields, groups }
}

describe('стартовые поля ALPI — данные настройки', () => {
  it('ровно поля раздела 1 таблицы docs/setup/alpi-start-fields.md, в том же порядке', () => {
    const table = tableFields()
    expect(table.fields).toHaveLength(20)
    expect(
      ALPI.fields.map((f) => ({
        entity: f.entity,
        group: f.group,
        code: f.code,
        nameUk: f.nameUk,
        nameRu: f.nameRu,
        type: f.type,
        optionCount: f.options?.length ?? 0,
        options: table.fields.find((t) => t.code === f.code)?.options && f.options,
        pipelines: f.pipelines && [...f.pipelines].sort(),
        required: ruleKeys(f.required),
        important: f.important === true,
        frequentlyFiltered: f.frequentlyFiltered === true,
      })),
    ).toEqual(table.fields)
    expect(ALPI.fieldGroups).toEqual(table.groups)
  })

  it('коды, типы, названия и варианты проходят правила конструктора', () => {
    const codes = ALPI.fields.map((f) => `${f.entity}:${f.code}`)
    expect(new Set(codes).size).toBe(codes.length)
    for (const field of ALPI.fields) {
      expect(fieldCodeProblem(field.entity, field.code), field.code).toBeNull()
      expect(FIELD_TYPES, field.code).toContain(field.type)
      expect(field.nameUk.length, field.code).toBeLessThanOrEqual(FIELD_NAME_MAX_LENGTH)
      expect(field.nameRu.length, field.code).toBeLessThanOrEqual(FIELD_NAME_MAX_LENGTH)
      const options = field.options ?? []
      expect(options.length > 0, field.code).toBe(hasOptions(field.type as never))
      expect(new Set(options).size, field.code).toBe(options.length)
      expect(options.every((o) => o.trim() !== '' && o.length <= FIELD_NAME_MAX_LENGTH)).toBe(true)
      expect(
        ALPI.fieldGroups.some((g) => g.entity === field.entity && g.nameUk === field.group),
        field.code,
      ).toBe(true)
      if (field.entity !== 'deal') {
        expect(field.pipelines, field.code).toBeUndefined()
        expect(field.required, field.code).toBeUndefined()
      }
    }
    expect(PROJECT_PRESETS.franch.fields).toEqual([])
  })

  it('правила обязательности — на этапах стартовых воронок ALPI, где поле видно', () => {
    for (const field of ALPI.fields) {
      const pipelines = (field.required ?? []).map((r) => r.pipeline)
      expect(new Set(pipelines).size, field.code).toBe(pipelines.length)
      for (const rule of field.required ?? []) {
        const pipeline = ALPI.pipelines.find((p) => p.code === rule.pipeline)
        expect(pipeline, `${field.code}: воронка ${rule.pipeline}`).toBeDefined()
        expect(field.pipelines ?? [rule.pipeline], field.code).toContain(rule.pipeline)
        if (rule.stage !== null) {
          expect(pipeline?.stages, `${field.code}: этап «${rule.stage}»`).toContain(rule.stage)
        }
      }
    }
  })
})

describe('pnpm project-preset', () => {
  let testDb: TestDatabase
  let service: Kysely<Database>

  beforeAll(async () => {
    testDb = await startTestDatabase()
    service = createDb(testDb.connectionString)
    await migrateToLatest(service)
  })

  afterAll(async () => {
    await service?.destroy()
    await testDb?.stop()
  })

  const silent = { log: () => {}, error: () => {} }

  async function snapshot(projectId: string) {
    const pipelines = await service
      .selectFrom('pipeline')
      .select(['id', 'code', 'name', 'is_upsell'])
      .where('project_id', '=', projectId)
      .orderBy('position')
      .execute()
    const stages = await service
      .selectFrom('stage')
      .select(['pipeline_id', 'name'])
      .where('project_id', '=', projectId)
      .orderBy('pipeline_id')
      .orderBy('position')
      .execute()
    const reasons = await service
      .selectFrom('lost_reason as r')
      .innerJoin('lost_reason_group as g', 'g.id', 'r.group_id')
      .select(['g.name as group', 'r.name'])
      .where('r.project_id', '=', projectId)
      .orderBy('g.position')
      .orderBy('r.position')
      .execute()
    return {
      pipelines: pipelines.map((p) => ({
        code: p.code,
        name: p.name,
        isUpsell: p.is_upsell,
        stages: stages.filter((s) => s.pipeline_id === p.id).map((s) => s.name),
      })),
      reasons: reasons.map((r) => `${r.group} / ${r.name}`),
    }
  }

  it('alpi дважды подряд: ровно 3 воронки, этапы в порядке исследования, причины без дублей', async () => {
    const project = await createProject(service, { code: 'alpi-preset', name: 'ALPI' })
    expect(await runProjectPreset(service, ['alpi', project.id], silent)).toBe(0)
    const first = await snapshot(project.id)
    expect(await runProjectPreset(service, ['alpi', project.id], silent)).toBe(0)
    const second = await snapshot(project.id)

    expect(second).toEqual(first)
    expect(second.pipelines).toEqual([
      {
        code: 'alpi',
        name: 'ALPI',
        isUpsell: false,
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
        // docs/research/our-pipedrive.md, раздел 1, «Платформа (допродаж) (7)».
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
        isUpsell: false,
        // docs/research/our-pipedrive.md, раздел 1, «Автовебінари (4)».
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
    ])
    expect(second.pipelines[1]?.stages.every((name) => name.endsWith('(Д)'))).toBe(true)
    expect(second.reasons).toHaveLength(13)
    expect(new Set(second.reasons).size).toBe(13)
    expect(second.reasons).toContain('Якість ліда / Пенсіонер')
    expect(second.reasons).toContain('Інше / Інше')

    // Запуск пишет журнал проекта только когда что-то создал.
    const audit = await service
      .selectFrom('audit_log')
      .select(['action', 'actor_id'])
      .where('project_id', '=', project.id)
      .execute()
    expect(audit).toEqual([{ action: 'project.preset_applied', actor_id: null }])
  })

  it('franch: воронка «Франч» из 10 этапов, группа «Франч»', async () => {
    const project = await createProject(service, { code: 'franch-preset', name: 'Франч' })
    expect(await runProjectPreset(service, ['franch', project.id], silent)).toBe(0)
    const { pipelines, reasons } = await snapshot(project.id)
    expect(pipelines.map((p) => [p.code, p.stages.length])).toEqual([['franch', 10]])
    expect(reasons).toEqual(['Франч / Нецелевой', 'Франч / Другое'])
  })

  /** Поля проекта с группами, вариантами, видимостью и правилами — в виде настройки поля. */
  async function fieldSnapshot(projectId: string) {
    const groups = await service
      .selectFrom('field_group')
      .select(['id', 'entity', 'name_uk', 'name_ru'])
      .where('project_id', '=', projectId)
      .orderBy('entity', 'desc')
      .orderBy('position')
      .execute()
    const fields = await service
      .selectFrom('field_definition as f')
      .innerJoin('field_group as g', 'g.id', 'f.group_id')
      .select([
        'f.id',
        'f.entity',
        'f.code',
        'f.name_uk',
        'f.name_ru',
        'f.type',
        'f.pipeline_visibility',
        'f.required',
        'f.is_important',
        'f.is_frequently_filtered',
        'g.name_uk as group',
      ])
      .where('f.project_id', '=', projectId)
      .orderBy('f.entity', 'desc')
      .orderBy('g.position')
      .orderBy('f.position')
      .execute()
    const options = await service
      .selectFrom('field_option')
      .select(['field_id', 'name_uk'])
      .where('project_id', '=', projectId)
      .orderBy('position')
      .execute()
    const visible = await service
      .selectFrom('field_pipeline as fp')
      .innerJoin('pipeline as p', 'p.id', 'fp.pipeline_id')
      .select(['fp.field_id', 'p.code'])
      .where('fp.project_id', '=', projectId)
      .execute()
    const rules = await service
      .selectFrom('field_required_stage as r')
      .innerJoin('pipeline as p', 'p.id', 'r.pipeline_id')
      .leftJoin('stage as s', 's.id', 'r.stage_id')
      .select(['r.field_id', 'p.code', 's.name as stage'])
      .where('r.project_id', '=', projectId)
      .execute()
    return {
      groups: groups.map((g) => ({ entity: g.entity, nameUk: g.name_uk, nameRu: g.name_ru })),
      fields: fields.map((f) => ({
        entity: f.entity,
        group: f.group,
        code: f.code,
        nameUk: f.name_uk,
        nameRu: f.name_ru,
        type: f.type,
        options: options.filter((o) => o.field_id === f.id).map((o) => o.name_uk),
        pipelines:
          f.pipeline_visibility === 'all'
            ? undefined
            : visible
                .filter((v) => v.field_id === f.id)
                .map((v) => v.code)
                .sort(),
        required: rules
          .filter((r) => r.field_id === f.id)
          .map((r) => `${r.code} / ${r.stage ?? 'Виграно'}`)
          .sort(),
        requiredMode: f.required,
        important: f.is_important,
        frequentlyFiltered: f.is_frequently_filtered,
      })),
    }
  }

  /** Ожидаемое по настройке: то же, что fieldSnapshot. */
  const expectedFields = () =>
    ALPI.fields.map((f) => ({
      entity: f.entity,
      group: f.group,
      code: f.code,
      nameUk: f.nameUk,
      nameRu: f.nameRu,
      type: f.type,
      options: [...(f.options ?? [])],
      pipelines: f.pipelines && [...f.pipelines].sort(),
      required: ruleKeys(f.required),
      requiredMode: f.required ? 'stages' : 'none',
      important: f.important === true,
      frequentlyFiltered: f.frequentlyFiltered === true,
    }))

  it('alpi на чистом проекте: ровно поля таблицы с группами, вариантами, видимостью и правилами; второй запуск ничего не создаёт', async () => {
    const project = await createProject(service, { code: 'alpi-fields', name: 'ALPI' })
    const errors: string[] = []
    const out = { log: () => {}, error: (m: string) => errors.push(m) }
    expect(await runProjectPreset(service, ['alpi', project.id], out)).toBe(0)
    const first = await fieldSnapshot(project.id)
    expect(first.groups).toEqual(ALPI.fieldGroups)
    expect(first.fields).toEqual(expectedFields())
    expect(errors).toEqual([])

    const log: string[] = []
    expect(
      await runProjectPreset(service, ['alpi', project.id], {
        log: (m) => log.push(m),
        error: (m) => errors.push(m),
      }),
    ).toBe(0)
    expect(log.join('\n')).toMatch(/ничего не создано/)
    expect(await fieldSnapshot(project.id)).toEqual(first)
    expect(errors).toEqual([])
  })

  it('правила обязательности ссылаются на действующие этапы своих стартовых воронок ALPI', async () => {
    const project = await createProject(service, { code: 'alpi-rules', name: 'ALPI' })
    expect(await runProjectPreset(service, ['alpi', project.id], silent)).toBe(0)
    const rules = await service
      .selectFrom('field_required_stage as r')
      .innerJoin('field_definition as f', 'f.id', 'r.field_id')
      .innerJoin('pipeline as p', 'p.id', 'r.pipeline_id')
      .leftJoin('stage as s', 's.id', 'r.stage_id')
      .select([
        'f.code',
        'p.code as pipeline',
        'r.pipeline_id',
        'r.stage_id',
        's.name as stage',
        's.pipeline_id as stage_pipeline_id',
        's.deleted_at',
      ])
      .where('r.project_id', '=', project.id)
      .execute()
    expect(rules).toHaveLength(ALPI.fields.flatMap((f) => f.required ?? []).length)
    expect(rules.filter((r) => r.stage_id !== null).length).toBeGreaterThan(0)
    for (const rule of rules) {
      const preset = ALPI.pipelines.find((p) => p.code === rule.pipeline)
      expect(preset, `${rule.code}: ${rule.pipeline}`).toBeDefined()
      if (rule.stage_id === null) continue
      // Этап правила — действующий этап воронки правила (не одноимённый этап другой воронки).
      expect(rule.stage_pipeline_id, rule.code).toBe(rule.pipeline_id)
      expect(rule.deleted_at, rule.code).toBeNull()
      expect(preset?.stages, rule.code).toContain(rule.stage)
    }
  })

  it('повторный запуск ищет поле по коду: переименованное администратором не трогает, удалённое заводит снова', async () => {
    const project = await createProject(service, { code: 'alpi-admin', name: 'ALPI' })
    expect(await runProjectPreset(service, ['alpi', project.id], silent)).toBe(0)
    const field = (code: string) =>
      service
        .selectFrom('field_definition')
        .selectAll()
        .where('project_id', '=', project.id)
        .where('code', '=', code)
        .executeTakeFirstOrThrow()
    // Администратор переименовал поле и его группу, снял «важное», убрал правило, отправил
    // вариант в архив; поле контакта удалил совсем; поле «Score» отправил в архив.
    const motive = await field('holovnyi_motyv_v_ai')
    await service
      .updateTable('field_definition')
      .set({ name_uk: 'Мотив', name_ru: null, is_important: false })
      .where('id', '=', motive.id)
      .execute()
    await service
      .updateTable('field_group')
      .set({ name_uk: 'Лід' })
      .where('id', '=', motive.group_id)
      .execute()
    await service
      .deleteFrom('field_required_stage')
      .where('field_id', '=', motive.id)
      .where('pipeline_id', 'in', (eb) =>
        eb
          .selectFrom('pipeline')
          .select('id')
          .where('project_id', '=', project.id)
          .where('code', '=', 'platform'),
      )
      .execute()
    await service
      .updateTable('field_option')
      .set({ archived_at: new Date() })
      .where('field_id', '=', motive.id)
      .where('name_uk', '=', 'Інше')
      .execute()
    await service
      .updateTable('field_definition')
      .set({ archived_at: new Date() })
      .where('id', '=', (await field('score')).id)
      .execute()
    await service
      .deleteFrom('field_definition')
      .where('id', '=', (await field('telegram')).id)
      .execute()
    const before = await fieldSnapshot(project.id)

    const log: string[] = []
    expect(
      await runProjectPreset(service, ['alpi', project.id], {
        log: (m) => log.push(m),
        error: () => {},
      }),
    ).toBe(0)
    expect(log.join('\n')).toMatch(/поля telegram$/)
    const after = await fieldSnapshot(project.id)
    // Ничего не задвоилось: по одному полю на код, групп столько же (поле контакта — в своей группе).
    expect(after.fields.map((f) => f.code).sort()).toEqual(ALPI.fields.map((f) => f.code).sort())
    expect(after.groups).toEqual(before.groups)
    // Правки администратора на месте.
    expect(after.fields.filter((f) => f.code !== 'telegram')).toEqual(before.fields)
    const changed = after.fields.find((f) => f.code === 'holovnyi_motyv_v_ai')
    expect(changed).toMatchObject({ nameUk: 'Мотив', nameRu: null, group: 'Лід', important: false })
    expect(changed?.required).toEqual(['alpi / Дивиться запис вебінар'])
    expect((await field('score')).archived_at).not.toBeNull()
    // Удалённое поле заведено снова — таким, как в таблице.
    expect(after.fields.find((f) => f.code === 'telegram')).toEqual(
      expectedFields().find((f) => f.code === 'telegram'),
    )
  })

  it('этапа или воронки из правила в проекте нет — поле заводится без этого правила, запуск предупреждает', async () => {
    const project = await createProject(service, { code: 'alpi-own', name: 'ALPI' })
    // Воронку ALPI администратор завёл сам, со своими этапами, раньше стартовой настройки.
    const pipeline = await service
      .insertInto('pipeline')
      .values({ project_id: project.id, code: 'alpi', name: 'ALPI', position: 1 })
      .returning('id')
      .executeTakeFirstOrThrow()
    await service
      .insertInto('stage')
      .values(
        ['Новий лід', 'Дивиться запис вебінар'].map((name, i) => ({
          project_id: project.id,
          pipeline_id: pipeline.id,
          name,
          position: i + 1,
        })),
      )
      .execute()
    const errors: string[] = []
    expect(
      await runProjectPreset(service, ['alpi', project.id], {
        log: () => {},
        error: (m) => errors.push(m),
      }),
    ).toBe(0)
    expect(errors).toEqual([
      'Внимание: поле yakist_lida: в воронке alpi нет этапа «Не вийшов на звязок» — правило обязательности не заведено',
      'Внимание: поле vziatyi_v_robotu: в воронке alpi нет этапа «Не вийшов на звязок» — правило обязательности не заведено',
    ])
    const { fields } = await fieldSnapshot(project.id)
    expect(fields.find((f) => f.code === 'yakist_lida')?.required).toEqual([
      'platform / Приймає рішення (Д)',
    ])
    expect(fields.find((f) => f.code === 'typ_kliienta')?.required).toEqual([
      'alpi / Дивиться запис вебінар',
      'autowebinars / Виграно',
      'platform / Приймає рішення (Д)',
    ])
  })

  it('второй запуск, пока первый не закончил транзакцию: группы и поля по одному разу', async () => {
    const project = await createProject(service, { code: 'alpi-race', name: 'ALPI' })
    expect(await runProjectPreset(service, ['alpi', project.id], silent)).toBe(0)
    // Проект, где воронки уже есть, а полей ещё нет (настройку применили до тикета полей):
    // воронки второй запуск не задерживают.
    await service.deleteFrom('field_definition').where('project_id', '=', project.id).execute()
    await service.deleteFrom('field_group').where('project_id', '=', project.id).execute()

    // Первый запуск всё создал, но транзакцию держит открытой, пока второй не начнёт работу.
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let markApplied = () => {}
    const applied = new Promise<void>((resolve) => {
      markApplied = resolve
    })
    const first = service.transaction().execute(async (trx) => {
      await applyProjectPreset(trx, project.id, 'alpi')
      markApplied()
      await held
    })
    await applied
    const second = runProjectPreset(service, ['alpi', project.id], silent)
    // Второй успевает дойти до места, где ждёт первого (очередь по проекту или ключ кода поля).
    await new Promise((resolve) => setTimeout(resolve, 500))
    release()
    await first
    expect(await second).toBe(0)
    const snapshot = await fieldSnapshot(project.id)
    expect(snapshot.groups).toEqual(ALPI.fieldGroups)
    expect(snapshot.fields).toEqual(expectedFields())
  })

  it('неизвестная настройка или проект — отказ без изменений', async () => {
    expect(await runProjectPreset(service, ['other', crypto.randomUUID()], silent)).toBe(2)
    expect(await runProjectPreset(service, ['alpi', 'not-a-uuid'], silent)).toBe(2)
    expect(await runProjectPreset(service, ['alpi', crypto.randomUUID()], silent)).toBe(1)
  })
})
