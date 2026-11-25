import type { AddressInfo } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { withProject } from '@alpi/db'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.ts'
import type { BulkAction, BulkActionRegistry } from '../bulk/registry.ts'
import type { BulkJobDetails, BulkJobSummary } from '../bulk/routes.ts'
import type { ContactView } from '../contacts/contacts.ts'
import { DEAL_BULK_REGISTRY } from '../deals/bulk.ts'
import type { DealView } from '../deals/store.ts'
import { emitDealChanges } from '../events/deal-events.ts'
import { WEBHOOK_FANOUT_QUEUE } from '../events/queue.ts'
import { type ApiHarness, type SignedInUser, startApiHarness } from '../testing/api-harness.ts'
import { NO_TRASH_PURGERS } from '../trash/purge.ts'
import { startJobs } from './jobs.ts'
import { stopApi } from './shutdown.ts'

// Остановка API (доработка тикета crm-api/05): очередь событий отключается только после того,
// как дождались текущих обработчиков фоновых задач и HTTP-запросов — иначе их изменения не могут
// записать событие (массовая операция помечала записи FAILED навсегда, запрос получал 500).
//
// Как в процессе API, очередь событий здесь подключает только startJobs: запасная очередь
// тестового окружения (startEventQueue в testing/api-harness.ts) подменена пустой, иначе после
// отключения очереди фоновых задач события ставила бы она и ошибка не проявилась бы.
vi.mock('./jobs.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./jobs.ts')>()),
  startEventQueue: async () => ({ stop: async () => {} }),
}))

/** Обещание, которое тест выполняет сам. */
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const ARCHIVE = new Map(DEAL_BULK_REGISTRY).get('deals.archive') as BulkAction

describe('остановка API не отключает очередь событий раньше текущей работы', () => {
  let h: ApiHarness
  let admin: SignedInUser
  let projectA: string
  let pipelineId: string

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_jobs_stop')
    admin = await h.signIn('owner')
    projectA = (await h.createProject(admin, 'Зупинка')).id
    const pipeline = await h.owner
      .insertInto('pipeline')
      .values({ project_id: projectA, code: 'stop', name: 'Воронка зупинки', position: 1 })
      .returning('id')
      .executeTakeFirstOrThrow()
    await h.owner
      .insertInto('stage')
      .values({ project_id: projectA, pipeline_id: pipeline.id, name: 'Етап', position: 1 })
      .execute()
    pipelineId = pipeline.id
  })

  afterAll(async () => {
    await h?.stop()
  })

  /** Новая сделка; нужна подключённая очередь событий (deal.created). */
  async function createDeal(): Promise<DealView> {
    const contact = await admin.api('POST', '/v1/contacts', {
      project: projectA,
      body: { firstName: 'Зупинко' },
    })
    expect(contact.status).toBe(201)
    const deal = await admin.api('POST', '/v1/deals', {
      project: projectA,
      body: {
        title: 'Угода зупинки',
        pipelineId,
        contactId: ((await contact.json()) as ContactView).id,
      },
    })
    expect(deal.status).toBe(201)
    return (await deal.json()) as DealView
  }

  /** События сделки `dealId` типа `type` и число их задач webhook-fanout. */
  async function eventsOf(dealId: string, type: string) {
    const events = await h.owner
      .selectFrom('webhook_event')
      .select('id')
      .where('entity_id', '=', dealId)
      .where('type', '=', type)
      .execute()
    const { rows } = await sql<{ event_id: string }>`
      select data->>'eventId' as event_id from pgboss.job where name = ${WEBHOOK_FANOUT_QUEUE}
    `.execute(h.owner)
    const ids = new Set(events.map((e) => e.id))
    return { events: events.length, fanout: rows.filter((r) => ids.has(r.event_id)).length }
  }

  it('массовая операция, которая выполняется при остановке, записывает событие — без FAILED', async () => {
    const entered = deferred()
    const gate = deferred()
    // Архив сделок, который ждёт команды теста посреди записи — как порция при SIGTERM.
    const actions: BulkActionRegistry = new Map([
      [
        'probe.archive',
        {
          ...ARCHIVE,
          async apply(trx, id, ctx) {
            entered.resolve()
            await gate.promise
            return ARCHIVE.apply(trx, id, ctx)
          },
        },
      ],
    ])
    const jobs = await startJobs({
      connectionString: h.appUrl,
      db: h.appDb,
      bulkActions: actions,
      trashPurgers: NO_TRASH_PURGERS,
      bulkRetryLimit: 0,
      pollingIntervalSeconds: 0.5,
      schedule: false,
    })
    const deal = await createDeal()
    const app = createApp({
      auth: h.auth,
      db: h.appDb,
      bulk: { actions, enqueue: jobs.enqueueBulk },
    })
    const started = await admin.call(app, 'POST', '/v1/bulk-jobs', {
      project: projectA,
      body: { action: 'probe.archive', selection: { ids: [deal.id] } },
    })
    expect(started.status).toBe(202)
    const bulk = (await started.json()) as BulkJobSummary

    await entered.promise
    const stopped = jobs.stop()
    // Остановка уже идёт и ждёт обработчик; запись продолжается только теперь.
    await delay(300)
    gate.resolve()
    await stopped

    const details = await admin.call(app, 'GET', `/v1/bulk-jobs/${bulk.id}`, { project: projectA })
    const job = (await details.json()) as BulkJobDetails
    expect(job).toMatchObject({ status: 'done', processed: 1, failed: 0, errors: [] })
    expect(await eventsOf(deal.id, 'deal.archived')).toEqual({ events: 1, fanout: 1 })
  }, 30_000)

  it('HTTP-запрос, который выполняется при остановке, записывает событие — без 500', async () => {
    const jobs = await startJobs({
      connectionString: h.appUrl,
      db: h.appDb,
      bulkActions: new Map(),
      trashPurgers: NO_TRASH_PURGERS,
      pollingIntervalSeconds: 0.5,
      schedule: false,
    })
    const deal = await createDeal()
    const entered = deferred()
    const gate = deferred()
    // Изменение сделки, которое ждёт команды теста посреди запроса.
    const probe = new Hono().post('/probe', async (c) => {
      entered.resolve()
      await gate.promise
      await withProject(h.appDb, projectA, async (trx) => {
        const row = await trx
          .selectFrom('deal')
          .selectAll()
          .where('id', '=', deal.id)
          .executeTakeFirstOrThrow()
        await emitDealChanges({ db: trx, projectId: projectA, actorId: admin.id }, row, {
          ...row,
          archived_at: new Date(),
        })
      })
      return c.text('ok')
    })
    const listening = deferred()
    const server = serve({ fetch: probe.fetch, port: 0, hostname: '127.0.0.1' }, () =>
      listening.resolve(),
    )
    await listening.promise
    const { port } = server.address() as AddressInfo

    const order: string[] = []
    const response = fetch(`http://127.0.0.1:${port}/probe`, { method: 'POST' })
    await entered.promise
    const stopped = stopApi(
      {
        server,
        jobs: {
          async stop() {
            order.push('jobs')
            await jobs.stop()
          },
        },
        db: {
          async destroy() {
            order.push('db')
          },
        },
      },
      20_000,
    )
    await delay(300)
    expect(order).toEqual([])
    gate.resolve()
    const res = await response
    expect(res.status, await res.text()).toBe(200)
    const answered = Date.now()
    await stopped
    // Соединение после ответа закрыто сразу, а не по истечении keep-alive (5 с).
    expect(Date.now() - answered).toBeLessThan(2_000)
    expect(order).toEqual(['jobs', 'db'])
    expect(await eventsOf(deal.id, 'deal.archived')).toEqual({ events: 1, fanout: 1 })
  }, 30_000)

  it('HTTP-запрос дольше срока остановки обрывается, остановка идёт дальше', async () => {
    const entered = deferred()
    const hang = new Hono().get('/hang', async (c) => {
      entered.resolve()
      await new Promise(() => {})
      return c.text('never')
    })
    const listening = deferred()
    const server = serve({ fetch: hang.fetch, port: 0, hostname: '127.0.0.1' }, () =>
      listening.resolve(),
    )
    await listening.promise
    const { port } = server.address() as AddressInfo
    const response = fetch(`http://127.0.0.1:${port}/hang`).then(
      () => 'ответ',
      () => 'оборвано',
    )
    await entered.promise
    const order: string[] = []
    const begun = Date.now()
    await stopApi(
      {
        server,
        jobs: {
          async stop() {
            order.push('jobs')
          },
        },
        db: {
          async destroy() {
            order.push('db')
          },
        },
      },
      300,
    )
    expect(Date.now() - begun).toBeLessThan(5_000)
    expect(order).toEqual(['jobs', 'db'])
    expect(await response).toBe('оборвано')
  }, 15_000)
})
