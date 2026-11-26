import type { Hook } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { problem } from '../http/problem.ts'
import type { PermissionsEnv } from '../middleware/permissions.ts'

// Общее для маршрутов контактов и организаций: разбор тела, ответ «результат или отказ».

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type Ctx = Context<PermissionsEnv>

/** Отказ: статус ответа, код и, если нужно, подробности (поле, ссылка на запись). */
export interface Refusal<Code extends string> {
  ok: false
  status: 400 | 403 | 404 | 409 | 422
  code: Code
  details?: Record<string, unknown>
}

export type Outcome<T, Code extends string> = { ok: true; value: T } | Refusal<Code>

export const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value })

export function refuse<Code extends string>(
  status: Refusal<Code>['status'],
  code: Code,
  details?: Record<string, unknown>,
): Refusal<Code> {
  return details === undefined ? { ok: false, status, code } : { ok: false, status, code, details }
}

/** Ответ отказом в формате RFC 9457 (http/problem.ts). */
export function fail<Code extends string>(c: Ctx, refusal: Refusal<Code>) {
  const { status, code, details } = refusal
  return problem(c, status, code, { details })
}

/** Тело запроса — объект JSON, иначе null. */
export async function readBody(c: Ctx): Promise<Record<string, unknown> | null> {
  const body = (await c.req.json().catch(() => null)) as unknown
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null
}

/**
 * Необязательная строка до `max` символов: пустая или null — null; не строка или длиннее —
 * undefined (ошибка формы).
 */
export function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text.length > max) return undefined
  return text === '' ? null : text
}

/** Обязательная непустая строка до `max` символов; иначе undefined. */
export function requiredText(value: unknown, max: number): string | undefined {
  const text = optionalText(value, max)
  return text ?? undefined
}

/** Подстрока для ILIKE: % и _ из ввода ищутся буквально. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
}

/** Размер страницы выдачи `?limit=`: 1…200, по умолчанию 50; не число — undefined. */
export function readLimit(value: string | undefined): number | undefined {
  if (value === undefined) return 50
  if (!/^\d+$/.test(value)) return undefined
  const limit = Number(value)
  return limit >= 1 && limit <= 200 ? limit : undefined
}

/**
 * Ошибка схемы запроса маршрута с описанием OpenAPI (keyRoute) — тем же отказом `code` с путём к
 * полю, что и разбор тела вручную: клиент apps/web читает код, а не общий INVALID_INPUT.
 */
// biome-ignore lint/suspicious/noExplicitAny: один обработчик для маршрутов с любыми схемами
export function refusalHook(code: string): Hook<any, any, any, any> {
  return (result, c) => {
    if (result.success) return
    const [issue] = result.error.issues
    const path = issue?.path.map(String) ?? []
    // Лишний ключ тела — путь к самому ключу, как у разбора тела.
    if (issue?.code === 'unrecognized_keys' && issue.keys[0] !== undefined) path.push(issue.keys[0])
    return fail(c as Ctx, refuse(400, code, { path: path.join('.') }))
  }
}

/**
 * Ответ маршрута `openapi()` (keyRoute): форму описывает схема маршрута, собирают те же ответы,
 * что у маршрутов сессии; с типом схемы не сверяется (apps/web ходит своим fetch).
 */
export const typed = (res: Response) => res as never
