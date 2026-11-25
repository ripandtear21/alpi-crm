import { randomBytes, randomUUID } from 'node:crypto'
import { createDb, type Database, migrateToLatest } from '@alpi/db'
import { startTestDatabase, type TestDatabase } from '@alpi/db/testing'
import {
  PROJECT_HEADER,
  type ProjectAccess,
  type ProjectSummary,
  type RoleTemplateKey,
} from '@alpi/shared'
import { Hono } from 'hono'
import { type Kysely, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { type AccessEnv, accessGuard } from '../auth/access-guard.ts'
import { type Auth, createAuth } from '../auth/auth.ts'
import { createOwner } from '../auth/owner.ts'
import { projectContext } from '../middleware/project-context.ts'
import { problemOf } from '../testing/problem.ts'
import { totp } from '../testing/totp.ts'

// Проекты и контекст проекта на настоящем PostgreSQL: миграции packages/db, API ходит в базу
// ролью приложения (член alpi_app, без BYPASSRLS), пользователи входят с 2FA через приложение.

const ORIGIN = 'http://localhost:3000'
const APP_USER = 'alpi_test_projects'

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

/** Приложение Hono, которому тест шлёт запросы. */
interface Target {
  request(input: string, init: RequestInit): Response | Promise<Response>
}

describe('проекты и контекст проекта', () => {
  let testDb: TestDatabase
  let owner: Kysely<Database>
  let appDb: Kysely<Database>
  let appPassword: string
  let auth: Auth
  let app: Target
  /**
   * Приложение с проверочными маршрутами в контексте проекта: обработчики читают и пишут
   * таблицы проекта без фильтра по проекту — отделяет только row-level security.
   */
  let probe: Target
  const opened: Kysely<Database>[] = []

  beforeAll(async () => {
    testDb = await startTestDatabase()
    owner = createDb(testDb.connectionString)
    await migrateToLatest(owner)

    appPassword = randomBytes(16).toString('hex')
    await sql`create role ${sql.id(APP_USER)} login password ${sql.lit(appPassword)} in role alpi_app`.execute(
      owner,
    )
    appDb = connectAs(APP_USER, appPassword)
    auth = createAuth({
      db: appDb,
      secret: randomBytes(32).toString('base64'),
      baseURL: ORIGIN,
      secureCookies: true,
    })
    app = createApp({ auth, db: appDb })

    probe = new Hono<AccessEnv>()
      .use('*', accessGuard(auth))
      .use('*', projectContext(appDb))
      .get('/links', async (c) =>
        c.json(
          await c
            .get('db')
            .selectFrom('external_link')
            .select(['entity_id', 'project_id'])
            .orderBy('entity_id')
            .execute(),
        ),
      )
      .get('/members', async (c) =>
        c.json(await c.get('db').selectFrom('project_member').select('project_id').execute()),
      )
      .post('/links-then-fail', async (c) => {
        await c
          .get('db')
          .insertInto('external_link')
          .values({
            project_id: c.get('projectId'),
            entity_type: 'deal',
            entity_id: 'rolled-back',
            source: 'pipedrive',
            external_id: randomUUID(),
          })
          .execute()
        throw new Error('сбой обработчика после записи')
      })
  })

  afterAll(async () => {
    await Promise.all(opened.map((db) => db.destroy()))
    await owner?.destroy()
    await testDb?.stop()
  })

  function connectAs(user: string, password: string): Kysely<Database> {
    const url = new URL(testDb.connectionString)
    url.username = user
    url.password = password
    const db = createDb(url.href)
    opened.push(db)
    return db
  }

  /**
   * Пользователь, вошедший с 2FA, как из браузера: cookie между запросами, свой адрес для
   * ограничителя попыток входа. `as: 'owner'` — владелец системы.
   */
  async function signedInUser(as: 'owner' | 'manager' = 'manager') {
    const email = `${randomUUID()}@example.test`
    const password = randomBytes(18).toString('base64url')
    const { id } =
      as === 'owner'
        ? await createOwner(auth, { email, name: 'Власник', password })
        : await auth.api
            .createUser({ body: { email, password, name: 'Менеджер' } })
            .then((r) => r.user)
    const jar = new Map<string, string>()
    const [a = 0, b = 0, c = 0] = randomBytes(3)
    const ip = `10.${a}.${b}.${c}`

    async function request(
      target: Target,
      method: Method,
      path: string,
      options: { project?: string; body?: unknown } = {},
    ) {
      const headers = new Headers({ origin: ORIGIN, 'x-forwarded-for': ip })
      if (jar.size > 0) {
        headers.set('cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '))
      }
      if (options.project !== undefined) headers.set(PROJECT_HEADER, options.project)
      if (options.body !== undefined) headers.set('content-type', 'application/json')
      const res = await target.request(`${ORIGIN}${path}`, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      })
      for (const cookie of res.headers.getSetCookie()) {
        const [pair = ''] = cookie.split(';')
        const eq = pair.indexOf('=')
        const name = pair.slice(0, eq)
        const value = pair.slice(eq + 1)
        if (value === '' || /max-age=0/i.test(cookie)) jar.delete(name)
        else jar.set(name, value)
      }
      return res
    }

    expect(
      (await request(app, 'POST', '/auth/sign-in/email', { body: { email, password } })).status,
    ).toBe(200)
    const enabled = await request(app, 'POST', '/auth/two-factor/enable', { body: { password } })
    expect(enabled.status).toBe(200)
    const { totpURI } = (await enabled.json()) as { totpURI: string }
    const secret = new URL(totpURI).searchParams.get('secret') ?? ''
    const verified = await request(app, 'POST', '/auth/two-factor/verify-totp', {
      body: { code: totp(secret) },
    })
    expect(verified.status).toBe(200)
    expect((await request(app, 'GET', '/me')).status).toBe(200)

    return {
      id,
      api: (method: Method, path: string, options?: { project?: string; body?: unknown }) =>
        request(app, method, path, options),
      probe: (method: Method, path: string, options?: { project?: string; body?: unknown }) =>
        request(probe, method, path, options),
    }
  }

  /** Проект, созданный владельцем через API; создатель становится участником. */
  async function createProjectVia(
    creator: Awaited<ReturnType<typeof signedInUser>>,
    name: string,
  ): Promise<ProjectSummary> {
    const res = await creator.api('POST', '/projects', {
      body: { code: `p-${randomBytes(4).toString('hex')}`, name },
    })
    expect(res.status).toBe(201)
    return (await res.json()) as ProjectSummary
  }

  /**
   * Участие пользователя в проекте — служебной ролью, как его выдаст тикет 06; роль —
   * шаблон этого проекта, по умолчанию «менеджер».
   */
  async function addMember(
    projectId: string,
    userId: string,
    template: RoleTemplateKey = 'manager',
  ): Promise<void> {
    await owner
      .insertInto('project_member')
      .values({
        project_id: projectId,
        user_id: userId,
        role_id: owner
          .selectFrom('role')
          .select('id')
          .where('project_id', '=', projectId)
          .where('template_key', '=', template),
      })
      .execute()
  }

  describe('создание проекта', () => {
    it('владелец системы создаёт проект и становится его участником', async () => {
      const systemOwner = await signedInUser('owner')
      const res = await systemOwner.api('POST', '/projects', {
        body: { code: 'alpi-school', name: '  AI-школа ALPI ' },
      })
      expect(res.status).toBe(201)
      const project = (await res.json()) as ProjectSummary
      expect(project).toMatchObject({ code: 'alpi-school', name: 'AI-школа ALPI' })

      const members = await owner
        .selectFrom('project_member')
        .select(['user_id', 'created_by'])
        .where('project_id', '=', project.id)
        .execute()
      expect(members).toEqual([{ user_id: systemOwner.id, created_by: systemOwner.id }])

      const list = await systemOwner.api('GET', '/projects')
      expect(await list.json()).toEqual([project])

      const again = await systemOwner.api('POST', '/projects', {
        body: { code: 'alpi-school', name: 'Ещё один' },
      })
      expect(again.status).toBe(409)
      expect(await again.json()).toEqual({ code: 'PROJECT_CODE_TAKEN' })
    })

    it('пользователь, не владелец системы, проект не создаёт', async () => {
      const manager = await signedInUser()
      const res = await manager.api('POST', '/projects', {
        body: { code: 'franch', name: 'Франч' },
      })
      expect(res.status).toBe(403)
      expect(await owner.selectFrom('project').where('code', '=', 'franch').execute()).toEqual([])
    })

    it('неверный код или пустое название — 400', async () => {
      const systemOwner = await signedInUser('owner')
      for (const body of [{ code: 'Bad Code', name: 'X' }, { code: 'ok-code', name: '  ' }, null]) {
        const res = await systemOwner.api('POST', '/projects', { body })
        expect(res.status).toBe(400)
      }
    })

    it('функция базы сама отказывает, если создатель не владелец системы', async () => {
      const manager = await signedInUser()
      await expect(
        sql`select * from public.create_project('by-manager', 'Чужой', ${manager.id})`.execute(
          appDb,
        ),
      ).rejects.toMatchObject({ code: '42501' })
      expect(await owner.selectFrom('project').where('code', '=', 'by-manager').execute()).toEqual(
        [],
      )
    })

    it('функции проектов закрыты для ролей не из alpi_app', async () => {
      const password = randomBytes(12).toString('hex')
      await sql`create role alpi_projects_outsider login password ${sql.lit(password)}`.execute(
        owner,
      )
      const outsider = connectAs('alpi_projects_outsider', password)
      await expect(sql`select * from public.user_projects('x')`.execute(outsider)).rejects.toThrow(
        /permission denied for function user_projects/,
      )
      await expect(
        sql`select * from public.create_project('x1', 'x', 'x')`.execute(outsider),
      ).rejects.toThrow(/permission denied for function create_project/)
    })
  })

  describe('мои проекты', () => {
    it('список — только проекты, где пользователь участник; чужие участия не видны', async () => {
      const systemOwner = await signedInUser('owner')
      const x = await signedInUser()
      const y = await signedInUser()
      const projectX = await createProjectVia(systemOwner, 'Проект X')
      const projectY = await createProjectVia(systemOwner, 'Проект Y')
      await addMember(projectX.id, x.id)
      await addMember(projectY.id, y.id)

      expect(await (await x.api('GET', '/projects')).json()).toEqual([projectX])
      expect(await (await y.api('GET', '/projects')).json()).toEqual([projectY])
      const fresh = await signedInUser()
      expect(await (await fresh.api('GET', '/projects')).json()).toEqual([])

      // Роль приложения вне контекста проекта участий не видит вовсе (политика проекта).
      expect(await appDb.selectFrom('project_member').selectAll().execute()).toEqual([])
    })
  })

  describe('контекст проекта', () => {
    let systemOwner: Awaited<ReturnType<typeof signedInUser>>
    let both: Awaited<ReturnType<typeof signedInUser>>
    let onlyA: Awaited<ReturnType<typeof signedInUser>>
    let projectA: ProjectSummary
    let projectB: ProjectSummary

    beforeAll(async () => {
      systemOwner = await signedInUser('owner')
      both = await signedInUser()
      onlyA = await signedInUser()
      projectA = await createProjectVia(systemOwner, 'A')
      projectB = await createProjectVia(systemOwner, 'B')
      await addMember(projectA.id, both.id)
      // В B — другая роль: права в ответе /project/access берутся из роли текущего проекта.
      await addMember(projectB.id, both.id, 'head')
      await addMember(projectA.id, onlyA.id)
      await owner
        .insertInto('external_link')
        .values(
          [
            [projectA.id, 'a1'],
            [projectA.id, 'a2'],
            [projectB.id, 'b1'],
          ].map(([project_id = '', entity_id = '']) => ({
            project_id,
            entity_type: 'deal',
            entity_id,
            source: 'pipedrive',
            external_id: entity_id,
          })),
        )
        .execute()
    })

    it('участнику текущий проект отвечает 200', async () => {
      const res = await onlyA.api('GET', '/project', { project: projectA.id })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(projectA)
    })

    it('права пользователя — по его роли в текущем проекте, без чужих данных', async () => {
      const inA = await both.api('GET', '/project/access', { project: projectA.id })
      expect(inA.status).toBe(200)
      const accessA = (await inA.json()) as ProjectAccess
      expect(Object.keys(accessA).sort()).toEqual(['permissions', 'userId'])
      expect(accessA.userId).toBe(both.id)
      // Менеджер: без «передачи сделок» и без удаления сделок.
      expect(accessA.permissions.standalone).not.toContain('transfer_deals')
      expect(accessA.permissions.actions.deals).toEqual(['view', 'create', 'edit'])

      const inB = await both.api('GET', '/project/access', { project: projectB.id })
      expect(inB.status).toBe(200)
      const accessB = (await inB.json()) as ProjectAccess
      expect(accessB.userId).toBe(both.id)
      expect(accessB.permissions.standalone).toContain('transfer_deals')
      expect(accessB.permissions.actions.deals).toContain('delete')

      // Не участник B — тот же 403, что у любого запроса в контексте чужого проекта.
      const outsider = await onlyA.api('GET', '/project/access', { project: projectB.id })
      expect(outsider.status).toBe(403)
      expect(await problemOf(outsider)).toEqual({ code: 'PROJECT_FORBIDDEN' })

      const anonymous = await app.request(`${ORIGIN}/project/access`, {
        headers: { origin: ORIGIN, [PROJECT_HEADER]: projectA.id },
      })
      expect(anonymous.status).toBe(401)
    })

    it('без участия в проекте — 403 на любой запрос в его контексте', async () => {
      const requests: [Method, string][] = [
        ['GET', '/project'],
        ['POST', '/project'],
        ['DELETE', '/project'],
        ['GET', '/deals'],
        ['PUT', '/contacts/1'],
      ]
      for (const [method, path] of requests) {
        const res = await onlyA.api(method, path, {
          project: projectB.id,
          ...(method === 'GET' ? {} : { body: {} }),
        })
        expect({ method, path, status: res.status }).toEqual({ method, path, status: 403 })
        expect(await problemOf(res)).toEqual({ code: 'PROJECT_FORBIDDEN' })
      }
      // Обработчик в контексте проекта не вызывается вовсе.
      const probed = await onlyA.probe('GET', '/links', { project: projectB.id })
      expect(probed.status).toBe(403)
    })

    it('несуществующий проект и неверный id — тот же 403, что и без участия', async () => {
      for (const project of [randomUUID(), 'not-a-uuid']) {
        const res = await onlyA.api('GET', '/project', { project })
        expect(res.status).toBe(403)
        expect(await problemOf(res)).toEqual({ code: 'PROJECT_FORBIDDEN' })
      }
    })

    it('без заголовка проекта — 400, без входа — 401', async () => {
      const res = await onlyA.api('GET', '/project')
      expect(res.status).toBe(400)
      expect(await problemOf(res)).toEqual({ code: 'PROJECT_REQUIRED' })

      const anonymous = await app.request(`${ORIGIN}/project`, {
        headers: { origin: ORIGIN, [PROJECT_HEADER]: projectA.id },
      })
      expect(anonymous.status).toBe(401)

      // Открытый путь входа пропускается accessGuard без сессии; если метод не совпал
      // с маршрутом Better Auth, запрос доходит до контекста проекта и должен получить 401.
      const openPath = await app.request(`${ORIGIN}/auth/sign-out`, {
        method: 'PUT',
        headers: { origin: ORIGIN, [PROJECT_HEADER]: projectA.id },
      })
      expect(openPath.status).toBe(401)
    })

    it('контекст проекта сам требует сессию с пройденной 2FA, даже без accessGuard перед ним', async () => {
      const sessionOf = (twoFactorEnabled: boolean, twoFactorVerified: boolean) =>
        ({
          user: { id: onlyA.id, twoFactorEnabled },
          session: { twoFactorVerified },
        }) as unknown as AccessEnv['Variables']['session']
      for (const session of [sessionOf(false, false), sessionOf(true, false)]) {
        const bare = new Hono<AccessEnv>()
          .use('*', async (c, next) => {
            c.set('session', session)
            await next()
          })
          .use('*', projectContext(appDb))
          .get('/project', (c) => c.text('в проекте'))
        const res = await bare.request('/project', { headers: { [PROJECT_HEADER]: projectA.id } })
        expect(res.status).toBe(401)
      }
    })

    it('обработчик в контексте A не видит данных B, а в контексте B — данных A', async () => {
      const inA = await both.probe('GET', '/links', { project: projectA.id })
      expect(inA.status).toBe(200)
      expect(await inA.json()).toEqual([
        { entity_id: 'a1', project_id: projectA.id },
        { entity_id: 'a2', project_id: projectA.id },
      ])

      const inB = await both.probe('GET', '/links', { project: projectB.id })
      expect(await inB.json()).toEqual([{ entity_id: 'b1', project_id: projectB.id }])

      // Участия: в контексте A — только строки A, хотя пользователь состоит и в B.
      const members = (await (
        await both.probe('GET', '/members', { project: projectA.id })
      ).json()) as {
        project_id: string
      }[]
      expect(members.length).toBe(3)
      expect(new Set(members.map((m) => m.project_id))).toEqual(new Set([projectA.id]))
    })

    it('ошибка обработчика откатывает его изменения', async () => {
      const res = await both.probe('POST', '/links-then-fail', { project: projectA.id, body: {} })
      expect(res.status).toBe(500)
      const rows = await owner
        .selectFrom('external_link')
        .select('id')
        .where('entity_id', '=', 'rolled-back')
        .execute()
      expect(rows).toEqual([])
    })
  })
})
