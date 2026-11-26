import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ApiKeyWithSecret, EventType, WebhookEndpointWithSecret } from '@alpi/shared'
import { sql } from 'kysely'
import { Webhook } from 'standardwebhooks'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.ts'
import type { WebhookDeliveryOptions } from '../events/deliver.ts'
import { fanoutEvent } from '../events/fanout.ts'
import { WEBHOOK_FANOUT_QUEUE } from '../events/queue.ts'
import { type Jobs, startJobs } from '../jobs/jobs.ts'
import {
  type ApiHarness,
  ORIGIN,
  type SignedInUser,
  startApiHarness,
} from '../testing/api-harness.ts'
import { pathError, problemOf } from '../testing/problem.ts'
import { NO_TRASH_PURGERS } from '../trash/purge.ts'

// «Догнать события с даты» (тикет crm-api/09) на настоящем PostgreSQL и pg-boss: API и фоновые
// задачи ходят ролью приложения, приёмник — локальный HTTP-сервер (переменная для тестов
// разрешает http://127.0.0.1). События «за время отключения» пишутся прямо в базу (рассылки по
// ним не было) или создаются через API, пока вебхук отключён. Все данные — выдуманные.

const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * MINUTE_MS

interface Received {
  path: string
  headers: IncomingHttpHeaders
  body: string
}

describe('догнать события с даты', () => {
  let h: ApiHarness
  let jobs: Jobs
  let app: ReturnType<typeof createApp>
  let admin: SignedInUser
  let manager: SignedInUser
  let projectA: string
  let projectB: string
  let server: Server
  let base: string
  const received: Received[] = []

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        received.push({
          path: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
        res.writeHead(200)
        res.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    h = await startApiHarness('alpi_test_webhook_catch_up')
    const webhooks: WebhookDeliveryOptions = {
      secretKey: randomBytes(32),
      allowInsecureUrls: true,
      timeoutMs: 2000,
    }
    jobs = await startJobs({
      connectionString: h.appUrl,
      db: h.appDb,
      bulkActions: new Map(),
      trashPurgers: NO_TRASH_PURGERS,
      pollingIntervalSeconds: 0.5,
      schedule: false,
      webhooks,
      webhookQueue: { retryLimit: 2, retryDelay: 1, retryBackoff: false, expireInSeconds: 30 },
    })
    app = createApp({ auth: h.auth, db: h.appDb, webhooks })
    admin = await h.signIn('owner')
    manager = await h.signIn()
  })

  // Каждому тесту — свои проекты: «догнать» берёт все события проекта с даты, события соседних
  // тестов попали бы в счёт.
  beforeEach(async () => {
    projectA = (await h.createProject(admin, 'Наздогнати А')).id
    projectB = (await h.createProject(admin, 'Наздогнати Б')).id
    await h.addMember(projectA, manager.id, 'manager')
  })

  afterAll(async () => {
    await jobs?.stop()
    await h?.stop()
    server?.closeAllConnections()
    await new Promise((resolve) => server?.close(resolve))
  })

  const until = (check: () => Promise<void> | void, timeout = 20_000) =>
    vi.waitFor(check, { timeout, interval: 200 })

  const requestsTo = (path: string) => received.filter((r) => r.path === path)
  const idsSentTo = (path: string) => requestsTo(path).map((r) => String(r.headers['webhook-id']))

  async function endpoint(
    path: string,
    eventTypes: EventType[] = ['contact.created'],
    project = projectA,
  ): Promise<WebhookEndpointWithSecret> {
    const res = await admin.call(app, 'POST', '/v1/webhook-endpoints', {
      project,
      body: { url: `${base}${path}`, eventTypes },
    })
    expect(res.status).toBe(201)
    return (await res.json()) as WebhookEndpointWithSecret
  }

  /** Сдвигает время создания вебхука в прошлое: вебхук «давний». */
  async function createdAgo(endpointId: string, ms: number): Promise<void> {
    await sql`
      update webhook_endpoint set created_at = ${new Date(Date.now() - ms)} where id = ${endpointId}
    `.execute(h.owner)
  }

  /** Событие прямо в базе, `ago` мс назад: рассылки по нему не было. Возвращает id. */
  async function event(
    type: EventType,
    { project = projectA, ago = MINUTE_MS }: { project?: string; ago?: number } = {},
  ): Promise<string> {
    const id = `evt_${randomUUID()}`
    const at = new Date(Date.now() - ago)
    const entityId = randomUUID()
    const entity = type.startsWith('deal.') ? 'deal' : 'contact'
    await h.owner
      .insertInto('webhook_event')
      .values({
        id,
        project_id: project,
        type,
        occurred_at: at,
        entity_type: entity,
        entity_id: entityId,
        body: JSON.stringify({
          type,
          timestamp: at.toISOString(),
          data: {
            event_id: id,
            project_id: project,
            [`${entity}_id`]: entityId,
            actor: { type: 'user', id: admin.id },
          },
        }),
        actor_type: 'user',
        actor_id: admin.id,
        created_at: at,
      })
      .execute()
    return id
  }

  /** Доставка события на вебхук в состоянии `state`, без задачи в очереди. */
  async function delivery(
    project: string,
    endpointId: string,
    eventId: string,
    state: 'pending' | 'succeeded' | 'failed' | 'cancelled',
  ) {
    await h.owner
      .insertInto('webhook_delivery')
      .values({
        project_id: project,
        event_id: eventId,
        endpoint_id: endpointId,
        state,
        attempts: state === 'pending' ? 0 : 1,
        next_attempt_at: null,
        succeeded_at: state === 'succeeded' ? new Date() : null,
      })
      .execute()
  }

  async function deliveries(endpointId: string) {
    return h.owner
      .selectFrom('webhook_delivery')
      .select(['event_id', 'state', 'attempts'])
      .where('endpoint_id', '=', endpointId)
      .orderBy('event_id')
      .execute()
  }

  function catchUp(
    endpointId: string,
    since: Date | string,
    { project = projectA, user = admin }: { project?: string; user?: SignedInUser } = {},
  ) {
    return user.call(app, 'POST', `/v1/webhook-endpoints/${endpointId}/catch-up`, {
      project,
      body: { since: typeof since === 'string' ? since : since.toISOString() },
    })
  }

  async function queued(res: Response): Promise<number> {
    expect([res.status, res.status === 202 ? null : await problemOf(res)]).toEqual([202, null])
    const body = (await res.json()) as { queued: number }
    return body.queued
  }

  it('событие, случившееся пока вебхук отключён, после «догнать с даты» доставлено с тем же webhook-id и подписью', async () => {
    const target = await endpoint('/while-off')
    const path = `/v1/webhook-endpoints/${target.endpoint.id}`
    expect((await admin.call(app, 'POST', `${path}/disable`, { project: projectA })).status).toBe(
      200,
    )
    const contact = await admin.call(app, 'POST', '/v1/contacts', {
      project: projectA,
      body: { firstName: 'Вихідні' },
    })
    expect(contact.status).toBe(201)
    const { id: contactId } = (await contact.json()) as { id: string }
    const { id: eventId } = await h.owner
      .selectFrom('webhook_event')
      .select('id')
      .where('entity_id', '=', contactId)
      .executeTakeFirstOrThrow()
    // Рассылка этого события прошла, пока вебхук был отключён: доставки нет.
    await until(async () => {
      const { rows } = await sql<{ open: number }>`
        select count(*)::int as open from pgboss.job
        where name = ${WEBHOOK_FANOUT_QUEUE} and data->>'eventId' = ${eventId}
          and state not in ('completed', 'failed', 'cancelled')
      `.execute(h.owner)
      expect(rows[0]?.open).toBe(0)
    })
    expect(await deliveries(target.endpoint.id)).toEqual([])
    expect((await admin.call(app, 'POST', `${path}/enable`, { project: projectA })).status).toBe(
      200,
    )
    expect(requestsTo('/while-off')).toEqual([])

    expect(await queued(await catchUp(target.endpoint.id, target.endpoint.createdAt))).toBe(1)
    await until(() => expect(requestsTo('/while-off')).toHaveLength(1))
    const [request] = requestsTo('/while-off')
    if (!request) throw new Error('нет запроса')
    expect(request.headers['webhook-id']).toBe(eventId)
    expect(
      new Webhook(target.secret).verify(request.body, {
        'webhook-id': String(request.headers['webhook-id']),
        'webhook-timestamp': String(request.headers['webhook-timestamp']),
        'webhook-signature': String(request.headers['webhook-signature']),
      }),
    ).toMatchObject({ type: 'contact.created' })
    await until(async () => {
      expect(await deliveries(target.endpoint.id)).toEqual([
        { event_id: eventId, state: 'succeeded', attempts: 1 },
      ])
    })
  })

  it('успешно доставленное не отправляется повторно; неудачное, отменённое и событие без доставки — отправляются; ожидающее не ставится второй раз', async () => {
    const target = await endpoint('/states')
    await createdAgo(target.endpoint.id, DAY_MS)
    const succeeded = await event('contact.created')
    const failed = await event('contact.created')
    const cancelled = await event('contact.created')
    const pending = await event('contact.created')
    const missing = await event('contact.created')
    await delivery(projectA, target.endpoint.id, succeeded, 'succeeded')
    await delivery(projectA, target.endpoint.id, failed, 'failed')
    await delivery(projectA, target.endpoint.id, cancelled, 'cancelled')
    await delivery(projectA, target.endpoint.id, pending, 'pending')

    expect(await queued(await catchUp(target.endpoint.id, new Date(Date.now() - DAY_MS / 2)))).toBe(
      3,
    )
    await until(() => expect(requestsTo('/states')).toHaveLength(3))
    expect(new Set(idsSentTo('/states'))).toEqual(new Set([failed, cancelled, missing]))
    await until(async () => {
      expect(await deliveries(target.endpoint.id)).toEqual(
        [
          { event_id: succeeded, state: 'succeeded', attempts: 1 },
          { event_id: failed, state: 'succeeded', attempts: 2 },
          { event_id: cancelled, state: 'succeeded', attempts: 2 },
          // Ожидающую доставку отправит её собственная задача: вторая задача — двойная отправка.
          { event_id: pending, state: 'pending', attempts: 0 },
          { event_id: missing, state: 'succeeded', attempts: 1 },
        ].sort((a, b) => a.event_id.localeCompare(b.event_id)),
      )
    })
    // Второй запуск: всё уже доставлено — ничего не уходит.
    expect(await queued(await catchUp(target.endpoint.id, new Date(Date.now() - DAY_MS / 2)))).toBe(
      0,
    )
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(requestsTo('/states')).toHaveLength(3)
  })

  it('только события с даты и только типов, на которые вебхук подписан сейчас', async () => {
    const target = await endpoint('/types', ['deal.won'])
    await createdAgo(target.endpoint.id, 3 * DAY_MS)
    // Подписку сменили: теперь только contact.created.
    const patched = await admin.call(app, 'PATCH', `/v1/webhook-endpoints/${target.endpoint.id}`, {
      project: projectA,
      body: { eventTypes: ['contact.created'] },
    })
    expect(patched.status).toBe(200)
    const before = await event('contact.created', { ago: 2 * DAY_MS })
    const wanted = await event('contact.created', { ago: DAY_MS / 2 })
    const unsubscribed = await event('deal.won', { ago: DAY_MS / 2 })
    const unsubscribedFailed = await event('deal.won', { ago: DAY_MS / 2 })
    await delivery(projectA, target.endpoint.id, unsubscribedFailed, 'failed')

    expect(await queued(await catchUp(target.endpoint.id, new Date(Date.now() - DAY_MS)))).toBe(1)
    await until(() => expect(requestsTo('/types')).toHaveLength(1))
    expect(idsSentTo('/types')).toEqual([wanted])
    const rows = await deliveries(target.endpoint.id)
    expect(rows.map((row) => row.event_id).sort()).toEqual([wanted, unsubscribedFailed].sort())
    expect(rows.find((row) => row.event_id === unsubscribedFailed)?.state).toBe('failed')
    expect(rows.some((row) => row.event_id === before || row.event_id === unsubscribed)).toBe(false)
  })

  it('события другого проекта не уходят на вебхук; чужой вебхук — 404', async () => {
    const target = await endpoint('/isolation-a')
    const foreign = await endpoint('/isolation-b', ['contact.created'], projectB)
    await createdAgo(target.endpoint.id, DAY_MS)
    await createdAgo(foreign.endpoint.id, DAY_MS)
    const own = await event('contact.created')
    const other = await event('contact.created', { project: projectB })

    expect(await queued(await catchUp(target.endpoint.id, new Date(Date.now() - DAY_MS / 2)))).toBe(
      1,
    )
    await until(() => expect(requestsTo('/isolation-a')).toHaveLength(1))
    expect(idsSentTo('/isolation-a')).toEqual([own])
    expect((await deliveries(target.endpoint.id)).map((row) => row.event_id)).toEqual([own])
    expect((await deliveries(foreign.endpoint.id)).map((row) => row.event_id)).not.toContain(own)

    // Вебхук проекта B в контексте проекта A не находится.
    const res = await catchUp(foreign.endpoint.id, new Date(Date.now() - DAY_MS / 2))
    expect([res.status, await problemOf(res)]).toEqual([
      404,
      { code: 'WEBHOOK_ENDPOINT_NOT_FOUND' },
    ])
    expect(await deliveries(foreign.endpoint.id)).toEqual([])
    expect(idsSentTo('/isolation-b')).not.toContain(other)
  })

  it('дата раньше создания вебхука или старше 30 дней — 422; без даты — 400; отключённый — 409', async () => {
    const fresh = await endpoint('/dates-fresh')
    const createdAt = new Date(fresh.endpoint.createdAt)
    const early = await catchUp(fresh.endpoint.id, new Date(createdAt.getTime() - 1))
    expect([early.status, await problemOf(early)]).toEqual([
      422,
      pathError('WEBHOOK_CATCH_UP_BEFORE_CREATED', 'since'),
    ])
    // Ровно время создания (как его отдаёт API, до миллисекунды) — можно.
    expect(await queued(await catchUp(fresh.endpoint.id, fresh.endpoint.createdAt))).toBe(0)

    // Вебхук создан 40 дней назад: граница — 30 дней хранения событий.
    const old = await endpoint('/dates-old')
    await createdAgo(old.endpoint.id, 40 * DAY_MS)
    const tooOld = await catchUp(old.endpoint.id, new Date(Date.now() - 30 * DAY_MS - MINUTE_MS))
    expect([tooOld.status, await problemOf(tooOld)]).toEqual([
      422,
      pathError('WEBHOOK_CATCH_UP_TOO_OLD', 'since'),
    ])
    expect(
      await queued(await catchUp(old.endpoint.id, new Date(Date.now() - 30 * DAY_MS + MINUTE_MS))),
    ).toBe(0)

    for (const body of [{}, { since: '2026-11-20' }, { since: 'вчора' }]) {
      const res = await admin.call(
        app,
        'POST',
        `/v1/webhook-endpoints/${old.endpoint.id}/catch-up`,
        {
          project: projectA,
          body,
        },
      )
      expect([res.status, await problemOf(res)]).toEqual([
        400,
        pathError('INVALID_WEBHOOK_ENDPOINT', 'since'),
      ])
    }
    const extra = await admin.call(
      app,
      'POST',
      `/v1/webhook-endpoints/${old.endpoint.id}/catch-up`,
      {
        project: projectA,
        body: { since: new Date().toISOString(), types: ['deal.won'] },
      },
    )
    expect([extra.status, await problemOf(extra)]).toEqual([
      400,
      pathError('INVALID_WEBHOOK_ENDPOINT', 'types'),
    ])

    const off = await endpoint('/dates-off')
    await createdAgo(off.endpoint.id, DAY_MS)
    const missed = await event('contact.created')
    await admin.call(app, 'POST', `/v1/webhook-endpoints/${off.endpoint.id}/disable`, {
      project: projectA,
    })
    const disabled = await catchUp(off.endpoint.id, new Date(Date.now() - DAY_MS / 2))
    expect([disabled.status, await problemOf(disabled)]).toEqual([
      409,
      { code: 'WEBHOOK_ENDPOINT_DISABLED' },
    ])
    expect((await deliveries(off.endpoint.id)).map((row) => row.event_id)).not.toContain(missed)
  })

  it('без права «интеграции: изменять» — 403; по ключу API (даже администратора) — 403 API_KEY_NOT_ALLOWED', async () => {
    const target = await endpoint('/rights')
    await createdAgo(target.endpoint.id, DAY_MS)
    const missed = await event('contact.created')
    const since = new Date(Date.now() - DAY_MS / 2)

    const denied = await catchUp(target.endpoint.id, since, { user: manager })
    expect([denied.status, await problemOf(denied)]).toEqual([403, { code: 'PERMISSION_DENIED' }])

    const { id: roleId } = await h.owner
      .selectFrom('role')
      .select('id')
      .where('project_id', '=', projectA)
      .where('template_key', '=', 'admin')
      .executeTakeFirstOrThrow()
    const issued = await admin.call(app, 'POST', '/v1/api-keys', {
      project: projectA,
      body: { name: 'Наздогнати ключем', roleId },
    })
    expect(issued.status).toBe(201)
    const { secret } = (await issued.json()) as ApiKeyWithSecret
    const byKey = await app.request(
      `${ORIGIN}/v1/webhook-endpoints/${target.endpoint.id}/catch-up`,
      {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          authorization: `Bearer ${secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ since: since.toISOString() }),
      },
    )
    expect([byKey.status, await problemOf(byKey)]).toEqual([403, { code: 'API_KEY_NOT_ALLOWED' }])
    expect(await deliveries(target.endpoint.id)).toEqual([])
    expect(idsSentTo('/rights')).not.toContain(missed)
  })

  it('запуск записан в журнал проекта: кто, вебхук, дата, сколько поставлено', async () => {
    const target = await endpoint('/audit')
    await createdAgo(target.endpoint.id, DAY_MS)
    await event('contact.created')
    await event('contact.created')
    const since = new Date(Date.now() - DAY_MS / 2)
    expect(await queued(await catchUp(target.endpoint.id, since))).toBe(2)

    const rows = await h.owner
      .selectFrom('audit_log')
      .select(['project_id', 'action', 'actor_id', 'entity_type', 'details'])
      .where('entity_id', '=', target.endpoint.id)
      .where('action', '=', 'webhook_endpoint.caught_up')
      .execute()
    expect(rows).toEqual([
      {
        project_id: projectA,
        action: 'webhook_endpoint.caught_up',
        actor_id: admin.id,
        entity_type: 'webhook_endpoint',
        details: { url: `${base}/audit`, since: since.toISOString(), queued: 2 },
      },
    ])
    // Отказ (отключённый вебхук) в журнал не пишется.
    await admin.call(app, 'POST', `/v1/webhook-endpoints/${target.endpoint.id}/disable`, {
      project: projectA,
    })
    expect((await catchUp(target.endpoint.id, since)).status).toBe(409)
    const after = await h.owner
      .selectFrom('audit_log')
      .select('id')
      .where('entity_id', '=', target.endpoint.id)
      .where('action', '=', 'webhook_endpoint.caught_up')
      .execute()
    expect(after).toHaveLength(1)
  })

  it('гонка: рассылка события и «догнать» одновременно, два «догнать» одновременно — одна доставка и одна отправка', async () => {
    const target = await endpoint('/race')
    await createdAgo(target.endpoint.id, DAY_MS)
    const since = new Date(Date.now() - DAY_MS / 2)
    const ids = await Promise.all(Array.from({ length: 5 }, () => event('contact.created')))

    const [first, second, ...fanned] = await Promise.all([
      catchUp(target.endpoint.id, since).then(queued),
      catchUp(target.endpoint.id, since).then(queued),
      ...ids.map((eventId) => fanoutEvent(h.appDb, { projectId: projectA, eventId })),
    ])
    // Каждое событие поставлено ровно один раз — тем, кто первым создал доставку.
    expect((first ?? 0) + (second ?? 0) + fanned.reduce((sum, n) => sum + n, 0)).toBe(ids.length)
    await until(async () => {
      expect((await deliveries(target.endpoint.id)).map((row) => row.state)).toEqual(
        ids.map(() => 'succeeded'),
      )
    })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(idsSentTo('/race').sort()).toEqual([...ids].sort())
  })
})
