import { randomBytes } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import type { Database } from '@alpi/db'
import type { Kysely } from 'kysely'
import { AUTH_BASE_PATH, type Auth } from '../auth/auth.ts'
import { createOwner } from '../auth/owner.ts'
import { totp } from '../testing/totp.ts'
import type { PlannedUser } from './plan.ts'

// Пользователи тестовых данных: учётные записи Better Auth с паролем и включённой 2FA, как у
// живых пользователей. Пароль случайный; он и секрет 2FA печатаются в консоль и пишутся в
// локальный файл вне git — другого способа узнать их нет.

export interface SeedCredential {
  email: string
  name: string
  role: PlannedUser['role']
  password: string
  /** Секрет TOTP (base32): код для входа — любое приложение-аутентификатор. */
  totpSecret: string
}

/**
 * Ключ источника регистраций seed (тикет crm-intake/10): как пароль — только в файле учётных
 * данных, в вывод команды не печатается. В базе — лишь его отпечаток, другого способа узнать
 * ключ нет.
 */
export interface SourceKey {
  /** Код проекта. */
  project: string
  name: string
  sourceId: string
  key: string
}

interface CredentialsFile {
  users: SeedCredential[]
  sources?: SourceKey[]
}

async function readFileOf(file: string): Promise<CredentialsFile> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as CredentialsFile
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { users: [] }
    throw error
  }
}

/** Пишет файл; пустой (ни пользователей, ни ключей) — удаляет. */
async function writeFileOf(file: string, content: CredentialsFile): Promise<void> {
  const sources = content.sources ?? []
  if (content.users.length === 0 && sources.length === 0) {
    await rm(file, { force: true })
    return
  }
  const body: CredentialsFile = sources.length > 0 ? content : { users: content.users }
  await writeFile(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
}

export async function readCredentials(file: string): Promise<SeedCredential[]> {
  return (await readFileOf(file)).users
}

/** Пользователи файла; ключи источников остаются как были. */
export async function writeCredentials(file: string, users: SeedCredential[]): Promise<void> {
  await writeFileOf(file, { users, sources: (await readFileOf(file)).sources ?? [] })
}

export async function readSourceKeys(file: string): Promise<SourceKey[]> {
  return (await readFileOf(file)).sources ?? []
}

/** Ключи источников файла; пользователи остаются как были. */
export async function writeSourceKeys(file: string, sources: SourceKey[]): Promise<void> {
  await writeFileOf(file, { users: (await readFileOf(file)).users, sources })
}

export interface EnsuredUsers {
  /** Ключ пользователя плана → user.id. */
  ids: Map<string, string>
  /** Известные учётные данные (новые и из файла). */
  credentials: SeedCredential[]
  created: number
  /** Есть в базе, но пароля нет в файле: войти под ними нельзя. */
  unknown: string[]
}

/**
 * Заводит недостающих пользователей плана; существующих (по email) не трогает. Администратор —
 * владелец системы (createOwner), остальные — обычные учётные записи.
 */
export async function ensureUsers(
  serviceDb: Kysely<Database>,
  auth: Auth,
  authUrl: string,
  users: PlannedUser[],
  known: SeedCredential[],
  /** Сохраняет известные учётные данные: после каждого нового пользователя и в конце. */
  save: (credentials: SeedCredential[]) => Promise<void>,
): Promise<EnsuredUsers> {
  const ids = new Map<string, string>()
  const credentials: SeedCredential[] = []
  const unknown: string[] = []
  let created = 0
  for (const [n, user] of users.entries()) {
    const existing = await serviceDb
      .selectFrom('user')
      .select('id')
      .where('email', '=', user.email)
      .executeTakeFirst()
    if (existing) {
      ids.set(user.key, existing.id)
      const credential = known.find((c) => c.email === user.email)
      if (credential) credentials.push(credential)
      else unknown.push(user.email)
      continue
    }
    const password = randomBytes(18).toString('base64url')
    const { id } =
      user.role === 'admin'
        ? await createOwner(auth, { email: user.email, name: user.name, password })
        : await auth.api
            .createUser({ body: { email: user.email, name: user.name, password } })
            .then((r) => r.user)
    const totpSecret = await enableTwoFactor(auth, authUrl, user.email, password, n + 1)
    ids.set(user.key, id)
    credentials.push({ email: user.email, name: user.name, role: user.role, password, totpSecret })
    created++
    await save(mergeCredentials(credentials, known))
  }
  await save(credentials)
  return { ids, credentials, created, unknown }
}

/** Новые и уже сохранённые учётные данные: сохранённые ещё не пройденных пользователей не теряются. */
function mergeCredentials(fresh: SeedCredential[], known: SeedCredential[]): SeedCredential[] {
  return [...fresh, ...known.filter((k) => !fresh.some((c) => c.email === k.email))]
}

/**
 * Удаляет пользователей seed (по email плана) вместе с их записями журнала входов. Пользователь,
 * на которого ещё ссылаются (участник оставленного проекта, автор заметки или записи журнала
 * проекта), остаётся: возвращаются email оставленных.
 */
export async function deleteSeedUsers(
  serviceDb: Kysely<Database>,
  emails: string[],
): Promise<{ deleted: string[]; kept: string[] }> {
  const deleted: string[] = []
  const kept: string[] = []
  for (const email of emails) {
    const user = await serviceDb
      .selectFrom('user')
      .select('id')
      .where('email', '=', email)
      .executeTakeFirst()
    if (!user) continue
    try {
      await serviceDb.transaction().execute(async (db) => {
        await db.deleteFrom('system_audit_log').where('actor_id', '=', user.id).execute()
        await db.deleteFrom('user').where('id', '=', user.id).execute()
      })
      deleted.push(email)
    } catch (error) {
      // 23503 — на пользователя ссылается другая запись (внешний ключ).
      if ((error as { code?: string }).code !== '23503') throw error
      kept.push(email)
    }
  }
  return { deleted, kept }
}

/**
 * Включает 2FA так же, как пользователь в браузере: вход по паролю, включение, код из
 * приложения, выход. Возвращает секрет TOTP. `n` — номер пользователя: свой адрес клиента,
 * чтобы ограничитель попыток входа не считал всех вместе.
 */
async function enableTwoFactor(
  auth: Auth,
  authUrl: string,
  email: string,
  password: string,
  n: number,
): Promise<string> {
  const origin = new URL(authUrl).origin
  const jar = new Map<string, string>()
  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const headers = new Headers({
      origin,
      'content-type': 'application/json',
      'x-forwarded-for': `127.0.${Math.floor(n / 250)}.${(n % 250) + 1}`,
    })
    if (jar.size > 0) {
      headers.set('cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '))
    }
    const res = await auth.handler(
      new Request(new URL(`${AUTH_BASE_PATH}${path}`, origin), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }),
    )
    for (const cookie of res.headers.getSetCookie()) {
      const [pair = ''] = cookie.split(';')
      const eq = pair.indexOf('=')
      jar.set(pair.slice(0, eq), pair.slice(eq + 1))
    }
    if (!res.ok) throw new Error(`${email}: ${path} ответил ${res.status} ${await res.text()}`)
    return (await res.json()) as Record<string, unknown>
  }

  await post('/sign-in/email', { email, password })
  const { totpURI } = await post('/two-factor/enable', { password })
  const secret = new URL(String(totpURI)).searchParams.get('secret')
  if (!secret) throw new Error(`${email}: в ответе включения 2FA нет секрета`)
  await post('/two-factor/verify-totp', { code: totp(secret) })
  await post('/sign-out', {})
  return secret
}
