import type { Database } from '@alpi/db'
import {
  can,
  FIELD_ENTITIES,
  FIELD_NAME_MAX_LENGTH,
  type FieldEntity,
  type FieldNames,
  type FieldsErrorCode,
  type Resource,
} from '@alpi/shared'
import type { Transaction } from 'kysely'
import { type Ctx, optionalText, type Refusal, refuse, requiredText } from '../contacts/http.ts'
import { loadMemberAccess, type MemberAccess } from '../roles/access.ts'
import type { FieldPurgeMessage } from './purge.ts'
import type { FieldRetypeMessage } from './retype.ts'

// Общее для маршрутов конструктора полей (тикет crm-fields/01): право смотреть сущность,
// разбор названий, ответы с кодом ошибки, зависимости (очередь и часы).

/** Часть системы сущности: право «смотреть» на неё открывает чтение описаний полей. */
export const ENTITY_RESOURCE: Record<FieldEntity, Resource> = {
  deal: 'deals',
  contact: 'contacts',
  organization: 'organizations',
}

export const isFieldEntity = (value: unknown): value is FieldEntity =>
  FIELD_ENTITIES.some((entity) => entity === value)

export type FieldsRefusal = Refusal<FieldsErrorCode>

/** 400 INVALID_INPUT с путём к неверному полю тела или запроса. */
export const invalid = (path: string): FieldsRefusal => refuse(400, 'INVALID_INPUT', { path })

export const notFound = (): FieldsRefusal => refuse(404, 'NOT_FOUND')

/**
 * Читать описания может каждый, у кого есть право смотреть сущность (решено без владельца,
 * подтвердить). Роль читается один раз за запрос, как в requirePermission.
 */
export async function canViewEntity(c: Ctx, entity: FieldEntity): Promise<boolean> {
  let access = c.get('access') as MemberAccess | undefined
  if (!access) {
    const loaded = await loadMemberAccess(c.get('db'), c.get('session').user.id)
    if (!loaded) return false
    access = loaded
    c.set('access', access)
  }
  return can(access.permissions, ENTITY_RESOURCE[entity], 'view')
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
