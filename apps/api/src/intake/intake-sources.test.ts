import { createHash, randomUUID } from 'node:crypto'
import { withProject } from '@alpi/db'
import {
  type ApiKeyWithSecret,
  eventBodyProblem,
  INTAKE_KEY_PATTERN,
  type IntakeSourceSummary,
  type IntakeSourceWithKey,
  ROLE_TEMPLATES,
  type RolePermissions,
} from '@alpi/shared'
import { sql } from 'kysely'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.ts'
import { recordChanges } from '../change-log/record.ts'
import { emitEvent } from '../events/emit.ts'
import {
  type ApiHarness,
  type Method,
  ORIGIN,
  type SignedInUser,
  startApiHarness,
  type Target,
} from '../testing/api-harness.ts'
import { problemOf } from '../testing/problem.ts'
import { intakeSourceByKey } from './auth.ts'

// Источники регистраций и ключи источников (тикет crm-intake/03) на настоящем PostgreSQL, API
// ходит ролью приложения: изоляция проектов, права «интеграции», ключ только в ответе,
// проверка ключа на /intake и одинаковый 401, лимит запросов на источник, автор-источник в
// истории и событиях, журнал проекта. Названия и имена — выдуманные.

const MANAGER = ROLE_TEMPLATES.find((t) => t.key === 'manager')?.permissions as RolePermissions

function permissions(change: (p: RolePermissions) => void): RolePermissions {
  const p = structuredClone(MANAGER)
  change(p)
  return p
}

describe('источники регистраций', () => {
  let h: ApiHarness
  let admin: SignedInUser
  let projectA: string
  let projectB: string
  let pipelineA: string
  let pipelineB: string
  let counter = 0

  /** Запрос с одним заголовком Authorization, без cookie: так ходит внешний сервис. */
  function bearerRequest(
    target: Target,
    key: string | null,
    method: Method,
    path: string,
    body?: unknown,
  ) {
    const headers = new Headers({ origin: ORIGIN })
    if (key !== null) headers.set('authorization', `Bearer ${key}`)
    if (body !== undefined) headers.set('content-type', 'application/json')
    return target.request(`${ORIGIN}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  /**
   * Запрос приёма к основному приложению: путь `/intake/...` (снаружи — /api/intake/...). По
   * умолчанию — путь без маршрута: принятый ключ получает 404, а не 401 (регистрации — тикет 06,
   * intake/registrations.test.ts).
   */
  const intake = (key: string | null, path = '/intake/unknown') =>
    bearerRequest(h.app, key, 'POST', path, { event_id: `e-${++counter}` })

  async function createPipeline(projectId: string): Promise<string> {
    const n = ++counter
    const { id } = await h.owner
      .insertInto('pipeline')
      .values({ project_id: projectId, code: `src${n}`, name: `Воронка ${n}`, position: n })
      .returning('id')
      .executeTakeFirstOrThrow()
    return id
  }

  async function createRole(projectId: string, perms: RolePermissions): Promise<string> {
    const { id } = await h.owner
      .insertInto('role')
      .values({
        project_id: projectId,
        name: `Роль ${++counter}`,
        permissions: JSON.stringify(perms),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return id
  }

  async function memberWith(perms: RolePermissions): Promise<SignedInUser> {
    const user = await h.signIn()
    await h.owner
      .insertInto('project_member')
      .values({
        project_id: projectA,
        user_id: user.id,
        role_id: await createRole(projectA, perms),
      })
      .execute()
    return user
  }

  async function createSource(
    options: { project?: string; pipeline?: string; name?: string } = {},
  ): Promise<IntakeSourceWithKey> {
    const res = await admin.api('POST', '/v1/intake-sources', {
      project: options.project ?? projectA,
      body: {
        name: options.name ?? `Лендінг ${++counter}`,
        pipelineId: options.pipeline ?? pipelineA,
      },
    })
    expect(res.status).toBe(201)
    return (await res.json()) as IntakeSourceWithKey
  }

  const post = (user: SignedInUser, path: string, body?: unknown) =>
    user.api('POST', path, { project: projectA, ...(body === undefined ? {} : { body }) })

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_intake_sources')
    admin = await h.signIn('owner')
    projectA = (await h.createProject(admin, 'Проєкт А')).id
    projectB = (await h.createProject(admin, 'Проєкт Б')).id
    pipelineA = await createPipeline(projectA)
    pipelineB = await createPipeline(projectB)
  })

  afterAll(async () => {
    await h?.stop()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('изоляция проектов', () => {
    it('источники проекта A не видны в контексте B — ни через API, ни запросом без фильтра', async () => {
      const { source } = await createSource()

      const listB = await admin.api('GET', '/v1/intake-sources', { project: projectB })
      expect(listB.status).toBe(200)
      expect(((await listB.json()) as IntakeSourceSummary[]).map((s) => s.id)).not.toContain(
        source.id,
      )
      const rowsB = await withProject(h.appDb, projectB, (trx) =>
        trx.selectFrom('intake_source').select(['id', 'project_id']).execute(),
      )
      expect(rowsB.every((r) => r.project_id === projectB)).toBe(true)
      expect(rowsB.map((r) => r.id)).not.toContain(source.id)
      // Без выставленного проекта — ни одной строки.
      expect(await h.appDb.selectFrom('intake_source').select('id').execute()).toEqual([])
      // Действия с источником A в контексте B — как с несуществующим.
      for (const action of ['reissue-key', 'disable', 'enable']) {
        const res = await admin.api('POST', `/v1/intake-sources/${source.id}/${action}`, {
          project: projectB,
        })
        expect(res.status).toBe(404)
        expect(await problemOf(res)).toEqual({ code: 'INTAKE_SOURCE_NOT_FOUND' })
      }
    })

    it('источник нельзя создать с воронкой другого проекта — ни через API, ни в базе', async () => {
      const res = await admin.api('POST', '/v1/intake-sources', {
        project: projectA,
        body: { name: `Чужа воронка ${++counter}`, pipelineId: pipelineB },
      })
      expect(res.status).toBe(422)
      expect(await problemOf(res)).toEqual({ code: 'PIPELINE_NOT_FOUND' })

      await expect(
        h.owner
          .insertInto('intake_source')
          .values({
            project_id: projectA,
            name: `Обхід ${++counter}`,
            pipeline_id: pipelineB,
            key_hash: 'a'.repeat(64),
            key_prefix: 'alpi_src_abc',
            created_by: admin.id,
          })
          .execute(),
      ).rejects.toThrow(/foreign key/)
    })

    it('ключ источника проекта A даёт проект A и воронку источника', async () => {
      const { source, key } = await createSource()
      expect(await intakeSourceByKey(h.appDb, key)).toEqual({
        id: source.id,
        projectId: projectA,
        pipelineId: pipelineA,
      })
      const { source: sourceB, key: keyB } = await createSource({
        project: projectB,
        pipeline: pipelineB,
      })
      expect(await intakeSourceByKey(h.appDb, keyB)).toEqual({
        id: sourceB.id,
        projectId: projectB,
        pipelineId: pipelineB,
      })
    })
  })

  describe('права', () => {
    it('без integrations: view список — 403; без create — создание 403; без edit — смена ключа, отключение и включение 403', async () => {
      const target = await createSource()
      const noView = await memberWith(
        permissions((p) => {
          p.actions.integrations = []
        }),
      )
      const viewOnly = await memberWith(
        permissions((p) => {
          p.actions.integrations = ['view']
        }),
      )
      const editOnly = await memberWith(
        permissions((p) => {
          p.actions.integrations = ['view', 'edit']
        }),
      )
      const createOnly = await memberWith(
        permissions((p) => {
          p.actions.integrations = ['view', 'create']
        }),
      )

      const denied = async (res: Response) => {
        expect(res.status).toBe(403)
        expect(await problemOf(res)).toEqual({ code: 'PERMISSION_DENIED' })
      }
      await denied(await noView.api('GET', '/v1/intake-sources', { project: projectA }))
      expect((await viewOnly.api('GET', '/v1/intake-sources', { project: projectA })).status).toBe(
        200,
      )

      const body = () => ({ name: `Спроба ${++counter}`, pipelineId: pipelineA })
      for (const user of [noView, viewOnly, editOnly]) {
        await denied(await post(user, '/v1/intake-sources', body()))
      }
      expect((await post(createOnly, '/v1/intake-sources', body())).status).toBe(201)

      for (const user of [noView, viewOnly, createOnly]) {
        for (const action of ['reissue-key', 'disable', 'enable']) {
          await denied(await post(user, `/v1/intake-sources/${target.source.id}/${action}`))
        }
      }
      // Источник цел: ключ работает.
      expect(await intakeSourceByKey(h.appDb, target.key)).not.toBeNull()

      // С integrations: edit — смена ключа, отключение и включение.
      for (const action of ['reissue-key', 'disable', 'enable']) {
        const res = await post(editOnly, `/v1/intake-sources/${target.source.id}/${action}`)
        expect(res.status, action).toBe(200)
      }
    })

    it('ключ API с ролью администратора — 403 API_KEY_NOT_ALLOWED на всех запросах источников', async () => {
      const { id: adminRole } = await h.owner
        .selectFrom('role')
        .select('id')
        .where('project_id', '=', projectA)
        .where('is_admin', '=', true)
        .executeTakeFirstOrThrow()
      const created = await admin.api('POST', '/v1/api-keys', {
        project: projectA,
        body: { name: `Адмін-ключ ${++counter}`, roleId: adminRole },
      })
      expect(created.status).toBe(201)
      const { secret } = (await created.json()) as ApiKeyWithSecret
      const { source } = await createSource()

      const requests: [Method, string, unknown?][] = [
        ['GET', '/v1/intake-sources'],
        ['POST', '/v1/intake-sources', { name: `Ключем ${++counter}`, pipelineId: pipelineA }],
        ['POST', `/v1/intake-sources/${source.id}/reissue-key`],
        ['POST', `/v1/intake-sources/${source.id}/disable`],
        ['POST', `/v1/intake-sources/${source.id}/enable`],
      ]
      for (const [method, path, body] of requests) {
        const res = await bearerRequest(h.app, secret, method, path, body)
        expect(res.status, path).toBe(403)
        expect(await problemOf(res)).toEqual({ code: 'API_KEY_NOT_ALLOWED' })
      }
    })
  })

  describe('ключ', () => {
    it('показывается только в ответе на создание и смену ключа; в списке, базе, журнале, idempotency_record и логах его нет', async () => {
      const output: string[] = []
      const capture = (...args: unknown[]) => {
        output.push(args.map(String).join(' '))
      }
      for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
        vi.spyOn(console, method).mockImplementation(capture)
      }
      const write = (chunk: unknown) => {
        output.push(String(chunk))
        return true
      }
      vi.spyOn(process.stdout, 'write').mockImplementation(write)
      vi.spyOn(process.stderr, 'write').mockImplementation(write)

      // Создание и смена ключа — с Idempotency-Key: повтор отдаёт ответ без ключа.
      const createKey = `src-create-${++counter}-${Date.now()}`
      const body = { name: `Секретне джерело ${counter}`, pipelineId: pipelineA }
      const first = await admin.api('POST', '/v1/intake-sources', {
        project: projectA,
        body,
        headers: { 'Idempotency-Key': createKey },
      })
      expect(first.status).toBe(201)
      expect(first.headers.get('cache-control')).toBe('no-store')
      const created = (await first.json()) as IntakeSourceWithKey
      expect(created.key).toMatch(INTAKE_KEY_PATTERN)
      expect(created.source.keyPrefix).toBe(created.key.slice(0, 12))
      expect(JSON.stringify(created.source)).not.toContain(created.key)

      const again = await admin.api('POST', '/v1/intake-sources', {
        project: projectA,
        body,
        headers: { 'Idempotency-Key': createKey },
      })
      expect(again.status).toBe(201)
      expect(again.headers.get('Idempotent-Replayed')).toBe('true')
      const replayed = (await again.json()) as Record<string, unknown>
      expect(replayed).not.toHaveProperty('key')
      expect(replayed.source).toEqual(JSON.parse(JSON.stringify(created.source)))

      // Запросы приёма — удачный и с неверным ключом.
      expect((await intake(created.key)).status).toBe(404)
      expect((await intake(`${created.key.slice(0, -1)}x`)).status).toBe(401)

      const reissueKey = `src-reissue-${++counter}-${Date.now()}`
      const reissued = await admin.api(
        'POST',
        `/v1/intake-sources/${created.source.id}/reissue-key`,
        { project: projectA, headers: { 'Idempotency-Key': reissueKey } },
      )
      expect(reissued.status).toBe(200)
      expect(reissued.headers.get('cache-control')).toBe('no-store')
      const { key: second } = (await reissued.json()) as IntakeSourceWithKey
      expect(second).toMatch(INTAKE_KEY_PATTERN)
      expect(second).not.toBe(created.key)
      const reissuedAgain = await admin.api(
        'POST',
        `/v1/intake-sources/${created.source.id}/reissue-key`,
        { project: projectA, headers: { 'Idempotency-Key': reissueKey } },
      )
      expect(reissuedAgain.headers.get('Idempotent-Replayed')).toBe('true')
      expect(await reissuedAgain.text()).not.toContain(second)
      // Повтор не сменил ключ второй раз.
      expect(await intakeSourceByKey(h.appDb, second)).not.toBeNull()

      const list = await admin.api('GET', '/v1/intake-sources', { project: projectA })
      const listText = await list.text()
      expect(listText).toContain(created.source.id)
      vi.restoreAllMocks()

      for (const key of [created.key, second]) {
        expect(listText).not.toContain(key)
        expect(output.join('\n')).not.toContain(key)
        // Ни в одной строке ни одной таблицы схемы public (служебная роль видит всё):
        // intake_source, audit_log, change_log, idempotency_record и остальные.
        const { rows } = await sql<{ table: string }>`
          select c.relname as table
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r'
        `.execute(h.owner)
        expect(rows.map((r) => r.table)).toEqual(
          expect.arrayContaining(['intake_source', 'audit_log', 'idempotency_record']),
        )
        for (const { table } of rows) {
          const found = await sql<{ n: number }>`
            select count(*)::int as n from ${sql.table(table)} t
            where t::text like ${`%${key}%`}
          `.execute(h.owner)
          expect(found.rows[0]?.n, table).toBe(0)
        }
      }
      // В базе — отпечаток SHA-256 нового ключа.
      const stored = await sql<{ key_hash: string }>`
        select key_hash from intake_source where id = ${created.source.id}
      `.execute(h.owner)
      expect(stored.rows[0]?.key_hash).toBe(createHash('sha256').update(second).digest('hex'))
    })

    it('роль приложения не читает отпечаток ключа и не меняет название и воронку', async () => {
      const { source } = await createSource()
      await expect(
        withProject(h.appDb, projectA, (trx) =>
          sql`select key_hash from intake_source`.execute(trx),
        ),
      ).rejects.toThrow(/permission denied/)
      await expect(
        withProject(h.appDb, projectA, (trx) =>
          sql`update intake_source set name = 'Інша назва' where id = ${source.id}`.execute(trx),
        ),
      ).rejects.toThrow(/permission denied/)
      await expect(
        withProject(h.appDb, projectA, (trx) =>
          sql`delete from intake_source where id = ${source.id}`.execute(trx),
        ),
      ).rejects.toThrow(/permission denied/)
    })
  })

  describe('проверка ключа', () => {
    it('верный ключ даёт источник; неизвестный, отключённый, старый после смены, ключ API и не ключ — одинаковое «нет» и одинаковый 401', async () => {
      const disabled = await createSource()
      expect((await post(admin, `/v1/intake-sources/${disabled.source.id}/disable`)).status).toBe(
        200,
      )
      const rotated = await createSource()
      const next = await post(admin, `/v1/intake-sources/${rotated.source.id}/reissue-key`)
      expect(next.status).toBe(200)
      const { key: newKey } = (await next.json()) as IntakeSourceWithKey

      expect(await intakeSourceByKey(h.appDb, newKey)).toEqual({
        id: rotated.source.id,
        projectId: projectA,
        pipelineId: pipelineA,
      })
      // Принятый ключ проходит проверку: неизвестный путь приёма — 404, а не 401.
      const passed = await intake(newKey, '/intake/unknown')
      expect(passed.status).toBe(404)
      expect(await problemOf(passed)).toEqual({ code: 'NOT_FOUND' })

      const { id: adminRole } = await h.owner
        .selectFrom('role')
        .select('id')
        .where('project_id', '=', projectA)
        .where('is_admin', '=', true)
        .executeTakeFirstOrThrow()
      const apiKey = await admin.api('POST', '/v1/api-keys', {
        project: projectA,
        body: { name: `Ключ API ${++counter}`, roleId: adminRole },
      })
      const { secret: apiSecret } = (await apiKey.json()) as ApiKeyWithSecret

      const refused = [
        `alpi_src_${'A'.repeat(43)}`,
        disabled.key,
        rotated.key,
        apiSecret,
        'not-a-key',
        '',
      ]
      const answers = []
      for (const key of refused) {
        expect(await intakeSourceByKey(h.appDb, key)).toBeNull()
        const res = await intake(key)
        answers.push({
          status: res.status,
          body: await res.text(),
          authenticate: res.headers.get('www-authenticate'),
          limit: res.headers.get('ratelimit-limit'),
        })
      }
      // Без заголовка Authorization — так же.
      const none = await intake(null)
      answers.push({
        status: none.status,
        body: await none.text(),
        authenticate: none.headers.get('www-authenticate'),
        limit: none.headers.get('ratelimit-limit'),
      })
      expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1)
      expect(answers[0]?.status).toBe(401)
      expect(answers[0]?.authenticate).toBe('Bearer')
      expect(answers[0]?.limit).toBeNull()
      expect(JSON.parse(answers[0]?.body ?? '{}')).toMatchObject({ code: 'INTAKE_KEY_INVALID' })

      // Включённый снова источник принимает свой ключ.
      expect((await post(admin, `/v1/intake-sources/${disabled.source.id}/enable`)).status).toBe(
        200,
      )
      expect(await intakeSourceByKey(h.appDb, disabled.key)).not.toBeNull()
    })

    it('ключ источника в запросе к /v1 — 401 API_KEY_INVALID; сессия на /intake не действует', async () => {
      const { key } = await createSource()
      const res = await bearerRequest(h.app, key, 'GET', '/v1/deals')
      expect(res.status).toBe(401)
      expect(await problemOf(res)).toEqual({ code: 'API_KEY_INVALID' })

      // Вошедший пользователь без ключа источника на /intake — 401.
      const bySession = await admin.api('POST', '/intake/registrations', {
        body: { event_id: 'session' },
      })
      expect(bySession.status).toBe(401)
      expect(await problemOf(bySession)).toEqual({ code: 'INTAKE_KEY_INVALID' })
    })

    it('last_used_at обновляется при принятом запросе, но не чаще раза в минуту', async () => {
      const { source, key } = await createSource()
      const lastUsed = async () =>
        (
          await h.owner
            .selectFrom('intake_source')
            .select('last_used_at')
            .where('id', '=', source.id)
            .executeTakeFirstOrThrow()
        ).last_used_at
      expect(await lastUsed()).toBeNull()
      await intake(key)
      const first = await lastUsed()
      expect(first).not.toBeNull()
      await intake(key)
      expect(await lastUsed()).toEqual(first)

      const list = await admin.api('GET', '/v1/intake-sources', { project: projectA })
      const summary = ((await list.json()) as IntakeSourceSummary[]).find((s) => s.id === source.id)
      expect(summary?.lastUsedAt).toBe(first?.toISOString())
    })
  })

  describe('лимит запросов', () => {
    it('сверх лимита в минуту — 429 с Retry-After; счётчик свой у каждого источника и не общий с ключами API', async () => {
      let now = 1_000_000
      const app = createApp({ auth: h.auth, db: h.appDb, rateLimit: { limit: 2, now: () => now } })
      const busy = await createSource()
      const quiet = await createSource()
      const send = (key: string) =>
        bearerRequest(app, key, 'POST', '/intake/unknown', { event_id: `l-${++counter}` })

      const firstAnswer = await send(busy.key)
      expect(firstAnswer.status).toBe(404)
      expect(firstAnswer.headers.get('ratelimit-limit')).toBe('2')
      expect(firstAnswer.headers.get('ratelimit-remaining')).toBe('1')
      expect((await send(busy.key)).status).toBe(404)
      const limited = await send(busy.key)
      expect(limited.status).toBe(429)
      expect(limited.headers.get('retry-after')).toBe('60')
      expect(await problemOf(limited)).toEqual({ code: 'RATE_LIMITED' })

      // Другой источник того же проекта — свой счётчик.
      expect((await send(quiet.key)).status).toBe(404)

      // Новая минута — снова принимается.
      now += 60_000
      expect((await send(busy.key)).status).toBe(404)
    })

    it('по умолчанию — 600 запросов в минуту на источник', async () => {
      const now = 5_000_000
      const app = createApp({ auth: h.auth, db: h.appDb, rateLimit: { now: () => now } })
      const { key } = await createSource()
      const res = await bearerRequest(app, key, 'POST', '/intake/registrations', {})
      expect(res.headers.get('ratelimit-limit')).toBe('600')
    })
  })

  describe('автор-источник', () => {
    it('строка change_log с автором-источником проходит; с двумя авторами сразу и с источником другого проекта — отклонена базой', async () => {
      const { source } = await createSource()
      const { source: sourceB } = await createSource({ project: projectB, pipeline: pipelineB })
      const { id: contactId } = await h.owner
        .insertInto('contact')
        .values({ project_id: projectA, first_name: 'Вигадана' })
        .returning('id')
        .executeTakeFirstOrThrow()

      await withProject(h.appDb, projectA, (trx) =>
        recordChanges(
          { db: trx, projectId: projectA, actorId: null, actorIntakeSourceId: source.id },
          { type: 'contact', id: contactId },
          [{ field: 'firstName', before: null, after: 'Вигадана' }],
        ),
      )
      const rows = await h.owner
        .selectFrom('change_log')
        .select(['actor_id', 'actor_api_key_id', 'actor_intake_source_id'])
        .where('entity_id', '=', contactId)
        .execute()
      expect(rows).toEqual([
        { actor_id: null, actor_api_key_id: null, actor_intake_source_id: source.id },
      ])

      const row = {
        project_id: projectA,
        entity_type: 'contact',
        entity_id: contactId,
        field: 'firstName',
        before: null,
        after: null,
      }
      await expect(
        h.owner
          .insertInto('change_log')
          .values({ ...row, actor_id: admin.id, actor_intake_source_id: source.id })
          .execute(),
      ).rejects.toThrow(/change_log_one_actor/)
      await expect(
        h.owner
          .insertInto('change_log')
          .values({ ...row, actor_intake_source_id: sourceB.id })
          .execute(),
      ).rejects.toThrow(/change_log_actor_intake_source_fkey/)
    })

    it('событие с actor.type = "intake_source" проходит схему каталога и пишется с этим автором', async () => {
      const { source } = await createSource()
      const body = {
        type: 'contact.created',
        timestamp: new Date().toISOString(),
        data: {
          event_id: `evt_${randomUUID()}`,
          project_id: projectA,
          contact_id: randomUUID(),
          actor: { type: 'intake_source', id: source.id },
        },
      }
      expect(eventBodyProblem(body)).toBeNull()
      expect(
        eventBodyProblem({
          ...body,
          data: { ...body.data, actor: { type: 'robot', id: source.id } },
        }),
      ).toMatch(/data\.actor\.type/)
      expect(
        eventBodyProblem({
          ...body,
          data: { ...body.data, actor: { type: 'intake_source', id: 'not-uuid' } },
        }),
      ).toMatch(/data\.actor\.id/)

      const contactId = randomUUID()
      const eventId = await withProject(h.appDb, projectA, (trx) =>
        emitEvent(
          { db: trx, projectId: projectA, actorId: null, actorIntakeSourceId: source.id },
          'contact.created',
          { contact_id: contactId },
        ),
      )
      const stored = await h.owner
        .selectFrom('webhook_event')
        .select(['actor_type', 'actor_id', 'body'])
        .where('id', '=', eventId)
        .executeTakeFirstOrThrow()
      expect(stored.actor_type).toBe('intake_source')
      expect(stored.actor_id).toBe(source.id)
      expect(stored.body).toMatchObject({
        data: { contact_id: contactId, actor: { type: 'intake_source', id: source.id } },
      })
    })
  })

  describe('журнал проекта', () => {
    it('создание, смена ключа, отключение и включение — в журнале, автор — пользователь, без ключа', async () => {
      const { source, key } = await createSource({ name: 'Під журнал' })
      const reissued = await post(admin, `/v1/intake-sources/${source.id}/reissue-key`)
      const { key: second } = (await reissued.json()) as IntakeSourceWithKey
      await post(admin, `/v1/intake-sources/${source.id}/disable`)
      await post(admin, `/v1/intake-sources/${source.id}/enable`)

      const rows = await h.owner
        .selectFrom('audit_log')
        .select(['project_id', 'action', 'actor_id', 'actor_api_key_id', 'entity_type', 'details'])
        .where('entity_id', '=', source.id)
        .orderBy('occurred_at')
        .orderBy('id')
        .execute()
      expect(rows.map((r) => [r.project_id, r.action, r.actor_id, r.entity_type])).toEqual([
        [projectA, 'intake_source.created', admin.id, 'intake_source'],
        [projectA, 'intake_source.key_reissued', admin.id, 'intake_source'],
        [projectA, 'intake_source.disabled', admin.id, 'intake_source'],
        [projectA, 'intake_source.enabled', admin.id, 'intake_source'],
      ])
      expect(rows[0]?.details).toEqual({
        name: 'Під журнал',
        pipeline: { id: pipelineA, name: expect.any(String) },
      })
      const text = JSON.stringify(rows)
      expect(text).not.toContain(key.slice(12))
      expect(text).not.toContain(second.slice(12))

      // Экран журнала проекта отдаёт эти записи.
      const page = await admin.api('GET', '/audit?action=intake_source.disabled', {
        project: projectA,
      })
      expect(page.status).toBe(200)
      expect(await page.text()).toContain(source.id)
    })
  })

  describe('создание и состояние', () => {
    it('название обязательно, до 100 символов и уникально в проекте без учёта регистра; воронка — не архивная', async () => {
      const create = (body: Record<string, unknown>) =>
        post(admin, '/v1/intake-sources', { pipelineId: pipelineA, ...body })
      const invalid = async (res: Response, path: string) => {
        expect(res.status).toBe(400)
        expect(await problemOf(res)).toMatchObject({
          code: 'INVALID_INTAKE_SOURCE',
          details: { path },
        })
      }
      await invalid(await create({ name: '   ' }), 'name')
      await invalid(await create({ name: 'я'.repeat(101) }), 'name')
      await invalid(await create({ name: 'Ок', pipelineId: 'not-uuid' }), 'pipelineId')
      await invalid(await create({ name: 'Ок', key: 'свій ключ' }), 'key')

      const name = `Унікальне ${++counter}`
      expect((await create({ name: 'я'.repeat(100) })).status).toBe(201)
      expect((await create({ name })).status).toBe(201)
      const taken = await create({ name: name.toUpperCase() })
      expect(taken.status).toBe(409)
      expect(await problemOf(taken)).toEqual({ code: 'INTAKE_SOURCE_NAME_TAKEN' })
      // То же название в другом проекте — можно.
      expect(
        (await createSource({ project: projectB, pipeline: pipelineB, name })).source.name,
      ).toBe(name)

      const archived = await createPipeline(projectA)
      await h.owner
        .updateTable('pipeline')
        .set({ archived_at: new Date() })
        .where('id', '=', archived)
        .execute()
      const toArchived = await create({ name: `Архів ${++counter}`, pipelineId: archived })
      expect(toArchived.status).toBe(422)
      expect(await problemOf(toArchived)).toEqual({ code: 'PIPELINE_NOT_FOUND' })
    })

    it('отключить отключённый и включить включённый — 409; неизвестный источник — 404; список показывает состояние', async () => {
      const { source } = await createSource()
      const enabledAgain = await post(admin, `/v1/intake-sources/${source.id}/enable`)
      expect(enabledAgain.status).toBe(409)
      expect(await problemOf(enabledAgain)).toEqual({ code: 'INTAKE_SOURCE_ENABLED' })

      const disabled = await post(admin, `/v1/intake-sources/${source.id}/disable`)
      expect(disabled.status).toBe(200)
      const summary = (await disabled.json()) as IntakeSourceSummary
      expect(summary.disabledAt).not.toBeNull()
      expect(summary.disabledBy?.id).toBe(admin.id)
      const twice = await post(admin, `/v1/intake-sources/${source.id}/disable`)
      expect(twice.status).toBe(409)
      expect(await problemOf(twice)).toEqual({ code: 'INTAKE_SOURCE_DISABLED' })

      for (const id of [randomUUID(), 'not-uuid']) {
        const res = await post(admin, `/v1/intake-sources/${id}/disable`)
        expect(res.status).toBe(404)
        expect(await problemOf(res)).toEqual({ code: 'INTAKE_SOURCE_NOT_FOUND' })
      }

      const list = await admin.api('GET', '/v1/intake-sources', { project: projectA })
      const item = ((await list.json()) as IntakeSourceSummary[]).find((s) => s.id === source.id)
      expect(item).toMatchObject({
        name: source.name,
        pipeline: { id: pipelineA },
        keyPrefix: source.keyPrefix,
        createdBy: { id: admin.id },
        disabledBy: { id: admin.id },
      })

      const enabled = await post(admin, `/v1/intake-sources/${source.id}/enable`)
      expect(enabled.status).toBe(200)
      expect(((await enabled.json()) as IntakeSourceSummary).disabledAt).toBeNull()
    })
  })
})
