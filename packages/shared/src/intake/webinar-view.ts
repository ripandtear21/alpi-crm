import { normalizeEmail } from '../phone.ts'
import {
  intakeScalarText,
  intakeTimeOf,
  registrationEventId,
  registrationPhone,
  storableIntakeJson,
} from './registration.ts'

// Просмотр вебинара (тикет crm-intake/08; .scratch/crm-intake/spec.md, «Просмотры вебинара»;
// GLOSSARY.md, «Просмотр вебинара»): тело `POST /api/intake/webinar-views` и ответ.
//
// Платформа вебинаров ещё не выбрана (пункт 17): до неё — общий формат ниже, имена полей
// решены без владельца — подтвердить. Любые другие ключи верхнего уровня (процент, нажатые
// кнопки и т. п.) идут в `view_extra` регистрации как есть (решено без владельца —
// подтвердить). Тело отклоняется (400) только без `event_id`, без верного телефона и верного
// email или без `webinar`; неверные «начал», «вышел» и «минут» — в `view_extra` как прислано.

/** Наибольшее число минут просмотра (столбец registration.view_minutes, миграция 0030). */
export const MAX_VIEW_MINUTES = 100_000

/** Известные ключи тела просмотра; остальные — в `view_extra`. */
export const WEBINAR_VIEW_BODY_FIELDS = [
  'event_id',
  'phone',
  'email',
  'webinar',
  'started_at',
  'finished_at',
  'minutes',
] as const

/**
 * Ошибки запроса просмотра (вдобавок к INTAKE_KEY_INVALID и RATE_LIMITED):
 * - INVALID_WEBINAR_VIEW — тело не объект JSON;
 * - INVALID_EVENT_ID — `event_id` нет или он не 1–255 символов;
 * - CONTACT_KEYS_REQUIRED — нет ни верного телефона, ни верного email;
 * - WEBINAR_REQUIRED — нет `webinar`;
 * - INTERNAL — сбой обработки (500): ничего не записано, строка журнала — осталась.
 */
export type WebinarViewErrorCode =
  | 'INVALID_WEBINAR_VIEW'
  | 'INVALID_EVENT_ID'
  | 'CONTACT_KEYS_REQUIRED'
  | 'WEBINAR_REQUIRED'
  | 'INTERNAL'

/**
 * Ответ на просмотр — всегда 200. `matched: true` — просмотр записан в регистрацию
 * `registration_id`; `matched: false` — контакт или его регистрация на этот вебинар не найдены,
 * ничего не записано (решено без владельца — подтвердить). Повтор `event_id` — тот же ответ.
 */
export interface WebinarViewAccepted {
  registration_id: string | null
  matched: boolean
}

/** Разобранное тело просмотра. */
export interface ParsedWebinarView {
  eventId: string
  /** Телефон в E.164; null — не прислан или не разобран. */
  phone: string | null
  /** Email в нижнем регистре; null — не прислан или не разобран. */
  email: string | null
  webinar: string
  /** ISO 8601; null — не прислано или не разобрано (тогда как прислано — в `extra`). */
  startedAt: string | null
  finishedAt: string | null
  /** Целое 0–100 000; null — не прислано или не число (тогда как прислано — в `extra`). */
  minutes: number | null
  extra: Record<string, unknown>
}

export type WebinarViewParse =
  | { ok: true; value: ParsedWebinarView }
  | {
      ok: false
      code: Exclude<WebinarViewErrorCode, 'INTERNAL'>
    }

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Минуты: число или строка с числом 0–100 000, дробное округляется; иначе null. */
function minutesOf(value: unknown): number | null {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(number) || number < 0 || number > MAX_VIEW_MINUTES) return null
  return Math.round(number)
}

/** Тело просмотра (уже разобранный JSON): значения или код ошибки 400. */
export function parseWebinarView(body: unknown): WebinarViewParse {
  if (!isObject(body)) return { ok: false, code: 'INVALID_WEBINAR_VIEW' }
  const eventId = registrationEventId(body)
  if (eventId === null) return { ok: false, code: 'INVALID_EVENT_ID' }
  const known = new Set<string>(WEBINAR_VIEW_BODY_FIELDS)
  // Без прототипа: ключ `__proto__` из тела — обычный ключ, а не замена прототипа.
  const extra: Record<string, unknown> = Object.create(null)
  for (const [key, value] of Object.entries(body)) {
    if (!known.has(key)) extra[key] = value
  }
  // Известное поле не той формы (объект, список) — в `extra` как есть: не теряется.
  const field = (key: string): string | null => {
    const value = intakeScalarText(body[key])
    if (value === undefined) {
      if (body[key] !== undefined && body[key] !== null) extra[key] = body[key]
      return null
    }
    return value
  }
  const phoneRaw = field('phone')
  const emailRaw = field('email')
  const phone = phoneRaw === null ? null : registrationPhone(phoneRaw, null)
  const email = emailRaw === null ? null : normalizeEmail(emailRaw)
  if (phone === null && email === null) return { ok: false, code: 'CONTACT_KEYS_REQUIRED' }
  const webinar = field('webinar')
  if (webinar === null) return { ok: false, code: 'WEBINAR_REQUIRED' }

  // Неверное значение не теряется: как прислано — в `extra`.
  const time = (key: 'started_at' | 'finished_at'): string | null => {
    const raw = field(key)
    const value = intakeTimeOf(raw)
    if (raw !== null && value === null) extra[key] = body[key]
    return value
  }
  const minutes = minutesOf(body.minutes)
  if (minutes === null && body.minutes !== undefined && body.minutes !== null) {
    extra.minutes = body.minutes
  }
  return {
    ok: true,
    value: {
      eventId,
      phone,
      email,
      webinar,
      startedAt: time('started_at'),
      finishedAt: time('finished_at'),
      minutes,
      extra: storableIntakeJson(extra) as Record<string, unknown>,
    },
  }
}
