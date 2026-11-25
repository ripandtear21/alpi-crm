import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { WEBHOOK_SECRET_BYTES, WEBHOOK_SECRET_PREFIX } from '@alpi/shared'

// Секрет подписи адреса событий (тикет crm-api/06): `whsec_` и base64 от 32 случайных байт
// (Standard Webhooks). Показывается один раз — в ответе на создание адреса и на смену секрета.
// В базе он нужен для подписи каждой отправки, поэтому хранится не отпечатком, а зашифрованным
// AES-256-GCM ключом из окружения (WEBHOOK_SECRET_KEY, config.ts; спецификация MVP, раздел 9.2 —
// секреты интеграций в базе зашифрованы; решено без владельца — подтвердить).
//
// - Шифротекст привязан к проекту и адресу (дополнительные данные GCM): скопированный в другую
//   строку или другой проект, он не расшифруется.
// - Формат: `v1.` и base64 от iv (12 байт), тега (16 байт) и шифротекста.
// - Тексты ошибок не содержат ни секрета, ни шифротекста.

const VERSION = 'v1.'
const IV_BYTES = 12
const TAG_BYTES = 16

/** Новый секрет подписи. */
export function generateWebhookSecret(): string {
  return WEBHOOK_SECRET_PREFIX + randomBytes(WEBHOOK_SECRET_BYTES).toString('base64')
}

/** Чей секрет: шифротекст расшифруется только для того же проекта и адреса. */
export interface SecretOwner {
  projectId: string
  endpointId: string
}

const aad = (owner: SecretOwner) => Buffer.from(`${owner.projectId}/${owner.endpointId}`, 'utf8')

/** Шифрует секрет `secret` адреса `owner` ключом `key` (32 байта). */
export function encryptWebhookSecret(key: Buffer, owner: SecretOwner, secret: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad(owner))
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return VERSION + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
}

/** Расшифровывает секрет адреса `owner`; чужой ключ, чужой адрес или порча — ошибка. */
export function decryptWebhookSecret(key: Buffer, owner: SecretOwner, stored: string): string {
  if (!stored.startsWith(VERSION)) throw new Error('секрет адреса: неизвестный формат шифротекста')
  const raw = Buffer.from(stored.slice(VERSION.length), 'base64')
  if (raw.length <= IV_BYTES + TAG_BYTES) throw new Error('секрет адреса: шифротекст повреждён')
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES))
  decipher.setAAD(aad(owner))
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
  try {
    return Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    throw new Error('секрет адреса не расшифрован: другой ключ WEBHOOK_SECRET_KEY или чужая строка')
  }
}
