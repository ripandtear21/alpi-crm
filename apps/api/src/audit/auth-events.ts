import type { Database } from '@alpi/db'
import type { SystemAuditAction } from '@alpi/shared'
import { createAuthMiddleware, getIP, isAPIError } from 'better-auth/api'
import type { Kysely } from 'kysely'
import { audit } from './record.ts'

// События входа в системный журнал (тикет crm-foundation/07). Better Auth зовёт:
// - after — общий хук после каждого своего эндпоинта, в том числе после ошибки (тогда
//   ctx.context.returned — APIError). Наш хук идёт раньше хуков плагинов: после /sign-in/email
//   newSession ещё есть и у пользователя с 2FA — плагин twoFactor удалит её следом.
// - sessionDeleted — хук удаления сессии: так узнаём, чья сессия закрыта выходом.
//
// Ограничитель частоты Better Auth стоит раньше эндпоинтов и хуков (onRequest): запрос сверх
// лимита получает 429 и не доходит сюда, поэтому неудачные входы пишутся не чаще, чем лимит
// пропускает попытки (SIGN_IN_RATE_LIMIT для /sign-in/email, 3 за 10 с для /two-factor/*).
//
// Ошибка записи в журнал не глотается: вход без следа в журнале хуже, чем ответ 500.

/** Контекст эндпоинта Better Auth в хуке (только то, что нам нужно). */
type HookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]

/** Имя cookie второго шага входа плагина twoFactor (константа TWO_FACTOR_COOKIE_NAME). */
const TWO_FACTOR_COOKIE = 'two_factor'

const SECOND_FACTOR_METHODS: Record<string, string> = {
  '/two-factor/verify-totp': 'totp',
  '/two-factor/verify-backup-code': 'backup_code',
}

function clientIp(ctx: HookContext): string | null {
  const source = ctx.request ?? ctx.headers
  return source ? getIP(source, ctx.context.options) : null
}

/** Код ошибки Better Auth (INVALID_EMAIL_OR_PASSWORD, BANNED_USER…) — причина отказа. */
function errorCode(error: unknown): string | null {
  const body = (error as { body?: { code?: unknown } }).body
  return typeof body?.code === 'string' ? body.code : null
}

/** Пользователь, который на втором шаге входа: по cookie этого шага. */
async function pendingSecondFactorUser(ctx: HookContext): Promise<string | null> {
  const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE)
  const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret)
  if (!identifier) return null
  const verification = await ctx.context.internalAdapter.findVerificationValue(identifier)
  return verification?.value ?? null
}

export function authAuditHooks(db: Kysely<Database>) {
  async function write(
    ctx: HookContext,
    action: SystemAuditAction,
    actorId: string | null,
    extra: { details?: Record<string, unknown>; attemptedEmail?: string | null } = {},
  ) {
    await audit.recordSystem(db, {
      action,
      actorId,
      ip: clientIp(ctx),
      ...(actorId ? { entity: { type: 'user', id: actorId } } : {}),
      ...extra,
    })
  }

  const after = createAuthMiddleware(async (ctx) => {
    const returned = ctx.context.returned
    const failed = isAPIError(returned)
    const newSession = ctx.context.newSession

    if (ctx.path === '/sign-in/email') {
      const email = typeof ctx.body?.email === 'string' ? ctx.body.email : null
      if (failed) {
        const found = email ? await ctx.context.internalAdapter.findUserByEmail(email) : null
        await write(ctx, 'auth.sign_in_failed', found?.user.id ?? null, {
          attemptedEmail: email,
          details: { stage: 'password', reason: errorCode(returned) },
        })
      } else if (newSession) {
        // С 2FA вход ещё не завершён: сессию плагин twoFactor сейчас удалит и спросит код.
        await write(
          ctx,
          newSession.user.twoFactorEnabled ? 'auth.password_accepted' : 'auth.sign_in',
          newSession.user.id,
          { details: { method: 'password' } },
        )
      }
      return
    }

    const method = SECOND_FACTOR_METHODS[ctx.path]
    if (method !== undefined) {
      // Сессия до запроса есть — это не вход, а подтверждение кода при настройке 2FA.
      const priorSession = ctx.context.session
      if (priorSession) {
        if (!failed && newSession) {
          await write(ctx, 'auth.two_factor_enabled', priorSession.user.id)
        }
        return
      }
      if (failed) {
        await write(ctx, 'auth.sign_in_failed', await pendingSecondFactorUser(ctx), {
          details: { stage: 'second_factor', method, reason: errorCode(returned) },
        })
      } else if (newSession) {
        await write(ctx, 'auth.sign_in', newSession.user.id, { details: { method } })
      }
      return
    }

    const userId = ctx.context.session?.user.id
    if (failed || !userId) return
    if (ctx.path === '/two-factor/disable') {
      await write(ctx, 'auth.two_factor_disabled', userId)
    } else if (ctx.path === '/two-factor/generate-backup-codes') {
      await write(ctx, 'auth.backup_codes_regenerated', userId)
    }
  })

  /** Удалена сессия: при выходе это и есть событие «выход». */
  async function sessionDeleted(session: { userId: string }, ctx: HookContext | null) {
    if (ctx?.path === '/sign-out') {
      await write(ctx, 'auth.sign_out', session.userId)
    }
  }

  return { after, sessionDeleted }
}
