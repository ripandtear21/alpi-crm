import {
  type CustomFieldErrorCode,
  type FieldEntity,
  type FieldType,
  type FieldValue,
  fieldGroupAccess,
  hasOptions,
  normalizeFieldValue,
} from '@alpi/shared'
import { type RawBuilder, sql } from 'kysely'
import {
  type ChangeAuthor,
  type ChangeLogEntity,
  type FieldChange,
  recordChanges,
} from '../change-log/record.ts'
import { type Outcome, ok, refuse } from '../contacts/http.ts'
import type { FieldViewer } from './access.ts'

// Значения пользовательских полей в записях (тикет crm-fields/02; spec.md MVP, раздел 3.3):
// единственное место, где API читает и пишет `custom` сделки, контакта и организации.
// Права на группы полей (тикет 03, fields/access.ts) действуют здесь же: запись — в
// prepareCustom, чтение — в visibleCustom.
//
// - Запрос создания и изменения записи несёт `custom: { код: значение | null }`; меняются только
//   переданные коды, null (и пустое значение) убирает ключ.
// - Неизвестный код, код архивного поля или поля, которое окончательно удаляется, — 422
//   CUSTOM_FIELD_UNKNOWN; значение не по типу — 422 CUSTOM_FIELD_INVALID с причиной
//   (packages/shared/src/fields/values.ts); идёт смена типа поля — 409 CUSTOM_FIELD_CONVERTING.
// - Поле группы, скрытой от роли, — тот же 422 CUSTOM_FIELD_UNKNOWN, что неизвестный код: ответ
//   не выдаёт, что поле есть (решено без владельца, подтвердить); поле группы «только чтение» —
//   403 CUSTOM_FIELD_READ_ONLY. Значения скрытых полей запись других кодов не трогает
//   (customUpdate меняет только переданные коды).
// - Запись в два шага: prepareCustom проверяет всё и ничего не пишет (отказ не оставляет следов
//   в транзакции запроса), вызывающий кладёт customUpdate / customInsert в свою запись строки,
//   потом finishCustom ставит first_value_at полям с первым значением и пишет «было → стало»
//   в change_log (поле `custom.<код>`; у вариантов — id).
// - Описания полей читаются FOR KEY SHARE: смена типа и архив (fields.ts, FOR UPDATE) ждут
//   конца записи значений, а запись, пришедшая после них, видит новое состояние поля. Условный
//   UPDATE first_value_at с этой блокировкой не конфликтует.

/** Значения записи по коду поля, как в колонке `custom`. */
export type CustomValues = Record<string, unknown>

/** `custom` из тела запроса: undefined — не передан; null — не объект (ответ 400). */
export function readCustomInput(value: unknown): CustomValues | undefined | null {
  if (value === undefined) return undefined
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as CustomValues)
    : null
}

/** Проверенное изменение `custom` одной записи. */
export interface CustomWrite {
  /** Коды с новыми значениями. */
  set: Record<string, FieldValue>
  /** Коды, которые убираются. */
  removed: string[]
  /** «Было → стало» по изменившимся кодам. */
  changes: FieldChange[]
  /** Поля, у которых это первое значение. */
  firstValueFieldIds: string[]
}

const NO_WRITE: CustomWrite = { set: {}, removed: [], changes: [], firstValueFieldIds: [] }

/** JSON с ключами по алфавиту: jsonb хранит ключи объекта в своём порядке. */
function canonical(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, v: unknown) =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  )
}

/**
 * Проверяет `input` для записи сущности `entity` с текущими значениями `current` и считает,
 * что меняется. Ничего не пишет.
 */
export async function prepareCustom(
  viewer: FieldViewer,
  entity: FieldEntity,
  current: CustomValues,
  input: CustomValues,
): Promise<Outcome<CustomWrite, CustomFieldErrorCode>> {
  const codes = Object.keys(input)
  if (codes.length === 0) return ok(NO_WRITE)
  const { db } = viewer
  const fields = await db
    .selectFrom('field_definition')
    .select(['id', 'code', 'type', 'first_value_at', 'archived_at', 'purge_requested_at'])
    .select(['converting_to', 'group_id'])
    .where('entity', '=', entity)
    .where('code', 'in', codes)
    .orderBy('id')
    .forKeyShare()
    .execute()
  const byCode = new Map(fields.map((f) => [f.code, f]))
  const accessOf = (field: { group_id: string }) =>
    fieldGroupAccess(viewer.permissions, { id: field.group_id, entity })
  // Сначала «неизвестные» по всем кодам, потом остальные отказы: иначе по тому, какой отказ
  // пришёл при паре кодов, можно было бы угадать, что скрытое поле есть.
  for (const code of codes) {
    const field = byCode.get(code)
    if (
      !field ||
      field.archived_at !== null ||
      field.purge_requested_at !== null ||
      accessOf(field) === 'hidden'
    ) {
      return refuse(422, 'CUSTOM_FIELD_UNKNOWN', { field: code })
    }
  }
  for (const field of fields) {
    if (accessOf(field) !== 'edit') {
      return refuse(403, 'CUSTOM_FIELD_READ_ONLY', { field: field.code })
    }
    if (field.converting_to !== null) {
      return refuse(409, 'CUSTOM_FIELD_CONVERTING', { field: field.code })
    }
  }

  // Запросы по очереди: транзакция проекта — одно соединение.
  const listFields = fields.filter((f) => hasOptions(f.type as FieldType)).map((f) => f.id)
  const options =
    listFields.length === 0
      ? []
      : await db
          .selectFrom('field_option')
          .select(['id', 'field_id', 'archived_at'])
          .where('field_id', 'in', listFields)
          .orderBy('position')
          .orderBy('created_at')
          .orderBy('id')
          .execute()
  const userIds = fields
    .filter((f) => f.type === 'user' && typeof input[f.code] === 'string')
    .map((f) => input[f.code] as string)
  const members =
    userIds.length === 0
      ? []
      : await db
          .selectFrom('project_member')
          .select(['user_id', 'disabled_at'])
          .where('user_id', 'in', userIds)
          .execute()
  const users = new Map(members.map((m) => [m.user_id, { disabled: m.disabled_at !== null }]))

  const write: CustomWrite = { set: {}, removed: [], changes: [], firstValueFieldIds: [] }
  for (const code of codes) {
    const field = byCode.get(code)
    if (!field) continue
    const previous = current[code] ?? null
    const result = normalizeFieldValue(
      {
        type: field.type as FieldType,
        options: options
          .filter((o) => o.field_id === field.id)
          .map((o) => ({ id: o.id, archivedAt: o.archived_at === null ? null : 'archived' })),
      },
      input[code],
      { users, previous },
    )
    if (!result.ok) {
      return refuse(422, 'CUSTOM_FIELD_INVALID', { field: code, reason: result.problem })
    }
    if (canonical(previous) === canonical(result.value)) continue
    if (result.value === null) {
      write.removed.push(code)
    } else {
      write.set[code] = result.value
      if (field.first_value_at === null) write.firstValueFieldIds.push(field.id)
    }
    write.changes.push({ field: `custom.${code}`, before: previous, after: result.value })
  }
  return ok(write)
}

/** Есть ли что писать в `custom`. */
export function changesCustom(write: CustomWrite): boolean {
  return write.changes.length > 0
}

/**
 * Новое значение колонки `custom` для UPDATE: убранные коды прочь, новые — поверх. Выражение,
 * а не готовый объект: ключи, которых запрос не касался, остаются как в строке.
 */
export function customUpdate(write: CustomWrite): RawBuilder<string> {
  return sql<string>`(custom - ${write.removed}::text[]) || ${JSON.stringify(write.set)}::jsonb`
}

/** Колонка `custom` новой записи. */
export function customInsert(write: CustomWrite): string {
  return JSON.stringify(write.set)
}

/**
 * После записи строки: первое значение ставит полю first_value_at (одним условным UPDATE), а
 * `history` — «было → стало» в change_log (у новой записи истории нет, как у её полей).
 */
export async function finishCustom(
  author: ChangeAuthor,
  record: { type: ChangeLogEntity; id: string },
  write: CustomWrite,
  { history }: { history: boolean },
): Promise<void> {
  if (write.firstValueFieldIds.length > 0) {
    await author.db
      .updateTable('field_definition')
      .set({ first_value_at: sql`now()` })
      .where('id', 'in', write.firstValueFieldIds)
      .where('first_value_at', 'is', null)
      .execute()
  }
  if (history) await recordChanges(author, record, write.changes)
}

/**
 * `custom` записей для ответа API: только коды действующих полей сущности (архивные и
 * удаляемые не отдаются, их значения лежат до возврата из архива или окончательного удаления)
 * из групп, которые роль `viewer` видит.
 */
export async function visibleCustom(
  viewer: FieldViewer,
  entity: FieldEntity,
  values: readonly CustomValues[],
): Promise<CustomValues[]> {
  if (values.every((v) => Object.keys(v).length === 0)) return values.map(() => ({}))
  const live = await viewer.db
    .selectFrom('field_definition')
    .select(['code', 'group_id'])
    .where('entity', '=', entity)
    .where('archived_at', 'is', null)
    .where('purge_requested_at', 'is', null)
    .execute()
  const codes = new Set(
    live
      .filter((f) => fieldGroupAccess(viewer.permissions, { id: f.group_id, entity }) !== 'hidden')
      .map((f) => f.code),
  )
  return values.map((v) =>
    Object.fromEntries(Object.entries(v).filter(([code]) => codes.has(code))),
  )
}
