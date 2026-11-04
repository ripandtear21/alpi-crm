import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { createDb, type Database, migrateToLatest } from '@alpi/db'
import { startTestDatabase, type TestDatabase } from '@alpi/db/testing'
import { getMigrations } from 'better-auth/db/migration'
import { type Kysely, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { type Auth, createAuth, SIGN_IN_RATE_LIMIT } from './auth.ts'
import { createOwner, OWNER_ROLE } from './owner.ts'

// Вход целиком на настоящем PostgreSQL: миграции packages/db, роль приложения без BYPASSRLS
// (член alpi_app), запросы — через приложение Hono, как от браузера.

const ORIGIN = 'http://localhost:3000'
const APP_USER = 'alpi_test_api'

describe('вход и обязательная 2FA', () => {
  let testDb: TestDatabase
  let owner: Kysely<Database>
  let appDb: Kysely<Database>
  let auth: Auth
  let app: ReturnType<typeof createApp>

  beforeAll(async () => {
    testDb = await startTestDatabase()
    owner = createDb(testDb.connectionString)
    await migrateToLatest(owner)

    const appPassword = randomBytes(16).toString('hex')
    await sql`create role ${sql.id(APP_USER)} login password ${sql.lit(appPassword)} in role alpi_app`.execute(
      owner,
    )
    const url = new URL(testDb.connectionString)
    url.username = APP_USER
    url.password = appPassword
    appDb = createDb(url.href)

    auth = createAuth({
      db: appDb,
      secret: randomBytes(32).toString('base64'),
      baseURL: ORIGIN,
      secureCookies: true,
    })
    app = createApp({ auth })
  })

  afterAll(async () => {
    await appDb?.destroy()
    await owner?.destroy()
    await testDb?.stop()
  })

  /** Новый пользователь со случайным паролем; 2FA не включена. */
  async function newUser(role?: string) {
    const email = `${randomUUID()}@example.test`
    const password = randomBytes(18).toString('base64url')
    const { id } =
      role === OWNER_ROLE
        ? await createOwner(auth, { email, name: 'Власник', password })
        : await auth.api
            .createUser({ body: { email, password, name: 'Менеджер' } })
            .then((r) => r.user)
    return { id, email, password }
  }

  /**
   * Браузер: хранит cookie между запросами. У каждого браузера свой адрес (X-Forwarded-For),
   * чтобы ограничитель попыток считал их отдельно; `ip` можно сменить посреди сценария.
   */
  function browser() {
    const jar = new Map<string, string>()
    const state = { ip: randomIp(), lastSetCookie: [] as string[] }
    async function request(method: 'GET' | 'POST', path: string, body?: unknown) {
      const headers = new Headers({ origin: ORIGIN, 'x-forwarded-for': state.ip })
      if (jar.size > 0) {
        headers.set('cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '))
      }
      if (body !== undefined) headers.set('content-type', 'application/json')
      const res = await app.request(`${ORIGIN}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      state.lastSetCookie = res.headers.getSetCookie()
      for (const cookie of state.lastSetCookie) {
        const [pair = ''] = cookie.split(';')
        const eq = pair.indexOf('=')
        const name = pair.slice(0, eq)
        const value = pair.slice(eq + 1)
        if (value === '' || /max-age=0/i.test(cookie)) jar.delete(name)
        else jar.set(name, value)
      }
      return res
    }
    return {
      state,
      get: (path: string) => request('GET', path),
      post: (path: string, body: unknown = {}) => request('POST', path, body),
      signIn: (user: { email: string; password: string }) =>
        request('POST', '/auth/sign-in/email', { email: user.email, password: user.password }),
    }
  }

  /** Включает 2FA вошедшему пользователю так же, как экран настройки. */
  async function setUpTwoFactor(
    b: ReturnType<typeof browser>,
    password: string,
  ): Promise<{ secret: string; backupCodes: string[] }> {
    const enabled = await b.post('/auth/two-factor/enable', { password })
    expect(enabled.status).toBe(200)
    const { totpURI, backupCodes } = (await enabled.json()) as {
      totpURI: string
      backupCodes: string[]
    }
    const secret = new URL(totpURI).searchParams.get('secret') ?? ''
    const verified = await b.post('/auth/two-factor/verify-totp', { code: totp(secret) })
    expect(verified.status).toBe(200)
    return { secret, backupCodes }
  }

  describe('без включённой 2FA', () => {
    it('вход по паролю даёт доступ только к настройке 2FA, после настройки — ко всему', async () => {
      const user = await newUser(OWNER_ROLE)
      const b = browser()

      const signIn = await b.signIn(user)
      expect(signIn.status).toBe(200)

      // Сессию прочитать можно: по ней клиент понимает, что надо настроить 2FA.
      const session = await b.get('/auth/get-session')
      expect(session.status).toBe(200)
      expect(
        ((await session.json()) as { user: { twoFactorEnabled: boolean } }).user,
      ).toMatchObject({ twoFactorEnabled: false })

      // Всё остальное — 403, включая маршруты Better Auth и плагина admin (это владелец).
      for (const res of [
        await b.get('/me'),
        await b.get('/auth/list-sessions'),
        await b.get('/auth/admin/list-users'),
        await b.post('/auth/change-password', {
          currentPassword: user.password,
          newPassword: randomBytes(18).toString('base64url'),
        }),
        await b.post('/auth/update-user', { name: 'Інше імʼя' }),
        await b.get('/auth/no-such-route'),
      ]) {
        expect(res.status).toBe(403)
        expect(await res.json()).toEqual({ code: 'TWO_FACTOR_SETUP_REQUIRED' })
      }

      // Секрет выдан, но код ещё не подтверждён — доступа по-прежнему нет.
      const enabled = await b.post('/auth/two-factor/enable', { password: user.password })
      expect(enabled.status).toBe(200)
      const { totpURI, backupCodes } = (await enabled.json()) as {
        totpURI: string
        backupCodes: string[]
      }
      expect(totpURI).toMatch(/^otpauth:\/\/totp\/Alpi%20CRM:/)
      expect(backupCodes.length).toBeGreaterThanOrEqual(10)
      expect((await b.get('/me')).status).toBe(403)

      const secret = new URL(totpURI).searchParams.get('secret') ?? ''
      const wrong = await b.post('/auth/two-factor/verify-totp', { code: wrongCode(secret) })
      expect(wrong.status).toBe(401)
      expect((await b.get('/me')).status).toBe(403)

      const verified = await b.post('/auth/two-factor/verify-totp', { code: totp(secret) })
      expect(verified.status).toBe(200)

      const me = await b.get('/me')
      expect(me.status).toBe(200)
      expect(await me.json()).toEqual({
        id: user.id,
        email: user.email,
        name: 'Власник',
        role: OWNER_ROLE,
      })
    })

    it('без сессии — 401 на всё, кроме входа; /health открыт', async () => {
      const b = browser()
      expect((await b.get('/health')).status).toBe(200)
      expect((await b.get('/me')).status).toBe(401)
      expect((await b.get('/auth/list-sessions')).status).toBe(401)
      expect((await b.post('/auth/two-factor/enable', { password: 'x' })).status).toBe(401)
      const session = await b.get('/auth/get-session')
      expect(session.status).toBe(200)
      expect(await session.json()).toBeNull()
    })
  })

  describe('с включённой 2FA', () => {
    it('вход требует код: после пароля сессии нет, неверный код — отказ, верный — вход', async () => {
      const user = await newUser()
      const setup = browser()
      await setup.signIn(user)
      const { secret } = await setUpTwoFactor(setup, user.password)

      const b = browser()
      const signIn = await b.signIn(user)
      expect(signIn.status).toBe(200)
      expect(await signIn.json()).toMatchObject({ twoFactorRedirect: true })

      // Пароль принят, но сессии нет.
      expect(await (await b.get('/auth/get-session')).json()).toBeNull()
      expect((await b.get('/me')).status).toBe(401)

      const wrong = await b.post('/auth/two-factor/verify-totp', { code: wrongCode(secret) })
      expect(wrong.status).toBe(401)
      expect((await b.get('/me')).status).toBe(401)

      const right = await b.post('/auth/two-factor/verify-totp', { code: totp(secret) })
      expect(right.status).toBe(200)
      expect((await b.get('/me')).status).toBe(200)
    })

    it('резервный код заменяет код из приложения, но только один раз', async () => {
      const user = await newUser()
      const setup = browser()
      await setup.signIn(user)
      const { backupCodes } = await setUpTwoFactor(setup, user.password)
      const [code] = backupCodes

      const first = browser()
      await first.signIn(user)
      expect((await first.post('/auth/two-factor/verify-backup-code', { code })).status).toBe(200)
      expect((await first.get('/me')).status).toBe(200)

      const second = browser()
      await second.signIn(user)
      expect((await second.post('/auth/two-factor/verify-backup-code', { code })).status).toBe(401)
      expect((await second.get('/me')).status).toBe(401)
    })

    it('cookie сессии — HttpOnly, SameSite=Lax, Secure', async () => {
      const user = await newUser()
      const b = browser()
      await b.signIn(user)
      const sessionCookie = b.state.lastSetCookie.find((c) => c.includes('session_token='))
      expect(sessionCookie).toBeDefined()
      expect(sessionCookie).toMatch(/;\s*HttpOnly/i)
      expect(sessionCookie).toMatch(/;\s*SameSite=Lax/i)
      expect(sessionCookie).toMatch(/;\s*Secure/i)
    })
  })

  describe('учётные записи', () => {
    it('открытой регистрации нет: ни через API, ни вызовом на сервере', async () => {
      const email = `${randomUUID()}@example.test`
      const password = randomBytes(18).toString('base64url')
      const res = await browser().post('/auth/sign-up/email', { email, password, name: 'Гість' })
      expect(res.status).toBeGreaterThanOrEqual(400)
      await expect(
        auth.api.signUpEmail({ body: { email, password, name: 'Гість' } }),
      ).rejects.toThrow()

      const rows = await owner.selectFrom('user').select('id').where('email', '=', email).execute()
      expect(rows).toEqual([])
    })

    it('владелец создаётся с ролью admin, пароль в базе — только хэш', async () => {
      const user = await newUser(OWNER_ROLE)
      const row = await owner
        .selectFrom('user')
        .innerJoin('account', 'account.user_id', 'user.id')
        .select(['user.role', 'account.provider_id', 'account.password'])
        .where('user.id', '=', user.id)
        .executeTakeFirstOrThrow()
      expect(row.role).toBe(OWNER_ROLE)
      expect(row.provider_id).toBe('credential')
      expect(row.password).not.toContain(user.password)
    })

    it('бан отзывает сессии пользователя и закрывает вход', async () => {
      const admin = await newUser(OWNER_ROLE)
      const adminBrowser = browser()
      await adminBrowser.signIn(admin)
      await setUpTwoFactor(adminBrowser, admin.password)

      const user = await newUser()
      const userBrowser = browser()
      await userBrowser.signIn(user)
      expect((await userBrowser.get('/auth/get-session')).status).toBe(200)

      const ban = await adminBrowser.post('/auth/admin/ban-user', { userId: user.id })
      expect(ban.status).toBe(200)

      expect(await (await userBrowser.get('/auth/get-session')).json()).toBeNull()
      const again = await browser().signIn(user)
      expect(again.status).toBe(403)
    })

    it('схема базы совпадает с ожиданиями Better Auth', async () => {
      const { toBeCreated, toBeAdded } = await getMigrations(auth.options)
      expect(toBeCreated.map((t) => t.table)).toEqual([])
      expect(toBeAdded.map((t) => [t.table, Object.keys(t.fields)])).toEqual([])
    })
  })

  describe('ограничение частоты попыток входа', () => {
    it(`после ${SIGN_IN_RATE_LIMIT.max} неверных паролей подряд — отказ по лимиту даже с верным`, async () => {
      const user = await newUser()
      const b = browser()
      for (let i = 0; i < SIGN_IN_RATE_LIMIT.max; i++) {
        const res = await b.signIn({ email: user.email, password: `wrong-${i}-${user.password}` })
        expect(res.status).toBe(401)
      }
      const limited = await b.signIn(user)
      expect(limited.status).toBe(429)

      // Счётчик в базе, а не в памяти процесса.
      const rows = await owner
        .selectFrom('rate_limit')
        .select(['key', 'count'])
        .where('key', '=', `${b.state.ip}|/sign-in/email`)
        .execute()
      expect(rows).toEqual([{ key: `${b.state.ip}|/sign-in/email`, count: SIGN_IN_RATE_LIMIT.max }])

      // С другого адреса тот же пользователь входит.
      expect((await browser().signIn(user)).status).toBe(200)
    })
  })
})

/** Случайный адрес IPv4 из диапазона документации (198.51.100.0/24 недостаточно — берём 10/8). */
function randomIp(): string {
  const [a = 0, b = 0, c = 0] = randomBytes(3)
  return `10.${a}.${b}.${c}`
}

/** Код TOTP (RFC 6238: SHA-1, 6 цифр, 30 с) — так же считает приложение на телефоне. */
function totp(base32Secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)))
  const hmac = createHmac('sha1', base32Decode(base32Secret)).update(counter).digest()
  const offset = (hmac.at(-1) ?? 0) & 0x0f
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff
  return String(binary % 1_000_000).padStart(6, '0')
}

/** Код, которого нет ни в текущем, ни в соседних 30-секундных окнах. */
function wrongCode(secret: string): string {
  const valid = new Set([-30_000, 0, 30_000].map((shift) => totp(secret, Date.now() + shift)))
  let code = 0
  while (valid.has(String(code).padStart(6, '0'))) code++
  return String(code).padStart(6, '0')
}

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const char of input.replace(/=+$/, '').toUpperCase()) {
    const value = alphabet.indexOf(char)
    if (value < 0) throw new Error(`Не base32: ${char}`)
    bits += value.toString(2).padStart(5, '0')
  }
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(bytes)
}
