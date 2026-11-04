// Запросы входа к Better Auth на API (apps/api/src/auth). Снаружи он живёт по /api/auth:
// префикс /api срезают прокси Vite и Caddy. Сессия — в cookie HttpOnly, клиент её не видит
// и только читает через /get-session.

const AUTH_URL = '/api/auth'

export interface SessionUser {
  id: string
  email: string
  name: string
  twoFactorEnabled: boolean
}

export interface Session {
  /** Сессия прошла код 2FA. Без этого при включённой 2FA API отвечает 401. */
  session: { twoFactorVerified: boolean }
  user: SessionUser
}

/** Почему запрос не прошёл — для текста ошибки на экране. */
export type AuthError = 'invalid' | 'rate-limited' | 'banned' | 'failed'

export type AuthResult<T = object> = ({ ok: true } & T) | { ok: false; error: AuthError }

export interface TwoFactorSetup {
  /** otpauth://… для QR-кода. */
  totpURI: string
  /** Секрет из totpURI — для ручного ввода в приложение. */
  secret: string
  backupCodes: string[]
}

export interface AuthApi {
  getSession(): Promise<Session | null>
  /** `twoFactor: true` — пароль принят, нужен код 2FA. */
  signIn(email: string, password: string): Promise<AuthResult<{ twoFactor: boolean }>>
  verifyTotp(code: string): Promise<AuthResult>
  verifyBackupCode(code: string): Promise<AuthResult>
  enableTwoFactor(password: string): Promise<AuthResult<TwoFactorSetup>>
  signOut(): Promise<void>
}

export function createAuthApi(fetchImpl: typeof fetch = (...args) => fetch(...args)): AuthApi {
  async function post(path: string, body: unknown): Promise<Response> {
    return fetchImpl(`${AUTH_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    })
  }

  async function verify(path: string, code: string): Promise<AuthResult> {
    const res = await post(path, { code: code.trim() })
    return res.ok ? { ok: true } : { ok: false, error: await toError(res) }
  }

  return {
    async getSession() {
      const res = await fetchImpl(`${AUTH_URL}/get-session`, { credentials: 'same-origin' })
      if (!res.ok) {
        throw new Error(`Сессия не прочитана: API ответил ${res.status}`)
      }
      return (await res.json()) as Session | null
    },

    async signIn(email, password) {
      const res = await post('/sign-in/email', { email, password })
      if (!res.ok) return { ok: false, error: await toError(res) }
      const body = (await res.json()) as { twoFactorRedirect?: boolean }
      return { ok: true, twoFactor: body.twoFactorRedirect === true }
    },

    verifyTotp: (code) => verify('/two-factor/verify-totp', code),

    verifyBackupCode: (code) => verify('/two-factor/verify-backup-code', code),

    async enableTwoFactor(password) {
      const res = await post('/two-factor/enable', { password })
      if (!res.ok) return { ok: false, error: await toError(res) }
      const { totpURI, backupCodes } = (await res.json()) as {
        totpURI: string
        backupCodes: string[]
      }
      const secret = new URL(totpURI).searchParams.get('secret') ?? ''
      return { ok: true, totpURI, secret, backupCodes }
    },

    async signOut() {
      await post('/sign-out', {})
    },
  }
}

async function toError(res: Response): Promise<AuthError> {
  if (res.status === 429) return 'rate-limited'
  if (res.status === 400 || res.status === 401) return 'invalid'
  if (res.status === 403) {
    const body = (await res.json().catch(() => null)) as { code?: string } | null
    if (body?.code === 'BANNED_USER') return 'banned'
  }
  return 'failed'
}
