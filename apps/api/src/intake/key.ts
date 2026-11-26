import { createHash, randomBytes } from 'node:crypto'
import { INTAKE_KEY_BYTES, INTAKE_KEY_PREFIX, INTAKE_KEY_SHOWN_PREFIX_LENGTH } from '@alpi/shared'

// Ключ источника регистраций (тикет crm-intake/03): `alpi_src_` и 32 случайных байта в
// base64url. В базе — только отпечаток SHA-256 и первые 12 символов. Соль и медленный хеш не
// нужны, как у ключа API (api-keys/secret.ts): 256 случайных бит перебором не подобрать, а
// быстрый отпечаток считается на каждом запросе приёма.

/** Новый ключ и то, что о нём хранится в базе. */
export interface IssuedIntakeKey {
  /** Сам ключ: отдаётся в ответе один раз и больше нигде не появляется. */
  key: string
  hash: string
  shownPrefix: string
}

/** Отпечаток ключа для поиска источника: SHA-256, hex. */
export function hashIntakeKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}

export function issueIntakeKey(): IssuedIntakeKey {
  const key = INTAKE_KEY_PREFIX + randomBytes(INTAKE_KEY_BYTES).toString('base64url')
  return {
    key,
    hash: hashIntakeKey(key),
    shownPrefix: key.slice(0, INTAKE_KEY_SHOWN_PREFIX_LENGTH),
  }
}
