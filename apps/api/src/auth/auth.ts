import type { Database } from '@alpi/db'
import { betterAuth } from 'better-auth'
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { admin, twoFactor } from 'better-auth/plugins'
import type { Kysely } from 'kysely'
import { authAuditHooks } from '../audit/auth-events.ts'

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
  /**
   * Адреса и подсети (CIDR) прокси перед API, которым верим в X-Forwarded-For (TRUSTED_PROXIES).
   * Пусто — верим только заголовку из одного адреса: так его выставляет Caddy.
   */
  trustedProxies?: string[]
}

/**
 * Пути, на которых Better Auth создаёт сессию только после проверки кода 2FA: завершение
 * входа и завершение настройки 2FA.
 */
const SECOND_FACTOR_PATHS = new Set(['/two-factor/verify-totp', '/two-factor/verify-backup-code'])

/** Сессия запроса, как её кладёт Better Auth в контекст (с нашим полем twoFactorVerified). */
interface SessionOfRequest {
  user: { id: string; twoFactorEnabled?: boolean | null }
  session: { twoFactorVerified?: boolean | null }
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

/**
 * Выключенные эндпоинты плагина admin (решения владельца) — отвечают 404, даже владельцу
 * системы:
 * - вход под чужой учётной записью: владелец получает в проекте только права своей роли;
 * - удаление пользователя: пользователей не удаляют, а банят, и автор записи в журнале всегда
 *   остаётся ссылкой на учётную запись.
 */
export const DISABLED_AUTH_PATHS = [
  '/admin/impersonate-user',
  '/admin/stop-impersonating',
  '/admin/remove-user',
]

export function createAuth(config: AuthConfig) {
  // Журнал входов и 2FA (тикет crm-foundation/07).
  const auditHooks = authAuditHooks(config.db)
  return betterAuth({
    appName: 'Alpi CRM',
    secret: config.secret,
    baseURL: config.baseURL,
    basePath: AUTH_BASE_PATH,
    database: { db: config.db, type: 'postgres', transaction: true },
    telemetry: { enabled: false },
    disabledPaths: DISABLED_AUTH_PATHS,
    // Открытой регистрации нет: учётные записи заводит администратор (плагин admin) или CLI.
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
    },
    user: {
      fields: snakeFields('emailVerified', 'createdAt', 'updatedAt'),
      additionalFields: {
        // Временный пароль (учётную запись создал администратор проекта): до смены пароля API
        // пускает только к смене пароля и выходу (access-guard.ts). Ставит флаг API
        // (apps/api/src/members/service.ts), снимает хук после смены пароля ниже.
        mustChangePassword: {
          type: 'boolean',
          required: false,
          defaultValue: false,
          input: false,
          fieldName: 'must_change_password',
        },
      },
    },
    session: {
      fields: snakeFields(
        'expiresAt',
        'createdAt',
        'updatedAt',
        'ipAddress',
        'userAgent',
        'userId',
      ),
      // Прошла ли сессия второй фактор. Доступ к API с включённой 2FA — только у таких
      // (access-guard.ts): сессия, открытая по одному паролю до включения 2FA, его не получает.
      additionalFields: {
        twoFactorVerified: {
          type: 'boolean',
          required: false,
          defaultValue: false,
          input: false,
          fieldName: 'two_factor_verified',
        },
      },
    },
    databaseHooks: {
      session: {
        create: {
          // Отметку ставит только код 2FA; сессия, созданная взамен проверенной сессии того же
          // пользователя (например, при смене пароля), отметку наследует.
          before: async (session, ctx) => {
            const current = ctx?.context.session as SessionOfRequest | null | undefined
            const verified =
              (ctx?.path !== undefined && SECOND_FACTOR_PATHS.has(ctx.path)) ||
              (current?.user.id === session.userId && current.session.twoFactorVerified === true)
            return { data: { ...session, twoFactorVerified: verified } }
          },
        },
      },
      user: {
        update: {
          // 2FA только что включена (в сессии запроса она ещё выключена): все сессии
          // пользователя, открытые по одному паролю, удаляются. Новую сессию, прошедшую код,
          // Better Auth создаёт уже после этого обновления.
          after: async (user, ctx) => {
            const current = ctx?.context.session as SessionOfRequest | null | undefined
            if (
              ctx &&
              user.twoFactorEnabled === true &&
              current?.user.id === user.id &&
              current.user.twoFactorEnabled !== true
            ) {
              await ctx.context.internalAdapter.deleteUserSessions(user.id)
            }
          },
        },
      },
    },
    // «Запомнить устройство» (вход без кода с этого браузера) не поддерживаем: такой вход
    // создаёт сессию без второго фактора.
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Журнал: выход пишется до удаления сессии (audit/auth-events.ts).
        await auditHooks.before(ctx)
        if (SECOND_FACTOR_PATHS.has(ctx.path) && ctx.body?.trustDevice !== undefined) {
          return { context: { body: { ...ctx.body, trustDevice: false } } }
        }
        if (ctx.path === '/change-password') {
          // Новый пароль, совпадающий с текущим, — не смена: иначе флаг временного пароля
          // снимался бы без смены.
          if (
            typeof ctx.body?.newPassword === 'string' &&
            ctx.body.newPassword === ctx.body.currentPassword
          ) {
            throw new APIError('BAD_REQUEST', {
              code: 'PASSWORD_UNCHANGED',
              message: 'новый пароль совпадает с текущим',
            })
          }
          // Временный пароль видел тот, кто создал учётную запись: при его смене все другие
          // сессии закрываются, что бы ни прислал клиент.
          const session = (await getSessionFromCtx(ctx)) as
            | (SessionOfRequest & { user: { mustChangePassword?: boolean | null } })
            | null
          if (session?.user.mustChangePassword === true) {
            return { context: { body: { ...ctx.body, revokeOtherSessions: true } } }
          }
        }
      }),
      // Журнал (audit/auth-events.ts), затем снятие флага временного пароля: пароль сменён —
      // временного пароля больше нет. Отказ смены (неверный текущий пароль, короткий новый)
      // приходит сюда ошибкой и флаг не снимает.
      after: createAuthMiddleware(async (ctx) => {
        const result = await auditHooks.after(ctx)
        if (ctx.path === '/change-password' && !(ctx.context.returned instanceof APIError)) {
          const userId = (ctx.context.session as SessionOfRequest | null | undefined)?.user.id
          if (userId) {
            await ctx.context.internalAdapter.updateUser(userId, { mustChangePassword: false })
          }
        }
        return result
      }),
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
      // Адрес клиента для ограничителя — из X-Forwarded-For, который выставляет Caddy. Если перед
      // Caddy есть ещё прокси, их адреса — в trustedProxies: цепочка разбирается справа налево
      // до первого недоверенного адреса. Без этого при нескольких адресах в заголовке клиент
      // не определяется, и у всех один общий счётчик попыток.
      ipAddress: {
        ipAddressHeaders: ['x-forwarded-for'],
        ...(config.trustedProxies?.length ? { trustedProxies: config.trustedProxies } : {}),
      },
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
