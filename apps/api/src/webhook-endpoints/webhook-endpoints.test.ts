import { randomBytes, randomUUID } from 'node:crypto'
import { withProject } from '@alpi/db'
import {
  type ApiKeyWithSecret,
  EVENT_TYPES,
  PROJECT_HEADER,
  type WebhookDeliveryView,
  type WebhookEndpointListItem,
  type WebhookEndpointSummary,
  type WebhookEndpointWithSecret,
  type WebhookEventTypeInfo,
} from '@alpi/shared'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.ts'
import type { HostLookup } from '../events/ssrf.ts'
import {
  type ApiHarness,
  ORIGIN,
  type SignedInUser,
  startApiHarness,
} from '../testing/api-harness.ts'
import { problemOf } from '../testing/problem.ts'

// Адреса событий (тикет crm-api/06) на настоящем PostgreSQL, API ходит ролью приложения: права
// «интеграции», закрытость для ключа API, SSRF при сохранении, секрет только в ответе (в базе
// зашифрован, в журналах его нет), журнал проекта, изоляция проектов. Адреса и имена —
// выдуманные; разрешение имён — подставная таблица.

const names = new Map<string, string[]>([
  ['hooks.example.test', ['93.184.216.34']],
  ['internal.example.test', ['10.0.0.5']],
  ['localhost', ['127.0.0.1', '::1']],
])
const lookup: HostLookup = async (host) => {
  const addresses = names.get(host)
  if (!addresses) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' })
  return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
}

describe('адреса событий', () => {
  let h: ApiHarness
  let app: ReturnType<typeof createApp>
  let strictApp: ReturnType<typeof createApp>
  let keylessApp: ReturnType<typeof createApp>
  let admin: SignedInUser
  let manager: SignedInUser
  let projectA: string
  let projectB: string
  const key = randomBytes(32)

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_webhook_endpoints')
    app = createApp({
      auth: h.auth,
      db: h.appDb,
      webhooks: { secretKey: key, allowInsecureUrls: true, lookup },
    })
    strictApp = createApp({
      auth: h.auth,
      db: h.appDb,
      webhooks: { secretKey: key, allowInsecureUrls: false, lookup },
    })
    keylessApp = createApp({
      auth: h.auth,
      db: h.appDb,
      webhooks: { secretKey: null, allowInsecureUrls: false, lookup },
    })
    admin = await h.signIn('owner')
    manager = await h.signIn()
    projectA = (await h.createProject(admin, 'Адреси А')).id
    projectB = (await h.createProject(admin, 'Адреси Б')).id
    await h.addMember(projectA, manager.id, 'manager')
  })

  afterAll(async () => {
    await h?.stop()
  })

  async function create(
    body: Record<string, unknown>,
    options: { project?: string; target?: ReturnType<typeof createApp> } = {},
  ) {
    return admin.call(options.target ?? strictApp, 'POST', '/v1/webhook-endpoints', {
      project: options.project ?? projectA,
      body,
    })
  }

  async function created(body: Record<string, unknown> = {}, project = projectA) {
    const res = await create(
      { url: 'https://hooks.example.test/crm', eventTypes: ['deal.won'], ...body },
      { project },
    )
    expect(res.status).toBe(201)
    return (await res.json()) as WebhookEndpointWithSecret
  }

  describe('права', () => {
    it('без права «интеграции» — 403 на все запросы адресов', async () => {
      const { endpoint } = await created()
      const id = endpoint.id
      const routes: [string, string, unknown?][] = [
        ['GET', '/v1/webhook-endpoints'],
        ['GET', '/v1/webhook-endpoints/event-types'],
        ['GET', '/v1/webhook-endpoints/alerts'],
        [
          'POST',
          '/v1/webhook-endpoints',
          { url: 'https://hooks.example.test/m', eventTypes: ['deal.won'] },
        ],
        ['GET', `/v1/webhook-endpoints/${id}`],
        ['PATCH', `/v1/webhook-endpoints/${id}`, { description: 'менеджер' }],
        ['DELETE', `/v1/webhook-endpoints/${id}`],
        ['POST', `/v1/webhook-endpoints/${id}/enable`],
        ['POST', `/v1/webhook-endpoints/${id}/disable`],
        ['POST', `/v1/webhook-endpoints/${id}/rotate-secret`],
        ['GET', `/v1/webhook-endpoints/${id}/deliveries`],
        ['POST', `/v1/webhook-endpoints/${id}/deliveries/${id}/retry`],
        ['POST', `/v1/webhook-endpoints/${id}/retry-failed`, { since: '2026-01-01T00:00:00Z' }],
      ]
      for (const [method, path, body] of routes) {
        const res = await manager.call(strictApp, method as 'GET', path, {
          project: projectA,
          ...(body === undefined ? {} : { body }),
        })
        expect([method, path, res.status, await problemOf(res)]).toEqual([
          method,
          path,
          403,
          { code: 'PERMISSION_DENIED' },
        ])
      }
      // Ничего не изменилось.
      const after = (await (
        await admin.call(strictApp, 'GET', `/v1/webhook-endpoints/${id}`, { project: projectA })
      ).json()) as WebhookEndpointSummary
      expect(after).toEqual(endpoint)
    })

    it('запрос по ключу API (даже с ролью администратора) — 403 API_KEY_NOT_ALLOWED', async () => {
      const { id: roleId } = await h.owner
        .selectFrom('role')
        .select('id')
        .where('project_id', '=', projectA)
        .where('template_key', '=', 'admin')
        .executeTakeFirstOrThrow()
      const issued = await admin.call(strictApp, 'POST', '/v1/api-keys', {
        project: projectA,
        body: { name: 'Автоматизація адрес', roleId },
      })
      expect(issued.status).toBe(201)
      const { secret } = (await issued.json()) as ApiKeyWithSecret
      const { endpoint } = await created()
      for (const [method, path, body] of [
        ['GET', '/v1/webhook-endpoints'],
        ['GET', '/v1/webhook-endpoints/event-types'],
        [
          'POST',
          '/v1/webhook-endpoints',
          { url: 'https://hooks.example.test/k', eventTypes: ['deal.won'] },
        ],
        ['POST', `/v1/webhook-endpoints/${endpoint.id}/rotate-secret`],
        ['DELETE', `/v1/webhook-endpoints/${endpoint.id}`],
        ['GET', `/v1/webhook-endpoints/${endpoint.id}/deliveries`],
      ] as const) {
        const headers = new Headers({ origin: ORIGIN, authorization: `Bearer ${secret}` })
        if (body !== undefined) headers.set('content-type', 'application/json')
        const res = await strictApp.request(`${ORIGIN}${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        expect([path, res.status, await problemOf(res)]).toEqual([
          path,
          403,
          { code: 'API_KEY_NOT_ALLOWED' },
        ])
      }
    })
  })

  describe('SSRF при сохранении', () => {
    it('http://, внутренние IP, метаданные облака, [::1] и имя во внутреннюю сеть — 422 с кодом причины', async () => {
      const cases: [string, string][] = [
        ['http://hooks.example.test/crm', 'WEBHOOK_URL_NOT_HTTPS'],
        ['https://127.0.0.1/crm', 'WEBHOOK_URL_FORBIDDEN_ADDRESS'],
        ['https://10.0.0.5/crm', 'WEBHOOK_URL_FORBIDDEN_ADDRESS'],
        ['https://169.254.169.254/latest/meta-data', 'WEBHOOK_URL_FORBIDDEN_ADDRESS'],
        ['https://[::1]/crm', 'WEBHOOK_URL_FORBIDDEN_ADDRESS'],
        ['https://internal.example.test/crm', 'WEBHOOK_URL_FORBIDDEN_ADDRESS'],
        ['https://missing.example.test/crm', 'WEBHOOK_URL_UNRESOLVABLE'],
        ['https://user:pw@hooks.example.test/crm', 'WEBHOOK_URL_INVALID'],
        ['не адрес', 'WEBHOOK_URL_INVALID'],
        // Без переменной для тестов localhost не проходит.
        ['http://localhost:4000/hook', 'WEBHOOK_URL_NOT_HTTPS'],
        ['https://localhost:4000/hook', 'WEBHOOK_URL_FORBIDDEN_ADDRESS'],
      ]
      for (const [url, code] of cases) {
        const res = await create({ url, eventTypes: ['deal.won'] })
        expect([url, res.status, await problemOf(res)]).toEqual([
          url,
          422,
          {
            code,
            details: { path: 'url' },
            errors: [{ field: 'url', code, message: 'Invalid value' }],
          },
        ])
      }
      // Изменение адреса проверяется так же.
      const { endpoint } = await created()
      const res = await admin.call(strictApp, 'PATCH', `/v1/webhook-endpoints/${endpoint.id}`, {
        project: projectA,
        body: { url: 'https://169.254.169.254/' },
      })
      expect(res.status).toBe(422)
      expect((await problemOf(res)).code).toBe('WEBHOOK_URL_FORBIDDEN_ADDRESS')
    })

    it('с переменной для тестов http://localhost сохраняется', async () => {
      const res = await create(
        { url: 'http://localhost:4000/hook', eventTypes: ['deal.won'] },
        { target: app },
      )
      expect(res.status).toBe(201)
    })
  })

  describe('создание и секрет', () => {
    it('секрет показан один раз; в базе он зашифрован; в журнале проекта и журнале процесса его нет', async () => {
      const logged: string[] = []
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          logged.push(args.map(String).join(' '))
        }),
      )
      let secrets: string[] = []
      let endpoint: WebhookEndpointSummary
      try {
        const first = await created({
          description: 'Тестовий приймач',
          eventTypes: ['deal.won', 'deal.created'],
        })
        endpoint = first.endpoint
        expect(first.secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/)
        expect(endpoint).toMatchObject({
          url: 'https://hooks.example.test/crm',
          description: 'Тестовий приймач',
          // Порядок каталога, а не запроса.
          eventTypes: ['deal.created', 'deal.won'],
          state: 'active',
          disabledReason: null,
          previousSecretExpiresAt: null,
          createdBy: { id: admin.id },
        })
        const rotated = await admin.call(
          strictApp,
          'POST',
          `/v1/webhook-endpoints/${endpoint.id}/rotate-secret`,
          { project: projectA },
        )
        expect(rotated.status).toBe(200)
        const second = (await rotated.json()) as WebhookEndpointWithSecret
        expect(second.secret).not.toBe(first.secret)
        expect(
          Date.parse(second.endpoint.previousSecretExpiresAt ?? '') - Date.now(),
        ).toBeGreaterThan(23 * 3600 * 1000)
        secrets = [first.secret, second.secret]
      } finally {
        for (const spy of spies) spy.mockRestore()
      }

      // Второй раз секрет не показывается: ни в списке, ни в адресе.
      const list = await admin.call(strictApp, 'GET', '/v1/webhook-endpoints', {
        project: projectA,
      })
      const one = await admin.call(strictApp, 'GET', `/v1/webhook-endpoints/${endpoint.id}`, {
        project: projectA,
      })
      const shown = `${await list.text()}${await one.text()}`
      for (const secret of secrets) {
        const raw = secret.slice('whsec_'.length)
        expect(shown).not.toContain(raw)
        expect(logged.join('\n')).not.toContain(raw)
        // В базе — ни в адресе, ни в журнале проекта, ни в задачах.
        const { rows } = await sql<{ hits: number }>`
          select
            (select count(*) from webhook_endpoint
              where secret_encrypted like ${`%${raw}%`} or previous_secret_encrypted like ${`%${raw}%`})
            + (select count(*) from audit_log where details::text like ${`%${raw}%`})
            + (select count(*) from idempotency_record where response_body::text like ${`%${raw}%`})
            as hits
        `.execute(h.owner)
        expect(Number(rows[0]?.hits)).toBe(0)
      }
      const stored = await h.owner
        .selectFrom('webhook_endpoint')
        .select(['secret_encrypted', 'previous_secret_encrypted'])
        .where('id', '=', endpoint.id)
        .executeTakeFirstOrThrow()
      expect(stored.secret_encrypted).toMatch(/^v1\./)
      expect(stored.previous_secret_encrypted).toMatch(/^v1\./)

      const audit = await h.owner
        .selectFrom('audit_log')
        .select(['action', 'actor_id', 'details'])
        .where('entity_id', '=', endpoint.id)
        .orderBy('occurred_at')
        .execute()
      expect(audit.map((a) => [a.action, a.actor_id])).toEqual([
        ['webhook_endpoint.created', admin.id],
        ['webhook_endpoint.secret_rotated', admin.id],
      ])
      expect(audit[0]?.details).toEqual({
        url: 'https://hooks.example.test/crm',
        description: 'Тестовий приймач',
        eventTypes: ['deal.created', 'deal.won'],
      })
    })

    it('с Idempotency-Key секрет не сохраняется для повтора: повтор создания и смены секрета — тот же ответ без секрета', async () => {
      const post = (path: string, idempotencyKey: string, body?: unknown) =>
        admin.call(strictApp, 'POST', path, {
          project: projectA,
          ...(body === undefined ? {} : { body }),
          headers: { 'Idempotency-Key': idempotencyKey },
        })
      /** Строки idempotency_record целиком, текстом: секрета не должно быть ни в одном поле. */
      async function recordsWith(raw: string): Promise<number> {
        const { rows } = await sql<{ n: number }>`
          select count(*)::int as n from idempotency_record r where r::text like ${`%${raw}%`}
        `.execute(h.owner)
        return rows[0]?.n ?? -1
      }

      const createRequestKey = randomUUID()
      const description = `Повтор ${createRequestKey}`
      const body = { url: 'https://hooks.example.test/crm', description, eventTypes: ['deal.won'] }
      const first = await post('/v1/webhook-endpoints', createRequestKey, body)
      expect(first.status).toBe(201)
      const created = (await first.json()) as WebhookEndpointWithSecret
      expect(created.secret).toMatch(/^whsec_/)
      expect(await recordsWith(created.secret.slice('whsec_'.length))).toBe(0)

      const again = await post('/v1/webhook-endpoints', createRequestKey, body)
      expect(again.status).toBe(201)
      expect(again.headers.get('Idempotent-Replayed')).toBe('true')
      const replayed = (await again.json()) as Record<string, unknown>
      expect(replayed).not.toHaveProperty('secret')
      expect(replayed.endpoint).toEqual(JSON.parse(JSON.stringify(created.endpoint)))
      const same = await h.owner
        .selectFrom('webhook_endpoint')
        .select('id')
        .where('description', '=', description)
        .execute()
      expect(same).toHaveLength(1)

      const rotateRequestKey = randomUUID()
      const rotatePath = `/v1/webhook-endpoints/${created.endpoint.id}/rotate-secret`
      const rotated = await post(rotatePath, rotateRequestKey)
      expect(rotated.status).toBe(200)
      const { secret } = (await rotated.json()) as WebhookEndpointWithSecret
      expect(secret).toMatch(/^whsec_/)
      expect(await recordsWith(secret.slice('whsec_'.length))).toBe(0)
      const encrypted = await h.owner
        .selectFrom('webhook_endpoint')
        .select('secret_encrypted')
        .where('id', '=', created.endpoint.id)
        .executeTakeFirstOrThrow()

      const rotatedAgain = await post(rotatePath, rotateRequestKey)
      expect(rotatedAgain.status).toBe(200)
      expect(rotatedAgain.headers.get('Idempotent-Replayed')).toBe('true')
      const text = await rotatedAgain.text()
      expect(text).not.toContain(secret.slice('whsec_'.length))
      const replayedRotation = JSON.parse(text) as Record<string, unknown>
      expect(replayedRotation).not.toHaveProperty('secret')
      expect(replayedRotation.endpoint).toMatchObject({ id: created.endpoint.id })
      // Повтор не сменил секрет второй раз.
      const after = await h.owner
        .selectFrom('webhook_endpoint')
        .select('secret_encrypted')
        .where('id', '=', created.endpoint.id)
        .executeTakeFirstOrThrow()
      expect(after.secret_encrypted).toBe(encrypted.secret_encrypted)
    })

    it('без ключа шифрования адрес не создаётся (500), открытый секрет не сохраняется', async () => {
      const before = await h.owner.selectFrom('webhook_endpoint').select('id').execute()
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const res = await admin.call(keylessApp, 'POST', '/v1/webhook-endpoints', {
          project: projectA,
          body: { url: 'https://hooks.example.test/crm', eventTypes: ['deal.won'] },
        })
        expect(res.status).toBe(500)
      } finally {
        error.mockRestore()
      }
      expect(await h.owner.selectFrom('webhook_endpoint').select('id').execute()).toHaveLength(
        before.length,
      )
    })

    it('форма: неизвестный тип, пустой список, лишнее поле — 400 с полем', async () => {
      for (const [body, path] of [
        [{ url: 'https://hooks.example.test/x', eventTypes: ['deal.unknown'] }, 'eventTypes'],
        [{ url: 'https://hooks.example.test/x', eventTypes: [] }, 'eventTypes'],
        [
          { url: 'https://hooks.example.test/x', eventTypes: ['deal.won'], secret: 'whsec_x' },
          'secret',
        ],
        [
          {
            url: 'https://hooks.example.test/x',
            eventTypes: ['deal.won'],
            description: 'x'.repeat(501),
          },
          'description',
        ],
      ] as const) {
        const res = await create(body)
        expect([path, res.status, (await problemOf(res)).details]).toEqual([path, 400, { path }])
      }
    })

    it('типы событий — весь каталог с описаниями на uk и ru', async () => {
      const res = await admin.call(strictApp, 'GET', '/v1/webhook-endpoints/event-types', {
        project: projectA,
      })
      const types = (await res.json()) as WebhookEventTypeInfo[]
      expect(types.map((t) => t.type)).toEqual(EVENT_TYPES)
      expect(types.find((t) => t.type === 'deal.won')).toEqual({
        type: 'deal.won',
        entity: 'deal',
        title: { uk: 'Угоду виграно', ru: 'Сделка выиграна' },
      })
      for (const t of types) {
        expect(t.title.uk).not.toBe('')
        expect(t.title.ru).not.toBe('')
      }
    })
  })

  describe('изменение, включение, отключение, удаление', () => {
    it('каждое действие — в журнал проекта; ручное отключение — с автором, без предупреждения', async () => {
      const { endpoint } = await created()
      const path = `/v1/webhook-endpoints/${endpoint.id}`
      const patch = await admin.call(strictApp, 'PATCH', path, {
        project: projectA,
        body: { description: 'Новий опис', eventTypes: ['contact.created'] },
      })
      expect(patch.status).toBe(200)
      expect(await patch.json()).toMatchObject({
        description: 'Новий опис',
        eventTypes: ['contact.created'],
      })
      const disabled = await admin.call(strictApp, 'POST', `${path}/disable`, { project: projectA })
      expect(await disabled.json()).toMatchObject({ state: 'disabled', disabledReason: 'manual' })
      const alerts = await admin.call(strictApp, 'GET', '/v1/webhook-endpoints/alerts', {
        project: projectA,
      })
      expect((await alerts.json()) as unknown[]).not.toContainEqual(
        expect.objectContaining({ endpointId: endpoint.id }),
      )
      const enabled = await admin.call(strictApp, 'POST', `${path}/enable`, { project: projectA })
      expect(await enabled.json()).toMatchObject({
        state: 'active',
        disabledReason: null,
        disabledAt: null,
      })
      expect((await admin.call(strictApp, 'DELETE', path, { project: projectA })).status).toBe(204)
      expect((await admin.call(strictApp, 'GET', path, { project: projectA })).status).toBe(404)

      const audit = await h.owner
        .selectFrom('audit_log')
        .select(['action', 'actor_id', 'details'])
        .where('entity_id', '=', endpoint.id)
        .orderBy('occurred_at')
        .execute()
      expect(audit.map((a) => [a.action, a.actor_id])).toEqual([
        ['webhook_endpoint.created', admin.id],
        ['webhook_endpoint.updated', admin.id],
        ['webhook_endpoint.disabled', admin.id],
        ['webhook_endpoint.enabled', admin.id],
        ['webhook_endpoint.deleted', admin.id],
      ])
      expect(audit[2]?.details).toEqual({ reason: 'manual', url: 'https://hooks.example.test/crm' })
    })

    it('чужой или несуществующий адрес — 404 на всех действиях', async () => {
      const { endpoint } = await created({}, projectB)
      for (const [method, suffix] of [
        ['GET', ''],
        ['PATCH', ''],
        ['DELETE', ''],
        ['POST', '/enable'],
        ['POST', '/disable'],
        ['POST', '/rotate-secret'],
        ['GET', '/deliveries'],
      ] as const) {
        for (const id of [endpoint.id, 'not-a-uuid']) {
          const res = await admin.call(strictApp, method, `/v1/webhook-endpoints/${id}${suffix}`, {
            project: projectA,
            ...(method === 'PATCH' ? { body: { description: 'чужий' } } : {}),
          })
          expect([method, suffix, id, res.status]).toEqual([method, suffix, id, 404])
        }
      }
    })
  })

  describe('сводка доставок и тело события для экрана «Вебхуки» (тикет 07)', () => {
    /** Событие проекта `project` прямо в базе; возвращает id и тело. */
    async function event(project: string) {
      const id = `evt_${randomUUID()}`
      const body = {
        type: 'contact.created',
        timestamp: '2026-11-25T10:00:00.000Z',
        data: {
          event_id: id,
          project_id: project,
          contact_id: randomUUID(),
          actor: { type: 'user', id: admin.id },
        },
      }
      await h.owner
        .insertInto('webhook_event')
        .values({
          id,
          project_id: project,
          type: 'contact.created',
          occurred_at: body.timestamp,
          entity_type: 'contact',
          entity_id: body.data.contact_id,
          body: JSON.stringify(body),
          actor_type: 'user',
          actor_id: admin.id,
        })
        .execute()
      return { id, body }
    }

    /** Доставка события на вебхук: состояние и сколько часов назад она изменилась. */
    async function delivery(
      project: string,
      endpointId: string,
      eventId: string,
      state: 'pending' | 'succeeded' | 'failed' | 'cancelled',
      hoursAgo = 1,
    ) {
      const row = await h.owner
        .insertInto('webhook_delivery')
        .values({
          project_id: project,
          event_id: eventId,
          endpoint_id: endpointId,
          state,
          attempts: state === 'pending' ? 0 : 1,
          next_attempt_at: null,
          succeeded_at: state === 'succeeded' ? new Date() : null,
          updated_at: new Date(Date.now() - hoursAgo * 60 * 60 * 1000),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      return row.id
    }

    async function listOf(project: string) {
      const res = await admin.call(strictApp, 'GET', '/v1/webhook-endpoints', { project })
      expect(res.status).toBe(200)
      return (await res.json()) as WebhookEndpointListItem[]
    }

    it('в списке — сколько доставок завершилось за 24 часа и сколько из них неудачных; ожидающие, отменённые и старые не считаются', async () => {
      const a = await created({ description: 'Зведення' })
      const quiet = await created({ description: 'Без доставок' })
      for (const [state, hoursAgo] of [
        ['succeeded', 1],
        ['succeeded', 2],
        ['failed', 3],
        ['failed', 30],
        ['succeeded', 26],
        ['pending', 1],
        ['cancelled', 1],
      ] as const) {
        const { id } = await event(projectA)
        await delivery(projectA, a.endpoint.id, id, state, hoursAgo)
      }
      const list = await listOf(projectA)
      expect(list.find((e) => e.id === a.endpoint.id)?.deliveries24h).toEqual({
        finished: 3,
        failed: 1,
      })
      expect(list.find((e) => e.id === quiet.endpoint.id)?.deliveries24h).toEqual({
        finished: 0,
        failed: 0,
      })
      // Один вебхук — та же форма, что в списке, без сводки.
      const one = (await (
        await admin.call(strictApp, 'GET', `/v1/webhook-endpoints/${a.endpoint.id}`, {
          project: projectA,
        })
      ).json()) as WebhookEndpointSummary
      expect(one).not.toHaveProperty('deliveries24h')
    })

    it('журнал доставок отдаёт тело события; доставки и события другого проекта не видны', async () => {
      const a = await created({ description: 'Тіло А' })
      const b = await created({ description: 'Тіло Б' }, projectB)
      const ownEvent = await event(projectA)
      const foreignEvent = await event(projectB)
      const ownDelivery = await delivery(projectA, a.endpoint.id, ownEvent.id, 'failed')
      await h.owner
        .insertInto('webhook_delivery_attempt')
        .values({
          project_id: projectA,
          delivery_id: ownDelivery,
          status_code: 500,
          error: null,
          duration_ms: 120,
          response_body: 'boom',
        })
        .execute()
      await delivery(projectB, b.endpoint.id, foreignEvent.id, 'failed')

      const res = await admin.call(
        strictApp,
        'GET',
        `/v1/webhook-endpoints/${a.endpoint.id}/deliveries`,
        { project: projectA },
      )
      expect(res.status).toBe(200)
      const { data } = (await res.json()) as { data: WebhookDeliveryView[] }
      expect(data.map((d) => d.eventId)).toEqual([ownEvent.id])
      expect(data[0]?.event).toEqual(ownEvent.body)
      expect(data[0]?.attemptLog.map((attempt) => attempt.statusCode)).toEqual([500])

      // Журнал вебхука проекта B из контекста A — 404; сводка B своя.
      const foreign = await admin.call(
        strictApp,
        'GET',
        `/v1/webhook-endpoints/${b.endpoint.id}/deliveries`,
        { project: projectA },
      )
      expect(foreign.status).toBe(404)
      const listB = await listOf(projectB)
      expect(listB.find((e) => e.id === b.endpoint.id)?.deliveries24h).toEqual({
        finished: 1,
        failed: 1,
      })
      expect(JSON.stringify(await listOf(projectA))).not.toContain(foreignEvent.id)
    })
  })

  describe('изоляция проектов', () => {
    it('адреса проекта A не видны в контексте B — ни через API, ни под row-level security', async () => {
      const a = await created({ description: 'Тільки А' }, projectA)
      const listB = (await (
        await admin.call(strictApp, 'GET', '/v1/webhook-endpoints', { project: projectB })
      ).json()) as WebhookEndpointSummary[]
      expect(listB.map((e) => e.id)).not.toContain(a.endpoint.id)
      const rows = await withProject(h.appDb, projectB, (trx) =>
        trx.selectFrom('webhook_endpoint').select(['id', 'project_id']).execute(),
      )
      expect(rows.every((row) => row.project_id === projectB)).toBe(true)
      expect(rows.map((row) => row.id)).not.toContain(a.endpoint.id)
      // Заголовок проекта не подменить: тот же адрес с X-Project-Id проекта B — 404.
      const res = await admin.call(strictApp, 'GET', `/v1/webhook-endpoints/${a.endpoint.id}`, {
        project: projectB,
        headers: { [PROJECT_HEADER]: projectB },
      })
      expect(res.status).toBe(404)
    })
  })
})
