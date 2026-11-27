import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  ApiKeyWithSecret,
  EventActor,
  RoleSummary,
  WebhookAlert,
  WebhookDeliveryView,
  WebhookEndpointWithSecret,
} from '@alpi/shared'
import { Webhook } from 'standardwebhooks'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.ts'
import { runSeed } from '../cli/seed.ts'
import type { WebhookDeliveryOptions } from '../events/deliver.ts'
import { type Jobs, startJobs } from '../jobs/jobs.ts'
import { readCredentials, type SeedCredential } from '../seed/users.ts'
import {
  type ApiHarness,
  type Method,
  ORIGIN,
  type RequestOptions,
  startApiHarness,
} from '../testing/api-harness.ts'
import { keyRequest } from '../testing/api-key.ts'
import { totp } from '../testing/totp.ts'
import { NO_TRASH_PURGERS } from '../trash/purge.ts'

// Приёмка эпика crm-api (тикет crm-api/08; .scratch/crm-api/spec.md, «Приёмка владельцем»):
// сквозной сценарий на настоящем API и обработчике фоновых задач (pg-boss) поверх embedded
// PostgreSQL с данными `pnpm seed` (runSeed, 1/20 объёма — как стенд e2e). Приёмник событий —
// HTTP-сервер этого теста на 127.0.0.1 (http и loopback разрешены настройкой доставки, как
// переменной WEBHOOK_ALLOW_INSECURE_URLS=1 в тестовом запуске); повторы pg-boss укорочены:
// 2 повтора через 1 с.
//
// Приёмник ведёт себя как внешняя автоматизация владельца:
// - проверяет подпись каждого события пакетом standardwebhooks и неверную отклоняет (400);
// - помнит обработанные webhook-id и повтор пропускает;
// - пропускает событие, автор которого — его собственный ключ;
// - на deal.created и deal.stage_changed чужого автора переводит сделку на следующий этап
//   запросом /v1 своим ключом с Idempotency-Key. Реакция и на смену этапа — нарочно: без
//   проверки автора приёмник отвечал бы на собственный перевод и зацикливался, и тест это видит
//   (не больше REQUEST_LIMIT запросов на сделку — предел, в который цикл упирается).
// Все данные, кроме пользователей и воронок seed, — выдуманные.

/** Предел запросов приёмника в CRM на одну сделку: дальше приёмник ничего не делает. */
const REQUEST_LIMIT = 3
/** Сколько ждать после последнего события, чтобы убедиться, что новых нет (опрос pg-boss 0,5 с). */
const QUIET_MS = 3_000
const SLOW = 180_000

/** Что приёмник сделал с запросом CRM. */
type Outcome =
  | 'rejected' // подпись не сошлась — 400
  | 'forced' // тест велел ответить кодом не 2xx — событие не обработано
  | 'duplicate' // этот webhook-id уже обработан
  | 'own' // автор — ключ приёмника
  | 'moved' // приёмник перевёл сделку (ответ CRM — в crmCalls)
  | 'limit' // упёрся в REQUEST_LIMIT
  | 'ignored' // событие не про перевод сделки или этап последний

interface Received {
  webhookId: string
  type: string
  dealId: string
  actor: EventActor | null
  status: number
  outcome: Outcome
}

interface CrmCall {
  dealId: string
  webhookId: string
  stageId: string
  status: number
}

/** Тело события, как его видит приёмник (тонкое событие каталога, packages/shared/src/events). */
interface ReceivedEvent {
  type: string
  data: {
    deal_id?: string
    stage_id?: string
    to?: { stage_id: string }
    actor: EventActor
  }
}

interface Receiver {
  url: string
  received: Received[]
  crmCalls: CrmCall[]
  /** Коды, которыми ответить на следующие запросы (по одному на запрос), не обрабатывая их. */
  forced: number[]
  /** Секрет подписи вебхука и ключ API — их «вписывает» в автоматизацию администратор. */
  configure(settings: { signingSecret: string; keyId: string; keySecret: string }): void
  close(): Promise<void>
}

function startReceiver(
  crm: Parameters<typeof keyRequest>[0],
  stages: readonly string[],
): Promise<Receiver> {
  const received: Received[] = []
  const crmCalls: CrmCall[] = []
  const forced: number[] = []
  const processed = new Set<string>()
  let settings: { signingSecret: string; keyId: string; keySecret: string } | undefined

  async function handle(headers: IncomingHttpHeaders, body: string): Promise<number> {
    const webhookId = String(headers['webhook-id'] ?? '')
    const record = (event: ReceivedEvent | null, status: number, outcome: Outcome) => {
      received.push({
        webhookId,
        type: event?.type ?? '',
        dealId: event?.data.deal_id ?? '',
        actor: event?.data.actor ?? null,
        status,
        outcome,
      })
      return status
    }
    if (!settings) return record(null, 400, 'rejected')
    let event: ReceivedEvent
    try {
      event = new Webhook(settings.signingSecret).verify(body, {
        'webhook-id': webhookId,
        'webhook-timestamp': String(headers['webhook-timestamp'] ?? ''),
        'webhook-signature': String(headers['webhook-signature'] ?? ''),
      }) as ReceivedEvent
    } catch {
      return record(null, 400, 'rejected')
    }
    const status = forced.shift()
    if (status !== undefined) return record(event, status, 'forced')
    if (processed.has(webhookId)) return record(event, 200, 'duplicate')
    processed.add(webhookId)
    const { actor, deal_id: dealId } = event.data
    if (actor.type === 'api_key' && actor.id === settings.keyId) return record(event, 200, 'own')
    const current =
      event.type === 'deal.created'
        ? event.data.stage_id
        : event.type === 'deal.stage_changed'
          ? event.data.to?.stage_id
          : undefined
    const next = current === undefined ? undefined : stages[stages.indexOf(current) + 1]
    if (dealId === undefined || next === undefined) return record(event, 200, 'ignored')
    if (crmCalls.filter((c) => c.dealId === dealId).length >= REQUEST_LIMIT) {
      return record(event, 200, 'limit')
    }
    const res = await keyRequest(crm, settings.keySecret, 'POST', `/v1/deals/${dealId}/stage`, {
      body: { stageId: next },
      headers: { 'Idempotency-Key': `move-${webhookId}` },
    })
    crmCalls.push({ dealId, webhookId, stageId: next, status: res.status })
    return record(event, 200, 'moved')
  }

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      handle(req.headers, Buffer.concat(chunks).toString('utf8')).then(
        (status) => res.writeHead(status).end(),
        (error: unknown) => {
          console.error('приёмник упал', error)
          res.writeHead(500).end()
        },
      )
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/crm-events`,
        received,
        crmCalls,
        forced,
        configure: (value) => {
          settings = value
        },
        close: async () => {
          server.closeAllConnections()
          await new Promise((done) => server.close(done))
        },
      })
    })
  })
}

/** Клиент с сессией пользователя seed: запросы — к приложению `app` с доставкой событий. */
interface Session {
  id: string
  api(method: Method, path: string, options?: RequestOptions): Promise<Response>
}

describe('приёмка crm-api: приёмник событий двигает сделку ключом без зацикливания', () => {
  let h: ApiHarness
  let jobs: Jobs
  let app: ReturnType<typeof createApp>
  let receiver: Receiver
  let admin: Session
  let manager: Session
  let projectId: string
  let pipelineId: string
  /** Этапы воронки ALPI по порядку. */
  let stages: string[]
  let key: { id: string; secret: string }
  let endpoint: WebhookEndpointWithSecret
  /** Сделка шага 3 и сделка шагов 5–6. */
  let firstDeal: string
  let retriedDeal: string

  async function json<T>(res: Response, status = 200): Promise<T> {
    const text = await res.text()
    expect(res.status, text).toBe(status)
    return JSON.parse(text) as T
  }

  const until = (check: () => Promise<void> | void, timeout = 20_000) =>
    vi.waitFor(check, { timeout, interval: 200 })

  const quiet = () => new Promise((resolve) => setTimeout(resolve, QUIET_MS))

  /** Вход пользователя seed паролем и кодом 2FA из файла учётных данных. */
  async function signIn(credential: SeedCredential): Promise<Session> {
    const browser = h.browser()
    const res = await browser.api('POST', '/auth/sign-in/email', {
      body: { email: credential.email, password: credential.password },
    })
    expect(await json(res)).toMatchObject({ twoFactorRedirect: true })
    await json(
      await browser.api('POST', '/auth/two-factor/verify-totp', {
        body: { code: totp(credential.totpSecret) },
      }),
    )
    const user = await h.owner
      .selectFrom('user')
      .select('id')
      .where('email', '=', credential.email)
      .executeTakeFirstOrThrow()
    return {
      id: user.id,
      api: (method, p, options) => browser.call(app, method, p, { project: projectId, ...options }),
    }
  }

  /** Менеджер создаёт сделку на первом этапе ALPI с новым контактом. */
  async function managerCreatesDeal(title: string): Promise<string> {
    const deal = await json<{ id: string; stageId: string }>(
      await manager.api('POST', '/v1/deals', {
        body: {
          title,
          pipelineId,
          contact: { firstName: 'Приймання', lastName: randomBytes(3).toString('hex') },
        },
      }),
      201,
    )
    expect(deal.stageId).toBe(stages[0])
    return deal.id
  }

  async function dealRow(id: string) {
    return h.owner
      .selectFrom('deal')
      .select(['stage_id', 'status', 'amount'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  }

  /** События сделки в журнале событий (transactional outbox): что CRM вообще сообщила. */
  async function eventsOf(dealId: string) {
    const rows = await h.owner
      .selectFrom('webhook_event')
      .select(['id', 'type', 'actor_type', 'actor_id'])
      .where('entity_id', '=', dealId)
      .orderBy('occurred_at')
      .execute()
    return rows
  }

  const receivedFor = (dealId: string, type?: string) =>
    receiver.received.filter((r) => r.dealId === dealId && (type === undefined || r.type === type))
  const callsFor = (dealId: string) => receiver.crmCalls.filter((c) => c.dealId === dealId)

  async function journal(): Promise<WebhookDeliveryView[]> {
    const page = await json<{ data: WebhookDeliveryView[] }>(
      await admin.api('GET', `/v1/webhook-endpoints/${endpoint.endpoint.id}/deliveries`),
    )
    return page.data
  }

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_crm_api_acceptance')
    const credentialsFile = path.join(
      await mkdtemp(path.join(tmpdir(), 'alpi-crm-api-acceptance-')),
      'seed-credentials.json',
    )
    const silent = { log: () => {}, error: () => {} }
    expect(
      await runSeed(
        {
          serviceDb: h.owner,
          databaseUrl: h.appUrl,
          appDatabaseUrl: h.appUrl,
          auth: h.auth,
          authUrl: ORIGIN,
          env: { NODE_ENV: 'test' },
          credentialsFile,
          out: silent,
        },
        ['--scale', '0.05'],
      ),
    ).toBe(0)

    const webhooks: WebhookDeliveryOptions = {
      secretKey: randomBytes(32),
      allowInsecureUrls: true,
      timeoutMs: 5_000,
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

    const project = await h.owner
      .selectFrom('project')
      .select('id')
      .where('code', '=', 'alpi')
      .executeTakeFirstOrThrow()
    projectId = project.id
    const pipeline = await h.owner
      .selectFrom('pipeline')
      .select('id')
      .where('project_id', '=', projectId)
      .where('code', '=', 'alpi')
      .executeTakeFirstOrThrow()
    pipelineId = pipeline.id
    stages = (
      await h.owner
        .selectFrom('stage')
        .select('id')
        .where('pipeline_id', '=', pipelineId)
        .orderBy('position')
        .execute()
    ).map((s) => s.id)

    const credentials = await readCredentials(credentialsFile)
    const adminCredential = credentials.find((c) => c.role === 'admin')
    const managerCredential = credentials.find((c) => c.role === 'manager')
    if (!adminCredential || !managerCredential)
      throw new Error('seed без администратора или менеджера')
    admin = await signIn(adminCredential)
    manager = await signIn(managerCredential)
    receiver = await startReceiver(app, stages)
  }, SLOW)

  afterAll(async () => {
    await jobs?.stop()
    await h?.stop()
    await receiver?.close()
  })

  it('1. администратор создаёт ключ «Автоматизація (тест)» с ролью со сделками и передачей сделок; секрет показан один раз', async () => {
    const roles = await json<RoleSummary[]>(await admin.api('GET', '/roles'))
    const role = roles.find((r) => r.templateKey === 'head')
    expect(role?.permissions.actions.deals).toEqual(expect.arrayContaining(['view', 'edit']))
    expect(role?.permissions.standalone).toContain('transfer_deals')

    const created = await json<ApiKeyWithSecret>(
      await admin.api('POST', '/v1/api-keys', {
        body: { name: 'Автоматизація (тест)', roleId: role?.id },
      }),
      201,
    )
    key = { id: created.key.id, secret: created.secret }
    // Второй раз секрет не показывается: ни в списке, ни в самом ключе.
    const list = await admin.api('GET', '/v1/api-keys')
    expect(list.status).toBe(200)
    const listed = await list.text()
    expect(listed).toContain(key.id)
    expect(listed).not.toContain(key.secret)
  })

  it('2. администратор создаёт вебхук на deal.created, deal.stage_changed, deal.won и получает секрет whsec_…', async () => {
    endpoint = await json<WebhookEndpointWithSecret>(
      await admin.api('POST', '/v1/webhook-endpoints', {
        body: {
          url: receiver.url,
          description: 'Автоматизація (тест)',
          eventTypes: ['deal.created', 'deal.stage_changed', 'deal.won'],
        },
      }),
      201,
    )
    expect(endpoint.secret).toMatch(/^whsec_/)
    const shown = await admin.api('GET', `/v1/webhook-endpoints/${endpoint.endpoint.id}`)
    expect(shown.status).toBe(200)
    expect(await shown.text()).not.toContain(endpoint.secret)
    // Администратор вписывает секрет подписи и ключ в свою автоматизацию.
    receiver.configure({ signingSecret: endpoint.secret, keyId: key.id, keySecret: key.secret })
  })

  it(
    '3. менеджер создаёт сделку — приёмник получает deal.created от пользователя, подпись сходится; чужую подпись приёмник отклоняет',
    async () => {
      firstDeal = await managerCreatesDeal('Приймання: перша угода')
      const [event] = await eventsOf(firstDeal)
      expect(event).toMatchObject({ type: 'deal.created', actor_type: 'user' })
      // Первый запрос с этим webhook-id: подпись сошлась (иначе outcome — rejected, код 400).
      await until(() => expect(receiver.received.some((r) => r.webhookId === event?.id)).toBe(true))
      expect(receiver.received.find((r) => r.webhookId === event?.id)).toMatchObject({
        type: 'deal.created',
        dealId: firstDeal,
        actor: { type: 'user', id: manager.id },
        outcome: 'moved',
        status: 200,
      })

      // Запрос, подписанный не секретом вебхука, приёмник не принимает.
      const forged = new Webhook(`whsec_${randomBytes(24).toString('base64')}`)
      const body = JSON.stringify({
        type: 'deal.created',
        data: { deal_id: firstDeal, actor: { type: 'user', id: manager.id } },
      })
      const msgId = `evt_${randomUUID()}`
      const now = new Date()
      const res = await fetch(receiver.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'webhook-id': msgId,
          'webhook-timestamp': String(Math.floor(now.getTime() / 1000)),
          'webhook-signature': forged.sign(msgId, now, body),
        },
        body,
      })
      expect(res.status).toBe(400)
      expect(receiver.received.at(-1)).toMatchObject({ webhookId: msgId, outcome: 'rejected' })
    },
    SLOW,
  )

  it(
    '4. приёмник переводит сделку ключом (200); deal.stage_changed с автором-ключом он пропускает — один запрос, одна смена этапа, цикла нет',
    async () => {
      const [move] = callsFor(firstDeal)
      expect(move).toMatchObject({ status: 200, stageId: stages[1] })
      await until(() =>
        expect(receivedFor(firstDeal, 'deal.stage_changed').length).toBeGreaterThan(0),
      )
      await quiet()

      expect(receivedFor(firstDeal, 'deal.stage_changed')).toEqual([
        expect.objectContaining({ actor: { type: 'api_key', id: key.id }, outcome: 'own' }),
      ])
      expect(callsFor(firstDeal)).toHaveLength(1)
      expect((await eventsOf(firstDeal)).map((e) => [e.type, e.actor_type])).toEqual([
        ['deal.created', 'user'],
        ['deal.stage_changed', 'api_key'],
      ])
      expect((await dealRow(firstDeal)).stage_id).toBe(stages[1])
    },
    SLOW,
  )

  it(
    '5. приёмник один раз отвечает 500 — событие приходит повторно с тем же webhook-id и обрабатывается один раз; в журнале две попытки',
    async () => {
      receiver.forced.push(500)
      retriedDeal = await managerCreatesDeal('Приймання: угода з повтором')
      await until(() => expect(receivedFor(retriedDeal, 'deal.created')).toHaveLength(2))
      const [first, second] = receivedFor(retriedDeal, 'deal.created')
      expect(first).toMatchObject({ status: 500, outcome: 'forced' })
      expect(second).toMatchObject({ status: 200, outcome: 'moved', webhookId: first?.webhookId })
      await until(() => expect(receivedFor(retriedDeal, 'deal.stage_changed')).toHaveLength(1))
      expect(callsFor(retriedDeal)).toEqual([
        expect.objectContaining({ status: 200, stageId: stages[1] }),
      ])

      await until(async () => {
        const delivery = (await journal()).find((d) => d.eventId === first?.webhookId)
        expect(delivery).toMatchObject({
          eventType: 'deal.created',
          state: 'succeeded',
          attempts: 2,
        })
        expect(delivery?.attemptLog.map((a) => a.statusCode)).toEqual([500, 200])
      })
    },
    SLOW,
  )

  it(
    '6. ручной повтор из журнала доставляет событие ещё раз с тем же webhook-id — приёмник узнаёт дубль',
    async () => {
      const [first] = receivedFor(retriedDeal, 'deal.created')
      const delivery = (await journal()).find((d) => d.eventId === first?.webhookId)
      expect(
        await json(
          await admin.api(
            'POST',
            `/v1/webhook-endpoints/${endpoint.endpoint.id}/deliveries/${delivery?.id}/retry`,
          ),
          202,
        ),
      ).toEqual({ queued: 1 })
      await until(() => expect(receivedFor(retriedDeal, 'deal.created')).toHaveLength(3))
      expect(receivedFor(retriedDeal, 'deal.created')[2]).toMatchObject({
        webhookId: first?.webhookId,
        outcome: 'duplicate',
        status: 200,
      })
      await quiet()
      expect(callsFor(retriedDeal)).toHaveLength(1)
      expect((await dealRow(retriedDeal)).stage_id).toBe(stages[1])
      await until(async () => {
        const again = (await journal()).find((d) => d.id === delivery?.id)
        expect(again?.attemptLog.map((a) => a.statusCode)).toEqual([500, 200, 200])
      })
    },
    SLOW,
  )

  it(
    '7. сумму сделки меняют ключом — этап и статус те же, событий deal.stage_changed и deal.won нет (ADR 0003)',
    async () => {
      const before = await eventsOf(firstDeal)
      const receivedBefore = receivedFor(firstDeal).length
      const changed = await json<{ stageId: string; status: string; amount: number }>(
        await keyRequest(app, key.secret, 'PATCH', `/v1/deals/${firstDeal}`, {
          body: { amount: 4200 },
          headers: { 'Idempotency-Key': randomUUID() },
        }),
      )
      expect(changed).toMatchObject({ stageId: stages[1], status: 'open', amount: 4200 })
      await quiet()
      expect(await dealRow(firstDeal)).toMatchObject({ stage_id: stages[1], status: 'open' })
      expect(await eventsOf(firstDeal)).toEqual(before)
      expect(receivedFor(firstDeal)).toHaveLength(receivedBefore)
    },
    SLOW,
  )

  it(
    '8. приёмник отвечает 410 — вебхук отключён, у администратора предупреждение',
    async () => {
      receiver.forced.push(410)
      const deal = await managerCreatesDeal('Приймання: угода для 410')
      await until(() => expect(receivedFor(deal, 'deal.created')).toHaveLength(1))
      expect(receivedFor(deal, 'deal.created')[0]).toMatchObject({ status: 410, outcome: 'forced' })
      await until(async () => {
        const shown = await json<{ state: string; disabledReason: string | null }>(
          await admin.api('GET', `/v1/webhook-endpoints/${endpoint.endpoint.id}`),
        )
        expect(shown).toMatchObject({ state: 'disabled', disabledReason: 'gone_410' })
      })
      const alerts = await json<WebhookAlert[]>(
        await admin.api('GET', '/v1/webhook-endpoints/alerts'),
      )
      expect(alerts).toContainEqual(
        expect.objectContaining({ endpointId: endpoint.endpoint.id, reason: 'gone_410' }),
      )
      await quiet()
      expect(receivedFor(deal)).toHaveLength(1)
      expect(callsFor(deal)).toEqual([])
      expect((await dealRow(deal)).stage_id).toBe(stages[0])
    },
    SLOW,
  )

  it(
    '9. ключ отозван — следующий запрос приёмника получает 401, сделка не двигается',
    async () => {
      await json(await admin.api('POST', `/v1/api-keys/${key.id}/revoke`))
      // Вебхук после 410 снова включают, чтобы приёмник получил следующее событие.
      expect(
        (await admin.api('POST', `/v1/webhook-endpoints/${endpoint.endpoint.id}/enable`)).status,
      ).toBe(200)
      const deal = await managerCreatesDeal('Приймання: угода після відкликання ключа')
      await until(() => expect(callsFor(deal)).toHaveLength(1))
      expect(callsFor(deal)[0]).toMatchObject({ status: 401 })
      await quiet()
      expect(callsFor(deal)).toHaveLength(1)
      expect((await dealRow(deal)).stage_id).toBe(stages[0])
      expect((await eventsOf(deal)).map((e) => e.type)).toEqual(['deal.created'])
    },
    SLOW,
  )
})
