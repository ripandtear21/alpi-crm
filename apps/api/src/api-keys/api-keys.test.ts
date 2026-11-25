import { createHash, randomInt } from 'node:crypto'
import { withProject } from '@alpi/db'
import {
  API_KEY_SECRET_PATTERN,
  type ApiKeySummary,
  type ApiKeyWithSecret,
  type AuditPage,
  fullPermissions,
  PROJECT_HEADER,
  type ProjectAuditAction,
  ROLE_TEMPLATES,
  type RolePermissions,
} from '@alpi/shared'
import { Hono } from 'hono'
import { sql } from 'kysely'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { recordInRequest } from '../audit/record.ts'
import { recordChanges } from '../change-log/record.ts'
import { apiKeyAuth, apiKeyRoute } from '../middleware/api-key.ts'
import { type PermissionsEnv, requirePermission } from '../middleware/permissions.ts'
import { projectContext } from '../middleware/project-context.ts'
import {
  type ApiHarness,
  type Method,
  ORIGIN,
  type SignedInUser,
  startApiHarness,
} from '../testing/api-harness.ts'
import { problemOf } from '../testing/problem.ts'
import { requestAuthor } from './actor.ts'

// Ключи API (тикет crm-api/01) на настоящем PostgreSQL, API ходит ролью приложения: изоляция
// проектов, права на управление ключами, секрет только в ответе, запрос по ключу с правами и
// охватом роли, одинаковый 401, закрытые для ключа маршруты, журналы, защита роли с ключом.
// Названия и имена — выдуманные.

const MANAGER = ROLE_TEMPLATES.find((t) => t.key === 'manager')?.permissions as RolePermissions

function permissions(change: (p: RolePermissions) => void): RolePermissions {
  const p = structuredClone(MANAGER)
  change(p)
  return p
}

describe('ключи API', () => {
  let h: ApiHarness
  let admin: SignedInUser
  let projectA: string
  let projectB: string
  /** Сделки проекта A: с ответственным (админ) и в общей очереди; сделка проекта B. */
  let dealOwnedA: string
  let dealQueueA: string
  let dealB: string
  let counter = 0

  /** Запрос по ключу: только заголовок Authorization, без cookie. */
  function keyRequest(
    secret: string,
    method: Method,
    path: string,
    options: { project?: string; body?: unknown; authorization?: string } = {},
  ) {
    const headers = new Headers({
      origin: ORIGIN,
      authorization: options.authorization ?? `Bearer ${secret}`,
    })
    if (options.project !== undefined) headers.set(PROJECT_HEADER, options.project)
    if (options.body !== undefined) headers.set('content-type', 'application/json')
    return h.app.request(`${ORIGIN}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
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

  async function templateRole(projectId: string, key: string): Promise<string> {
    const { id } = await h.owner
      .selectFrom('role')
      .select('id')
      .where('project_id', '=', projectId)
      .where('template_key', '=', key)
      .executeTakeFirstOrThrow()
    return id
  }

  /** Участник проекта A с ролью `roleId`. */
  async function memberWithRole(roleId: string): Promise<SignedInUser> {
    const user = await h.signIn()
    await h.owner
      .insertInto('project_member')
      .values({ project_id: projectA, user_id: user.id, role_id: roleId })
      .execute()
    return user
  }

  async function createKey(
    roleId: string,
    options: { project?: string; name?: string; expiresAt?: string } = {},
  ): Promise<ApiKeyWithSecret> {
    const res = await admin.api('POST', '/v1/api-keys', {
      project: options.project ?? projectA,
      body: {
        name: options.name ?? `Автоматизація ${++counter}`,
        roleId,
        ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
      },
    })
    expect(res.status).toBe(201)
    return (await res.json()) as ApiKeyWithSecret
  }

  async function createDeal(projectId: string, ownerId: string | null): Promise<string> {
    const n = ++counter
    const pipeline = await h.owner
      .insertInto('pipeline')
      .values({ project_id: projectId, code: `k${n}`, name: `Воронка ${n}`, position: n })
      .returning('id')
      .executeTakeFirstOrThrow()
    const stage = await h.owner
      .insertInto('stage')
      .values({ project_id: projectId, pipeline_id: pipeline.id, name: 'Новий', position: 1 })
      .returning('id')
      .executeTakeFirstOrThrow()
    const contact = await h.owner
      .insertInto('contact')
      .values({ project_id: projectId, first_name: `Клієнт ${n}` })
      .returning('id')
      .executeTakeFirstOrThrow()
    const deal = await h.owner
      .insertInto('deal')
      .values({
        project_id: projectId,
        title: `Угода ${n}`,
        pipeline_id: pipeline.id,
        stage_id: stage.id,
        primary_contact_id: contact.id,
        owner_id: ownerId,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return deal.id
  }

  async function dealIds(res: Response): Promise<string[]> {
    expect(res.status).toBe(200)
    const page = (await res.json()) as { data: { id: string }[] }
    return page.data.map((d) => d.id).sort()
  }

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_api_keys')
    admin = await h.signIn('owner')
    projectA = (await h.createProject(admin, 'Проєкт А')).id
    projectB = (await h.createProject(admin, 'Проєкт Б')).id
    dealOwnedA = await createDeal(projectA, admin.id)
    dealQueueA = await createDeal(projectA, null)
    dealB = await createDeal(projectB, admin.id)
  })

  afterAll(async () => {
    await h?.stop()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('изоляция проектов', () => {
    it('ключи проекта A не видны в контексте B — ни через API, ни запросом без фильтра', async () => {
      const head = await templateRole(projectA, 'head')
      const { key } = await createKey(head)

      const listB = await admin.api('GET', '/v1/api-keys', { project: projectB })
      expect(listB.status).toBe(200)
      expect(((await listB.json()) as ApiKeySummary[]).map((k) => k.id)).not.toContain(key.id)

      const rowsB = await withProject(h.appDb, projectB, (trx) =>
        trx.selectFrom('api_key').select(['id', 'project_id']).execute(),
      )
      expect(rowsB.every((r) => r.project_id === projectB)).toBe(true)
      expect(rowsB.map((r) => r.id)).not.toContain(key.id)
      // Без выставленного проекта — ни одной строки.
      expect(await h.appDb.selectFrom('api_key').select('id').execute()).toEqual([])
    })

    it('ключ проекта A с X-Project-Id проекта B — 403 PROJECT_FORBIDDEN, данных B в ответе нет', async () => {
      const { secret } = await createKey(await templateRole(projectA, 'head'))
      const res = await keyRequest(secret, 'GET', '/v1/deals', { project: projectB })
      expect(res.status).toBe(403)
      expect(await problemOf(res)).toEqual({ code: 'PROJECT_FORBIDDEN' })

      // Тот же ключ без заголовка и с заголовком своего проекта — сделки только A.
      const own = await dealIds(await keyRequest(secret, 'GET', '/v1/deals'))
      expect(own).toEqual([dealOwnedA, dealQueueA].sort())
      expect(own).not.toContain(dealB)
      expect(
        await dealIds(await keyRequest(secret, 'GET', '/v1/deals', { project: projectA })),
      ).toEqual(own)
    })

    it('ключ нельзя выдать с ролью чужого проекта', async () => {
      const res = await admin.api('POST', '/v1/api-keys', {
        project: projectA,
        body: { name: 'Чужа роль', roleId: await templateRole(projectB, 'head') },
      })
      expect(res.status).toBe(422)
      expect(await problemOf(res)).toEqual({ code: 'ROLE_NOT_FOUND' })
    })
  })

  describe('права на управление ключами', () => {
    it('без integrations или без users_roles: edit — создание, перевыпуск и отзыв 403; список без integrations: view — 403', async () => {
      const head = await templateRole(projectA, 'head')
      const target = await createKey(head)

      const noIntegrations = await memberWithRole(
        await createRole(
          projectA,
          permissions((p) => {
            p.actions.users_roles = ['view', 'create', 'edit', 'delete']
          }),
        ),
      )
      const noUsersRoles = await memberWithRole(
        await createRole(
          projectA,
          permissions((p) => {
            p.actions.integrations = ['view', 'create', 'edit', 'delete']
            p.actions.users_roles = ['view']
          }),
        ),
      )
      for (const user of [noIntegrations, noUsersRoles]) {
        const create = await user.api('POST', '/v1/api-keys', {
          project: projectA,
          body: { name: `Спроба ${++counter}`, roleId: head },
        })
        expect(create.status).toBe(403)
        for (const action of ['reissue', 'revoke']) {
          const res = await user.api('POST', `/v1/api-keys/${target.key.id}/${action}`, {
            project: projectA,
          })
          expect(res.status).toBe(403)
          expect(await problemOf(res)).toEqual({ code: 'PERMISSION_DENIED' })
        }
      }
      const list = await noIntegrations.api('GET', '/v1/api-keys', { project: projectA })
      expect(list.status).toBe(403)
      // С integrations: view список виден.
      expect((await noUsersRoles.api('GET', '/v1/api-keys', { project: projectA })).status).toBe(
        200,
      )
      // Ключ цел: старый секрет работает.
      expect((await keyRequest(target.secret, 'GET', '/v1/deals')).status).toBe(200)
    })

    it('не-администратор не выдаёт ключу роль администратора и роль шире своей', async () => {
      const keeperPerms = permissions((p) => {
        p.actions.integrations = ['view', 'create', 'edit', 'delete']
        p.actions.users_roles = ['view', 'edit']
      })
      const keeper = await memberWithRole(await createRole(projectA, keeperPerms))
      const tryCreate = async (roleId: string) =>
        keeper.api('POST', '/v1/api-keys', {
          project: projectA,
          body: { name: `Ключ ${++counter}`, roleId },
        })

      const asAdmin = await tryCreate(await templateRole(projectA, 'admin'))
      expect(asAdmin.status).toBe(403)
      expect(await problemOf(asAdmin)).toEqual({ code: 'ADMIN_ONLY' })
      const wider = await tryCreate(await templateRole(projectA, 'head'))
      expect(wider.status).toBe(403)
      expect(await problemOf(wider)).toEqual({ code: 'EXCEEDS_OWN_PERMISSIONS' })
      expect((await tryCreate(await createRole(projectA, keeperPerms))).status).toBe(201)

      // Перевыпустить и отозвать ключ с ролью шире своей тоже нельзя.
      const strong = await createKey(await templateRole(projectA, 'head'))
      for (const action of ['reissue', 'revoke']) {
        const res = await keeper.api('POST', `/v1/api-keys/${strong.key.id}/${action}`, {
          project: projectA,
        })
        expect(res.status).toBe(403)
      }
    })
  })

  describe('секрет', () => {
    it('показывается только в ответе на создание; в списке, базе, журнале и логах его нет', async () => {
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

      const created = await createKey(await templateRole(projectA, 'head'), { name: 'Секретний' })
      expect(created.secret).toMatch(API_KEY_SECRET_PATTERN)
      expect(created.key.secretPrefix).toBe(created.secret.slice(0, 8))
      expect(JSON.stringify(created.key)).not.toContain(created.secret)

      // Запросы по ключу, в том числе неудачные, и перевыпуск.
      expect((await keyRequest(created.secret, 'GET', '/v1/deals')).status).toBe(200)
      expect((await keyRequest(created.secret, 'GET', '/v1/roles')).status).toBe(403)
      const reissued = await admin.api('POST', `/v1/api-keys/${created.key.id}/reissue`, {
        project: projectA,
      })
      const { secret: second } = (await reissued.json()) as ApiKeyWithSecret
      expect((await keyRequest(created.secret, 'GET', '/v1/deals')).status).toBe(401)

      const list = await admin.api('GET', '/v1/api-keys', { project: projectA })
      const listText = await list.text()
      vi.restoreAllMocks()

      for (const secret of [created.secret, second]) {
        expect(listText).not.toContain(secret)
        expect(output.join('\n')).not.toContain(secret)
        // Ни в одной строке ни одной таблицы схемы public (служебная роль видит всё).
        const { rows } = await sql<{ table: string }>`
          select c.relname as table
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r'
        `.execute(h.owner)
        for (const { table } of rows) {
          const found = await sql<{ n: number }>`
            select count(*)::int as n from ${sql.table(table)} t
            where t::text like ${`%${secret}%`}
          `.execute(h.owner)
          expect(found.rows[0]?.n, table).toBe(0)
        }
      }
      // В базе — отпечаток SHA-256 нового секрета.
      const stored = await sql<{ secret_hash: string }>`
        select secret_hash from api_key where id = ${created.key.id}
      `.execute(h.owner)
      expect(stored.rows[0]?.secret_hash).toBe(createHash('sha256').update(second).digest('hex'))
    })

    it('роль приложения не читает отпечаток секрета', async () => {
      await expect(
        withProject(h.appDb, projectA, (trx) => sql`select secret_hash from api_key`.execute(trx)),
      ).rejects.toThrow(/permission denied/)
    })
  })

  describe('запрос по ключу', () => {
    it('роль без «сделки: смотреть» — 403; с правом — 200 и только сделки своего проекта', async () => {
      const blind = await createRole(
        projectA,
        permissions((p) => {
          p.actions.deals = []
        }),
      )
      const { secret: blindSecret } = await createKey(blind)
      const denied = await keyRequest(blindSecret, 'GET', '/v1/deals')
      expect(denied.status).toBe(403)
      expect(await problemOf(denied)).toEqual({ code: 'PERMISSION_DENIED' })

      const { secret } = await createKey(await templateRole(projectA, 'head'))
      expect(await dealIds(await keyRequest(secret, 'GET', '/v1/deals'))).toEqual(
        [dealOwnedA, dealQueueA].sort(),
      )
    })

    it('охват «свои» и «команда» — только сделки общей очереди', async () => {
      for (const scope of ['own', 'team'] as const) {
        const role = await createRole(
          projectA,
          permissions((p) => {
            p.scopes.deals = { read: scope, write: scope }
          }),
        )
        const { secret } = await createKey(role)
        expect(await dealIds(await keyRequest(secret, 'GET', '/v1/deals'))).toEqual([dealQueueA])
        // «Я» у ключа нет: фильтр owner=me — ошибка, а не общая очередь.
        expect((await keyRequest(secret, 'GET', '/v1/deals?owner=me')).status).toBe(400)
      }
    })

    it('смена прав роли действует на следующий запрос', async () => {
      const perms = permissions(() => {})
      const role = await createRole(projectA, perms)
      const { secret } = await createKey(role)
      expect((await keyRequest(secret, 'GET', '/v1/deals')).status).toBe(200)

      perms.actions.deals = []
      await h.owner
        .updateTable('role')
        .set({ permissions: JSON.stringify(perms) })
        .where('id', '=', role)
        .execute()
      expect((await keyRequest(secret, 'GET', '/v1/deals')).status).toBe(403)
    })

    it('запрос ключа не читает cookie сессии: права — только роли ключа', async () => {
      const blind = await createRole(
        projectA,
        permissions((p) => {
          p.actions.deals = []
        }),
      )
      const { secret } = await createKey(blind)
      // Браузер администратора (с его cookie) шлёт запрос с ключом без прав на сделки.
      const res = await admin.call(
        {
          request: (input, init) => {
            const headers = new Headers(init.headers)
            headers.set('authorization', `Bearer ${secret}`)
            return h.app.request(input, { ...init, headers })
          },
        },
        'GET',
        '/v1/deals',
      )
      expect(res.status).toBe(403)
      expect(await problemOf(res)).toEqual({ code: 'PERMISSION_DENIED' })
    })

    it('last_used_at обновляется, но не чаще раза в минуту', async () => {
      const { key, secret } = await createKey(await templateRole(projectA, 'head'))
      expect(key.lastUsedAt).toBeNull()
      const lastUsed = () =>
        h.owner
          .selectFrom('api_key')
          .select('last_used_at')
          .where('id', '=', key.id)
          .executeTakeFirstOrThrow()
          .then((r) => r.last_used_at?.getTime() ?? null)

      await keyRequest(secret, 'GET', '/v1/deals')
      const first = await lastUsed()
      expect(first).not.toBeNull()
      await keyRequest(secret, 'GET', '/v1/deals')
      expect(await lastUsed()).toBe(first)

      await h.owner
        .updateTable('api_key')
        .set({ last_used_at: sql`now() - interval '2 minutes'` })
        .where('id', '=', key.id)
        .execute()
      const stale = await lastUsed()
      await keyRequest(secret, 'GET', '/v1/deals')
      expect(await lastUsed()).toBeGreaterThan(stale ?? 0)
    })
  })

  describe('401 одинаковый', () => {
    it('неизвестный, отозванный, истёкший ключ и старый секрет после перевыпуска', async () => {
      const head = await templateRole(projectA, 'head')
      const revoked = await createKey(head)
      expect(
        (await admin.api('POST', `/v1/api-keys/${revoked.key.id}/revoke`, { project: projectA }))
          .status,
      ).toBe(200)

      const expired = await createKey(head, {
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      await h.owner
        .updateTable('api_key')
        .set({ expires_at: sql`now() - interval '1 second'` })
        .where('id', '=', expired.key.id)
        .execute()

      const reissued = await createKey(head)
      const next = await admin.api('POST', `/v1/api-keys/${reissued.key.id}/reissue`, {
        project: projectA,
      })
      expect(next.status).toBe(200)
      const { secret: newSecret } = (await next.json()) as ApiKeyWithSecret
      expect(newSecret).not.toBe(reissued.secret)
      expect((await keyRequest(newSecret, 'GET', '/v1/deals')).status).toBe(200)

      const unknown = `alpi_${'A'.repeat(43)}`
      const answers = []
      for (const secret of [
        unknown,
        revoked.secret,
        expired.secret,
        reissued.secret,
        'not-a-key',
      ]) {
        const res = await keyRequest(secret, 'GET', '/v1/deals')
        answers.push({
          status: res.status,
          body: await res.text(),
          challenge: res.headers.get('www-authenticate'),
        })
      }
      expect(answers[0]).toEqual({
        status: 401,
        body: JSON.stringify({
          type: 'about:blank',
          title: 'Unauthorized',
          status: 401,
          code: 'API_KEY_INVALID',
        }),
        challenge: 'Bearer',
      })
      for (const answer of answers) expect(answer).toEqual(answers[0])
    })

    it('отозванный ключ не перевыпустить и не отозвать снова; отзыв в базе окончателен', async () => {
      const { key } = await createKey(await templateRole(projectA, 'head'))
      expect(
        (await admin.api('POST', `/v1/api-keys/${key.id}/revoke`, { project: projectA })).status,
      ).toBe(200)
      for (const action of ['reissue', 'revoke']) {
        const res = await admin.api('POST', `/v1/api-keys/${key.id}/${action}`, {
          project: projectA,
        })
        expect(res.status).toBe(409)
        expect(await problemOf(res)).toEqual({ code: 'API_KEY_REVOKED' })
      }
      await expect(
        withProject(h.appDb, projectA, (trx) =>
          trx
            .updateTable('api_key')
            .set({ revoked_at: null, revoked_by: null })
            .where('id', '=', key.id)
            .execute(),
        ),
      ).rejects.toThrow(/отозванный ключ API не меняется/)
    })
  })

  describe('маршруты без отметки «доступно ключу»', () => {
    it('ключ с ролью администратора — 403 API_KEY_NOT_ALLOWED на ключах, ролях, участниках и журнале', async () => {
      const { key, secret } = await createKey(await templateRole(projectA, 'admin'))
      const routes: [Method, string, unknown?][] = [
        ['GET', '/v1/api-keys'],
        ['POST', '/v1/api-keys', { name: 'Від ключа', roleId: key.role?.id }],
        ['POST', `/v1/api-keys/${key.id}/reissue`],
        ['POST', `/v1/api-keys/${key.id}/revoke`],
        ['GET', '/roles'],
        ['POST', '/roles', { name: 'Від ключа', permissions: fullPermissions() }],
        ['GET', '/members'],
        ['GET', '/audit'],
        ['GET', '/me'],
        ['GET', '/projects'],
        ['GET', '/v1/deals/count'],
        ['GET', `/v1/deals/${dealOwnedA}`],
        ['GET', '/v1/no-such-route'],
      ]
      for (const [method, path, body] of routes) {
        const res = await keyRequest(secret, method, path, { body })
        expect([path, res.status, await problemOf(res)]).toEqual([
          path,
          403,
          { code: 'API_KEY_NOT_ALLOWED' },
        ])
      }
      const keys = await h.owner
        .selectFrom('api_key')
        .select('id')
        .where('project_id', '=', projectA)
        .where('name', '=', 'Від ключа')
        .execute()
      expect(keys).toEqual([])
    })
  })

  describe('журнал', () => {
    it('изменение по ключу пишет автора-ключ в change_log и audit_log; экран журнала показывает ключ', async () => {
      const { key, secret } = await createKey(await templateRole(projectA, 'head'), {
        name: 'Робот журналу',
      })
      // Изменяющий маршрут, открытый ключу, — проверочный, как будут открывать тикеты 03 и 04.
      const probe = new Hono<PermissionsEnv>()
        .use('*', apiKeyAuth(h.appDb, h.auth))
        .use('*', projectContext(h.appDb))
        .post('/probe', apiKeyRoute, requirePermission('deals', 'edit'), async (c) => {
          await recordChanges(
            { db: c.var.db, projectId: c.var.projectId, ...requestAuthor(c.var.actor) },
            { type: 'deal', id: dealQueueA },
            [{ field: 'title', before: 'Було', after: 'Стало' }],
          )
          await recordInRequest(c, {
            action: 'role.updated',
            entity: { type: 'deal', id: dealQueueA },
          })
          return c.json({ ok: true })
        })
      const res = await probe.request(`${ORIGIN}/probe`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}` },
      })
      expect(res.status).toBe(200)

      const changes = await h.owner
        .selectFrom('change_log')
        .select(['actor_id', 'actor_api_key_id', 'field'])
        .where('entity_id', '=', dealQueueA)
        .execute()
      expect(changes).toEqual([{ actor_id: null, actor_api_key_id: key.id, field: 'title' }])

      const audit = await h.owner
        .selectFrom('audit_log')
        .select(['action', 'actor_id', 'actor_api_key_id', 'details'])
        .where('actor_api_key_id', '=', key.id)
        .orderBy('action')
        .execute()
      expect(audit).toEqual([
        {
          action: 'api_key.request',
          actor_id: null,
          actor_api_key_id: key.id,
          details: { method: 'POST', path: '/probe', status: 200 },
        },
        { action: 'role.updated', actor_id: null, actor_api_key_id: key.id, details: {} },
      ])

      const page = await admin.api('GET', '/audit?action=api_key.request', { project: projectA })
      const entries = ((await page.json()) as AuditPage<ProjectAuditAction>).items
      expect(entries[0]).toMatchObject({
        action: 'api_key.request',
        actor: null,
        apiKey: { id: key.id, name: 'Робот журналу' },
      })
    })

    it('создание, перевыпуск и отзыв ключа — в журнале опасных действий, без секрета', async () => {
      const { key, secret } = await createKey(await templateRole(projectA, 'head'), {
        name: 'Під журнал',
      })
      await admin.api('POST', `/v1/api-keys/${key.id}/reissue`, { project: projectA })
      await admin.api('POST', `/v1/api-keys/${key.id}/revoke`, { project: projectA })
      const rows = await h.owner
        .selectFrom('audit_log')
        .select(['action', 'actor_id', 'actor_api_key_id', 'entity_type', 'details'])
        .where('entity_id', '=', key.id)
        .where('action', 'like', 'api_key.%')
        .orderBy('occurred_at')
        .execute()
      expect(rows.map((r) => [r.action, r.actor_id, r.actor_api_key_id, r.entity_type])).toEqual([
        ['api_key.created', admin.id, null, 'api_key'],
        ['api_key.reissued', admin.id, null, 'api_key'],
        ['api_key.revoked', admin.id, null, 'api_key'],
      ])
      expect(rows[0]?.details).toMatchObject({ name: 'Під журнал', role: { id: key.role?.id } })
      expect(JSON.stringify(rows)).not.toContain(secret.slice(5))
    })

    it('база отклоняет строку журнала с автором-пользователем и автором-ключом сразу', async () => {
      const { key } = await createKey(await templateRole(projectA, 'head'))
      await expect(
        h.owner
          .insertInto('audit_log')
          .values({
            project_id: projectA,
            action: 'role.updated',
            actor_id: admin.id,
            actor_api_key_id: key.id,
          })
          .execute(),
      ).rejects.toThrow(/audit_log_one_actor/)
      await expect(
        h.owner
          .insertInto('change_log')
          .values({
            project_id: projectA,
            actor_id: admin.id,
            actor_api_key_id: key.id,
            entity_type: 'deal',
            entity_id: dealQueueA,
            field: 'title',
            before: null,
            after: null,
          })
          .execute(),
      ).rejects.toThrow(/change_log_one_actor/)
      // Ключ другого проекта автором быть не может.
      await expect(
        h.owner
          .insertInto('audit_log')
          .values({ project_id: projectB, action: 'role.updated', actor_api_key_id: key.id })
          .execute(),
      ).rejects.toThrow(/audit_log_actor_api_key_fkey/)
    })
  })

  describe('роль с ключом', () => {
    it('роль с действующим ключом удалить нельзя (409); после отзыва — можно', async () => {
      const role = await createRole(projectA, MANAGER)
      const { key } = await createKey(role)
      const blocked = await admin.api('DELETE', `/roles/${role}`, { project: projectA })
      expect(blocked.status).toBe(409)
      expect(await blocked.json()).toEqual({ code: 'ROLE_IN_USE' })

      await admin.api('POST', `/v1/api-keys/${key.id}/revoke`, { project: projectA })
      const deleted = await admin.api('DELETE', `/roles/${role}`, { project: projectA })
      expect(deleted.status).toBeLessThan(300)
      const list = (await (
        await admin.api('GET', '/v1/api-keys', { project: projectA })
      ).json()) as ApiKeySummary[]
      expect(list.find((k) => k.id === key.id)).toMatchObject({ role: null })
      expect(list.find((k) => k.id === key.id)?.revokedAt).not.toBeNull()
    })
  })

  describe('создание', () => {
    it('название обязательно, до 100 символов и уникально среди неотозванных ключей', async () => {
      const head = await templateRole(projectA, 'head')
      const post = (body: unknown) => admin.api('POST', '/v1/api-keys', { project: projectA, body })
      expect((await post({ name: ' ', roleId: head })).status).toBe(400)
      expect((await post({ name: 'x'.repeat(101), roleId: head })).status).toBe(400)
      expect((await post({ name: 'Ок', roleId: head, secret: 'свій' })).status).toBe(400)
      expect(
        (await post({ name: 'Ок', roleId: head, expiresAt: '2000-01-01T00:00:00Z' })).status,
      ).toBe(400)

      const name = `Унікальний ${randomInt(1e9)}`
      const first = await post({ name, roleId: head })
      expect(first.status).toBe(201)
      const again = await post({ name: name.toUpperCase(), roleId: head })
      expect(again.status).toBe(409)
      expect(await problemOf(again)).toEqual({ code: 'API_KEY_NAME_TAKEN' })
      // Тот же проект B — своё пространство имён.
      expect(
        (
          await admin.api('POST', '/v1/api-keys', {
            project: projectB,
            body: { name, roleId: await templateRole(projectB, 'head') },
          })
        ).status,
      ).toBe(201)
      const { key } = (await first.json()) as ApiKeyWithSecret
      await admin.api('POST', `/v1/api-keys/${key.id}/revoke`, { project: projectA })
      expect((await post({ name, roleId: head })).status).toBe(201)
    })
  })
})
