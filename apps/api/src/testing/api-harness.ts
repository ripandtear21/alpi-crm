import { randomBytes, randomUUID } from 'node:crypto'
import { createDb, type Database, migrateToLatest } from '@alpi/db'
import { startTestDatabase, type TestDatabase } from '@alpi/db/testing'
import { PROJECT_HEADER, type ProjectSummary } from '@alpi/shared'
import { type Kysely, sql } from 'kysely'
import { expect } from 'vitest'
import { createApp } from '../app.ts'
import { type Auth, createAuth } from '../auth/auth.ts'
import { createOwner } from '../auth/owner.ts'
import { startEventQueue } from '../jobs/jobs.ts'
import { totp } from './totp.ts'

// Только для тестов: API на настоящем PostgreSQL (миграции packages/db), подключение ролью
// приложения (член alpi_app, без BYPASSRLS), пользователи входят с 2FA, как из браузера.

export const ORIGIN = 'http://localhost:3000'

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface RequestOptions {
  project?: string
  body?: unknown
  /** Свои заголовки запроса (например Idempotency-Key). */
  headers?: Record<string, string>
}

/** Приложение Hono, которому тест шлёт запросы. */
export interface Target {
  request(input: string, init: RequestInit): Response | Promise<Response>
}

export interface SignedInUser {
  id: string
  email: string
  password: string
  /** Секрет TOTP: код для нового входа — totp(totpSecret). */
  totpSecret: string
  /** Адрес клиента (X-Forwarded-For) этого пользователя. */
  ip: string
  /** Запрос к API (createApp). */
  api(method: Method, path: string, options?: RequestOptions): Promise<Response>
  /** Запрос с теми же cookie к другому приложению — проверочному набору маршрутов. */
  call(target: Target, method: Method, path: string, options?: RequestOptions): Promise<Response>
}

export interface ApiHarness {
  /** Само приложение: для запросов со своими заголовками. */
  app: Target
  /** Служебное подключение (владелец таблиц): политики проекта на него не действуют. */
  owner: Kysely<Database>
  /** Подключение ролью приложения: тем же ходит API. */
  appDb: Kysely<Database>
  /** Строка подключения ролью приложения: для pg-boss фоновых задач (apps/api/src/jobs). */
  appUrl: string
  auth: Auth
  /** Запрос к API без входа (без cookie). */
  request(method: Method, path: string, body?: unknown): Promise<Response>
  /** Новый пользователь, вошедший с 2FA. `as: 'owner'` — владелец системы. */
  signIn(as?: 'owner' | 'user'): Promise<SignedInUser>
  /** Новый клиент без входа: свои cookie и адрес, как отдельный браузер. */
  browser(): Pick<SignedInUser, 'api' | 'call' | 'ip'>
  /** Проект, созданный владельцем системы через API; создатель — его администратор. */
  createProject(creator: SignedInUser, name?: string): Promise<ProjectSummary>
  /** Участие в проекте с ролью-шаблоном `templateKey` — служебной ролью. */
  addMember(projectId: string, userId: string, templateKey?: string): Promise<void>
  stop(): Promise<void>
}

export async function startApiHarness(appUser: string): Promise<ApiHarness> {
  const testDb: TestDatabase = await startTestDatabase()
  const owner = createDb(testDb.connectionString)
  await migrateToLatest(owner)
  const appPassword = randomBytes(16).toString('hex')
  await sql`create role ${sql.id(appUser)} login password ${sql.lit(appPassword)} in role alpi_app`.execute(
    owner,
  )
  const url = new URL(testDb.connectionString)
  url.username = appUser
  url.password = appPassword
  const appDb = createDb(url.href)
  // Изменения сделок и контактов пишут события с задачей pg-boss (events/emit.ts): очередь
  // событий нужна каждому API, даже без фоновых задач.
  const eventQueue = await startEventQueue(url.href)
  const auth = createAuth({
    db: appDb,
    secret: randomBytes(32).toString('base64'),
    baseURL: ORIGIN,
    secureCookies: true,
  })
  const app = createApp({ auth, db: appDb })

  /** Клиент со своими cookie и своим адресом — как отдельный браузер. */
  function browser(): Pick<SignedInUser, 'api' | 'call' | 'ip'> {
    const jar = new Map<string, string>()
    const [a = 0, b = 0, c = 0] = randomBytes(3)
    const ip = `10.${a}.${b}.${c}`

    async function call(
      target: Target,
      method: Method,
      path: string,
      options: RequestOptions = {},
    ) {
      const headers = new Headers({ origin: ORIGIN, 'x-forwarded-for': ip })
      if (jar.size > 0) {
        headers.set('cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '))
      }
      if (options.project !== undefined) headers.set(PROJECT_HEADER, options.project)
      if (options.body !== undefined) headers.set('content-type', 'application/json')
      for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value)
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
    const api = (method: Method, path: string, options?: RequestOptions) =>
      call(app, method, path, options)
    return { api, call, ip }
  }

  async function signIn(as: 'owner' | 'user' = 'user'): Promise<SignedInUser> {
    const email = `${randomUUID()}@example.test`
    const password = randomBytes(18).toString('base64url')
    const { id } =
      as === 'owner'
        ? await createOwner(auth, { email, name: 'Власник', password })
        : await auth.api
            .createUser({ body: { email, password, name: 'Користувач' } })
            .then((r) => r.user)
    const { api, call, ip } = browser()

    expect((await api('POST', '/auth/sign-in/email', { body: { email, password } })).status).toBe(
      200,
    )
    const enabled = await api('POST', '/auth/two-factor/enable', { body: { password } })
    expect(enabled.status).toBe(200)
    const { totpURI } = (await enabled.json()) as { totpURI: string }
    const secret = new URL(totpURI).searchParams.get('secret') ?? ''
    const verified = await api('POST', '/auth/two-factor/verify-totp', {
      body: { code: totp(secret) },
    })
    expect(verified.status).toBe(200)
    return { id, email, password, totpSecret: secret, ip, api, call }
  }

  async function createProject(creator: SignedInUser, name = 'Проєкт') {
    const res = await creator.api('POST', '/projects', {
      body: { code: `p-${randomBytes(4).toString('hex')}`, name },
    })
    expect(res.status).toBe(201)
    return (await res.json()) as ProjectSummary
  }

  async function addMember(projectId: string, userId: string, templateKey = 'manager') {
    await owner
      .insertInto('project_member')
      .values({
        project_id: projectId,
        user_id: userId,
        role_id: owner
          .selectFrom('role')
          .select('id')
          .where('project_id', '=', projectId)
          .where('template_key', '=', templateKey),
      })
      .execute()
  }

  async function request(method: Method, path: string, body?: unknown) {
    return app.request(`${ORIGIN}${path}`, {
      method,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  return {
    app,
    owner,
    appDb,
    appUrl: url.href,
    auth,
    request,
    signIn,
    browser,
    createProject,
    addMember,
    async stop() {
      await eventQueue.stop()
      await appDb.destroy()
      await owner.destroy()
      await testDb.stop()
    },
  }
}
