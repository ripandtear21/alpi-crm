import type { Database } from '@alpi/db'
import { betterAuth } from 'better-auth'
import { admin, twoFactor } from 'better-auth/plugins'
import type { Kysely } from 'kysely'

// Вход: Better Auth (email и пароль, плагины twoFactor и admin). Таблицы — глобальные, вне
// проектов (docs/adr/0001-izolyatsiya-proektov.md), создаёт их наша миграция
// packages/db/migrations/0002_auth.ts, а не CLI Better Auth.

/** Путь Better Auth внутри API. Снаружи — /api/auth: префикс /api срезают Caddy и прокси Vite. */
export const AUTH_BASE_PATH = '/auth'

/** Сколько попыток входа по паролю подряд пропускает ограничитель с одного адреса. */
export const SIGN_IN_RATE_LIMIT = { window: 60, max: 5 } as const

/** Минимальная длина пароля. */
export const MIN_PASSWORD_LENGTH = 12

export interface AuthConfig {
  /** Подключение к базе: та же роль приложения, что и у остального API. */
  db: Kysely<Database>
  /** Ключ подписи cookie и шифрования секретов 2FA (BETTER_AUTH_SECRET). */
  secret: string
  /** Публичный адрес сайта (origin), с которого клиент шлёт запросы (BETTER_AUTH_URL). */
  baseURL: string
  /** Флаг Secure у cookie: везде, кроме разработки. */
  secureCookies: boolean
}

/**
 * В базе имена в snake_case, у Better Auth — camelCase: перечисленные поля модели получают
 * имена столбцов в snake_case.
 */
function snakeFields<const K extends string>(...names: K[]): Record<K, string> {
  return Object.fromEntries(
    names.map((name) => [name, name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)]),
  ) as Record<K, string>
}

export function createAuth(config: AuthConfig) {
  return betterAuth({
    appName: 'Alpi CRM',
    secret: config.secret,
    baseURL: config.baseURL,
    basePath: AUTH_BASE_PATH,
    database: { db: config.db, type: 'postgres', transaction: true },
    telemetry: { enabled: false },
    // Открытой регистрации нет: учётные записи заводит администратор (плагин admin) или CLI.
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
    },
    user: { fields: snakeFields('emailVerified', 'createdAt', 'updatedAt') },
    session: {
      fields: snakeFields(
        'expiresAt',
        'createdAt',
        'updatedAt',
        'ipAddress',
        'userAgent',
        'userId',
      ),
    },
    account: {
      fields: snakeFields(
        'accountId',
        'providerId',
        'userId',
        'accessToken',
        'refreshToken',
        'idToken',
        'accessTokenExpiresAt',
        'refreshTokenExpiresAt',
        'createdAt',
        'updatedAt',
      ),
    },
    verification: { fields: snakeFields('expiresAt', 'createdAt', 'updatedAt') },
    // Счётчики в базе: переживают перезапуск API и общие для всех его процессов.
    rateLimit: {
      enabled: true,
      storage: 'database',
      modelName: 'rate_limit',
      fields: snakeFields('lastRequest'),
      customRules: { '/sign-in/email': SIGN_IN_RATE_LIMIT },
    },
    advanced: {
      useSecureCookies: config.secureCookies,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure: config.secureCookies },
      // Адрес клиента для ограничителя — из X-Forwarded-For, который выставляет Caddy.
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },
    },
    plugins: [
      twoFactor({
        issuer: 'Alpi CRM',
        schema: {
          user: { fields: snakeFields('twoFactorEnabled') },
          twoFactor: {
            modelName: 'two_factor',
            fields: snakeFields('backupCodes', 'userId', 'failedVerificationCount', 'lockedUntil'),
          },
        },
      }),
      admin({
        schema: {
          user: { fields: snakeFields('banReason', 'banExpires') },
          session: { fields: snakeFields('impersonatedBy') },
        },
      }),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>
