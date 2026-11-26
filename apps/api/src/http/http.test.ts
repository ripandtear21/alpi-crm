import { createHash, randomInt, randomUUID } from 'node:crypto'
import { withProject } from '@alpi/db'
import {
  type ApiKeyWithSecret,
  IDEMPOTENT_REPLAYED_HEADER,
  type Page,
  PROJECT_HEADER,
  type ProblemDetails,
} from '@alpi/shared'
import { OpenAPIHono, z } from '@hono/zod-openapi'
import { Validator } from '@seriousme/openapi-schema-validator'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import type { ContactListItem } from '../contacts/list.ts'
import type { DealView } from '../deals/store.ts'
import { apiKeyAuth, apiKeyRoute } from '../middleware/api-key.ts'
import { projectContext } from '../middleware/project-context.ts'
import { keyRoute, v1Document, validationHook } from '../openapi/openapi.ts'
import {
  type ApiHarness,
  type Method,
  ORIGIN,
  type SignedInUser,
  startApiHarness,
  type Target,
} from '../testing/api-harness.ts'
import { idempotency } from './idempotency.ts'

// Общие правила /api/v1 (тикет crm-api/02) на настоящем PostgreSQL, API ходит ролью приложения:
// ошибки RFC 9457 на всех маршрутах /api/v1 (обход списка маршрутов приложения), курсорная
// выдача, Idempotency-Key (повтор, другой запрос, параллельные запросы, 5xx, изоляция авторов и
// проектов), лимит запросов ключа, описание OpenAPI. Имена и телефоны — выдуманные.

const fakePhone = () => `+38067${randomInt(1_000_000, 9_999_999)}`

/** Ответ — ошибка RFC 9457: тип содержимого и обязательные члены. */
async function problemOf(res: Response): Promise<ProblemDetails> {
  expect(res.headers.get('content-type') ?? '').toMatch(/^application\/problem\+json/)
  const body = (await res.json()) as ProblemDetails
  expect(body).toMatchObject({
    type: expect.any(String),
    title: expect.any(String),
    status: res.status,
    code: expect.any(String),
  })
  return body
}

describe('общие правила /api/v1', () => {
  let h: ApiHarness
  let admin: SignedInUser
  let projectA: string
  let projectB: string
  let pipelineA: string
  let pipelineB: string

  async function createPipeline(projectId: string): Promise<string> {
    const { id } = await h.owner
      .insertInto('pipeline')
      .values({
        project_id: projectId,
        code: `p${randomInt(1e9)}`,
        name: `Воронка ${randomInt(1e9)}`,
        position: randomInt(1e6),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    for (const [index, name] of ['Новий', 'Далі'].entries()) {
      await h.owner
        .insertInto('stage')
        .values({ project_id: projectId, pipeline_id: id, name, position: index + 1 })
        .execute()
    }
    return id
  }

  async function templateRole(projectId: string, key: string): Promise<string> {
    const { id } = await h.owner
      .selectFrom('role')
      .select('id')
      .where('project_id', '=', projectId)
      .where('template_key', '=', key)
      .executeTakeFirstOrThrow()
    return id
  }

  async function createKey(projectId: string, template = 'head'): Promise<ApiKeyWithSecret> {
    const res = await admin.api('POST', '/v1/api-keys', {
      project: projectId,
      body: {
        name: `Автоматизація ${randomInt(1e9)}`,
        roleId: await templateRole(projectId, template),
      },
    })
    expect(res.status).toBe(201)
    return (await res.json()) as ApiKeyWithSecret
  }

  /** Запрос по ключу: только Authorization, без cookie. */
  function keyRequest(
    target: Target,
    secret: string,
    method: Method,
    path: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ) {
    const headers = new Headers({ origin: ORIGIN, authorization: `Bearer ${secret}` })
    if (options.body !== undefined) headers.set('content-type', 'application/json')
    for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value)
    return target.request(`${ORIGIN}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
  }

  /** Тело новой сделки с новым контактом в воронке `pipelineId`. */
  const dealBody = (pipelineId: string, title = `Угода ${randomInt(1e9)}`) => ({
    title,
    pipelineId,
    contact: { firstName: 'Вигаданий', phones: [fakePhone()] },
  })

  async function dealsTitled(title: string) {
    return h.owner.selectFrom('deal').select('id').where('title', '=', title).execute()
  }

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_http')
    admin = await h.signIn('owner')
    projectA = (await h.createProject(admin, 'Правила А')).id
    projectB = (await h.createProject(admin, 'Правила Б')).id
    pipelineA = await createPipeline(projectA)
    pipelineB = await createPipeline(projectB)
  })

  afterAll(async () => {
    await h?.stop()
  })

  describe('ошибки RFC 9457', () => {
    it('400, 401, 403, 404, 409, 422 — application/problem+json с type, title, status, code; ошибка поля — errors[].field', async () => {
      const bad = await admin.api('GET', '/v1/contacts/list?cursor=not-a-cursor', {
        project: projectA,
      })
      expect(bad.status).toBe(400)
      expect((await problemOf(bad)).errors).toEqual([
        expect.objectContaining({ field: 'cursor', message: expect.any(String) }),
      ])

      const anonymous = await h.request('GET', '/v1/deals')
      expect(anonymous.status).toBe(401)
      expect((await problemOf(anonymous)).code).toBe('UNAUTHORIZED')

      const viewer = await h.signIn()
      const { id: noRights } = await h.owner
        .insertInto('role')
        .values({ project_id: projectA, name: `Без прав ${randomInt(1e9)}`, permissions: '{}' })
        .returning('id')
        .executeTakeFirstOrThrow()
      await h.owner
        .insertInto('project_member')
        .values({ project_id: projectA, user_id: viewer.id, role_id: noRights })
        .execute()
      const denied = await viewer.api('GET', '/v1/deals', { project: projectA })
      expect(denied.status).toBe(403)
      expect((await problemOf(denied)).code).toBe('PERMISSION_DENIED')

      const missing = await admin.api('GET', `/v1/deals/${randomUUID()}`, { project: projectA })
      expect(missing.status).toBe(404)
      expect((await problemOf(missing)).code).toBe('DEAL_NOT_FOUND')

      const contact = { firstName: 'Повтор', phones: [fakePhone()] }
      const first = await admin.api('POST', '/v1/deals', {
        project: projectA,
        body: { title: 'Перша', pipelineId: pipelineA, contact },
      })
      expect(first.status).toBe(201)
      const { primaryContactId } = (await first.json()) as DealView
      const second = await admin.api('POST', '/v1/deals', {
        project: projectA,
        body: { title: 'Друга', pipelineId: pipelineA, contactId: primaryContactId },
      })
      expect(second.status).toBe(409)
      expect((await problemOf(second)).code).toBe('OPEN_DEAL_EXISTS')

      const invalid = await admin.api('POST', '/v1/contacts', {
        project: projectA,
        body: { firstName: 'Телефон', phones: ['не телефон'] },
      })
      expect(invalid.status).toBe(422)
      const problem = await problemOf(invalid)
      expect(problem.code).toBe('INVALID_PHONE')
      expect(problem.errors).toEqual([
        { field: 'phones.0', code: 'INVALID_PHONE', message: expect.any(String) },
      ])
    })

    it('500 — код INTERNAL без текста и стека ошибки', async () => {
      const failing = createApp({
        auth: h.auth,
        db: h.appDb,
        stageRequirements: {
          missingFields: () => Promise.reject(new Error('секретна-подробиця')),
        },
      })
      const res = await admin.call(failing, 'POST', '/v1/deals', {
        project: projectA,
        body: dealBody(pipelineA),
      })
      expect(res.status).toBe(500)
      const text = await res.clone().text()
      expect(text).not.toContain('секретна-подробиця')
      expect(text).not.toContain('at ')
      expect(await problemOf(res)).toEqual({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        code: 'INTERNAL',
      })
    })

    it('неизвестный путь /api/v1 — 404 NOT_FOUND', async () => {
      const res = await admin.api('GET', '/v1/no-such-section', { project: projectA })
      expect(res.status).toBe(404)
      expect((await problemOf(res)).code).toBe('NOT_FOUND')
    })

    it('каждый маршрут /api/v1 отвечает ошибкой в формате RFC 9457 — без входа, с неверным и чужим ключом, без прав, в чужом проекте, с неверными данными', async () => {
      const app = createApp({ auth: h.auth, db: h.appDb })
      const project = (await h.createProject(admin, 'Обхід')).id
      const { secret } = await createKey(project)
      const noRights = await h.signIn()
      const { id: roleId } = await h.owner
        .insertInto('role')
        .values({ project_id: project, name: 'Порожня', permissions: '{}' })
        .returning('id')
        .executeTakeFirstOrThrow()
      await h.owner
        .insertInto('project_member')
        .values({ project_id: project, user_id: noRights.id, role_id: roleId })
        .execute()

      const OPEN = new Set(['GET /v1/openapi.json', 'GET /v1/docs'])
      const routes = new Map<string, { method: Method; path: string; keyOpen: boolean }>()
      for (const route of app.routes) {
        if (route.method === 'ALL' || !route.path.startsWith('/v1/')) continue
        const id = `${route.method} ${route.path}`
        if (OPEN.has(id) || routes.has(id)) continue
        routes.set(id, {
          method: route.method as Method,
          path: route.path.replace(/:[^/]+/g, randomUUID()),
          keyOpen: route.handler === apiKeyRoute,
        })
      }
      expect(routes.size).toBeGreaterThan(50)

      const failures: string[] = []
      async function check(id: string, label: string, res: Response, status?: number) {
        if (status === undefined && res.status < 400) return
        const type = res.headers.get('content-type') ?? ''
        const body = (await res.json().catch(() => null)) as ProblemDetails | null
        const ok =
          (status === undefined || res.status === status) &&
          type.startsWith('application/problem+json') &&
          body?.status === res.status &&
          typeof body.code === 'string' &&
          typeof body.type === 'string' &&
          typeof body.title === 'string'
        if (!ok) failures.push(`${id} (${label}): ${res.status} ${type} ${JSON.stringify(body)}`)
      }
      const body = { unexpected: true }

      for (const [id, { method, path, keyOpen }] of routes) {
        const send = (headers: Record<string, string>) =>
          app.request(`${ORIGIN}${path}`, {
            method,
            headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
            ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
          })
        await check(id, 'без входа', await send({}), 401)
        await check(id, 'неверный ключ', await send({ authorization: 'Bearer alpi_wrong' }), 401)
        const byKey = await keyRequest(app, secret, method, path, {
          ...(method === 'GET' ? {} : { body }),
        })
        await check(id, 'ключ', byKey, keyOpen ? undefined : 403)
        const options = { body: method === 'GET' ? undefined : body }
        await check(
          id,
          'чужой проект',
          await admin.call(app, method, path, { ...options, project: randomUUID() }),
          403,
        )
        await check(id, 'без прав', await noRights.call(app, method, path, { ...options, project }))
        await check(id, 'админ', await admin.call(app, method, path, { ...options, project }))
      }
      expect(failures).toEqual([])
    }, 180_000)
  })

  describe('курсорная выдача', () => {
    it('120 записей с равным значением сортировки читаются страницами по 50 ровно по одному разу; неверный курсор — 400', async () => {
      const project = (await h.createProject(admin, 'Курсор')).id
      const createdAt = new Date('2026-01-01T00:00:00.000Z')
      await h.owner
        .insertInto('contact')
        .values(
          Array.from({ length: 120 }, (_, i) => ({
            project_id: project,
            first_name: `Контакт ${i}`,
            created_at: createdAt,
            updated_at: createdAt,
          })),
        )
        .execute()

      const seen: string[] = []
      const sizes: number[] = []
      let cursor: string | null = null
      do {
        const query: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`
        const res = await admin.api(
          'GET',
          `/v1/contacts/list?limit=50&sort=createdAt:desc${query}`,
          {
            project,
          },
        )
        expect(res.status).toBe(200)
        const page = (await res.json()) as Page<ContactListItem>
        expect(Object.keys(page).sort()).toEqual(['data', 'next_cursor'])
        sizes.push(page.data.length)
        seen.push(...page.data.map((item) => item.id))
        cursor = page.next_cursor
      } while (cursor !== null)
      expect(sizes).toEqual([50, 50, 20])
      expect(new Set(seen).size).toBe(120)

      for (const wrong of ['abc', Buffer.from('{"s":"name:asc"}').toString('base64url')]) {
        const res = await admin.api('GET', `/v1/contacts/list?cursor=${wrong}`, { project })
        expect(res.status).toBe(400)
        await problemOf(res)
      }
      const tooMany = await admin.api('GET', '/v1/contacts/list?limit=201', { project })
      expect(tooMany.status).toBe(400)
    })
  })

  describe('Idempotency-Key', () => {
    it('повтор POST с тем же ключом и телом — тот же ответ с Idempotent-Replayed: true, вторая сделка не создана; другое тело — 422', async () => {
      const key = randomUUID()
      const body = dealBody(pipelineA)
      const first = await admin.api('POST', '/v1/deals', {
        project: projectA,
        body,
        headers: { 'Idempotency-Key': key },
      })
      expect(first.status).toBe(201)
      expect(first.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull()
      const created = await first.text()

      const again = await admin.api('POST', '/v1/deals', {
        project: projectA,
        body,
        headers: { 'Idempotency-Key': key },
      })
      expect(again.status).toBe(201)
      expect(again.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true')
      expect(again.headers.get('content-type')).toMatch(/^application\/json/)
      expect(await again.text()).toBe(created)
      expect(await dealsTitled(body.title)).toHaveLength(1)

      const other = await admin.api('POST', '/v1/deals', {
        project: projectA,
        body: { ...body, title: `${body.title} інша` },
        headers: { 'Idempotency-Key': key },
      })
      expect(other.status).toBe(422)
      expect((await problemOf(other)).code).toBe('IDEMPOTENCY_KEY_REUSED')
      expect(await dealsTitled(`${body.title} інша`)).toEqual([])
    })

    it('ответ 4xx сохраняется и повторяется; значение длиннее 255 символов — 400', async () => {
      const key = randomUUID()
      const body = { title: '', pipelineId: pipelineA }
      const first = await admin.api('POST', '/v1/deals', {
        project: projectA,
        body,
        headers: { 'Idempotency-Key': key },
      })
      expect(first.status).toBe(400)
      const again = await admin.api('POST', '/v1/deals', {
        project: projectA,
        body,
        headers: { 'Idempotency-Key': key },
      })
      expect(again.status).toBe(400)
      expect(again.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true')
      expect(again.headers.get('content-type')).toMatch(/^application\/problem\+json/)

      const tooLong = await admin.api('POST', '/v1/deals', {
        project: projectA,
        body: dealBody(pipelineA),
        headers: { 'Idempotency-Key': 'x'.repeat(256) },
      })
      expect(tooLong.status).toBe(400)
      expect((await problemOf(tooLong)).code).toBe('INVALID_IDEMPOTENCY_KEY')
    })

    it('10 параллельных одинаковых запросов создают одну сделку, все получают её ответ', async () => {
      const key = randomUUID()
      const body = dealBody(pipelineA)
      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          admin.api('POST', '/v1/deals', {
            project: projectA,
            body,
            headers: { 'Idempotency-Key': key },
          }),
        ),
      )
      expect(responses.map((r) => r.status)).toEqual(Array(10).fill(201))
      const ids = await Promise.all(responses.map(async (r) => ((await r.json()) as DealView).id))
      expect(new Set(ids).size).toBe(1)
      expect(
        responses.filter((r) => r.headers.get(IDEMPOTENT_REPLAYED_HEADER) === 'true'),
      ).toHaveLength(9)
      expect(await dealsTitled(body.title)).toHaveLength(1)
    })

    it('ответ 500 не сохраняется: тот же запрос можно повторить', async () => {
      const failing = createApp({
        auth: h.auth,
        db: h.appDb,
        stageRequirements: { missingFields: () => Promise.reject(new Error('збій')) },
      })
      const key = randomUUID()
      const body = dealBody(pipelineA)
      const failed = await admin.call(failing, 'POST', '/v1/deals', {
        project: projectA,
        body,
        headers: { 'Idempotency-Key': key },
      })
      expect(failed.status).toBe(500)
      expect(
        await h.owner
          .selectFrom('idempotency_record')
          .select('id')
          .where('key', '=', key)
          .execute(),
      ).toEqual([])

      const retried = await admin.api('POST', '/v1/deals', {
        project: projectA,
        body,
        headers: { 'Idempotency-Key': key },
      })
      expect(retried.status).toBe(201)
      expect(retried.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull()
      expect(await dealsTitled(body.title)).toHaveLength(1)
    })

    it('одно значение у двух авторов и в двух проектах — независимые запросы; записи проекта A не видны в контексте B', async () => {
      const key = randomUUID()
      const head = await h.signIn()
      await h.addMember(projectA, head.id, 'head')

      const bodies = [dealBody(pipelineA), dealBody(pipelineA), dealBody(pipelineB)]
      const results = [
        await admin.api('POST', '/v1/deals', {
          project: projectA,
          body: bodies[0],
          headers: { 'Idempotency-Key': key },
        }),
        await head.api('POST', '/v1/deals', {
          project: projectA,
          body: bodies[1],
          headers: { 'Idempotency-Key': key },
        }),
        await admin.api('POST', '/v1/deals', {
          project: projectB,
          body: bodies[2],
          headers: { 'Idempotency-Key': key },
        }),
      ]
      for (const res of results) {
        expect(res.status).toBe(201)
        expect(res.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull()
      }
      for (const body of bodies) expect(await dealsTitled(body?.title ?? '')).toHaveLength(1)

      // Ключ API — свой автор: то же значение — ещё один независимый запрос (маршрут, открытый
      // ключу, проверяется на строке журнала, а не на сделке: создание сделки ключом — тикет 03).
      const records = (projectId: string) =>
        withProject(h.appDb, projectId, (trx) =>
          trx
            .selectFrom('idempotency_record')
            .select(['project_id', 'author_type', 'author_id'])
            .where('key', '=', key)
            .execute(),
        )
      const inA = await records(projectA)
      expect(inA).toHaveLength(2)
      expect(inA.every((r) => r.project_id === projectA)).toBe(true)
      expect(new Set(inA.map((r) => r.author_id))).toEqual(new Set([admin.id, head.id]))
      const inB = await records(projectB)
      expect(inB).toEqual([{ project_id: projectB, author_type: 'user', author_id: admin.id }])
    })

    it('ключ API и пользователь с одним значением — разные авторы', async () => {
      const { secret, key: apiKey } = await createKey(projectA)
      const key = randomUUID()
      // Проверочный изменяющий маршрут, открытый ключу (как будут открывать тикеты 03 и 04).
      const probe = new Hono()
        .use('*', apiKeyAuth(h.appDb, h.auth))
        .use('*', projectContext(h.appDb))
        .use('*', idempotency())
        .post('/probe', apiKeyRoute, async (c) => c.json({ n: randomInt(1e9) }, 201))
      const call = () =>
        keyRequest(probe, secret, 'POST', '/probe', {
          body: { a: 1 },
          headers: { 'Idempotency-Key': key },
        })
      const first = await call()
      expect(first.status).toBe(201)
      const replay = await call()
      expect(replay.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true')
      expect(await replay.json()).toEqual(await first.json())
      // Повтор ничего не меняет — и в журнал действий ключа не пишется.
      const logged = await h.owner
        .selectFrom('audit_log')
        .select('id')
        .where('action', '=', 'api_key.request')
        .where('actor_api_key_id', '=', apiKey.id)
        .execute()
      expect(logged).toHaveLength(1)

      const byUser = await admin.api('POST', '/v1/deals', {
        project: projectA,
        body: dealBody(pipelineA),
        headers: { 'Idempotency-Key': key },
      })
      expect(byUser.status).toBe(201)
      expect(byUser.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull()
      const authors = await h.owner
        .selectFrom('idempotency_record')
        .select(['author_type', 'author_id'])
        .where('key', '=', key)
        .orderBy('author_type')
        .execute()
      expect(authors).toEqual([
        { author_type: 'api_key', author_id: apiKey.id },
        { author_type: 'user', author_id: admin.id },
      ])
    })
  })

  describe('лимит запросов ключа', () => {
    it('601-й запрос ключа за минуту — 429 с Retry-After; другой ключ не ограничен; сессия не ограничена', async () => {
      let now = Date.UTC(2026, 0, 1, 12, 0, 0)
      const app = createApp({ auth: h.auth, db: h.appDb, rateLimit: { now: () => now } })
      const first = await createKey(projectA)
      const second = await createKey(projectA)

      const allowed = await keyRequest(app, first.secret, 'GET', '/v1/deals')
      expect(allowed.status).toBe(200)
      expect(allowed.headers.get('RateLimit-Limit')).toBe('600')
      expect(allowed.headers.get('RateLimit-Remaining')).toBe('599')
      expect(allowed.headers.get('RateLimit-Reset')).toBe('60')
      // Закрытый ключу маршрут тоже считается и тоже несёт заголовки лимита.
      for (let i = 2; i <= 600; i++) {
        const res = await keyRequest(app, first.secret, 'GET', '/v1/contacts/list')
        expect(res.status).toBe(403)
      }
      now += 15_000
      const limited = await keyRequest(app, first.secret, 'GET', '/v1/deals')
      expect(limited.status).toBe(429)
      expect(limited.headers.get('Retry-After')).toBe('45')
      expect(limited.headers.get('RateLimit-Remaining')).toBe('0')
      expect((await problemOf(limited)).code).toBe('RATE_LIMITED')

      const other = await keyRequest(app, second.secret, 'GET', '/v1/deals')
      expect(other.status).toBe(200)

      for (let i = 0; i < 601; i++) {
        const res = await admin.call(app, 'GET', '/me')
        if (res.status !== 200) throw new Error(`сессия: ${i}-й запрос — ${res.status}`)
        expect(res.headers.get('RateLimit-Limit')).toBeNull()
      }

      now += 45_000
      expect((await keyRequest(app, first.secret, 'GET', '/v1/deals')).status).toBe(200)
    }, 120_000)
  })

  describe('описание OpenAPI', () => {
    it('GET /api/v1/openapi.json без входа — OpenAPI 3.1, проходит валидатор; в нём только маршруты, доступные ключу; /api/v1/docs открывается', async () => {
      const app = createApp({ auth: h.auth, db: h.appDb })
      const res = await app.request(`${ORIGIN}/v1/openapi.json`)
      expect(res.status).toBe(200)
      const doc = (await res.json()) as {
        openapi: string
        paths?: Record<string, Record<string, unknown>>
        components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> }
      }
      expect(doc.openapi).toBe('3.1.0')
      const result = await new Validator().validate(doc as never)
      expect(result.errors ?? []).toEqual([])
      expect(result.valid).toBe(true)
      expect(doc.components.schemas).toHaveProperty('Problem')
      expect(doc.components.securitySchemes).toEqual({
        bearer: expect.objectContaining({ type: 'http', scheme: 'bearer' }),
      })

      for (const [path, methods] of Object.entries(doc.paths ?? {})) {
        for (const method of Object.keys(methods)) {
          const honoPath = `/v1${path.replace(/\{([^}]+)\}/g, ':$1')}`
          const first = app.routes.find(
            (r) => r.method === method.toUpperCase() && r.path === honoPath,
          )
          expect([method, path, first?.handler === apiKeyRoute]).toEqual([method, path, true])
        }
      }

      // С ключом описание тоже открыто: оно до проверки ключа.
      const withKey = await app.request(`${ORIGIN}/v1/openapi.json`, {
        headers: { authorization: 'Bearer alpi_wrong' },
      })
      expect(withKey.status).toBe(200)

      const docs = await app.request(`${ORIGIN}/v1/docs`)
      expect(docs.status).toBe(200)
      expect(docs.headers.get('content-type')).toMatch(/^text\/html/)
      expect(await docs.text()).toContain('/api/v1/openapi.json')
    })

    it('/api/v1/docs: скрипт с CDN — точный файл с integrity и crossorigin; CSP пускает только его, пустой элемент настроек по хешу и запросы к своему адресу', async () => {
      const app = createApp({ auth: h.auth, db: h.appDb })
      const docs = await app.request(`${ORIGIN}/v1/docs`)
      expect(docs.status).toBe(200)
      const csp = docs.headers.get('content-security-policy') ?? ''
      const directives = new Map(
        csp
          .split(';')
          .map((part) => part.trim().split(/\s+/))
          .filter(([name]) => name)
          .map(([name, ...sources]) => [name, sources]),
      )
      expect(directives.get('default-src')).toEqual(["'none'"])
      expect(directives.get('connect-src')).toEqual(["'self'"])
      expect(directives.get('base-uri')).toEqual(["'none'"])
      expect(directives.get('form-action')).toEqual(["'none'"])
      expect(directives.get('frame-ancestors')).toEqual(["'none'"])

      const html = await docs.text()
      const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].map(
        ([, attrs = '', content = '']) => ({ attrs, content }),
      )
      const external = scripts.filter((s) => /\ssrc="/.test(s.attrs))
      const inline = scripts.filter((s) => !/\ssrc="/.test(s.attrs))
      expect(external).toHaveLength(1)
      const [script] = external
      const src = /\ssrc="([^"]+)"/.exec(script?.attrs ?? '')?.[1] ?? ''
      // Точный файл точной версии, а не «последняя» и не файл по умолчанию.
      expect(src).toMatch(
        /^https:\/\/cdn\.jsdelivr\.net\/npm\/@scalar\/api-reference@\d+\.\d+\.\d+\/dist\/browser\/standalone\.js$/,
      )
      expect(script?.attrs).toMatch(/\sintegrity="sha384-[A-Za-z0-9+/]{64}"/)
      expect(script?.attrs).toMatch(/\scrossorigin="anonymous"/)
      // script-src: ровно этот файл и хеши встроенных элементов — без 'unsafe-inline',
      // 'unsafe-eval', целого хоста CDN и подстановок.
      const inlineHashes = inline.map(
        (s) => `'sha256-${createHash('sha256').update(s.content).digest('base64')}'`,
      )
      expect(inline.length).toBeGreaterThan(0)
      expect([...(directives.get('script-src') ?? [])].sort()).toEqual(
        [...new Set(inlineHashes), src].sort(),
      )
    })

    it('keyRoute: одна схема проверяет запрос и описывает маршрут; ошибка проверки — 400 с errors[].field', async () => {
      const { secret } = await createKey(projectA)
      const routes = new OpenAPIHono().openapi(
        keyRoute({
          method: 'post',
          path: '/probes/{id}',
          request: {
            params: z.object({ id: z.uuid() }),
            body: {
              required: true,
              content: {
                'application/json': {
                  schema: z.object({ title: z.string().min(1), amount: z.number().int() }),
                },
              },
            },
          },
          responses: {
            201: {
              description: 'Создано',
              content: { 'application/json': { schema: z.object({ id: z.string() }) } },
            },
          },
        }),
        (c) => c.json({ id: c.req.valid('param').id }, 201),
      )
      const v1 = new OpenAPIHono({ defaultHook: validationHook }).route('/', routes)
      const app = new Hono()
        .use('*', apiKeyAuth(h.appDb, h.auth))
        .use('*', projectContext(h.appDb))
        .route('/v1', v1)

      const id = randomUUID()
      const good = await keyRequest(app, secret, 'POST', `/v1/probes/${id}`, {
        body: { title: 'Так', amount: 5 },
      })
      expect(good.status).toBe(201)
      expect(await good.json()).toEqual({ id })

      const bad = await keyRequest(app, secret, 'POST', `/v1/probes/${id}`, {
        body: { title: '', amount: 1.5 },
      })
      expect(bad.status).toBe(400)
      const problem = await problemOf(bad)
      expect(problem.code).toBe('INVALID_INPUT')
      expect(problem.errors?.map((e) => e.field).sort()).toEqual(['amount', 'title'])

      const doc = v1Document(v1) as unknown as {
        paths: Record<string, Record<string, Record<string, unknown>>>
      }
      const post = doc.paths['/probes/{id}']?.post
      expect(post).toMatchObject({
        security: [{ bearer: [] }],
        requestBody: {
          content: {
            'application/json': {
              schema: { required: ['title', 'amount'] },
            },
          },
        },
        responses: { 201: expect.anything(), 400: expect.anything(), 429: expect.anything() },
      })
      expect(post?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ in: 'header', name: 'idempotency-key' }),
        ]),
      )
      expect((await new Validator().validate(doc as never)).valid).toBe(true)
    })
  })

  it('заголовок проекта у запроса ключа сверяется, как раньше', async () => {
    const { secret } = await createKey(projectA)
    const res = await keyRequest(h.app, secret, 'GET', '/v1/deals', {
      headers: { [PROJECT_HEADER]: projectB },
    })
    expect(res.status).toBe(403)
    expect((await problemOf(res)).code).toBe('PROJECT_FORBIDDEN')
  })
})
