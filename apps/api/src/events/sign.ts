import { createHmac } from 'node:crypto'
import { WEBHOOK_SECRET_PREFIX } from '@alpi/shared'

// Подпись Standard Webhooks v1 (тикет crm-api/06; спецификация Standard Webhooks 1.0.0) — своя
// функция на node:crypto, без зависимостей. Совместимость с официальной библиотекой проверяет
// тест: `verify()` пакета `standardwebhooks` (только dev-зависимость) принимает нашу подпись.
//
// - Подписывается строка `{webhook-id}.{webhook-timestamp}.{тело}` — тело байт в байт, как оно
//   уходит в запросе.
// - Ключ HMAC-SHA256 — декодированные байты секрета (после `whsec_`, base64).
// - Несколько секретов (24 часа после смены) — несколько подписей `v1,<base64>` через пробел;
//   приёмник принимает, если совпала любая.

/** Байты ключа HMAC из секрета `whsec_…`. */
export function webhookSigningKey(secret: string): Buffer {
  if (!secret.startsWith(WEBHOOK_SECRET_PREFIX)) throw new Error('секрет подписи без whsec_')
  return Buffer.from(secret.slice(WEBHOOK_SECRET_PREFIX.length), 'base64')
}

export interface SignInput {
  /** id события: заголовок `webhook-id`, одинаков при всех повторах. */
  id: string
  /** Время отправки, Unix-секунды: заголовок `webhook-timestamp`, новое на каждой попытке. */
  timestamp: number
  /** Тело запроса — ровно та строка, что уйдёт. */
  body: string
  /** Действующие секреты: текущий и, первые 24 часа после смены, прежний. */
  secrets: readonly string[]
}

/** Значение заголовка `webhook-signature`: подписи всеми секретами через пробел. */
export function webhookSignature({ id, timestamp, body, secrets }: SignInput): string {
  if (secrets.length === 0) throw new Error('подпись без секрета')
  const content = `${id}.${timestamp}.${body}`
  return secrets
    .map(
      (secret) =>
        `v1,${createHmac('sha256', webhookSigningKey(secret)).update(content, 'utf8').digest('base64')}`,
    )
    .join(' ')
}

/** Заголовки подписи Standard Webhooks для одной попытки. */
export function webhookHeaders(input: SignInput): {
  'webhook-id': string
  'webhook-timestamp': string
  'webhook-signature': string
} {
  return {
    'webhook-id': input.id,
    'webhook-timestamp': String(input.timestamp),
    'webhook-signature': webhookSignature(input),
  }
}
