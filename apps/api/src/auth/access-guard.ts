import { createMiddleware } from 'hono/factory'
import { AUTH_BASE_PATH, type Auth } from './auth.ts'

export type AuthSession = Auth['$Infer']['Session']

/** Переменные контекста Hono после проверки доступа. */
export type AccessEnv = { Variables: { session: AuthSession } }

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

/** Пути, открытые пользователю с сессией, но без включённой 2FA: настройка 2FA. */
const TWO_FACTOR_SETUP_PATHS = new Set([
  '/two-factor/enable',
  '/two-factor/get-totp-uri',
  '/two-factor/verify-totp',
])

/**
 * Доступ к API: без сессии — 401, с сессией без включённой 2FA — 403 на всё, кроме настройки
 * 2FA. Действует на все маршруты, зарегистрированные после него, включая сам Better Auth.
 * Неизвестный путь Better Auth закрыт так же, как любой другой: список открытого — явный.
 */
export function accessGuard(auth: Auth) {
  return createMiddleware<AccessEnv>(async (c, next) => {
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
    if (!session.user.twoFactorEnabled && !(authPath && TWO_FACTOR_SETUP_PATHS.has(authPath))) {
      return c.json({ code: 'TWO_FACTOR_SETUP_REQUIRED' }, 403)
    }
    c.set('session', session)
    return next()
  })
}
