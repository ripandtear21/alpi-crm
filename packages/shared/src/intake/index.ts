// Источники регистраций и ключи источников (тикет crm-intake/03; GLOSSARY.md, «Источник
// регистраций», «Ключ источника»): формат ключа и общие типы API `/api/v1/intake-sources` и
// экрана «Налаштування → Джерела».
//
// Ключ источника — не ключ API: он только принимает регистрации и просмотры вебинара
// (`/api/intake/...`), читать и менять данные проекта не может. Префикс другой, чтобы проверка
// ключа API (`alpi_` и ровно 43 символа) его не узнала.

/** Начало каждого ключа источника: по нему ключ узнают в логах и сканерах утечек. */
export const INTAKE_KEY_PREFIX = 'alpi_src_'

/** Случайных байт в ключе (после префикса — base64url без `=`). */
export const INTAKE_KEY_BYTES = 32

/** Ключ целиком: префикс и 43 символа base64url (32 байта). */
export const INTAKE_KEY_PATTERN = /^alpi_src_[A-Za-z0-9_-]{43}$/

/** Сколько первых символов ключа хранится и показывается в списке источников. */
export const INTAKE_KEY_SHOWN_PREFIX_LENGTH = 12

/** Наибольшая длина названия источника. */
export const MAX_INTAKE_SOURCE_NAME_LENGTH = 100

/** Запросов приёма в минуту на один источник (пункт 19 ответов владельца). */
export const INTAKE_RATE_LIMIT = 600

/** Похожа ли строка на ключ источника (только форма, не проверка ключа). */
export function isIntakeKey(value: string): boolean {
  return INTAKE_KEY_PATTERN.test(value)
}

/** Источник регистраций в ответах API. Ключа здесь нет никогда. */
export interface IntakeSourceSummary {
  id: string
  name: string
  /** Воронка источника: новые сделки приёма — на её первом этапе. */
  pipeline: { id: string; name: string }
  /** Первые 12 символов ключа. */
  keyPrefix: string
  createdAt: string
  createdBy: { id: string; name: string }
  /** Последний принятый запрос по ключу (с точностью до минуты); null — запросов не было. */
  lastUsedAt: string | null
  /** null — источник включён и принимает запросы. */
  disabledAt: string | null
  disabledBy: { id: string; name: string } | null
}

/**
 * Ответ на создание и смену ключа: источник и его ключ. Ключ показывается только здесь, один
 * раз: в базе — лишь его отпечаток.
 */
export interface IntakeSourceWithKey {
  source: IntakeSourceSummary
  key: string
}

/** Тело `POST /api/v1/intake-sources`. Название и воронка после создания не меняются. */
export interface IntakeSourceCreateInput {
  name: string
  pipelineId: string
}

/**
 * Коды ошибок API источников (вдобавок к PERMISSION_DENIED). INVALID_INTAKE_SOURCE — тело
 * запроса не той формы, `details.path` — какое поле; PIPELINE_NOT_FOUND — воронки нет в
 * проекте или она в архиве; INTAKE_SOURCE_NAME_TAKEN — название занято другим источником
 * проекта; INTAKE_SOURCE_DISABLED — источник уже отключён; INTAKE_SOURCE_ENABLED — источник
 * уже включён.
 */
export type IntakeSourcesErrorCode =
  | 'INVALID_INTAKE_SOURCE'
  | 'INTAKE_SOURCE_NOT_FOUND'
  | 'INTAKE_SOURCE_NAME_TAKEN'
  | 'INTAKE_SOURCE_DISABLED'
  | 'INTAKE_SOURCE_ENABLED'
  | 'PIPELINE_NOT_FOUND'

/**
 * Ответ запросу приёма без действующего ключа источника: неизвестный, отключённый, старый
 * после смены ключ и отсутствие ключа — одинаковый 401.
 */
export type IntakeRequestErrorCode = 'INTAKE_KEY_INVALID'

export * from './registration.ts'
export * from './replay-status.ts'
export * from './webinar-view.ts'
