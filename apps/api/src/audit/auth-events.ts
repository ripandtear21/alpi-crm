import type { Database } from '@alpi/db'
import type { SystemAuditAction } from '@alpi/shared'
import { createAuthMiddleware, getIP, getSessionFromCtx, isAPIError } from 'better-auth/api'
import type { Kysely } from 'kysely'
import { audit } from './record.ts'

// События входа в системный журнал (тикет crm-foundation/07). Better Auth зовёт:
// - after — общий хук после каждого своего эндпоинта, в том числе после ошибки (тогда
//   ctx.context.returned — APIError). Наш хук идёт раньше хуков плагинов: после /sign-in/email
//   newSession ещё есть и у пользователя с 2FA — плагин twoFactor удалит её следом.
// - before — до эндпоинта: только выход (/sign-out). Запись делается до удаления сессии:
//   Better Auth в sign-out.mjs глотает ошибки deleteSession, и запись после удаления (в хуке
//   удаления сессии) пропадала бы молча. Не удалась запись — выход отвечает 500, сессия
//   остаётся: «нет записи — нет действия». Пользователь может повторить выход; если журнал не
//   пишется, база неисправна, и удаление сессии, скорее всего, не прошло бы тоже.
//
// Ограничитель частоты Better Auth стоит раньше эндпоинтов и хуков (onRequest): запрос сверх
// лимита получает 429 и не доходит сюда, поэтому неудачные входы пишутся не чаще, чем лимит
// пропускает попытки (SIGN_IN_RATE_LIMIT для /sign-in/email, 3 за 10 с для /two-factor/*).
//
// Ошибка записи в журнал не глотается: вход без следа в журнале хуже, чем ответ 500. Сессию,
// которую успел создать вход, при этом удаляем — иначе вход без записи всё же состоялся бы.
//
// Действия владельца системы через плагин admin (создание пользователя, роль, бан, отзыв
// сессий) пишутся после успешного ответа. Удаление пользователя выключено (disabledPaths в
// auth.ts): пользователей не удаляют, а банят.

/** Контекст эндпоинта Better Auth в хуке (только то, что нам нужно). */
type HookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]

/** Имя cookie второго шага входа плагина twoFactor (константа TWO_FACTOR_COOKIE_NAME). */
const TWO_FACTOR_COOKIE = 'two_factor'

/** Эндпоинты плагина admin, которые пишутся в журнал, и их коды действий. */
const ADMIN_ACTIONS: Record<string, SystemAuditAction> = {
  '/admin/create-user': 'admin.user_created',
  '/admin/set-role': 'admin.role_set',
  '/admin/ban-user': 'admin.user_banned',
  '/admin/unban-user': 'admin.user_unbanned',
  '/admin/revoke-user-session': 'admin.session_revoked',
  '/admin/revoke-user-sessions': 'admin.sessions_revoked',
}

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
    extra: {
      details?: Record<string, unknown>
      attemptedEmail?: string | null
      entity?: { type: string; id: string }
    } = {},
  ) {
    await audit.recordSystem(db, {
      action,
      actorId,
      ip: clientIp(ctx),
      ...(actorId ? { entity: { type: 'user', id: actorId } } : {}),
      ...extra,
    })
  }

  /** Запись о входе; не удалась — созданная входом сессия удаляется, ошибка идёт дальше. */
  async function writeSignIn(
    ctx: HookContext,
    action: SystemAuditAction,
    session: { session: { token: string }; user: { id: string } },
    details: Record<string, unknown>,
  ) {
    try {
      await write(ctx, action, session.user.id, { details })
    } catch (error) {
      await ctx.context.internalAdapter.deleteSession(session.session.token)
      ctx.context.setNewSession(null)
      throw error
    }
  }

  /** До эндпоинта: выход пишется, пока сессия ещё есть. */
  async function before(ctx: HookContext) {
    if (ctx.path !== '/sign-out') return
    const session = await getSessionFromCtx(ctx, { disableRefresh: true })
    if (session) await write(ctx, 'auth.sign_out', session.user.id)
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
        await writeSignIn(
          ctx,
          newSession.user.twoFactorEnabled ? 'auth.password_accepted' : 'auth.sign_in',
          newSession,
          { method: 'password' },
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
        await writeSignIn(ctx, 'auth.sign_in', newSession, { method })
      }
      return
    }

    const adminAction = ADMIN_ACTIONS[ctx.path]
    if (adminAction !== undefined) {
      if (!failed) await writeAdminAction(ctx, adminAction, returned)
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

  /**
   * Действие плагина admin. Автор — сессия запроса (владелец системы); вызов с сервера без
   * сессии (CLI create-owner) — автор null. Цель — пользователь из тела запроса или из ответа.
   */
  async function writeAdminAction(ctx: HookContext, action: SystemAuditAction, returned: unknown) {
    const body = (ctx.body ?? {}) as Record<string, unknown>
    const created = (returned as { user?: { id?: unknown } } | null)?.user?.id
    const target = typeof body.userId === 'string' ? body.userId : created
    const details: Record<string, unknown> = {}
    if (action === 'admin.role_set' || action === 'admin.user_created') {
      details.role = body.role ?? null
    }
    if (action === 'admin.user_banned') {
      details.reason = body.banReason ?? null
      details.expiresIn = body.banExpiresIn ?? null
    }
    await write(ctx, action, ctx.context.session?.user.id ?? null, {
      details,
      ...(typeof target === 'string' ? { entity: { type: 'user', id: target } } : {}),
    })
  }

  return { before, after }
}
