import type { RoleTemplateKey } from '../permissions.ts'

// Ключи API проекта (тикет crm-api/01; GLOSSARY.md, «Ключ API»): формат секрета и общие типы
// API `/api/v1/api-keys` и экрана «Налаштування → Ключі API».

/** Начало каждого секрета: по нему секрет узнают в логах и сканерах утечек. */
export const API_KEY_SECRET_PREFIX = 'alpi_'

/** Случайных байт в секрете (после префикса — base64url без `=`). */
export const API_KEY_SECRET_BYTES = 32

/** Секрет целиком: префикс и 43 символа base64url (32 байта). */
export const API_KEY_SECRET_PATTERN = /^alpi_[A-Za-z0-9_-]{43}$/

/** Сколько первых символов секрета хранится и показывается в списке ключей. */
export const API_KEY_SHOWN_PREFIX_LENGTH = 8

/** Наибольшая длина названия ключа. */
export const MAX_API_KEY_NAME_LENGTH = 100

/** Похожа ли строка на секрет ключа API (только форма, не проверка ключа). */
export function isApiKeySecret(value: string): boolean {
  return API_KEY_SECRET_PATTERN.test(value)
}

/** Ключ API в ответах API. Секрета здесь нет никогда. */
export interface ApiKeySummary {
  id: string
  name: string
  /** Роль ключа; null — роль удалена после отзыва или истечения срока. */
  role: { id: string; name: string; templateKey: RoleTemplateKey | null } | null
  /** Первые 8 символов секрета. */
  secretPrefix: string
  createdAt: string
  createdBy: { id: string; name: string }
  /** Срок действия; null — бессрочный. */
  expiresAt: string | null
  /** Последний запрос по ключу (с точностью до минуты); null — запросов не было. */
  lastUsedAt: string | null
  revokedAt: string | null
}

/**
 * Ответ на создание и перевыпуск: ключ и его секрет. Секрет показывается только здесь, один
 * раз: в базе — лишь его отпечаток.
 */
export interface ApiKeyWithSecret {
  key: ApiKeySummary
  secret: string
}

/** Тело `POST /api/v1/api-keys`. */
export interface ApiKeyCreateInput {
  name: string
  roleId: string
  /** ISO 8601, в будущем; null или нет — бессрочный. */
  expiresAt?: string | null
}

/**
 * Коды ошибок API ключей (вдобавок к PERMISSION_DENIED). INVALID_API_KEY — тело запроса не
 * той формы, `details.path` — какое поле; API_KEY_NAME_TAKEN — название занято другим
 * неотозванным ключом; API_KEY_REVOKED — ключ уже отозван.
 */
export type ApiKeysErrorCode =
  | 'INVALID_API_KEY'
  | 'API_KEY_NOT_FOUND'
  | 'API_KEY_NAME_TAKEN'
  | 'API_KEY_REVOKED'
  | 'ROLE_NOT_FOUND'
  | 'ADMIN_ONLY'
  | 'EXCEEDS_OWN_PERMISSIONS'

/**
 * Ответы запросу по ключу: API_KEY_INVALID (401) — ключ неизвестен, отозван или истёк, ответ
 * одинаковый; API_KEY_NOT_ALLOWED (403) — маршрут не открыт ключам.
 */
export type ApiKeyRequestErrorCode = 'API_KEY_INVALID' | 'API_KEY_NOT_ALLOWED'
