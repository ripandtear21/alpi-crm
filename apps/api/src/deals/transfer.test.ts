import { randomBytes, randomUUID } from 'node:crypto'
import type { MemberSummary, TeamSummary } from '@alpi/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.ts'
import type { BulkJobDetails, BulkJobSummary } from '../bulk/routes.ts'
import { type Jobs, startJobs } from '../jobs/jobs.ts'
import { type ApiHarness, type SignedInUser, startApiHarness } from '../testing/api-harness.ts'
import { NO_TRASH_PURGERS } from '../trash/purge.ts'
import { TRANSFER_DEALS_ACTION, transferDeals } from './transfer.ts'

// Передача сделок участника (тикет crm-deals/09): настоящая проверка открытых сделок при
// отключении и передача массовой операцией — на настоящем PostgreSQL, API и обработчик pg-boss
// ходят ролью приложения. Имена — вымышленные.

const ACTIONS = new Map([[TRANSFER_DEALS_ACTION, transferDeals]])

interface Place {
  pipelineId: string
  stageId: string
  lostReasonId: string
}

type DealKind = 'open' | 'archived' | 'won' | 'lost' | 'trashed'

describe('передача сделок участника', () => {
  let h: ApiHarness
  let jobs: Jobs
  let app: ReturnType<typeof createApp>
  let admin: SignedInUser
  let projectA: string
  let projectB: string
  let placeA: Place
  let placeB: Place
  let counter = 0

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_transfer')
    jobs = await startJobs({
      connectionString: h.appUrl,
      db: h.appDb,
      bulkActions: ACTIONS,
      trashPurgers: NO_TRASH_PURGERS,
      bulkRetryLimit: 0,
      pollingIntervalSeconds: 0.5,
      schedule: false,
    })
    app = createApp({
      auth: h.auth,
      db: h.appDb,
      bulk: { actions: ACTIONS, enqueue: jobs.enqueueBulk },
    })
    admin = await h.signIn('owner')
    projectA = (await h.createProject(admin, 'Передача А')).id
    projectB = (await h.createProject(admin, 'Передача Б')).id
    placeA = await createPlace(projectA)
    placeB = await createPlace(projectB)
  })

  afterAll(async () => {
    await jobs?.stop()
    await h?.stop()
  })

  async function createPlace(projectId: string): Promise<Place> {
    const pipeline = await h.owner
      .insertInto('pipeline')
      .values({ project_id: projectId, code: `p${++counter}`, name: 'Продажі', position: 1 })
      .returning('id')
      .executeTakeFirstOrThrow()
    const stage = await h.owner
      .insertInto('stage')
      .values({ project_id: projectId, pipeline_id: pipeline.id, name: 'Новий лід', position: 1 })
      .returning('id')
      .executeTakeFirstOrThrow()
    const group = await h.owner
      .insertInto('lost_reason_group')
      .values({ project_id: projectId, name: 'Причини' })
      .returning('id')
      .executeTakeFirstOrThrow()
    const reason = await h.owner
      .insertInto('lost_reason')
      .values({ project_id: projectId, group_id: group.id, name: 'Дорого' })
      .returning('id')
      .executeTakeFirstOrThrow()
    return { pipelineId: pipeline.id, stageId: stage.id, lostReasonId: reason.id }
  }

  /** Участник проекта, который в API не входит: только ответственный сделок. */
  async function newUser(): Promise<string> {
    const { user } = await h.auth.api.createUser({
      body: {
        email: `${randomUUID()}@example.test`,
        password: randomBytes(18).toString('base64url'),
        name: 'Вигаданий',
      },
    })
    return user.id
  }

  async function member(projectId: string, template = 'manager'): Promise<string> {
    const id = await newUser()
    await h.addMember(projectId, id, template)
    return id
  }

  /** `count` сделок ответственного `ownerId`, каждая — со своим контактом. */
  async function insertDeals(
    projectId: string,
    ownerId: string | null,
    count: number,
    kind: DealKind = 'open',
  ): Promise<string[]> {
    const place = projectId === projectA ? placeA : placeB
    const contacts = await h.owner
      .insertInto('contact')
      .values(
        Array.from({ length: count }, () => ({ project_id: projectId, first_name: 'Клієнт' })),
      )
      .returning('id')
      .execute()
    const now = new Date()
    const rows = await h.owner
      .insertInto('deal')
      .values(
        contacts.map((contact) => ({
          project_id: projectId,
          title: 'Угода',
          pipeline_id: place.pipelineId,
          stage_id: place.stageId,
          owner_id: ownerId,
          primary_contact_id: contact.id,
          status: kind === 'won' ? 'won' : kind === 'lost' ? 'lost' : 'open',
          won_at: kind === 'won' ? now : null,
          lost_at: kind === 'lost' ? now : null,
          lost_reason_id: kind === 'lost' ? place.lostReasonId : null,
          archived_at: kind === 'archived' ? now : null,
          deleted_at: kind === 'trashed' ? now : null,
        })),
      )
      .returning('id')
      .execute()
    return rows.map((r) => r.id)
  }

  async function owners(ids: string[]): Promise<Set<string | null>> {
    const rows = await h.owner
      .selectFrom('deal')
      .select('owner_id')
      .where('id', 'in', ids)
      .execute()
    return new Set(rows.map((r) => r.owner_id))
  }

  function disable(user: SignedInUser, projectId: string, userId: string) {
    return user.call(app, 'POST', `/members/${userId}/disable`, { project: projectId })
  }

  function transfer(user: SignedInUser, projectId: string, userId: string, body: unknown) {
    return user.call(app, 'POST', `/v1/members/${userId}/transfer-deals`, {
      project: projectId,
      body,
    })
  }

  async function reply(res: Response) {
    return { status: res.status, body: (await res.json()) as unknown }
  }

  async function waitFinished(user: SignedInUser, projectId: string, id: string) {
    return vi.waitFor(
      async () => {
        const res = await user.call(app, 'GET', `/v1/bulk-jobs/${id}`, { project: projectId })
        expect(res.status).toBe(200)
        const job = (await res.json()) as BulkJobDetails
        expect(['done', 'failed']).toContain(job.status)
        return job
      },
      { timeout: 30_000, interval: 200 },
    )
  }

  /** Передать и дождаться конца операции. */
  async function transferAndWait(
    user: SignedInUser,
    projectId: string,
    userId: string,
    toUserId: string | null,
  ): Promise<BulkJobDetails> {
    const res = await transfer(user, projectId, userId, { toUserId })
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(202)
    const started = (await res.json()) as BulkJobSummary
    expect(started).toMatchObject({ action: TRANSFER_DEALS_ACTION, status: 'queued' })
    return waitFinished(user, projectId, started.id)
  }

  describe('проверка открытых сделок при отключении', () => {
    it('открытая сделка — отказ с их числом', async () => {
      const user = await member(projectA)
      await insertDeals(projectA, user, 2)
      expect(await reply(await disable(admin, projectA, user))).toEqual({
        status: 409,
        body: { code: 'HAS_OPEN_DEALS', details: { count: 2 } },
      })
    })

    it('одна только архивная открытая сделка — отказ: архив — отметка, а не статус', async () => {
      const user = await member(projectA)
      await insertDeals(projectA, user, 1, 'archived')
      expect(await reply(await disable(admin, projectA, user))).toEqual({
        status: 409,
        body: { code: 'HAS_OPEN_DEALS', details: { count: 1 } },
      })
    })

    it('выигранные, проигранные и удалённые в корзину — отключение разрешено', async () => {
      const user = await member(projectA)
      await insertDeals(projectA, user, 1, 'won')
      await insertDeals(projectA, user, 1, 'lost')
      await insertDeals(projectA, user, 1, 'trashed')
      const res = await disable(admin, projectA, user)
      expect(res.status).toBe(200)
      expect(((await res.json()) as MemberSummary).disabled).toBe(true)
    })
  })

  it('300 открытых сделок менеджеру: массовая операция, история у каждой, затем отключение', async () => {
    const from = await member(projectA)
    const to = await member(projectA)
    const open = await insertDeals(projectA, from, 300)
    const archived = await insertDeals(projectA, from, 1, 'archived')
    const won = await insertDeals(projectA, from, 1, 'won')

    const res = await transfer(admin, projectA, from, { toUserId: to })
    expect(res.status).toBe(202)
    const started = (await res.json()) as BulkJobSummary
    const job = await waitFinished(admin, projectA, started.id)
    expect(job).toMatchObject({ status: 'done', total: 301, processed: 301, failed: 0 })
    expect(job.errors).toEqual([])

    expect(await owners([...open, ...archived])).toEqual(new Set([to]))
    // Закрытые сделки остаются за прежним ответственным: они — его история.
    expect(await owners(won)).toEqual(new Set([from]))

    const history = await h.owner
      .selectFrom('change_log')
      .select(['entity_id', 'field', 'before', 'after', 'actor_id'])
      .where('entity_type', '=', 'deal')
      .where('entity_id', 'in', [...open, ...archived])
      .execute()
    expect(history).toHaveLength(301)
    for (const entry of history) {
      expect(entry).toMatchObject({ field: 'ownerId', before: from, after: to, actor_id: admin.id })
    }

    // Запуск — в журнале опасных действий: кто, чьи сделки и кому.
    const audit = await h.owner
      .selectFrom('audit_log')
      .select(['project_id', 'actor_id', 'action', 'entity_type', 'details'])
      .where('entity_id', '=', started.id)
      .executeTakeFirstOrThrow()
    expect(audit).toEqual({
      project_id: projectA,
      actor_id: admin.id,
      action: 'bulk.started',
      entity_type: 'bulk_job',
      details: {
        action: TRANSFER_DEALS_ACTION,
        selection: 'filter',
        fromUserId: from,
        toUserId: to,
        count: 301,
      },
    })

    const disabled = await disable(admin, projectA, from)
    expect(disabled.status).toBe(200)
  }, 60_000)

  it('сделка, появившаяся после передачи, — отказ отключения с числом новых', async () => {
    const from = await member(projectA)
    const to = await member(projectA)
    await insertDeals(projectA, from, 3)
    expect(await transferAndWait(admin, projectA, from, to)).toMatchObject({ processed: 3 })
    await insertDeals(projectA, from, 1)
    expect(await reply(await disable(admin, projectA, from))).toEqual({
      status: 409,
      body: { code: 'HAS_OPEN_DEALS', details: { count: 1 } },
    })
  })

  it('в общую очередь: ответственный снимается, сделки видны менеджеру с охватом «свои»', async () => {
    const from = await member(projectA)
    const deals = await insertDeals(projectA, from, 2)
    const job = await transferAndWait(admin, projectA, from, null)
    expect(job).toMatchObject({ status: 'done', processed: 2, failed: 0 })
    expect(await owners(deals)).toEqual(new Set([null]))
    const history = await h.owner
      .selectFrom('change_log')
      .select(['before', 'after'])
      .where('entity_id', 'in', deals)
      .execute()
    expect(history).toEqual([
      { before: from, after: null },
      { before: from, after: null },
    ])

    const manager = await h.signIn()
    await h.addMember(projectA, manager.id, 'manager')
    for (const id of deals) {
      const res = await manager.call(app, 'GET', `/v1/deals/${id}`, { project: projectA })
      expect(res.status).toBe(200)
    }
  })

  describe('права', () => {
    let lead: SignedInUser
    let mate: string
    let mate2: string
    let outsider: string
    let teamId: string

    /** Новый участник команды тимлида. */
    async function teamMate(): Promise<string> {
      const userId = await member(projectA)
      const res = await admin.call(app, 'PUT', `/members/${userId}/team`, {
        project: projectA,
        body: { teamId },
      })
      expect(res.status).toBe(200)
      return userId
    }

    beforeAll(async () => {
      lead = await h.signIn()
      await h.addMember(projectA, lead.id, 'teamlead')
      outsider = await member(projectA)
      const team = await admin.call(app, 'POST', '/teams', {
        project: projectA,
        body: { name: `Команда ${++counter}`, leadUserId: lead.id },
      })
      expect(team.status).toBe(201)
      teamId = ((await team.json()) as TeamSummary).id
      mate = await teamMate()
      mate2 = await teamMate()
    })

    it('без права «передача сделок» — 403', async () => {
      const manager = await h.signIn()
      await h.addMember(projectA, manager.id, 'manager')
      const from = await member(projectA)
      const deals = await insertDeals(projectA, from, 1)
      expect(await reply(await transfer(manager, projectA, from, { toUserId: null }))).toEqual({
        status: 403,
        body: { code: 'PERMISSION_DENIED' },
      })
      expect(await owners(deals)).toEqual(new Set([from]))
    })

    it('тимлид без права «массовые операции» передаёт сделки внутри своей команды', async () => {
      const deals = await insertDeals(projectA, mate, 2)
      const job = await transferAndWait(lead, projectA, mate, mate2)
      // Каркас перепроверяет права на каждой порции: для передачи — «передача сделок».
      expect(job).toMatchObject({ status: 'done', processed: 2, failed: 0 })
      expect(await owners(deals)).toEqual(new Set([mate2]))
    })

    it('тимлид не передаёт сделки участнику другой команды и не трогает сделки вне охвата', async () => {
      const own = await insertDeals(projectA, mate, 1)
      const foreign = await insertDeals(projectA, outsider, 1)
      expect(await reply(await transfer(lead, projectA, mate, { toUserId: outsider }))).toEqual({
        status: 403,
        body: { code: 'PERMISSION_DENIED' },
      })
      expect(await reply(await transfer(lead, projectA, outsider, { toUserId: mate }))).toEqual({
        status: 403,
        body: { code: 'PERMISSION_DENIED' },
      })
      expect(await owners(own)).toEqual(new Set([mate]))
      expect(await owners(foreign)).toEqual(new Set([outsider]))
    })

    /** Запуск передачи через общий POST /v1/bulk-jobs и конец операции. */
    async function bulkTransferAndWait(
      selection: unknown,
      fromUserId: string,
      toUserId: string | null,
    ): Promise<BulkJobDetails> {
      const res = await lead.call(app, 'POST', '/v1/bulk-jobs', {
        project: projectA,
        body: { action: TRANSFER_DEALS_ACTION, selection, params: { fromUserId, toUserId } },
      })
      expect(res.status, JSON.stringify(await res.clone().json())).toBe(202)
      const started = (await res.json()) as BulkJobSummary
      return waitFinished(lead, projectA, started.id)
    }

    it('общий POST /v1/bulk-jobs по фильтру: сделки участника другой команды не выбираются и не видны', async () => {
      const foreign = await insertDeals(projectA, outsider, 3)
      const job = await bulkTransferAndWait({ filter: {} }, outsider, mate)
      // Ни числа, ни id чужих открытых сделок: операция пуста.
      expect(job).toMatchObject({ status: 'done', total: 0, processed: 0, failed: 0 })
      expect(job.errors).toEqual([])
      expect(await owners(foreign)).toEqual(new Set([outsider]))
    })

    it('общий POST /v1/bulk-jobs по id: сделки вне охвата — OUT_OF_SCOPE, ответственный прежний', async () => {
      const foreign = await insertDeals(projectA, outsider, 2)
      const job = await bulkTransferAndWait({ ids: foreign }, outsider, mate)
      expect(job).toMatchObject({ status: 'done', total: 2, processed: 2, failed: 2 })
      expect(job.errors.map((e) => e.code)).toEqual(['OUT_OF_SCOPE', 'OUT_OF_SCOPE'])
      expect(await owners(foreign)).toEqual(new Set([outsider]))
    })

    it('общий POST /v1/bulk-jobs: получатель вне команды — OUT_OF_SCOPE, ответственный прежний', async () => {
      const from = await teamMate()
      const own = await insertDeals(projectA, from, 2)
      for (const selection of [{ filter: {} }, { ids: own }]) {
        const job = await bulkTransferAndWait(selection, from, outsider)
        expect(job).toMatchObject({ status: 'done', total: 2, processed: 2, failed: 2 })
        expect(job.errors.map((e) => e.code)).toEqual(['OUT_OF_SCOPE', 'OUT_OF_SCOPE'])
        expect(await owners(own)).toEqual(new Set([from]))
      }
    })

    it('получатель из другого проекта или отключённый — 422', async () => {
      const from = await member(projectA)
      const deals = await insertDeals(projectA, from, 1)
      const elsewhere = await member(projectB)
      expect(await reply(await transfer(admin, projectA, from, { toUserId: elsewhere }))).toEqual({
        status: 422,
        body: { code: 'OWNER_NOT_MEMBER' },
      })
      const gone = await member(projectA)
      expect((await disable(admin, projectA, gone)).status).toBe(200)
      expect(await reply(await transfer(admin, projectA, from, { toUserId: gone }))).toEqual({
        status: 422,
        body: { code: 'OWNER_NOT_MEMBER' },
      })
      expect(await owners(deals)).toEqual(new Set([from]))
    })

    it('неверное тело и чужой участник', async () => {
      const from = await member(projectA)
      expect((await transfer(admin, projectA, from, {})).status).toBe(400)
      expect((await transfer(admin, projectA, from, { toUserId: 5 })).status).toBe(400)
      expect((await transfer(admin, projectA, from, { toUserId: from })).status).toBe(400)
      const elsewhere = await member(projectB)
      expect(await reply(await transfer(admin, projectA, elsewhere, { toUserId: null }))).toEqual({
        status: 404,
        body: { code: 'MEMBER_NOT_FOUND' },
      })
    })
  })

  it('изоляция: проверка и передача в проекте A не видят сделок того же участника в проекте B', async () => {
    const user = await newUser()
    await h.addMember(projectA, user, 'manager')
    await h.addMember(projectB, user, 'manager')
    const inA = await insertDeals(projectA, user, 2)
    const inB = await insertDeals(projectB, user, 3)
    const to = await member(projectA)

    expect(await reply(await disable(admin, projectA, user))).toEqual({
      status: 409,
      body: { code: 'HAS_OPEN_DEALS', details: { count: 2 } },
    })
    const job = await transferAndWait(admin, projectA, user, to)
    expect(job).toMatchObject({ status: 'done', total: 2, processed: 2, failed: 0 })
    expect(await owners(inA)).toEqual(new Set([to]))
    expect(await owners(inB)).toEqual(new Set([user]))
    expect(
      await h.owner.selectFrom('change_log').select('id').where('entity_id', 'in', inB).execute(),
    ).toEqual([])

    expect((await disable(admin, projectA, user)).status).toBe(200)
    expect(await reply(await disable(admin, projectB, user))).toEqual({
      status: 409,
      body: { code: 'HAS_OPEN_DEALS', details: { count: 3 } },
    })
  })
})
