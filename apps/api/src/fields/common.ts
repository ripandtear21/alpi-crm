import type { Database } from '@alpi/db'
import {
  can,
  FIELD_ENTITIES,
  FIELD_ENTITY_RESOURCE,
  FIELD_NAME_MAX_LENGTH,
  type FieldEntity,
  type FieldNames,
  type FieldsErrorCode,
  type RolePermissions,
} from '@alpi/shared'
import type { Transaction } from 'kysely'
import { type Ctx, optionalText, type Refusal, refuse, requiredText } from '../contacts/http.ts'
import type { FieldIndexMessage } from '../jobs/field-index.ts'
import { loadApiKeyAccess, loadMemberAccess, type MemberAccess } from '../roles/access.ts'
import type { FieldPurgeMessage } from './purge.ts'
import type { FieldRetypeMessage } from './retype.ts'

// Общее для маршрутов конструктора полей (тикет crm-fields/01): право смотреть сущность,
// разбор названий, ответы с кодом ошибки, зависимости (очередь и часы).

/** Часть системы сущности: право «смотреть» на неё открывает чтение описаний полей. */
export const ENTITY_RESOURCE = FIELD_ENTITY_RESOURCE

export const isFieldEntity = (value: unknown): value is FieldEntity =>
  FIELD_ENTITIES.some((entity) => entity === value)

export type FieldsRefusal = Refusal<FieldsErrorCode>

/** 400 INVALID_INPUT с путём к неверному полю тела или запроса. */
export const invalid = (path: string): FieldsRefusal => refuse(400, 'INVALID_INPUT', { path })

export const notFound = (): FieldsRefusal => refuse(404, 'NOT_FOUND')

/**
 * Читать описания может каждый, у кого есть право смотреть сущность (решено без владельца,
 * подтвердить); какие группы он видит — по его правам (fields/access.ts). Права роли, если
 * сущность видна; null — нет. Роль (участника или ключа API) читается один раз за запрос, как
 * в requirePermission.
 */
export async function entityReader(c: Ctx, entity: FieldEntity): Promise<RolePermissions | null> {
  let access = c.get('access') as MemberAccess | undefined
  if (!access) {
    // Автор запроса — участник или ключ API (тикет crm-api/03): у запроса по ключу сессии нет.
    const actor = c.get('actor')
    const loaded =
      actor.type === 'user'
        ? await loadMemberAccess(c.get('db'), actor.userId)
        : await loadApiKeyAccess(c.get('db'), actor.apiKeyId)
    if (!loaded) return null
    access = loaded
    c.set('access', access)
  }
  return can(access.permissions, ENTITY_RESOURCE[entity], 'view') ? access.permissions : null
}

/**
 * Названия из тела: украинское обязательно (при `partial` — если передано), русское —
 * необязательно, пустое или null — нет. Строка — путь неверного поля.
 */
export function readNames(
  body: Record<string, unknown>,
  partial: boolean,
): Partial<FieldNames> | string {
  const names: Partial<FieldNames> = {}
  if (!partial || body.nameUk !== undefined) {
    const nameUk = requiredText(body.nameUk, FIELD_NAME_MAX_LENGTH)
    if (nameUk === undefined) return 'nameUk'
    names.nameUk = nameUk
  }
  if (body.nameRu !== undefined) {
    const nameRu = optionalText(body.nameRu, FIELD_NAME_MAX_LENGTH)
    if (nameRu === undefined) return 'nameRu'
    names.nameRu = nameRu
  }
  return names
}

/** Первый ключ тела не из списка; undefined — лишних нет. */
export function unknownKey(body: Record<string, unknown>, allowed: string[]): string | undefined {
  return Object.keys(body).find((key) => !allowed.includes(key))
}

export interface FieldsDeps {
  /** Ставит окончательное удаление поля в очередь той же транзакцией проекта (jobs/jobs.ts). */
  enqueuePurge(trx: Transaction<Database>, message: FieldPurgeMessage): Promise<void>
  /** Ставит смену типа поля с данными в очередь той же транзакцией проекта (jobs/jobs.ts). */
  enqueueRetype(trx: Transaction<Database>, message: FieldRetypeMessage): Promise<void>
  /**
   * Ставит построение копии значений «часто фильтруют» в очередь той же транзакцией проекта
   * (jobs/field-index.ts, тикет 07). Нет — копия не строится: поле остаётся 'building', фильтр
   * работает по `custom` без ускорения.
   */
  enqueueIndex?(trx: Transaction<Database>, message: FieldIndexMessage): Promise<void>
  /** Текущее время: отметка архива и срок 30 дней до окончательного удаления. */
  now(): Date
}

const noJobs = async () => {
  throw new Error('очередь фоновых задач не подключена')
}

/**
 * Без очереди: окончательное удаление поля с данными и смена типа с переписыванием значений
 * отвечают ошибкой (500).
 */
export const NO_FIELD_JOBS: FieldsDeps = {
  enqueuePurge: noJobs,
  enqueueRetype: noJobs,
  now: () => new Date(),
}
