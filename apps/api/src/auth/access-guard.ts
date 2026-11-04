import { getIP } from 'better-auth/api'
import { createMiddleware } from 'hono/factory'
import { normalizeIp } from '../audit/record.ts'
import { AUTH_BASE_PATH, type Auth } from './auth.ts'

export type AuthSession = Auth['$Infer']['Session']

/** Переменные контекста Hono после проверки доступа. */
export type AccessEnv = {
  Variables: {
    session: AuthSession
    /**
     * Адрес клиента — тем же правилом, что у ограничителя входа Better Auth (X-Forwarded-For и
     * TRUSTED_PROXIES); для журнала действий. null — не определён.
     */
    clientIp: string | null
  }
}

/**
 * Пути Better Auth (после AUTH_BASE_PATH), которым сессия не нужна: вход, выход, чтение сессии
 * (по нему клиент узнаёт, что 2FA ещё не настроена) и второй шаг входа — код 2FA. На втором
 * шаге сессии ещё нет: Better Auth узнаёт пользователя по отдельной cookie этого шага.
 */
const OPEN_AUTH_PATHS = new Set([
  '/sign-in/email',
  '/sign-out',
  '/get-session',
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
])

/**
 * Пути, открытые пользователю с сессией, но без включённой 2FA: настройка 2FA. Подтверждение
 * настройки кодом (/two-factor/verify-totp) уже открыто в OPEN_AUTH_PATHS.
 */
const TWO_FACTOR_SETUP_PATHS = new Set(['/two-factor/enable', '/two-factor/get-totp-uri'])

/** Путь, открытый пользователю с временным паролем: смена пароля (выход открыт и так). */
const PASSWORD_CHANGE_PATH = '/change-password'

/**
 * Доступ к API:
 * - без сессии — 401;
 * - 2FA включена, но сессия не прошла второй фактор (открыта по одному паролю до включения
 *   2FA) — 401, нужен новый вход с кодом;
 * - временный пароль не сменён — 403 на всё, кроме смены пароля: сначала пароль, потом 2FA;
 * - 2FA не включена — 403 на всё, кроме настройки 2FA.
 * Действует на все маршруты, зарегистрированные после него, включая сам Better Auth.
 * Неизвестный путь Better Auth закрыт так же, как любой другой: список открытого — явный.
 */
export function accessGuard(auth: Auth) {
  return createMiddleware<AccessEnv>(async (c, next) => {
    c.set('clientIp', normalizeIp(getIP(c.req.raw, auth.options)))
    const authPath = c.req.path.startsWith(`${AUTH_BASE_PATH}/`)
      ? c.req.path.slice(AUTH_BASE_PATH.length)
      : null
    if (authPath !== null && OPEN_AUTH_PATHS.has(authPath)) {
      return next()
    }

    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) {
      return c.json({ code: 'UNAUTHORIZED' }, 401)
    }
    if (session.user.twoFactorEnabled && session.session.twoFactorVerified !== true) {
      return c.json({ code: 'SECOND_FACTOR_REQUIRED' }, 401)
    }
    if (session.user.mustChangePassword === true) {
      if (authPath !== PASSWORD_CHANGE_PATH) {
        return c.json({ code: 'PASSWORD_CHANGE_REQUIRED' }, 403)
      }
    } else if (
      !session.user.twoFactorEnabled &&
      !(authPath && TWO_FACTOR_SETUP_PATHS.has(authPath))
    ) {
      return c.json({ code: 'TWO_FACTOR_SETUP_REQUIRED' }, 403)
    }
    c.set('session', session)
    return next()
  })
}
