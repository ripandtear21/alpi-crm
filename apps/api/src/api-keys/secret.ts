import { createHash, randomBytes } from 'node:crypto'
import {
  API_KEY_SECRET_BYTES,
  API_KEY_SECRET_PREFIX,
  API_KEY_SHOWN_PREFIX_LENGTH,
} from '@alpi/shared'

// Секрет ключа API (тикет crm-api/01): `alpi_` и 32 случайных байта в base64url. В базе —
// только отпечаток SHA-256 и первые 8 символов. Соль и медленный хеш не нужны: секрет — 256
// случайных бит, перебором его не подобрать, а быстрый отпечаток считается на каждом запросе.

/** Новый секрет и то, что о нём хранится в базе. */
export interface IssuedSecret {
  /** Сам секрет: отдаётся в ответе один раз и больше нигде не появляется. */
  secret: string
  hash: string
  shownPrefix: string
}

/** Отпечаток секрета для поиска ключа: SHA-256, hex. */
export function hashApiKeySecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

export function issueApiKeySecret(): IssuedSecret {
  const secret = API_KEY_SECRET_PREFIX + randomBytes(API_KEY_SECRET_BYTES).toString('base64url')
  return {
    secret,
    hash: hashApiKeySecret(secret),
    shownPrefix: secret.slice(0, API_KEY_SHOWN_PREFIX_LENGTH),
  }
}
