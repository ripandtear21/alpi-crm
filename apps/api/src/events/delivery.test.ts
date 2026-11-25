import { randomBytes } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { withProject } from '@alpi/db'
import type {
  WebhookDeliveryView,
  WebhookEndpointSummary,
  WebhookEndpointWithSecret,
} from '@alpi/shared'
import { sql } from 'kysely'
import { Webhook } from 'standardwebhooks'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.ts'
import { type Jobs, startJobs } from '../jobs/jobs.ts'
import { purgeWebhookLog } from '../jobs/webhook-purge.ts'
import { type ApiHarness, type SignedInUser, startApiHarness } from '../testing/api-harness.ts'
import { problemOf } from '../testing/problem.ts'
import { NO_TRASH_PURGERS } from '../trash/purge.ts'
import type { WebhookDeliveryOptions } from './deliver.ts'
import { fanoutEvent } from './fanout.ts'
import type { HostLookup } from './ssrf.ts'

// Доставка событий (тикет crm-api/06) на настоящем PostgreSQL и pg-boss, API и фоновые задачи
// ходят ролью приложения; приёмник — локальный HTTP-сервер (переменная для тестов разрешает
// http://127.0.0.1). Повторы укорочены: 2 повтора через 1 с; таймаут попытки — 400 мс; «5 суток»
// и «24 часа» — подменой часов доставки, без ожиданий. Разрешение имён — подставная таблица.
// Все данные — выдуманные.

const DAY_MS = 24 * 60 * 60 * 1000

interface Received {
  path: string
  headers: IncomingHttpHeaders
  body: string
}

type Reply = (call: number) => {
  status: number
  headers?: Record<string, string>
  body?: string
  delayMs?: number
}

const names = new Map<string, string[]>()
const lookup: HostLookup = async (host) => {
  const addresses = names.get(host)
  if (!addresses) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' })
  return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
}

describe('доставка событий', () => {
  let h: ApiHarness
  let jobs: Jobs
  let app: ReturnType<typeof createApp>
  let admin: SignedInUser
  let manager: SignedInUser
  let projectA: string
  let projectB: string
  let server: Server
  let base: string
  /** Сдвиг часов доставки, мс. */
  let clockOffset = 0
  const replies = new Map<string, Reply>()
  const received: Received[] = []
  const logged: string[] = []
  const secretsSeen: string[] = []

  beforeAll(async () => {
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      const original = console[level].bind(console)
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '))
        original(...args)
      })
    }
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const path = req.url ?? ''
        received.push({ path, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
        const call = received.filter((r) => r.path === path).length
        const reply: ReturnType<Reply> = (replies.get(path) ?? (() => ({ status: 200 })))(call)
        setTimeout(() => {
          if (res.destroyed) return
          res.writeHead(reply.status, reply.headers ?? {})
          res.end(reply.body ?? '')
        }, reply.delayMs ?? 0)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    h = await startApiHarness('alpi_test_delivery')
    const webhooks: WebhookDeliveryOptions = {
      secretKey: randomBytes(32),
      allowInsecureUrls: true,
      lookup,
      timeoutMs: 400,
      now: () => new Date(Date.now() + clockOffset),
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
    projectA = (await h.createProject(admin, 'Доставка А')).id
    projectB = (await h.createProject(admin, 'Доставка Б')).id
    await h.addMember(projectA, manager.id, 'manager')
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    await jobs?.stop()
    await h?.stop()
    server?.closeAllConnections()
    await new Promise((resolve) => server?.close(resolve))
  })

  async function endpoint(
    path: string,
    eventTypes: string[] = ['contact.created'],
    project = projectA,
    url = `${base}${path}`,
  ): Promise<WebhookEndpointWithSecret> {
    const res = await admin.call(app, 'POST', '/v1/webhook-endpoints', {
      project,
      body: { url, eventTypes },
    })
    expect(res.status).toBe(201)
    const created = (await res.json()) as WebhookEndpointWithSecret
    secretsSeen.push(created.secret)
    return created
  }

  /** Создаёт контакт — событие contact.created; возвращает id события. */
  async function contactEvent(project = projectA): Promise<string> {
    const res = await admin.call(app, 'POST', '/v1/contacts', {
      project,
      body: { firstName: `Подія ${randomBytes(3).toString('hex')}` },
    })
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: string }
    const event = await h.owner
      .selectFrom('webhook_event')
      .select('id')
      .where('entity_id', '=', id)
      .where('type', '=', 'contact.created')
      .executeTakeFirstOrThrow()
    return event.id
  }

  const requestsTo = (path: string) => received.filter((r) => r.path === path)

  async function deliveries(endpointId: string) {
    return h.owner
      .selectFrom('webhook_delivery')
      .select(['id', 'event_id', 'state', 'attempts'])
      .where('endpoint_id', '=', endpointId)
      .orderBy('created_at')
      .execute()
  }

  async function attemptsOf(deliveryId: string) {
    return h.owner
      .selectFrom('webhook_delivery_attempt')
      .select(['status_code', 'error', 'duration_ms', 'response_body'])
      .where('delivery_id', '=', deliveryId)
      .orderBy('attempted_at')
      .execute()
  }

  async function endpointRow(id: string) {
    return h.owner
      .selectFrom('webhook_endpoint')
      .select(['state', 'disabled_reason'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  }

  async function journal(endpointId: string, query = '') {
    const res = await admin.call(
      app,
      'GET',
      `/v1/webhook-endpoints/${endpointId}/deliveries${query}`,
      {
        project: projectA,
      },
    )
    expect(res.status).toBe(200)
    return (await res.json()) as { data: WebhookDeliveryView[]; next_cursor: string | null }
  }

  const until = (check: () => Promise<void> | void, timeout = 20_000) =>
    vi.waitFor(check, { timeout, interval: 200 })

  const signatureHeaders = (r: Received) => ({
    'webhook-id': String(r.headers['webhook-id']),
    'webhook-timestamp': String(r.headers['webhook-timestamp']),
    'webhook-signature': String(r.headers['webhook-signature']),
  })

  it('подписка: адрес получает только подписанные типы; событие проекта A не уходит на адрес проекта B', async () => {
    const contacts = await endpoint('/sub-contacts', ['contact.created', 'deal.won'])
    const deals = await endpoint('/sub-deals', ['deal.won'])
    const other = await endpoint('/sub-other', ['contact.created'], projectB)
    const eventId = await contactEvent()

    await until(() => expect(requestsTo('/sub-contacts')).toHaveLength(1))
    const [request] = requestsTo('/sub-contacts')
    if (!request) throw new Error('нет запроса')
    expect(request.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(request.headers['webhook-id']).toBe(eventId)
    // Подпись проверяет официальная библиотека Standard Webhooks.
    const payload = new Webhook(contacts.secret).verify(request.body, signatureHeaders(request))
    const event = await h.owner
      .selectFrom('webhook_event')
      .select('body')
      .where('id', '=', eventId)
      .executeTakeFirstOrThrow()
    expect(payload).toEqual(event.body)

    await until(async () => {
      const [row] = await deliveries(contacts.endpoint.id)
      expect(row).toMatchObject({ event_id: eventId, state: 'succeeded', attempts: 1 })
    })
    const page = await journal(contacts.endpoint.id)
    expect(page.data[0]).toMatchObject({
      eventId,
      eventType: 'contact.created',
      state: 'succeeded',
      attempts: 1,
      nextAttemptAt: null,
      attemptLog: [{ statusCode: 200, error: null }],
    })
    // Рассылка уже прошла: на другие адреса доставок нет и не будет.
    expect(await deliveries(deals.endpoint.id)).toEqual([])
    expect(await deliveries(other.endpoint.id)).toEqual([])
    expect(requestsTo('/sub-deals')).toEqual([])
    expect(requestsTo('/sub-other')).toEqual([])

    // Задача с чужим проектом не находит событие — рассылки нет. Повтор рассылки и адрес,
    // созданный после события, второй доставки не дают.
    expect(await fanoutEvent(h.appDb, { projectId: projectB, eventId })).toBe(0)
    await endpoint('/sub-later', ['contact.created'])
    expect(await fanoutEvent(h.appDb, { projectId: projectA, eventId })).toBe(0)

    // Изоляция: доставки и попытки проекта A не видны в контексте B.
    const seenFromB = await withProject(h.appDb, projectB, async (trx) => ({
      endpoints: await trx.selectFrom('webhook_endpoint').select('project_id').execute(),
      deliveries: await trx.selectFrom('webhook_delivery').select('project_id').execute(),
      attempts: await trx.selectFrom('webhook_delivery_attempt').select('project_id').execute(),
    }))
    for (const rows of Object.values(seenFromB)) {
      expect(rows.every((row) => row.project_id === projectB)).toBe(true)
    }
    expect(seenFromB.endpoints).toHaveLength(1)
    expect(seenFromB.deliveries).toHaveLength(0)
    expect(seenFromB.attempts).toHaveLength(0)
    // Журнал адреса A из проекта B — 404.
    const foreign = await admin.call(
      app,
      'GET',
      `/v1/webhook-endpoints/${contacts.endpoint.id}/deliveries`,
      { project: projectB },
    )
    expect(foreign.status).toBe(404)
  })

  it('отключённый адрес не получает ничего, его ожидающие доставки — cancelled', async () => {
    replies.set('/disabled', () => ({ status: 500 }))
    const target = await endpoint('/disabled')
    await contactEvent()
    await until(() => expect(requestsTo('/disabled').length).toBeGreaterThanOrEqual(1))
    const off = await admin.call(
      app,
      'POST',
      `/v1/webhook-endpoints/${target.endpoint.id}/disable`,
      {
        project: projectA,
      },
    )
    expect(off.status).toBe(200)
    await until(async () => {
      expect((await deliveries(target.endpoint.id)).map((d) => d.state)).toEqual(['cancelled'])
    })
    const before = requestsTo('/disabled').length
    await contactEvent()
    await new Promise((resolve) => setTimeout(resolve, 2500))
    expect(requestsTo('/disabled')).toHaveLength(before)
    expect(await deliveries(target.endpoint.id)).toHaveLength(1)
  })

  it('500 — повтор с тем же webhook-id, успех только на 2xx; ручной повтор — ещё раз с тем же id', async () => {
    replies.set('/retry', (call) =>
      call === 1 ? { status: 500, body: 'тимчасова помилка' } : { status: 204 },
    )
    const target = await endpoint('/retry')
    const eventId = await contactEvent()
    await until(async () => {
      expect((await deliveries(target.endpoint.id)).map((d) => d.state)).toEqual(['succeeded'])
    })
    const sent = requestsTo('/retry')
    expect(sent.map((r) => r.headers['webhook-id'])).toEqual([eventId, eventId])
    for (const r of sent) {
      expect(new Webhook(target.secret).verify(r.body, signatureHeaders(r))).toBeTruthy()
    }
    const [delivery] = (await journal(target.endpoint.id)).data
    expect(delivery?.attemptLog.map((a) => [a.statusCode, a.responseBody])).toEqual([
      [500, 'тимчасова помилка'],
      [204, null],
    ])

    // Ручной повтор одной доставки: новая попытка в той же доставке, тот же webhook-id.
    const retried = await admin.call(
      app,
      'POST',
      `/v1/webhook-endpoints/${target.endpoint.id}/deliveries/${delivery?.id}/retry`,
      { project: projectA },
    )
    expect(retried.status).toBe(202)
    expect(await retried.json()).toEqual({ queued: 1 })
    await until(() => expect(requestsTo('/retry')).toHaveLength(3))
    expect(requestsTo('/retry')[2]?.headers['webhook-id']).toBe(eventId)
    await until(async () => {
      const [again] = (await journal(target.endpoint.id)).data
      expect(again?.state).toBe('succeeded')
      expect(again?.attemptLog.map((a) => a.statusCode)).toEqual([500, 204, 204])
    })
  })

  it('таймаут, 3xx и 429 — неудача без перехода по редиректу; после последней попытки — failed; «всё неудачное с даты»', async () => {
    replies.set('/slow', () => ({ status: 200, delayMs: 2000 }))
    replies.set('/redirect', () => ({
      status: 302,
      headers: { location: `${base}/redirect-target` },
    }))
    replies.set('/busy', () => ({ status: 429 }))
    const slow = await endpoint('/slow')
    const redirect = await endpoint('/redirect')
    const busy = await endpoint('/busy')
    const eventId = await contactEvent()

    for (const target of [slow, redirect, busy]) {
      await until(async () => {
        expect((await deliveries(target.endpoint.id)).map((d) => [d.state, d.attempts])).toEqual([
          ['failed', 3],
        ])
      })
    }
    const [slowDelivery] = await deliveries(slow.endpoint.id)
    const [redirectDelivery] = await deliveries(redirect.endpoint.id)
    const [busyDelivery] = await deliveries(busy.endpoint.id)
    expect((await attemptsOf(slowDelivery?.id ?? '')).map((a) => [a.status_code, a.error])).toEqual(
      [
        [null, 'timeout'],
        [null, 'timeout'],
        [null, 'timeout'],
      ],
    )
    expect((await attemptsOf(redirectDelivery?.id ?? '')).map((a) => a.status_code)).toEqual([
      302, 302, 302,
    ])
    expect((await attemptsOf(busyDelivery?.id ?? '')).map((a) => a.status_code)).toEqual([
      429, 429, 429,
    ])
    expect(requestsTo('/redirect-target')).toEqual([])
    expect(new Set(requestsTo('/redirect').map((r) => r.headers['webhook-id']))).toEqual(
      new Set([eventId]),
    )
    // Три дня неудач нет — адрес остаётся включённым.
    expect(await endpointRow(redirect.endpoint.id)).toEqual({
      state: 'active',
      disabled_reason: null,
    })
    // Журнал с фильтром по состоянию.
    expect((await journal(redirect.endpoint.id, '?state=failed')).data).toHaveLength(1)
    expect((await journal(redirect.endpoint.id, '?state=succeeded')).data).toHaveLength(0)

    // Приёмник починили: «всё неудачное с даты» отправляет заново с тем же webhook-id.
    replies.set('/redirect', () => ({ status: 200 }))
    const res = await admin.call(
      app,
      'POST',
      `/v1/webhook-endpoints/${redirect.endpoint.id}/retry-failed`,
      { project: projectA, body: { since: new Date(Date.now() - 3600_000).toISOString() } },
    )
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ queued: 1 })
    await until(async () => {
      expect((await deliveries(redirect.endpoint.id)).map((d) => [d.state, d.attempts])).toEqual([
        ['succeeded', 4],
      ])
    })
    expect(requestsTo('/redirect').at(-1)?.headers['webhook-id']).toBe(eventId)
    expect(
      (await journal(redirect.endpoint.id)).data[0]?.attemptLog.map((a) => a.statusCode),
    ).toEqual([302, 302, 302, 200])
  })

  it('410 отключает адрес сразу, ожидающие доставки — cancelled; журнал и предупреждение администратору, не менеджеру', async () => {
    replies.set('/gone', () => ({ status: 410 }))
    const gone = await endpoint('/gone')
    await contactEvent()
    await contactEvent()
    await until(async () => {
      expect(await endpointRow(gone.endpoint.id)).toEqual({
        state: 'disabled',
        disabled_reason: 'gone_410',
      })
      expect((await deliveries(gone.endpoint.id)).map((d) => d.state)).toEqual([
        'cancelled',
        'cancelled',
      ])
    })
    // Один ответ 410 — и больше ни одной попытки.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(requestsTo('/gone')).toHaveLength(1)

    const audit = await h.owner
      .selectFrom('audit_log')
      .select(['action', 'actor_id', 'actor_api_key_id', 'details'])
      .where('entity_id', '=', gone.endpoint.id)
      .where('action', '=', 'webhook_endpoint.disabled')
      .execute()
    expect(audit).toEqual([
      {
        action: 'webhook_endpoint.disabled',
        actor_id: null,
        actor_api_key_id: null,
        details: { reason: 'gone_410', url: `${base}/gone` },
      },
    ])
    const alerts = await admin.call(app, 'GET', '/v1/webhook-endpoints/alerts', {
      project: projectA,
    })
    expect(await alerts.json()).toContainEqual(
      expect.objectContaining({ endpointId: gone.endpoint.id, reason: 'gone_410' }),
    )
    const forManager = await manager.call(app, 'GET', '/v1/webhook-endpoints/alerts', {
      project: projectA,
    })
    expect(forManager.status).toBe(403)

    // Повтор отключённому адресу — 409; после включения — можно, предупреждение пропадает.
    const [first] = await deliveries(gone.endpoint.id)
    const refused = await admin.call(
      app,
      'POST',
      `/v1/webhook-endpoints/${gone.endpoint.id}/deliveries/${first?.id}/retry`,
      { project: projectA },
    )
    expect(await problemOf(refused)).toEqual({ code: 'WEBHOOK_ENDPOINT_DISABLED' })
    replies.set('/gone', () => ({ status: 200 }))
    await admin.call(app, 'POST', `/v1/webhook-endpoints/${gone.endpoint.id}/enable`, {
      project: projectA,
    })
    const after = await admin.call(app, 'GET', '/v1/webhook-endpoints/alerts', {
      project: projectA,
    })
    expect(await after.json()).not.toContainEqual(
      expect.objectContaining({ endpointId: gone.endpoint.id }),
    )
    const retried = await admin.call(
      app,
      'POST',
      `/v1/webhook-endpoints/${gone.endpoint.id}/deliveries/${first?.id}/retry`,
      { project: projectA },
    )
    expect(retried.status).toBe(202)
    await until(() => expect(requestsTo('/gone')).toHaveLength(2))
  })

  it('5 суток без успеха (часы подменены) отключают адрес: журнал и предупреждение', async () => {
    replies.set('/failing', () => ({ status: 503 }))
    const failing = await endpoint('/failing')
    clockOffset = 5 * DAY_MS + 60_000
    try {
      await contactEvent()
      await until(async () => {
        expect(await endpointRow(failing.endpoint.id)).toEqual({
          state: 'disabled',
          disabled_reason: 'failing_5_days',
        })
        expect((await deliveries(failing.endpoint.id)).map((d) => d.state)).toEqual(['cancelled'])
      })
    } finally {
      clockOffset = 0
    }
    const audit = await h.owner
      .selectFrom('audit_log')
      .select(['actor_id', 'details'])
      .where('entity_id', '=', failing.endpoint.id)
      .where('action', '=', 'webhook_endpoint.disabled')
      .execute()
    expect(audit).toEqual([
      { actor_id: null, details: { reason: 'failing_5_days', url: `${base}/failing` } },
    ])
    const alerts = await admin.call(app, 'GET', '/v1/webhook-endpoints/alerts', {
      project: projectA,
    })
    expect(await alerts.json()).toContainEqual(
      expect.objectContaining({ endpointId: failing.endpoint.id, reason: 'failing_5_days' }),
    )
    expect(
      (await manager.call(app, 'GET', '/v1/webhook-endpoints/alerts', { project: projectA }))
        .status,
    ).toBe(403)
  })

  it('имя, которое после сохранения стало разрешаться во внутреннюю сеть, — отправка отклонена, попытка с причиной', async () => {
    names.set('hooks.example.test', ['93.184.216.34'])
    const target = await endpoint(
      '/ssrf',
      ['contact.created'],
      projectA,
      'https://hooks.example.test/ssrf',
    )
    names.set('hooks.example.test', ['10.0.0.5'])
    await contactEvent()
    await until(async () => {
      expect((await deliveries(target.endpoint.id)).map((d) => d.state)).toEqual(['failed'])
    })
    const [delivery] = await deliveries(target.endpoint.id)
    expect(await attemptsOf(delivery?.id ?? '')).toEqual([
      { status_code: null, error: 'forbidden_address', duration_ms: 0, response_body: null },
      { status_code: null, error: 'forbidden_address', duration_ms: 0, response_body: null },
      { status_code: null, error: 'forbidden_address', duration_ms: 0, response_body: null },
    ])
  })

  it('соединение идёт на проверенный IP: второго запроса в DNS нет', async () => {
    // Имя есть только в подставной таблице проверки; системный DNS его не знает. Доставка
    // проходит, только если соединение открыто на IP из проверки, без нового разрешения имени.
    const port = new URL(base).port
    names.set('pinned.example.test', ['127.0.0.1'])
    const target = await endpoint(
      '/pinned',
      ['contact.created'],
      projectA,
      `http://pinned.example.test:${port}/pinned`,
    )
    await contactEvent()
    await until(async () => {
      expect((await deliveries(target.endpoint.id)).map((d) => d.state)).toEqual(['succeeded'])
    })
    expect(requestsTo('/pinned')[0]?.headers.host).toBe(`pinned.example.test:${port}`)
  })

  it('смена секрета: 24 часа принимаются старый и новый секрет, потом только новый', async () => {
    const target = await endpoint('/rotate')
    const rotated = await admin.call(
      app,
      'POST',
      `/v1/webhook-endpoints/${target.endpoint.id}/rotate-secret`,
      { project: projectA },
    )
    const { secret: fresh } = (await rotated.json()) as WebhookEndpointWithSecret
    secretsSeen.push(fresh)
    await contactEvent()
    await until(() => expect(requestsTo('/rotate')).toHaveLength(1))
    const [first] = requestsTo('/rotate')
    if (!first) throw new Error('нет запроса')
    expect(String(first.headers['webhook-signature']).split(' ')).toHaveLength(2)
    expect(new Webhook(target.secret).verify(first.body, signatureHeaders(first))).toBeTruthy()
    expect(new Webhook(fresh).verify(first.body, signatureHeaders(first))).toBeTruthy()

    clockOffset = DAY_MS + 3600_000
    try {
      await contactEvent()
      await until(() => expect(requestsTo('/rotate')).toHaveLength(2))
    } finally {
      clockOffset = 0
    }
    const second = requestsTo('/rotate')[1]
    if (!second) throw new Error('нет запроса')
    expect(String(second.headers['webhook-signature']).split(' ')).toHaveLength(1)
    // Подпись сделана «через 25 часов» — проверяем в то же время.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + DAY_MS + 3600_000)
      expect(new Webhook(fresh).verify(second.body, signatureHeaders(second))).toBeTruthy()
      expect(() =>
        new Webhook(target.secret).verify(second.body, signatureHeaders(second)),
      ).toThrow(/signature/i)
    } finally {
      vi.useRealTimers()
    }
    const summary = (await (
      await admin.call(app, 'GET', `/v1/webhook-endpoints/${target.endpoint.id}`, {
        project: projectA,
      })
    ).json()) as WebhookEndpointSummary
    expect(summary.previousSecretExpiresAt).not.toBeNull()
  })

  it('секреты не попадают ни в журнал процесса, ни в задачи pg-boss, ни в журнал проекта', async () => {
    expect(secretsSeen.length).toBeGreaterThan(5)
    for (const secret of secretsSeen) {
      const raw = secret.slice('whsec_'.length)
      expect(logged.join('\n')).not.toContain(raw)
      const { rows } = await sql<{ hits: number }>`
        select
          (select count(*) from pgboss.job where data::text like ${`%${raw}%`}
            or coalesce(output::text, '') like ${`%${raw}%`})
          + (select count(*) from audit_log where details::text like ${`%${raw}%`})
          + (select count(*) from webhook_endpoint where secret_encrypted like ${`%${raw}%`})
          as hits
      `.execute(h.owner)
      expect(Number(rows[0]?.hits)).toBe(0)
    }
  })

  it('хранение: события старше 30 дней удаляются задачей вместе с доставками и попытками, новее — остаются', async () => {
    const target = await endpoint('/retention')
    const oldEvent = await contactEvent()
    const newEvent = await contactEvent()
    await until(async () => {
      expect((await deliveries(target.endpoint.id)).map((d) => d.state)).toEqual([
        'succeeded',
        'succeeded',
      ])
    })
    const [oldDelivery] = (await deliveries(target.endpoint.id)).filter(
      (d) => d.event_id === oldEvent,
    )
    await sql`update webhook_event set created_at = now() - interval '31 days' where id = ${oldEvent}`.execute(
      h.owner,
    )
    await sql`update webhook_event set created_at = now() - interval '29 days' where id = ${newEvent}`.execute(
      h.owner,
    )
    expect(await purgeWebhookLog(h.appDb)).toBe(1)
    const left = await h.owner
      .selectFrom('webhook_event')
      .select('id')
      .where('id', 'in', [oldEvent, newEvent])
      .execute()
    expect(left.map((e) => e.id)).toEqual([newEvent])
    expect((await deliveries(target.endpoint.id)).map((d) => d.event_id)).toEqual([newEvent])
    expect(await attemptsOf(oldDelivery?.id ?? '')).toEqual([])
  })
})
