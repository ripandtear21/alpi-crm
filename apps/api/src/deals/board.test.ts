import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { type ApiHarness, type SignedInUser, startApiHarness } from '../testing/api-harness.ts'
import { problemFields, requiredErrors } from '../testing/problem.ts'
import type { BoardDeal, DealOwner, DealsPage, PipelineAggregates } from './board.ts'
import type { StageRequirements, StageTarget } from './stage-requirements.ts'

// Канбан (тикет crm-deals/11): выдача сделок этапа с курсором, агрегаты колонок, точка
// расширения «требования этапа» в смене этапа — на настоящем PostgreSQL, API ходит ролью
// приложения. Имена — вымышленные.

interface Pipeline {
  id: string
  stages: string[]
}

describe('канбан: выдача, агрегаты, требования этапа', () => {
  let h: ApiHarness
  let admin: SignedInUser
  let manager: SignedInUser
  let colleague: SignedInUser
  let projectA: string
  let projectB: string
  let counter = 0

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_board')
    admin = await h.signIn('owner')
    projectA = (await h.createProject(admin, 'Канбан А')).id
    projectB = (await h.createProject(admin, 'Канбан Б')).id
    manager = await h.signIn()
    colleague = await h.signIn()
    await h.owner
      .updateTable('user')
      .set({ name: 'Ганна Вигадана' })
      .where('id', '=', manager.id)
      .execute()
    await h.addMember(projectA, manager.id, 'manager')
    await h.addMember(projectA, colleague.id, 'manager')
  })

  afterAll(async () => {
    await h?.stop()
  })

  async function createPipeline(projectId: string, stages = ['s1', 's2']): Promise<Pipeline> {
    counter += 1
    const { id } = await h.owner
      .insertInto('pipeline')
      .values({
        project_id: projectId,
        code: `k${counter}`,
        name: `Воронка ${counter}`,
        position: counter,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const ids: string[] = []
    for (const [index, name] of stages.entries()) {
      const stage = await h.owner
        .insertInto('stage')
        .values({ project_id: projectId, pipeline_id: id, name, position: index + 1 })
        .returning('id')
        .executeTakeFirstOrThrow()
      ids.push(stage.id)
    }
    return { id, stages: ids }
  }

  interface SeedDeal {
    stage: string
    amount?: number
    currency?: 'EUR' | 'UAH' | 'USD'
    owner?: string | null
    status?: 'open' | 'won'
    archived?: boolean
    deleted?: boolean
  }

  /** Сделки прямо в базе (у каждой свой контакт): быстрее, чем через API. */
  async function seed(projectId: string, pipeline: Pipeline, deals: SeedDeal[]): Promise<string[]> {
    const ids: string[] = []
    for (const deal of deals) {
      counter += 1
      const contact = await h.owner
        .insertInto('contact')
        .values({ project_id: projectId, first_name: `Клієнт${counter}`, last_name: 'Вигаданий' })
        .returning('id')
        .executeTakeFirstOrThrow()
      const won = deal.status === 'won'
      const row = await h.owner
        .insertInto('deal')
        .values({
          project_id: projectId,
          title: `Угода ${counter}`,
          pipeline_id: pipeline.id,
          stage_id: deal.stage,
          amount: deal.amount ?? 0,
          currency: deal.currency ?? 'EUR',
          owner_id: deal.owner === undefined ? admin.id : deal.owner,
          primary_contact_id: contact.id,
          status: won ? 'won' : 'open',
          won_at: won ? new Date() : null,
          archived_at: deal.archived ? new Date() : null,
          deleted_at: deal.deleted ? new Date() : null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      ids.push(row.id)
    }
    return ids
  }

  function get(user: SignedInUser, path: string, project = projectA) {
    return user.api('GET', path, { project })
  }

  async function json<T>(res: Response, status = 200): Promise<T> {
    const body = (await res.json()) as T
    expect(res.status, JSON.stringify(body)).toBe(status)
    return body
  }

  /** То же, что агрегаты, прямым SQL служебным подключением: открытые, не в архиве и корзине. */
  async function expectedAggregates(pipelineId: string, owners: (string | null)[] | 'all') {
    const rows = await sql<{ stage_id: string; currency: string; count: string; sum: string }>`
      select stage_id, currency, count(*) as count, sum(amount) as sum from deal
      where pipeline_id = ${pipelineId} and status = 'open'
        and archived_at is null and deleted_at is null
        ${
          owners === 'all'
            ? sql``
            : sql`and (owner_id is null and ${owners.includes(null)}
                or owner_id in (${sql.join([...owners.filter((o) => o !== null), ''])}))`
        }
      group by stage_id, currency`.execute(h.owner)
    const byStage = new Map<string, { count: number; sums: Record<string, number> }>()
    for (const row of rows.rows) {
      const stage = byStage.get(row.stage_id) ?? { count: 0, sums: {} }
      stage.count += Number(row.count)
      stage.sums[row.currency] = Number(row.sum)
      byStage.set(row.stage_id, stage)
    }
    return byStage
  }

  function asMap(aggregates: PipelineAggregates) {
    return new Map(aggregates.stages.map((s) => [s.stageId, { count: s.count, sums: s.sums }]))
  }

  describe('агрегаты колонок', () => {
    let pipeline: Pipeline
    let pipelineB: Pipeline

    beforeAll(async () => {
      pipeline = await createPipeline(projectA)
      const [s1 = '', s2 = ''] = pipeline.stages
      await seed(projectA, pipeline, [
        { stage: s1, amount: 100.5, currency: 'EUR' },
        { stage: s1, amount: 200, currency: 'EUR', owner: manager.id },
        { stage: s1, amount: 1000, currency: 'UAH', owner: null },
        { stage: s1, amount: 7, currency: 'USD', owner: colleague.id },
        { stage: s2, amount: 50.25, currency: 'EUR', owner: manager.id },
        { stage: s2, amount: 999, currency: 'EUR', owner: manager.id, status: 'won' },
        { stage: s2, amount: 999, currency: 'EUR', owner: manager.id, archived: true },
        { stage: s2, amount: 999, currency: 'EUR', owner: manager.id, deleted: true },
      ])
      pipelineB = await createPipeline(projectB)
      await seed(projectB, pipelineB, [{ stage: pipelineB.stages[0] ?? '', amount: 5000 }])
    })

    it('числа и суммы по валютам совпадают с прямым SQL; закрытые, архивные и удалённые — не в счёт', async () => {
      const res = await get(admin, `/v1/pipelines/${pipeline.id}/aggregates`)
      const aggregates = await json<PipelineAggregates>(res)
      expect(asMap(aggregates)).toEqual(await expectedAggregates(pipeline.id, 'all'))
      const [s1 = '', s2 = ''] = pipeline.stages
      expect(asMap(aggregates).get(s1)).toEqual({
        count: 4,
        sums: { EUR: 300.5, UAH: 1000, USD: 7 },
      })
      expect(asMap(aggregates).get(s2)).toEqual({ count: 1, sums: { EUR: 50.25 } })
    })

    it('менеджер «свои» — только свои сделки и общая очередь', async () => {
      const aggregates = await json<PipelineAggregates>(
        await get(manager, `/v1/pipelines/${pipeline.id}/aggregates`),
      )
      expect(asMap(aggregates)).toEqual(await expectedAggregates(pipeline.id, [manager.id, null]))
      expect(asMap(aggregates).get(pipeline.stages[0] ?? '')).toEqual({
        count: 2,
        sums: { EUR: 200, UAH: 1000 },
      })
    })

    it('фильтры ответственного: «без відповідального», «я», участник', async () => {
      const queue = await json<PipelineAggregates>(
        await get(admin, `/v1/pipelines/${pipeline.id}/aggregates?owner=none`),
      )
      expect(asMap(queue)).toEqual(await expectedAggregates(pipeline.id, [null]))
      const mine = await json<PipelineAggregates>(
        await get(manager, `/v1/pipelines/${pipeline.id}/aggregates?owner=me`),
      )
      expect(asMap(mine)).toEqual(await expectedAggregates(pipeline.id, [manager.id]))
      const colleagues = await json<PipelineAggregates>(
        await get(admin, `/v1/pipelines/${pipeline.id}/aggregates?owner=${colleague.id}`),
      )
      expect(asMap(colleagues)).toEqual(await expectedAggregates(pipeline.id, [colleague.id]))
      // Чужой ответственный вне охвата «свои» фильтром не открывается.
      const foreign = await json<PipelineAggregates>(
        await get(manager, `/v1/pipelines/${pipeline.id}/aggregates?owner=${colleague.id}`),
      )
      expect(foreign.stages).toEqual([])
    })

    it('агрегаты проекта B не попадают в A: воронка B из A — 404', async () => {
      const res = await get(admin, `/v1/pipelines/${pipelineB.id}/aggregates`)
      expect(res.status).toBe(404)
      const inB = await json<PipelineAggregates>(
        await get(admin, `/v1/pipelines/${pipelineB.id}/aggregates`, projectB),
      )
      expect(inB.stages).toEqual([{ stageId: pipelineB.stages[0], count: 1, sums: { EUR: 5000 } }])
    })

    it('без права на сделки — 403; неверный фильтр — 400', async () => {
      const outsider = await h.signIn()
      const { id: roleId } = await h.owner
        .insertInto('role')
        .values({ project_id: projectA, name: 'Без прав канбану', permissions: '{}' })
        .returning('id')
        .executeTakeFirstOrThrow()
      await h.owner
        .insertInto('project_member')
        .values({ project_id: projectA, user_id: outsider.id, role_id: roleId })
        .execute()
      expect((await get(outsider, `/v1/pipelines/${pipeline.id}/aggregates`)).status).toBe(403)
      expect((await get(outsider, `/v1/deals?pipeline=${pipeline.id}`)).status).toBe(403)
      expect((await get(admin, `/v1/pipelines/${pipeline.id}/aggregates?owner=`)).status).toBe(400)
      expect((await get(admin, '/v1/pipelines/not-a-uuid/aggregates')).status).toBe(404)
    })
  })

  describe('выдача колонки', () => {
    it('50 карточек и курсор; следующая страница без повторов и пропусков при равных датах', async () => {
      const pipeline = await createPipeline(projectA)
      const stage = pipeline.stages[0] ?? ''
      const ids = await seed(
        projectA,
        pipeline,
        Array.from({ length: 60 }, () => ({ stage, amount: 10 })),
      )
      // Все 60 — с одним временем смены этапа: порядок решает только id.
      await h.owner
        .updateTable('deal')
        .set({ stage_changed_at: new Date('2026-11-20T10:00:00.123Z') })
        .where('pipeline_id', '=', pipeline.id)
        .execute()

      const first = await json<DealsPage>(
        await get(admin, `/v1/deals?pipeline=${pipeline.id}&stage=${stage}`),
      )
      expect(first.data).toHaveLength(50)
      expect(first.next_cursor).toEqual(expect.any(String))
      const second = await json<DealsPage>(
        await get(
          admin,
          `/v1/deals?pipeline=${pipeline.id}&stage=${stage}&cursor=${encodeURIComponent(first.next_cursor ?? '')}`,
        ),
      )
      expect(second.data).toHaveLength(10)
      expect(second.next_cursor).toBeNull()
      const seen = [...first.data, ...second.data].map((d) => d.id)
      expect(new Set(seen).size).toBe(60)
      expect([...seen].sort()).toEqual([...ids].sort())
    })

    it('порядок — недавно пришедшие на этап сверху; поля карточки; закрытые и архивные не видны', async () => {
      const pipeline = await createPipeline(projectA)
      const [s1 = '', s2 = ''] = pipeline.stages
      const [older = '', newer = '', , queued = ''] = await seed(projectA, pipeline, [
        { stage: s1, amount: 12.5, currency: 'USD', owner: manager.id },
        { stage: s1, amount: 1 },
        { stage: s1, status: 'won' },
        { stage: s1, owner: null },
        { stage: s1, archived: true },
        { stage: s2 },
      ])
      await h.owner
        .updateTable('deal')
        .set({ stage_changed_at: sql`now() - interval '1 day'` })
        .where('id', '=', older)
        .execute()
      const page = await json<DealsPage>(
        await get(admin, `/v1/deals?pipeline=${pipeline.id}&stage=${s1}`),
      )
      expect(page.data.map((d) => d.id)).toHaveLength(3)
      expect(page.data.at(-1)?.id).toBe(older)
      expect(page.data.map((d) => d.id)).toContain(newer)
      const card = page.data.find((d) => d.id === older) as BoardDeal
      expect(card).toMatchObject({
        pipelineId: pipeline.id,
        stageId: s1,
        amount: 12.5,
        currency: 'USD',
        ownerId: manager.id,
        ownerName: 'Ганна Вигадана',
        contactName: expect.stringMatching(/^Клієнт\d+ Вигаданий$/),
      })
      expect(page.data.find((d) => d.id === queued)).toMatchObject({
        ownerId: null,
        ownerName: null,
      })

      const queue = await json<DealsPage>(
        await get(admin, `/v1/deals?pipeline=${pipeline.id}&stage=${s1}&owner=none`),
      )
      expect(queue.data.map((d) => d.id)).toEqual([queued])
      const mine = await json<DealsPage>(
        await get(manager, `/v1/deals?pipeline=${pipeline.id}&stage=${s1}&owner=me`),
      )
      expect(mine.data.map((d) => d.id)).toEqual([older])
      // «Свои»: своя и очередь, чужие (администратора) — нет.
      const scoped = await json<DealsPage>(
        await get(manager, `/v1/deals?pipeline=${pipeline.id}&stage=${s1}`),
      )
      expect(scoped.data.map((d) => d.id).sort()).toEqual([older, queued].sort())
    })

    it('неверные параметры — 400; сделки проекта B из A не видны', async () => {
      expect((await get(admin, '/v1/deals?cursor=abc')).status).toBe(400)
      expect((await get(admin, '/v1/deals?pipeline=nope')).status).toBe(400)
      expect((await get(admin, '/v1/deals?limit=500')).status).toBe(400)
      const forged = Buffer.from(JSON.stringify({ t: '2026-13-45 99:00:00+00', id: '0' })).toString(
        'base64url',
      )
      expect((await get(admin, `/v1/deals?cursor=${forged}`)).status).toBe(400)
      const pipelineB = await createPipeline(projectB)
      await seed(projectB, pipelineB, [{ stage: pipelineB.stages[0] ?? '' }])
      const fromA = await json<DealsPage>(await get(admin, `/v1/deals?pipeline=${pipelineB.id}`))
      expect(fromA.data).toEqual([])
    })
  })

  describe('ответственные для фильтра', () => {
    it('администратор — все участники; менеджер «свои» — только он сам', async () => {
      const all = await json<DealOwner[]>(await get(admin, '/v1/deals/owners'))
      expect(all.map((o) => o.id)).toEqual(
        expect.arrayContaining([admin.id, manager.id, colleague.id]),
      )
      const own = await json<DealOwner[]>(await get(manager, '/v1/deals/owners'))
      expect(own).toEqual([{ id: manager.id, name: 'Ганна Вигадана' }])
    })
  })

  describe('требования этапа', () => {
    it('точка расширения вернула поле — 422 со списком, сделка остаётся на месте', async () => {
      const pipeline = await createPipeline(projectA, ['s1', 's2', 's3'])
      const [s1 = '', s2 = '', s3 = ''] = pipeline.stages
      const [dealId = ''] = await seed(projectA, pipeline, [{ stage: s1, owner: manager.id }])
      const asked: StageTarget[] = []
      const requirements: StageRequirements = {
        async missingFields(_viewer, target) {
          asked.push(target)
          return 'stageId' in target && target.stageId === s2
            ? {
                fields: [
                  { code: 'budget', nameUk: 'Бюджет', nameRu: null },
                  { code: 'contract', nameUk: 'Договір', nameRu: 'Договор' },
                ],
                hiddenCount: 1,
              }
            : { fields: [], hiddenCount: 0 }
        },
      }
      const app = createApp({ auth: h.auth, db: h.appDb, stageRequirements: requirements })

      const refused = await manager.call(app, 'POST', `/v1/deals/${dealId}/stage`, {
        project: projectA,
        body: { stageId: s2 },
      })
      expect(problemFields(await json(refused, 422), 422)).toEqual({
        code: 'STAGE_REQUIREMENTS_MISSING',
        details: {
          fields: ['budget', 'contract'],
          names: [
            { code: 'budget', nameUk: 'Бюджет', nameRu: null },
            { code: 'contract', nameUk: 'Договір', nameRu: 'Договор' },
          ],
          hiddenCount: 1,
        },
        errors: requiredErrors('budget', 'contract'),
      })
      const row = await h.owner
        .selectFrom('deal')
        .select('stage_id')
        .where('id', '=', dealId)
        .executeTakeFirstOrThrow()
      expect(row.stage_id).toBe(s1)
      const history = await h.owner
        .selectFrom('change_log')
        .select('field')
        .where('entity_id', '=', dealId)
        .execute()
      expect(history).toEqual([])

      const moved = await manager.call(app, 'POST', `/v1/deals/${dealId}/stage`, {
        project: projectA,
        body: { stageId: s3 },
      })
      expect((await json<{ stageId: string }>(moved)).stageId).toBe(s3)
      expect(asked).toEqual([
        { pipelineId: pipeline.id, stageId: s2 },
        { pipelineId: pipeline.id, stageId: s3 },
      ])
    })

    it('без пользовательских полей требований нет: смена этапа проходит', async () => {
      const pipeline = await createPipeline(projectA)
      const [s1 = '', s2 = ''] = pipeline.stages
      const [dealId = ''] = await seed(projectA, pipeline, [{ stage: s1 }])
      const res = await admin.api('POST', `/v1/deals/${dealId}/stage`, {
        project: projectA,
        body: { stageId: s2 },
      })
      expect((await json<{ stageId: string }>(res)).stageId).toBe(s2)
    })
  })

  // Карточки контакта и организации (тикет crm-deals/14): сделки контакта (основной и
  // участник), сделки организации, контакты организации — с охватом роли.
  describe('сделки и контакты для карточек контакта и организации', () => {
    let pipeline: Pipeline
    /** Вторая воронка: у контакта одна открытая сделка в воронке. */
    let otherPipeline: Pipeline
    let organizationId: string
    /** Основной в сделке менеджера и в сделке коллеги, участник в двух других. */
    let client: string
    /** Только основной в сделке коллеги: менеджеру «свои» не виден. */
    let foreign: string
    /** Создан менеджером, в организации. */
    let created: string
    /** Создан коллегой, в организации: менеджеру не виден. */
    let colleagues: string
    const deals: Record<
      'mine' | 'theirs' | 'asParticipant' | 'mineWonArchived' | 'orgOnly',
      string
    > = { mine: '', theirs: '', asParticipant: '', mineWonArchived: '', orgOnly: '' }

    async function contact(firstName: string, values: Record<string, unknown> = {}) {
      const row = await h.owner
        .insertInto('contact')
        .values({ project_id: projectA, first_name: firstName, last_name: 'Вигаданий', ...values })
        .returning('id')
        .executeTakeFirstOrThrow()
      return row.id
    }

    async function deal(
      primary: string,
      owner: string,
      extra: {
        organization?: string
        participant?: string
        wonArchived?: boolean
        in?: Pipeline
      } = {},
    ) {
      counter += 1
      const where = extra.in ?? pipeline
      const row = await h.owner
        .insertInto('deal')
        .values({
          project_id: projectA,
          title: `Угода картки ${counter}`,
          pipeline_id: where.id,
          stage_id: where.stages[0] ?? '',
          amount: 0,
          owner_id: owner,
          primary_contact_id: primary,
          organization_id: extra.organization ?? null,
          status: extra.wonArchived ? 'won' : 'open',
          won_at: extra.wonArchived ? new Date() : null,
          archived_at: extra.wonArchived ? new Date() : null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      if (extra.participant) {
        await h.owner
          .insertInto('deal_participant')
          .values({ project_id: projectA, deal_id: row.id, contact_id: extra.participant })
          .execute()
      }
      return row.id
    }

    beforeAll(async () => {
      pipeline = await createPipeline(projectA)
      otherPipeline = await createPipeline(projectA)
      organizationId = (
        await h.owner
          .insertInto('organization')
          .values({ project_id: projectA, name: 'ТОВ Вигадана' })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id
      client = await contact('Клієнт', { organization_id: organizationId })
      foreign = await contact('Чужинець')
      await h.owner
        .insertInto('contact_phone')
        .values({
          project_id: projectA,
          contact_id: foreign,
          phone: '+380679990011',
          is_primary: true,
        })
        .execute()
      created = await contact('Створений', {
        organization_id: organizationId,
        created_by: manager.id,
      })
      colleagues = await contact('Колегин', {
        organization_id: organizationId,
        created_by: colleague.id,
      })
      deals.mine = await deal(client, manager.id, { organization: organizationId })
      deals.theirs = await deal(client, colleague.id, {
        organization: organizationId,
        in: otherPipeline,
      })
      deals.asParticipant = await deal(foreign, colleague.id, { participant: client })
      deals.mineWonArchived = await deal(await contact('Інший'), manager.id, {
        participant: client,
        wonArchived: true,
      })
      deals.orgOnly = await deal(colleagues, colleague.id, { organization: organizationId })
    })

    const ids = (page: DealsPage) => page.data.map((item) => item.id).sort()

    it('сделки контакта: основной и участник, все статусы; менеджер «свои» — только свои', async () => {
      const all = await json<DealsPage>(
        await get(admin, `/v1/deals?contact=${client}&status=any&archived=any`),
      )
      expect(ids(all)).toEqual(
        [deals.mine, deals.theirs, deals.asParticipant, deals.mineWonArchived].sort(),
      )
      expect(all.data.find((item) => item.id === deals.mineWonArchived)?.status).toBe('won')

      const own = await json<DealsPage>(
        await get(manager, `/v1/deals?contact=${client}&status=any&archived=any`),
      )
      expect(ids(own)).toEqual([deals.mine, deals.mineWonArchived].sort())
    })

    it('сделки организации; менеджер «свои» — только свои; неверный id — 400', async () => {
      const all = await json<DealsPage>(
        await get(admin, `/v1/deals?organization=${organizationId}&status=any&archived=any`),
      )
      expect(ids(all)).toEqual([deals.mine, deals.theirs, deals.orgOnly].sort())
      const own = await json<DealsPage>(
        await get(manager, `/v1/deals?organization=${organizationId}&status=any&archived=any`),
      )
      expect(ids(own)).toEqual([deals.mine])
      expect((await get(admin, '/v1/deals?contact=abc')).status).toBe(400)
      expect((await get(admin, '/v1/deals?organization=abc')).status).toBe(400)
    })

    it('контакты организации: менеджер «свои» видит контакт своей сделки и созданный им', async () => {
      const path = `/v1/contacts?organizationId=${organizationId}&limit=200`
      const all = await json<{ id: string }[]>(await get(admin, path))
      expect(all.map((c) => c.id).sort()).toEqual([client, created, colleagues].sort())
      const own = await json<{ id: string }[]>(await get(manager, path))
      expect(own.map((c) => c.id).sort()).toEqual([client, created].sort())
    })

    it('карточка: контакт своей сделки и созданный — открываются; только из чужой сделки — 404 без данных', async () => {
      expect((await get(manager, `/v1/contacts/${client}`)).status).toBe(200)
      expect((await get(manager, `/v1/contacts/${created}`)).status).toBe(200)
      const denied = await get(manager, `/v1/contacts/${foreign}`)
      const body = await denied.text()
      expect(denied.status).toBe(404)
      expect(body).not.toContain('Чужинець')
      expect(body).not.toContain('380679990011')
      expect(body).not.toContain(foreign)
    })
  })
})
