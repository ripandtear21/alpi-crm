import { API_KEY_RATE_LIMIT } from '@alpi/shared'
import type { Context } from 'hono'
import { problem } from './problem.ts'

// Лимит запросов по ключу API (тикет crm-api/02; .scratch/crm-api/spec.md, «Общие правила»):
// 600 запросов в минуту на ключ; запросы по сессии пользователя не ограничены.
//
// - Окно фиксированное, одна минута с первого запроса ключа в окне. Сверх лимита — 429
//   RATE_LIMITED с `Retry-After` (секунды до конца окна).
// - В каждом ответе ключу — `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`
//   (секунды до конца окна).
// - Счётчик считает каждый запрос действующего ключа, в том числе отказанный (403, 404…).
//
// shortcut: счётчик — в памяти процесса API (решено без владельца — подтвердить: в MVP процесс
// API один), при нескольких процессах API счётчик переезжает в базу.

const WINDOW_MS = 60_000

/** Сколько окон держать, прежде чем вычистить закончившиеся. */
const PRUNE_THRESHOLD = 10_000

export interface RateLimitOptions {
  /** Запросов за окно; по умолчанию API_KEY_RATE_LIMIT. */
  limit?: number
  /** Часы, мс; тесты подставляют свои. */
  now?: () => number
}

export interface RateLimitState {
  allowed: boolean
  limit: number
  remaining: number
  /** Секунд до конца окна, не меньше 1. */
  resetSeconds: number
}

export interface RateLimiter {
  /** Учитывает запрос ключа `keyId`. */
  hit(keyId: string): RateLimitState
}

export function createRateLimiter({
  limit = API_KEY_RATE_LIMIT,
  now = Date.now,
}: RateLimitOptions = {}): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>()
  return {
    hit(keyId) {
      const at = now()
      let window = windows.get(keyId)
      if (!window || at - window.start >= WINDOW_MS) {
        if (windows.size >= PRUNE_THRESHOLD) {
          for (const [id, w] of windows) if (at - w.start >= WINDOW_MS) windows.delete(id)
        }
        window = { start: at, count: 0 }
        windows.set(keyId, window)
      }
      window.count += 1
      return {
        allowed: window.count <= limit,
        limit,
        remaining: Math.max(0, limit - window.count),
        resetSeconds: Math.max(1, Math.ceil((window.start + WINDOW_MS - at) / 1000)),
      }
    },
  }
}

/** Заголовки лимита на ответ ключу. */
export function rateLimitHeaders(state: RateLimitState): Record<string, string> {
  return {
    'RateLimit-Limit': String(state.limit),
    'RateLimit-Remaining': String(state.remaining),
    'RateLimit-Reset': String(state.resetSeconds),
  }
}

/** Ответ 429 сверх лимита. */
export function rateLimited(c: Context, state: RateLimitState) {
  c.header('Retry-After', String(state.resetSeconds))
  return problem(c, 429, 'RATE_LIMITED')
}
