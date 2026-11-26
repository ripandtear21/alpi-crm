import type { EventBody, EventType } from './index.ts'

// Адреса автоматизации и доставка событий (тикет crm-api/06): общие типы API
// `/api/v1/webhook-endpoints` и экрана «Налаштування → Вебхуки» (тикет 07), описания типов событий
// на украинском и русском.

/** Начало секрета подписи (Standard Webhooks); дальше — base64 от 32 случайных байт. */
export const WEBHOOK_SECRET_PREFIX = 'whsec_'

/** Случайных байт в секрете подписи. */
export const WEBHOOK_SECRET_BYTES = 32

/** Сколько часов после смены секрета события подписываются и старым секретом. */
export const WEBHOOK_SECRET_OVERLAP_HOURS = 24

/** Сколько суток без успешной доставки отключают адрес. */
export const WEBHOOK_FAILING_DAYS = 5

/**
 * Перерыв между неудачами, после которого серия неудач начинается заново (решение владельца,
 * 2026-11-26): «5 суток без успеха» считаются только при попытках в это время. Пока доставка
 * повторяется, попытки идут не реже чем раз в 6 часов (`retryDelayMax: 21600`, очередь
 * `webhook-deliver`), поэтому перерыв дольше суток значит, что попыток не было, а не что адрес
 * не отвечал.
 */
export const WEBHOOK_FAILING_GAP_HOURS = 24

/** Сколько дней хранятся события, доставки и попытки. */
export const WEBHOOK_RETENTION_DAYS = 30

/** Наибольшая длина адреса и описания. */
export const MAX_WEBHOOK_URL_LENGTH = 2048
export const MAX_WEBHOOK_DESCRIPTION_LENGTH = 500

/** Описание типа события для экрана подписки: что случилось, по-украински и по-русски. */
export const EVENT_TYPE_TITLES: Record<EventType, { uk: string; ru: string }> = {
  'deal.created': { uk: 'Угоду створено', ru: 'Сделка создана' },
  'deal.stage_changed': {
    uk: 'Етап угоди змінено (зокрема перенесення в іншу воронку)',
    ru: 'Этап сделки изменён (в том числе перенос в другую воронку)',
  },
  'deal.won': { uk: 'Угоду виграно', ru: 'Сделка выиграна' },
  'deal.lost': { uk: 'Угоду програно', ru: 'Сделка проиграна' },
  'deal.reopened': { uk: 'Угоду відкрито знову', ru: 'Сделка открыта заново' },
  'deal.owner_changed': {
    uk: 'Відповідального за угоду змінено',
    ru: 'Ответственный за сделку изменён',
  },
  'deal.archived': { uk: 'Угоду архівовано', ru: 'Сделка архивирована' },
  'deal.unarchived': { uk: 'Угоду повернуто з архіву', ru: 'Сделка возвращена из архива' },
  'contact.created': { uk: 'Контакт створено', ru: 'Контакт создан' },
  'contact.possible_duplicate': {
    uk: 'Контакт позначено як можливий дубль',
    ru: 'Контакт отмечен как возможный дубль',
  },
}

/** Тип события в ответе `GET /api/v1/webhook-endpoints/event-types`. */
export interface WebhookEventTypeInfo {
  type: EventType
  entity: 'deal' | 'contact'
  title: { uk: string; ru: string }
}

export type WebhookEndpointState = 'active' | 'disabled'

/** Почему адрес отключён: ответ 410, 5 суток без успеха или вручную. */
export type WebhookDisabledReason = 'gone_410' | 'failing_5_days' | 'manual'

export type WebhookDeliveryState = 'pending' | 'succeeded' | 'failed' | 'cancelled'

export const WEBHOOK_DELIVERY_STATES: readonly WebhookDeliveryState[] = [
  'pending',
  'succeeded',
  'failed',
  'cancelled',
]

/**
 * Ошибка попытки, когда ответа нет: таймаут (15 с), TLS, DNS, адрес запрещён (имя разрешилось
 * во внутреннюю сеть), прочая ошибка сети.
 */
export type WebhookAttemptError = 'timeout' | 'tls' | 'dns' | 'forbidden_address' | 'network'

/** Адрес автоматизации в ответах API. Секрета здесь нет никогда. */
export interface WebhookEndpointSummary {
  id: string
  url: string
  description: string | null
  eventTypes: EventType[]
  state: WebhookEndpointState
  disabledReason: WebhookDisabledReason | null
  disabledAt: string | null
  lastSuccessAt: string | null
  /** До какого времени события подписываются и прежним секретом; null — прежнего нет. */
  previousSecretExpiresAt: string | null
  createdAt: string
  createdBy: { id: string; name: string }
}

/**
 * Вебхук в ответе `GET /api/v1/webhook-endpoints` (список): со сводкой доставок за последние
 * 24 часа для экрана «Налаштування → Вебхуки» (тикет 07). Завершённые — успешные и неудачные
 * доставки, чьё состояние изменилось за 24 часа; ожидающие и отменённые не считаются.
 */
export interface WebhookEndpointListItem extends WebhookEndpointSummary {
  deliveries24h: { finished: number; failed: number }
}

/** Ответ на создание адреса и смену секрета: секрет показывается только здесь, один раз. */
export interface WebhookEndpointWithSecret {
  endpoint: WebhookEndpointSummary
  secret: string
}

/** Тело `POST /api/v1/webhook-endpoints`; у `PATCH` все поля необязательны. */
export interface WebhookEndpointInput {
  url: string
  description?: string | null
  eventTypes: EventType[]
}

/** Попытка доставки в журнале. */
export interface WebhookAttemptView {
  attemptedAt: string
  statusCode: number | null
  error: WebhookAttemptError | null
  durationMs: number
  /** Первые 1 КБ тела ответа. */
  responseBody: string | null
}

/** Доставка в журнале адреса: событие, состояние и все попытки. */
export interface WebhookDeliveryView {
  id: string
  eventId: string
  eventType: EventType
  occurredAt: string
  state: WebhookDeliveryState
  attempts: number
  /** Самое раннее время следующей автоматической попытки; null — попыток больше не будет. */
  nextAttemptAt: string | null
  succeededAt: string | null
  attemptLog: WebhookAttemptView[]
  /** Тело события — то, что получает приёмник (тикет 07: показ в раскрытой доставке). */
  event: EventBody
}

/** Отключённый системой адрес: предупреждение в шапке для пользователей с правом «интеграции». */
export interface WebhookAlert {
  endpointId: string
  url: string
  description: string | null
  reason: Exclude<WebhookDisabledReason, 'manual'>
  disabledAt: string
}

export type WebhookEndpointsErrorCode =
  | 'INVALID_WEBHOOK_ENDPOINT'
  | 'INVALID_WEBHOOK_DELIVERIES'
  | 'WEBHOOK_URL_INVALID'
  | 'WEBHOOK_URL_NOT_HTTPS'
  | 'WEBHOOK_URL_FORBIDDEN_ADDRESS'
  | 'WEBHOOK_URL_UNRESOLVABLE'
  | 'WEBHOOK_ENDPOINT_NOT_FOUND'
  | 'WEBHOOK_DELIVERY_NOT_FOUND'
  | 'WEBHOOK_ENDPOINT_DISABLED'
  | 'WEBHOOK_DELIVERY_PENDING'
