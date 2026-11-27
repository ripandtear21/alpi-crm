import { parsePhoneNumberFromString } from 'libphonenumber-js'
import { normalizeEmail, normalizePhone } from '../phone.ts'

// Приём регистраций и журнал входящих (тикет crm-intake/06; .scratch/crm-intake/spec.md):
// тело `POST /api/intake/registrations`, ответ, коды ошибок и предупреждений, журнал входящих.
//
// Имена полей тела — ключи заметки Pipedrive «Информация из формы» в snake_case (решено без
// владельца — подтвердить). Любые другие ключи верхнего уровня идут в `extra` регистрации как
// есть (пункт 12 ответов владельца). Регистрация не должна теряться: тело отклоняется (400)
// только без `event_id` или без верного телефона и верного email (пункты 4 и 19); прочее
// неверное — предупреждение или `extra`.

/** Наибольшая длина `event_id`. */
export const MAX_EVENT_ID_LENGTH = 255

/** Наибольшая длина строкового поля регистрации; длиннее — обрезается. */
export const MAX_REGISTRATION_TEXT_LENGTH = 2000

/** Сколько дней лежит строка журнала входящих (пункт 38, ADR 0006). */
export const INBOUND_RETENTION_DAYS = 30

/** Строковые поля тела и их столбцы в регистрации. */
export const REGISTRATION_TEXT_FIELDS = {
  name: 'name',
  dial_code: 'dial_code',
  form: 'form',
  webinar: 'webinar',
  plan_name: 'plan_name',
  page_url: 'page_url',
  referrer: 'referrer',
  utm_source: 'utm_source',
  utm_medium: 'utm_medium',
  utm_campaign: 'utm_campaign',
  utm_term: 'utm_term',
  utm_content: 'utm_content',
  ad_id: 'ad_id',
  gclid: 'gclid',
  gbraid: 'gbraid',
  wbraid: 'wbraid',
  fbclid: 'fbclid',
  fbp: 'fbp',
  fbc: 'fbc',
  user_agent: 'user_agent',
} as const

type TextField = keyof typeof REGISTRATION_TEXT_FIELDS

/** Все известные ключи тела; остальные — в `extra`. */
export const REGISTRATION_BODY_FIELDS = [
  'event_id',
  'phone',
  'email',
  'registered_at',
  'owner_email',
  ...(Object.keys(REGISTRATION_TEXT_FIELDS) as TextField[]),
] as const

/**
 * Ошибки запроса приёма регистрации (вдобавок к INTAKE_KEY_INVALID и RATE_LIMITED):
 * - INVALID_REGISTRATION — тело не объект JSON;
 * - INVALID_EVENT_ID — `event_id` нет или он не 1–255 символов;
 * - CONTACT_KEYS_REQUIRED — нет ни верного телефона, ни верного email;
 * - PIPELINE_ARCHIVED, PIPELINE_HAS_NO_STAGES — новую сделку некуда поставить: воронка источника
 *   в архиве или без этапов (422);
 * - INTERNAL — сбой обработки (500): данных не осталось, строка журнала — осталась.
 */
export type RegistrationErrorCode =
  | 'INVALID_REGISTRATION'
  | 'INVALID_EVENT_ID'
  | 'CONTACT_KEYS_REQUIRED'
  | 'PIPELINE_ARCHIVED'
  | 'PIPELINE_HAS_NO_STAGES'
  | 'INTERNAL'

/**
 * Предупреждения принятой регистрации:
 * - PHONE_INVALID — телефон не разобран (принята по email; исходный — в регистрации);
 * - EMAIL_INVALID — email не разобран (принята по телефону; исходный — в регистрации);
 * - OWNER_NOT_FOUND — `owner_email` не участник проекта или отключён: новая сделка без
 *   ответственного;
 * - RECORDS_DELETED — повтор события, чьи записи удалены окончательно: удалён контакт (с ним
 *   и регистрация) — все id null; удалена только сделка — deal_id null, регистрация и контакт
 *   на месте. Ничего не создано.
 */
export type RegistrationWarning =
  | 'PHONE_INVALID'
  | 'EMAIL_INVALID'
  | 'OWNER_NOT_FOUND'
  | 'RECORDS_DELETED'

/** Ответ на регистрацию: 201 — принята, 200 — повтор `event_id` (те же id). */
export interface RegistrationAccepted {
  registration_id: string | null
  contact_id: string | null
  deal_id: string | null
  /** Сделка создана этим запросом. */
  deal_created: boolean
  /** Контакт создан этим запросом. */
  contact_created: boolean
  warnings: RegistrationWarning[]
}

/** Разобранное тело регистрации: значения для поиска контакта и столбцов регистрации. */
export interface ParsedRegistration {
  eventId: string
  /** Телефон в E.164; null — не прислан или не разобран. */
  phone: string | null
  /** Телефон как прислан. */
  phoneRaw: string | null
  /** Email в нижнем регистре; null — не прислан или не разобран. */
  email: string | null
  /** Email как прислан (обрезанный по краям). */
  emailRaw: string | null
  /** ISO 8601; null — не прислано или не разобрано (тогда как прислано — в `extra`). */
  registeredAt: string | null
  /** Email ответственного новой сделки, в нижнем регистре; null — не прислан или не email. */
  ownerEmail: string | null
  /** `owner_email` прислан (любой): не найден участник — предупреждение OWNER_NOT_FOUND. */
  ownerGiven: boolean
  text: Record<TextField, string | null>
  extra: Record<string, unknown>
  warnings: RegistrationWarning[]
}

export type RegistrationParse =
  | { ok: true; value: ParsedRegistration }
  | { ok: false; code: 'INVALID_REGISTRATION' | 'INVALID_EVENT_ID' | 'CONTACT_KEYS_REQUIRED' }

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Символ NUL: PostgreSQL не хранит его ни в text, ни в jsonb — убирается. */
const NUL = String.fromCharCode(0)

/** Значение JSON без символов NUL в строках и ключах (для `extra`). */
function withoutNul(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll(NUL, '')
  if (Array.isArray(value)) return value.map(withoutNul)
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key.replaceAll(NUL, ''), withoutNul(item)]),
    )
  }
  return value
}

/**
 * Строка поля: строка — без пробелов по краям, число и да/нет — их запись; пустое — null.
 * Объект, список и null — undefined: в столбец не годится.
 */
function scalarText(value: unknown): string | null | undefined {
  if (typeof value === 'string') {
    const text = value.replaceAll(NUL, '').trim()
    return text === '' ? null : text.slice(0, MAX_REGISTRATION_TEXT_LENGTH)
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return undefined
}

/**
 * Телефон в E.164 с учётом `dial_code`: номер с «+» — как есть; номер без «+» при переданном
 * коде страны получает этот код (решено без владельца — подтвердить): `380671234567` и `+380` —
 * `+380671234567`, `0671234567` и `380` — тоже (национальный префикс 0 снимается). Без кода —
 * normalizePhone (номер без кода страны — украинский).
 */
export function registrationPhone(raw: string, dialCode: string | null): string | null {
  const code = dialCode?.replace(/\D/g, '') ?? ''
  if (raw.startsWith('+') || code === '') return normalizePhone(raw)
  const digits = raw.replace(/\D/g, '')
  if (digits === '') return null
  const candidates = [
    ...(digits.startsWith(code) ? [`+${digits}`] : []),
    `+${code}${digits.replace(/^0+/, '')}`,
  ]
  for (const candidate of candidates) {
    const parsed = parsePhoneNumberFromString(candidate)
    if (parsed?.isValid()) return parsed.number
  }
  return normalizePhone(raw)
}

/** Тело регистрации (уже разобранный JSON): значения или код ошибки 400. */
export function parseRegistration(body: unknown): RegistrationParse {
  if (!isObject(body)) return { ok: false, code: 'INVALID_REGISTRATION' }
  const eventId = scalarText(body.event_id)
  if (typeof eventId !== 'string' || eventId.length > MAX_EVENT_ID_LENGTH) {
    return { ok: false, code: 'INVALID_EVENT_ID' }
  }
  const known = new Set<string>(REGISTRATION_BODY_FIELDS)
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (!known.has(key)) extra[key] = value
  }
  // Известное поле не той формы (объект, список, null) — в `extra` как есть: не теряется.
  const field = (key: string): string | null => {
    const value = scalarText(body[key])
    if (value === undefined) {
      if (body[key] !== undefined && body[key] !== null) extra[key] = body[key]
      return null
    }
    return value
  }
  const text = Object.fromEntries(
    (Object.keys(REGISTRATION_TEXT_FIELDS) as TextField[]).map((key) => [key, field(key)]),
  ) as Record<TextField, string | null>
  const phoneRaw = field('phone')
  const emailRaw = field('email')
  const phone = phoneRaw === null ? null : registrationPhone(phoneRaw, text.dial_code)
  const email = emailRaw === null ? null : normalizeEmail(emailRaw)
  if (phone === null && email === null) return { ok: false, code: 'CONTACT_KEYS_REQUIRED' }
  const warnings: RegistrationWarning[] = []
  if (phoneRaw !== null && phone === null) warnings.push('PHONE_INVALID')
  if (emailRaw !== null && email === null) warnings.push('EMAIL_INVALID')

  const registeredRaw = field('registered_at')
  const registeredTime = registeredRaw === null ? Number.NaN : Date.parse(registeredRaw)
  const registeredAt = Number.isNaN(registeredTime) ? null : new Date(registeredTime).toISOString()
  if (registeredRaw !== null && registeredAt === null) extra.registered_at = body.registered_at
  const ownerRaw = field('owner_email')

  return {
    ok: true,
    value: {
      eventId,
      phone,
      phoneRaw,
      email,
      emailRaw,
      registeredAt,
      ownerEmail: ownerRaw === null ? null : normalizeEmail(ownerRaw),
      ownerGiven: body.owner_email !== undefined && body.owner_email !== null,
      text,
      extra: withoutNul(extra) as Record<string, unknown>,
      warnings,
    },
  }
}

// ---- Журнал входящих -------------------------------------------------------------------------

/** Канал журнала входящих: приём регистраций (тикет 08 — просмотры вебинара, эпики — свои). */
export type InboundChannel = 'intake.registration'

/** Итог входящего запроса. */
export type InboundOutcome = 'accepted' | 'repeat' | 'error'

export const INBOUND_OUTCOMES: readonly InboundOutcome[] = ['accepted', 'repeat', 'error']

/**
 * Строка журнала входящих в ответе `GET /api/v1/intake-sources/:id/requests` (экран источника,
 * тикет 07): тело запроса — как пришло.
 */
export interface InboundRequestView {
  id: string
  channel: InboundChannel
  sourceId: string | null
  receivedAt: string
  statusCode: number
  outcome: InboundOutcome
  errorCode: string | null
  eventId: string | null
  body: string
  /** id созданного или найденного (registration_id, contact_id, deal_id); у ошибки — null. */
  result: Record<string, unknown> | null
  warnings: string[]
  /** Строка журнала, которую провели заново; null — запрос пришёл от источника. */
  replayOf: string | null
}

/** Тело `POST /api/v1/inbound/replay`: провести заново входящие проекта с момента `since`. */
export interface InboundReplayInput {
  /** ISO 8601; не старше 30 дней. */
  since: string
}

/** Ответ 202 на «провести заново»: задача поставлена. */
export interface InboundReplayQueued {
  since: string
  /** Входящие с `since` до этого момента. */
  until: string
}

/**
 * Ошибки «провести заново» и журнала входящих: INVALID_REPLAY — тело не той формы
 * (`details.path`); REPLAY_TOO_OLD — момент старше 30 дней (422); INVALID_INBOUND_QUERY —
 * неверный фильтр или курсор журнала.
 */
export type InboundErrorCode =
  | 'PERMISSION_DENIED'
  | 'INVALID_REPLAY'
  | 'REPLAY_TOO_OLD'
  | 'INVALID_INBOUND_QUERY'
  | 'INTAKE_SOURCE_NOT_FOUND'
