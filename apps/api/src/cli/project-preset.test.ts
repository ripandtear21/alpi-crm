import { createDb, createProject, type Database, migrateToLatest } from '@alpi/db'
import { startTestDatabase, type TestDatabase } from '@alpi/db/testing'
import type { Kysely } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runProjectPreset } from './project-preset.ts'

// `pnpm project-preset <alpi|franch> <id проекта>` (тикет crm-deals/02): стартовые воронки,
// этапы и причины проигрыша; повторный запуск ничего не дублирует.

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

  it('неизвестная настройка или проект — отказ без изменений', async () => {
    expect(await runProjectPreset(service, ['other', crypto.randomUUID()], silent)).toBe(2)
    expect(await runProjectPreset(service, ['alpi', 'not-a-uuid'], silent)).toBe(2)
    expect(await runProjectPreset(service, ['alpi', crypto.randomUUID()], silent)).toBe(1)
  })
})
