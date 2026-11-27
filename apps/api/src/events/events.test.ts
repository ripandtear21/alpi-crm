import { randomInt } from 'node:crypto'
import type { WebhookEventTable } from '@alpi/db'
import { withProject } from '@alpi/db'
import { type ApiKeyWithSecret, type EventType, eventBodyProblem } from '@alpi/shared'
import { type Selectable, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { requestAuthor } from '../api-keys/actor.ts'
import { createApp } from '../app.ts'
import type { BulkActionRegistry } from '../bulk/registry.ts'
import type { BulkJobDetails, BulkJobSummary } from '../bulk/routes.ts'
import type { ContactView } from '../contacts/contacts.ts'
import { DEAL_BULK_REGISTRY } from '../deals/bulk.ts'
import type { DealView } from '../deals/store.ts'
import { TRANSFER_DEALS_ACTION, transferDeals } from '../deals/transfer.ts'
import { type Jobs, startJobs } from '../jobs/jobs.ts'
import {
  type ApiHarness,
  type Method,
  type SignedInUser,
  startApiHarness,
} from '../testing/api-harness.ts'
import { NO_TRASH_PURGERS } from '../trash/purge.ts'
import { emitDealChanges } from './deal-events.ts'
import { WEBHOOK_FANOUT_QUEUE } from './queue.ts'

// События (тикет crm-api/05): запись в той же транзакции, что изменение (откат — ни события,
// ни задачи webhook-fanout), каталог сделок и контактов на всех путях (карточка, массовая
// операция, передача сделок), автор, изоляция проектов, отсутствие персональных данных в теле —
// на настоящем PostgreSQL, API ходит ролью приложения. Все данные — выдуманные.

const ACTIONS: BulkActionRegistry = new Map([
  [TRANSFER_DEALS_ACTION, transferDeals],
  ...DEAL_BULK_REGISTRY,
])

type EventRow = Selectable<WebhookEventTable>
type Data = Record<string, unknown>

/** Выдуманные данные: ни одна из этих строк не должна попасть в тело события. */
const FAKE = {
  firstName: 'Подієслава',
  lastName: 'Вигаданенко',
  title: 'Угода-подія Вигадана',
  email: `podia.${randomInt(1e9)}@example.test`,
  phone: `+38067${randomInt(1_000_000, 9_999_999)}`,
  custom: 'Секретне-значення-поля',
}

describe('события', () => {
  let h: ApiHarness
  let jobs: Jobs
  let app: ReturnType<typeof createApp>
  let admin: SignedInUser
  let manager: SignedInUser
  let projectA: string
  let projectB: string
  let pipeline: { id: string; stages: string[] }
  let other: { id: string; stages: string[] }
  let reason: string
  let archivedReason: string
  let customCode: string
  /** Тела всех событий прогона — для проверки персональных данных. */
  const bodies: unknown[] = []
  const seen = new Set<string>()
  let counter = 0

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_events')
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
    manager = await h.signIn()
    projectA = (await h.createProject(admin, 'Події А')).id
    projectB = (await h.createProject(admin, 'Події Б')).id
    await h.addMember(projectA, manager.id, 'manager')
    pipeline = await createPipeline(projectA, 3)
    other = await createPipeline(projectA, 2)
    reason = await createReason(projectA, false)
    archivedReason = await createReason(projectA, true)
    const group = await json<{ id: string }>(
      await call(admin, 'POST', '/v1/field-groups', { entity: 'deal', nameUk: 'Подія' }),
      201,
    )
    customCode = 'podia_text'
    await json(
      await call(admin, 'POST', '/v1/fields', {
        groupId: group.id,
        nameUk: 'Текст події',
        code: customCode,
        type: 'text',
      }),
      201,
    )
  })

  afterAll(async () => {
    await jobs?.stop()
    await h?.stop()
  })

  async function createPipeline(projectId: string, stages: number) {
    counter += 1
    const { id } = await h.owner
      .insertInto('pipeline')
      .values({
        project_id: projectId,
        code: `ev${counter}`,
        name: `Воронка ${counter}`,
        position: counter,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const ids: string[] = []
    for (let i = 1; i <= stages; i++) {
      const stage = await h.owner
        .insertInto('stage')
        .values({ project_id: projectId, pipeline_id: id, name: `Етап ${i}`, position: i })
        .returning('id')
        .executeTakeFirstOrThrow()
      ids.push(stage.id)
    }
    return { id, stages: ids }
  }

  async function createReason(projectId: string, archived: boolean) {
    const group = await h.owner
      .insertInto('lost_reason_group')
      .values({ project_id: projectId, name: `Група ${randomInt(1e9)}` })
      .returning('id')
      .executeTakeFirstOrThrow()
    const row = await h.owner
      .insertInto('lost_reason')
      .values({
        project_id: projectId,
        group_id: group.id,
        name: archived ? 'Застаріла' : 'Дорого',
        archived_at: archived ? new Date() : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return row.id
  }

  function call(
    user: SignedInUser,
    method: Method,
    path: string,
    body?: unknown,
    project = projectA,
  ) {
    return user.call(app, method, path, { project, ...(body === undefined ? {} : { body }) })
  }

  async function json<T>(res: Response, status = 200): Promise<T> {
    const text = await res.text()
    expect(res.status, text).toBe(status)
    return JSON.parse(text) as T
  }

  /** События, появившиеся с прошлого вызова (служебной ролью — всех проектов). */
  async function newEvents(): Promise<EventRow[]> {
    const rows = await h.owner
      .selectFrom('webhook_event')
      .selectAll()
      .orderBy('occurred_at')
      .orderBy('id')
      .execute()
    const fresh = rows.filter((row) => !seen.has(row.id))
    for (const row of fresh) {
      seen.add(row.id)
      bodies.push(row.body)
    }
    return fresh
  }

  /** Новые события ровно одно, типа `type`: его `data` без id события, проекта и автора. */
  async function single(type: EventType): Promise<{ facts: Data; event: EventRow }> {
    const events = await newEvents()
    expect(events.map((e) => e.type)).toEqual([type])
    const event = events[0] as EventRow
    const { event_id, project_id, actor, ...facts } = (event.body as { data: Data }).data
    expect(event_id).toBe(event.id)
    expect(project_id).toBe(event.project_id)
    expect(actor).toEqual({ type: event.actor_type, id: event.actor_id })
    return { facts, event }
  }

  /** id событий, у которых есть задача webhook-fanout. */
  async function fanoutEventIds(): Promise<string[]> {
    const { rows } = await sql<{ event_id: string }>`
      select data->>'eventId' as event_id from pgboss.job where name = ${WEBHOOK_FANOUT_QUEUE}
    `.execute(h.owner)
    return rows.map((r) => r.event_id)
  }

  async function createContact(user: SignedInUser, extra: Data = {}, project = projectA) {
    return json<ContactView>(
      await call(user, 'POST', '/v1/contacts', { firstName: FAKE.firstName, ...extra }, project),
      201,
    )
  }

  async function createDeal(user: SignedInUser, body: Data = {}, project = projectA) {
    const contact =
      body.contact === undefined && body.contactId === undefined
        ? (await createContact(user, {}, project)).id
        : undefined
    const deal = await json<DealView>(
      await call(
        user,
        'POST',
        '/v1/deals',
        {
          title: FAKE.title,
          pipelineId: pipeline.id,
          ...(contact === undefined ? {} : { contactId: contact }),
          ...body,
        },
        project,
      ),
      201,
    )
    return deal
  }

  async function waitFinished(user: SignedInUser, id: string) {
    return vi.waitFor(
      async () => {
        const job = await json<BulkJobDetails>(await call(user, 'GET', `/v1/bulk-jobs/${id}`))
        expect(job.status).toBe('done')
        return job
      },
      { timeout: 20_000, interval: 200 },
    )
  }

  describe('та же транзакция, что изменение', () => {
    it('зафиксированное изменение оставляет ровно одно событие и одну задачу webhook-fanout', async () => {
      await newEvents()
      const deal = await createDeal(manager)
      const events = await newEvents()
      expect(events.map((e) => e.type).sort()).toEqual(['contact.created', 'deal.created'])
      const fanout = await fanoutEventIds()
      for (const event of events) {
        expect(fanout.filter((id) => id === event.id)).toHaveLength(1)
        expect(eventBodyProblem(event.body)).toBeNull()
      }
      expect(events.find((e) => e.type === 'deal.created')?.entity_id).toBe(deal.id)
    })

    it('отказ после записи контакта (этапа нет) откатывает и contact.created, и его задачу', async () => {
      await newEvents()
      const jobsBefore = (await fanoutEventIds()).length
      const res = await call(manager, 'POST', '/v1/deals', {
        title: FAKE.title,
        pipelineId: pipeline.id,
        stageId: '00000000-0000-4000-8000-000000000000',
        contact: { firstName: FAKE.firstName, emails: [`rollback.${randomInt(1e9)}@example.test`] },
      })
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.status).toBeLessThan(500)
      expect(await newEvents()).toEqual([])
      expect(await fanoutEventIds()).toHaveLength(jobsBefore)
    })

    it('409 «одна открытая сделка» и 422 архивной причины не оставляют ни события, ни задачи', async () => {
      const deal = await createDeal(manager)
      await newEvents()
      const jobsBefore = (await fanoutEventIds()).length
      const twin = await call(manager, 'POST', '/v1/deals', {
        title: FAKE.title,
        pipelineId: pipeline.id,
        contactId: deal.primaryContactId,
      })
      expect(twin.status).toBe(409)
      const lost = await call(manager, 'POST', `/v1/deals/${deal.id}/lose`, {
        lostReasonId: archivedReason,
      })
      expect(lost.status).toBe(422)
      expect(await newEvents()).toEqual([])
      expect(await fanoutEventIds()).toHaveLength(jobsBefore)
    })

    it('исключение после записи события откатывает и событие, и задачу', async () => {
      const deal = await createDeal(manager)
      await newEvents()
      const jobsBefore = (await fanoutEventIds()).length
      const failure = new Error('сбой после записи события')
      await expect(
        withProject(h.appDb, projectA, async (trx) => {
          const row = await trx
            .selectFrom('deal')
            .selectAll()
            .where('id', '=', deal.id)
            .executeTakeFirstOrThrow()
          await emitDealChanges({ db: trx, projectId: projectA, actorId: manager.id }, row, {
            ...row,
            archived_at: new Date(),
          })
          throw failure
        }),
      ).rejects.toBe(failure)
      expect(await newEvents()).toEqual([])
      expect(await fanoutEventIds()).toHaveLength(jobsBefore)
    })
  })

  describe('каталог: каждое действие — ровно одно событие своего типа', () => {
    it('deal.created: сделка, воронка, этап, контакт; автор — менеджер', async () => {
      const contact = await createContact(manager)
      await newEvents()
      const deal = await createDeal(manager, {
        contactId: contact.id,
        stageId: pipeline.stages[1],
        custom: { [customCode]: FAKE.custom },
      })
      const { facts, event } = await single('deal.created')
      expect(facts).toEqual({
        deal_id: deal.id,
        pipeline_id: pipeline.id,
        stage_id: pipeline.stages[1],
        contact_id: contact.id,
      })
      expect([event.actor_type, event.actor_id]).toEqual(['user', manager.id])
      expect([event.entity_type, event.entity_id]).toEqual(['deal', deal.id])
    })

    it('этап, перенос, выигрыш, проигрыш, повторное открытие', async () => {
      const deal = await createDeal(manager)
      const [s1, s2] = pipeline.stages
      await newEvents()

      await json(await call(manager, 'POST', `/v1/deals/${deal.id}/stage`, { stageId: s2 }))
      expect((await single('deal.stage_changed')).facts).toEqual({
        deal_id: deal.id,
        from: { pipeline_id: pipeline.id, stage_id: s1 },
        to: { pipeline_id: pipeline.id, stage_id: s2 },
      })

      await json(await call(manager, 'POST', `/v1/deals/${deal.id}/move`, { pipelineId: other.id }))
      expect((await single('deal.stage_changed')).facts).toEqual({
        deal_id: deal.id,
        from: { pipeline_id: pipeline.id, stage_id: s2 },
        to: { pipeline_id: other.id, stage_id: other.stages[0] },
      })

      await json(await call(manager, 'POST', `/v1/deals/${deal.id}/win`, {}))
      expect((await single('deal.won')).facts).toEqual({
        deal_id: deal.id,
        stage_id: other.stages[0],
      })

      await json(await call(manager, 'POST', `/v1/deals/${deal.id}/reopen`, {}))
      expect((await single('deal.reopened')).facts).toEqual({
        deal_id: deal.id,
        stage_id: other.stages[0],
      })

      await json(await call(manager, 'POST', `/v1/deals/${deal.id}/lose`, { lostReasonId: reason }))
      expect((await single('deal.lost')).facts).toEqual({
        deal_id: deal.id,
        stage_id: other.stages[0],
        lost_reason_id: reason,
      })

      // Повтор того же действия ничего не меняет — и события нет.
      await json(await call(manager, 'POST', `/v1/deals/${deal.id}/lose`, { lostReasonId: reason }))
      await json(
        await call(manager, 'POST', `/v1/deals/${deal.id}/stage`, { stageId: other.stages[0] }),
      )
      expect(await newEvents()).toEqual([])
    })

    it('ответственный: передать, снять в общую очередь, взять в работу', async () => {
      const deal = await createDeal(manager)
      await newEvents()

      await json(await call(admin, 'PUT', `/v1/deals/${deal.id}`, { ownerId: admin.id }))
      let event = await single('deal.owner_changed')
      expect(event.facts).toEqual({
        deal_id: deal.id,
        from_user_id: manager.id,
        to_user_id: admin.id,
      })
      expect(event.event.actor_id).toBe(admin.id)

      await json(await call(admin, 'PUT', `/v1/deals/${deal.id}`, { ownerId: null }))
      expect((await single('deal.owner_changed')).facts).toEqual({
        deal_id: deal.id,
        from_user_id: admin.id,
        to_user_id: null,
      })

      await json(await call(manager, 'POST', `/v1/deals/${deal.id}/take`))
      event = await single('deal.owner_changed')
      expect(event.facts).toEqual({ deal_id: deal.id, from_user_id: null, to_user_id: manager.id })
      expect(event.event.actor_id).toBe(manager.id)
    })

    it('архив и возврат из архива', async () => {
      const deal = await createDeal(manager)
      await newEvents()
      await json(await call(manager, 'POST', `/v1/deals/${deal.id}/archive`))
      expect((await single('deal.archived')).facts).toEqual({ deal_id: deal.id })
      await json(await call(manager, 'POST', `/v1/deals/${deal.id}/unarchive`))
      expect((await single('deal.unarchived')).facts).toEqual({ deal_id: deal.id })
    })

    it('сумма, название, пользовательские поля, корзина — без событий', async () => {
      const deal = await createDeal(manager)
      await newEvents()
      await json(
        await call(manager, 'PUT', `/v1/deals/${deal.id}`, {
          title: `${FAKE.title} 2`,
          amount: 1500,
          custom: { [customCode]: `${FAKE.custom} 2` },
        }),
      )
      expect(await newEvents()).toEqual([])
    })

    it('contact.created и contact.possible_duplicate', async () => {
      const first = await createContact(manager, {
        lastName: FAKE.lastName,
        emails: [FAKE.email],
        phones: [FAKE.phone],
      })
      expect((await single('contact.created')).facts).toEqual({ contact_id: first.id })

      const second = await createContact(manager, { emails: [FAKE.email] })
      expect(second.possibleDuplicate).toBe(true)
      const events = await newEvents()
      expect(events.map((e) => e.type).sort()).toEqual([
        'contact.created',
        'contact.possible_duplicate',
      ])
      for (const event of events) {
        expect((event.body as { data: Data }).data.contact_id).toBe(second.id)
      }

      // Отметка появляется при правке: email совпал с чужим.
      const third = await createContact(manager)
      await newEvents()
      await json(await call(manager, 'PUT', `/v1/contacts/${third.id}`, { emails: [FAKE.email] }))
      expect((await single('contact.possible_duplicate')).facts).toEqual({ contact_id: third.id })
      // Уже отмеченный — второй раз события нет.
      await json(
        await call(manager, 'PUT', `/v1/contacts/${third.id}`, { lastName: FAKE.lastName }),
      )
      expect(await newEvents()).toEqual([])
    })
  })

  describe('автор', () => {
    it('массовый архив и массовая передача — инициатор операции', async () => {
      const a = await createDeal(manager)
      const b = await createDeal(manager)
      await newEvents()
      const archive = await json<BulkJobSummary>(
        await call(admin, 'POST', '/v1/bulk-jobs', {
          action: 'deals.archive',
          selection: { ids: [a.id, b.id] },
        }),
        202,
      )
      await waitFinished(admin, archive.id)
      const archived = await newEvents()
      expect(archived.map((e) => [e.type, e.entity_id, e.actor_type, e.actor_id]).sort()).toEqual(
        [
          ['deal.archived', a.id, 'user', admin.id],
          ['deal.archived', b.id, 'user', admin.id],
        ].sort(),
      )

      const assign = await json<BulkJobSummary>(
        await call(admin, 'POST', '/v1/bulk-jobs', {
          action: 'deals.assign',
          selection: { ids: [a.id] },
          params: { ownerId: null },
        }),
        202,
      )
      await waitFinished(admin, assign.id)
      const assigned = await single('deal.owner_changed')
      expect(assigned.facts).toEqual({ deal_id: a.id, from_user_id: manager.id, to_user_id: null })
      expect(assigned.event.actor_id).toBe(admin.id)

      const stage = await json<BulkJobSummary>(
        await call(admin, 'POST', '/v1/bulk-jobs', {
          action: 'deals.stage',
          selection: { ids: [b.id] },
          params: { stageId: pipeline.stages[2] },
        }),
        202,
      )
      await waitFinished(admin, stage.id)
      expect((await single('deal.stage_changed')).facts).toEqual({
        deal_id: b.id,
        from: { pipeline_id: pipeline.id, stage_id: pipeline.stages[0] },
        to: { pipeline_id: pipeline.id, stage_id: pipeline.stages[2] },
      })

      const back = await json<BulkJobSummary>(
        await call(admin, 'POST', '/v1/bulk-jobs', {
          action: 'deals.unarchive',
          selection: { ids: [a.id] },
        }),
        202,
      )
      await waitFinished(admin, back.id)
      expect((await single('deal.unarchived')).event.actor_id).toBe(admin.id)
    })

    it('передача сделок участника — инициатор операции', async () => {
      const deal = await createDeal(manager)
      await newEvents()
      const transfer = await json<BulkJobSummary>(
        await call(admin, 'POST', `/v1/members/${manager.id}/transfer-deals`, {
          toUserId: admin.id,
        }),
        202,
      )
      await waitFinished(admin, transfer.id)
      const events = (await newEvents()).filter((e) => e.entity_id === deal.id)
      expect(events.map((e) => [e.type, e.actor_type, e.actor_id])).toEqual([
        ['deal.owner_changed', 'user', admin.id],
      ])
      expect(events.map((e) => (e.body as { data: Data }).data)[0]).toMatchObject({
        from_user_id: manager.id,
        to_user_id: admin.id,
      })
    })

    it('изменение по ключу API — автор api_key с id ключа', async () => {
      const head = await h.owner
        .selectFrom('role')
        .select('id')
        .where('project_id', '=', projectA)
        .where('template_key', '=', 'head')
        .executeTakeFirstOrThrow()
      const { key } = await json<ApiKeyWithSecret>(
        await call(admin, 'POST', '/v1/api-keys', { name: 'Автоматизація подій', roleId: head.id }),
        201,
      )
      const deal = await createDeal(manager)
      await newEvents()
      // Запросы сделок по ключу открывает тикет 03; здесь — тот же автор, что строит для них
      // dealContext (requestAuthor), и та же функция событий сделки.
      await withProject(h.appDb, projectA, async (trx) => {
        const row = await trx
          .selectFrom('deal')
          .selectAll()
          .where('id', '=', deal.id)
          .executeTakeFirstOrThrow()
        await emitDealChanges(
          { db: trx, projectId: projectA, ...requestAuthor({ type: 'api_key', apiKeyId: key.id }) },
          row,
          { ...row, stage_id: pipeline.stages[1] as string },
        )
      })
      const { event } = await single('deal.stage_changed')
      expect([event.actor_type, event.actor_id]).toEqual(['api_key', key.id])
      expect((event.body as { data: Data }).data.actor).toEqual({ type: 'api_key', id: key.id })
    })
  })

  it('изоляция: события проекта A не видны в контексте B без фильтра в коде', async () => {
    await createContact(admin, {}, projectB)
    const inA = await withProject(h.appDb, projectA, (trx) =>
      sql<{ project_id: string }>`select * from webhook_event`.execute(trx),
    )
    const inB = await withProject(h.appDb, projectB, (trx) =>
      sql<{ project_id: string }>`select * from webhook_event`.execute(trx),
    )
    expect(inA.rows.length).toBeGreaterThan(0)
    expect(inA.rows.every((r) => r.project_id === projectA)).toBe(true)
    expect(inB.rows.every((r) => r.project_id === projectB)).toBe(true)
    expect(await h.appDb.selectFrom('webhook_event').selectAll().execute()).toEqual([])
  })

  it('описание API: раздел webhooks со схемой каждого типа', async () => {
    const res = await h.request('GET', '/v1/openapi.json')
    const document = (await res.json()) as {
      webhooks: Record<
        string,
        { post: { requestBody: { content: Record<string, { schema: { $ref: string } }> } } }
      >
      components: { schemas: Record<string, unknown> }
    }
    expect(Object.keys(document.webhooks).sort()).toEqual(
      [
        'contact.created',
        'contact.merged',
        'contact.possible_duplicate',
        'contact.unmerged',
        'deal.archived',
        'deal.created',
        'deal.lost',
        'deal.merged',
        'deal.owner_changed',
        'deal.reopened',
        'deal.stage_changed',
        'deal.unarchived',
        'deal.unmerged',
        'deal.won',
        'registration.created',
      ].sort(),
    )
    for (const [type, webhook] of Object.entries(document.webhooks)) {
      const ref = webhook.post.requestBody.content['application/json']?.schema.$ref ?? ''
      const schema = document.components.schemas[ref.replace('#/components/schemas/', '')] as {
        properties: { type: { const: string }; data: { required: string[] } }
      }
      expect(schema.properties.type.const).toBe(type)
      expect(schema.properties.data.required).toContain('actor')
      expect(document.components.schemas.EventActor).toBeDefined()
    }
  })

  // Последним: тела всех событий прогона.
  it('в телах событий нет имён, телефонов, email, названий и значений пользовательских полей', async () => {
    await newEvents()
    expect(bodies.length).toBeGreaterThan(20)
    const all = JSON.stringify(bodies)
    for (const value of Object.values(FAKE)) {
      expect(all).not.toContain(value)
    }
    expect(all).not.toContain(FAKE.phone.slice(4))
    for (const body of bodies) expect(eventBodyProblem(body)).toBeNull()
  })
})
