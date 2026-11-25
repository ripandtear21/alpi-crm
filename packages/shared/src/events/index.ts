// Каталог событий (тикет crm-api/05; GLOSSARY.md, «Событие»): какие события пишет CRM, что лежит
// в их теле и как тело проверяется. Один каталог для сервера (apps/api/src/events/emit.ts — тело
// проверяется перед записью), описания API (раздел `webhooks` в /api/v1/openapi.json) и тестов.
//
// Тело — «тонкое» событие по Standard Webhooks: тип, время и `data` — id события, проекта и
// сущности, неизменяемые факты изменения и автор (только тип и id). Имён, телефонов, email и
// значений пользовательских полей в теле нет: актуальное состояние автоматизация читает через
// API ключом со своими правами. Тело меняется только добавлением полей; ломающее изменение —
// новый тип события.
//
// Новый тип (регистрации, платежи, звонки, задачи — их эпики) добавляется строкой в
// EVENT_CATALOG и вызовом emitEvent в той же транзакции, что изменение.

/** Наибольший размер тела события в байтах (UTF-8 JSON). */
export const EVENT_BODY_MAX_BYTES = 20 * 1024

/** Начало id события: `evt_` и UUID. Тот же id — заголовок `webhook-id` при доставке. */
export const EVENT_ID_PREFIX = 'evt_'

/**
 * Вид факта в `data`:
 * - `uuid` — id записи CRM (сделка, воронка, этап, контакт, причина проигрыша);
 * - `user_or_null` — id пользователя или null (без ответственного — общая очередь);
 * - `placement` — воронка и этап: `{ pipeline_id, stage_id }`.
 */
export type EventFactKind = 'uuid' | 'user_or_null' | 'placement'

/** Описание типа события в каталоге. */
export interface EventDefinition {
  /** Тип сущности; её id в `data` — факт `<entity>_id`. */
  entity: 'deal' | 'contact'
  /** Когда событие пишется — для описания API. */
  summary: string
  /** Факты изменения в `data`, по порядку. */
  facts: Readonly<Record<string, EventFactKind>>
}

export const EVENT_CATALOG = {
  'deal.created': {
    entity: 'deal',
    summary: 'Создана сделка',
    facts: { deal_id: 'uuid', pipeline_id: 'uuid', stage_id: 'uuid', contact_id: 'uuid' },
  },
  'deal.stage_changed': {
    entity: 'deal',
    summary: 'Сменился этап сделки, в том числе при переносе в другую воронку',
    facts: { deal_id: 'uuid', from: 'placement', to: 'placement' },
  },
  'deal.won': {
    entity: 'deal',
    summary: 'Сделка выиграна',
    facts: { deal_id: 'uuid', stage_id: 'uuid' },
  },
  'deal.lost': {
    entity: 'deal',
    summary: 'Сделка проиграна',
    facts: { deal_id: 'uuid', stage_id: 'uuid', lost_reason_id: 'uuid' },
  },
  'deal.reopened': {
    entity: 'deal',
    summary: 'Выигранная или проигранная сделка открыта заново',
    facts: { deal_id: 'uuid', stage_id: 'uuid' },
  },
  'deal.owner_changed': {
    entity: 'deal',
    summary:
      'Сменился ответственный за сделку, в том числе снят (общая очередь) или сделку взяли в работу; null — без ответственного',
    facts: { deal_id: 'uuid', from_user_id: 'user_or_null', to_user_id: 'user_or_null' },
  },
  'deal.archived': {
    entity: 'deal',
    summary: 'Сделка архивирована',
    facts: { deal_id: 'uuid' },
  },
  'deal.unarchived': {
    entity: 'deal',
    summary: 'Сделка возвращена из архива',
    facts: { deal_id: 'uuid' },
  },
  'contact.created': {
    entity: 'contact',
    summary: 'Создан контакт',
    facts: { contact_id: 'uuid' },
  },
  'contact.possible_duplicate': {
    entity: 'contact',
    summary: 'Контакт получил отметку «возможный дубль» (его email уже есть у другого контакта)',
    facts: { contact_id: 'uuid' },
  },
} as const satisfies Record<string, EventDefinition>

export type EventType = keyof typeof EVENT_CATALOG

export const EVENT_TYPES = Object.keys(EVENT_CATALOG) as EventType[]

/** Воронка и этап сделки. */
export interface EventPlacement {
  pipeline_id: string
  stage_id: string
}

type FactValue<K> = K extends 'uuid'
  ? string
  : K extends 'user_or_null'
    ? string | null
    : K extends 'placement'
      ? EventPlacement
      : never

/** Факты изменения события `T` — то, что передаёт вызывающий. */
export type EventFacts<T extends EventType> = {
  -readonly [F in keyof (typeof EVENT_CATALOG)[T]['facts']]: FactValue<
    (typeof EVENT_CATALOG)[T]['facts'][F]
  >
}

/** Автор события: пользователь (id Better Auth) или ключ API (uuid). Без имени. */
export interface EventActor {
  type: 'user' | 'api_key'
  id: string
}

/** Тело события, как его получает адрес автоматизации. */
export interface EventBody<T extends EventType = EventType> {
  type: T
  /** Время события, ISO 8601 в UTC. */
  timestamp: string
  data: { event_id: string; project_id: string } & EventFacts<T> & { actor: EventActor }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const EVENT_ID = /^evt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** id пользователя Better Auth — 32 символа; с запасом, как MAX_USER_ID в API. */
const MAX_USER_ID = 100
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

/** Длина строки в байтах UTF-8 (без TextEncoder: пакет общий для сервера и клиента). */
function utf8Length(text: string): number {
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isUuid = (value: unknown) => typeof value === 'string' && UUID.test(value)

const isUserId = (value: unknown) =>
  typeof value === 'string' && value !== '' && value.length <= MAX_USER_ID

/** Ключи объекта — ровно `keys` (порядок не важен); иначе — первый лишний или недостающий. */
function keysProblem(value: Record<string, unknown>, keys: readonly string[], path: string) {
  const extra = Object.keys(value).find((key) => !keys.includes(key))
  if (extra !== undefined) return `${path}.${extra}: лишнее поле`
  const missing = keys.find((key) => !(key in value))
  return missing === undefined ? null : `${path}.${missing}: нет поля`
}

function factProblem(kind: EventFactKind, value: unknown, path: string): string | null {
  switch (kind) {
    case 'uuid':
      return isUuid(value) ? null : `${path}: ожидается uuid`
    case 'user_or_null':
      return value === null || isUserId(value)
        ? null
        : `${path}: ожидается id пользователя или null`
    case 'placement': {
      if (!isObject(value)) return `${path}: ожидается { pipeline_id, stage_id }`
      return (
        keysProblem(value, ['pipeline_id', 'stage_id'], path) ??
        (isUuid(value.pipeline_id) ? null : `${path}.pipeline_id: ожидается uuid`) ??
        (isUuid(value.stage_id) ? null : `${path}.stage_id: ожидается uuid`)
      )
    }
  }
}

function actorProblem(value: unknown): string | null {
  if (!isObject(value)) return 'data.actor: ожидается { type, id }'
  const keys = keysProblem(value, ['type', 'id'], 'data.actor')
  if (keys) return keys
  if (value.type === 'user') return isUserId(value.id) ? null : 'data.actor.id: ожидается id'
  if (value.type === 'api_key') return isUuid(value.id) ? null : 'data.actor.id: ожидается uuid'
  return 'data.actor.type: ожидается user или api_key'
}

/**
 * Проверка тела события по схеме его типа: ровно поля каталога, без лишних (так в тело не
 * попадёт ни имя, ни телефон), и не больше EVENT_BODY_MAX_BYTES. null — тело годится, иначе —
 * текст первой ошибки с путём поля.
 */
export function eventBodyProblem(body: unknown): string | null {
  if (!isObject(body)) return 'тело: ожидается объект'
  const keys = keysProblem(body, ['type', 'timestamp', 'data'], 'тело')
  if (keys) return keys
  const type = body.type
  if (typeof type !== 'string' || !Object.hasOwn(EVENT_CATALOG, type)) {
    return 'type: неизвестный тип события'
  }
  const definition: EventDefinition = EVENT_CATALOG[type as EventType]
  if (typeof body.timestamp !== 'string' || !ISO_UTC.test(body.timestamp)) {
    return 'timestamp: ожидается время ISO 8601 в UTC'
  }
  const data = body.data
  if (!isObject(data)) return 'data: ожидается объект'
  const factNames = Object.keys(definition.facts)
  const dataKeys = keysProblem(data, ['event_id', 'project_id', ...factNames, 'actor'], 'data')
  if (dataKeys) return dataKeys
  if (typeof data.event_id !== 'string' || !EVENT_ID.test(data.event_id)) {
    return 'data.event_id: ожидается evt_ и uuid'
  }
  if (!isUuid(data.project_id)) return 'data.project_id: ожидается uuid'
  for (const [name, kind] of Object.entries(definition.facts)) {
    const problem = factProblem(kind, data[name], `data.${name}`)
    if (problem) return problem
  }
  const actor = actorProblem(data.actor)
  if (actor) return actor
  const size = utf8Length(JSON.stringify(body))
  return size <= EVENT_BODY_MAX_BYTES ? null : `тело: ${size} байт, больше ${EVENT_BODY_MAX_BYTES}`
}

// ---- JSON Schema для описания API ------------------------------------------------------------

/** Схема JSON (OpenAPI 3.1 — JSON Schema 2020-12), без зависимостей от библиотек. */
export type JsonSchema = Record<string, unknown>

const UUID_SCHEMA = { type: 'string', format: 'uuid' } as const

function factSchema(kind: EventFactKind): JsonSchema {
  switch (kind) {
    case 'uuid':
      return UUID_SCHEMA
    case 'user_or_null':
      return { type: ['string', 'null'], description: 'id пользователя; null — без ответственного' }
    case 'placement':
      return {
        type: 'object',
        required: ['pipeline_id', 'stage_id'],
        properties: { pipeline_id: UUID_SCHEMA, stage_id: UUID_SCHEMA },
      }
  }
}

/** Схема автора события — общая для всех типов. */
export const EVENT_ACTOR_SCHEMA: JsonSchema = {
  type: 'object',
  description: 'Кто сделал изменение: пользователь или ключ API. Только тип и id, без имени',
  required: ['type', 'id'],
  properties: {
    type: { type: 'string', enum: ['user', 'api_key'] },
    id: { type: 'string', description: 'id пользователя или id ключа API (uuid)' },
  },
}

/**
 * Схема тела события `type` для описания API. Лишние поля в ней не запрещены: тело меняется
 * добавлением полей, и проверка на стороне автоматизации не должна от этого ломаться. Строгая
 * проверка (ровно поля каталога) — eventBodyProblem, на стороне CRM.
 */
export function eventBodySchema(type: EventType, actorSchema: JsonSchema = EVENT_ACTOR_SCHEMA) {
  const definition: EventDefinition = EVENT_CATALOG[type]
  const facts = Object.entries(definition.facts)
  return {
    type: 'object',
    description: definition.summary,
    required: ['type', 'timestamp', 'data'],
    properties: {
      type: { type: 'string', const: type },
      timestamp: { type: 'string', format: 'date-time', description: 'Время события, UTC' },
      data: {
        type: 'object',
        required: ['event_id', 'project_id', ...facts.map(([name]) => name), 'actor'],
        properties: {
          event_id: {
            type: 'string',
            pattern: '^evt_[0-9a-f-]{36}$',
            description: 'id события; тот же в заголовке webhook-id при каждой попытке доставки',
          },
          project_id: UUID_SCHEMA,
          ...Object.fromEntries(facts.map(([name, kind]) => [name, factSchema(kind)])),
          actor: actorSchema,
        },
      },
    },
  } satisfies JsonSchema
}

export * from './webhooks.ts'
