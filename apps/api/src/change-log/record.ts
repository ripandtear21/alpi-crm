import type { Database } from '@alpi/db'
import { type Kysely, sql } from 'kysely'

// Журнал изменений «сущность, id, кто, когда, поле, было → стало» (тикет crm-deals/03;
// spec.md, раздел 3.2, change_log; таблица — packages/db/migrations/0009_contacts.ts).
//
// Запись — той же транзакцией проекта, что и само изменение: откатилось изменение — откатилась
// и запись, а ошибка записи отменяет изменение. Пишут контакты и организации; сделки
// (тикет 05) и платежи зовут те же функции со своим типом сущности.
//
// Отличие от журнала опасных действий (audit/record.ts): там — кто что сделал (роль, вход,
// окончательное удаление), здесь — история значений полей записи для её карточки.

/** Чья история: тип сущности в change_log.entity_type. */
export type ChangeLogEntity = 'contact' | 'organization' | 'deal'

/** Изменение одного поля; значения — то, что API отдаёт в ответе (JSON). */
export interface FieldChange {
  /** Имя поля в API: firstName, phones, deletedAt… */
  field: string
  before: unknown
  after: unknown
}

/**
 * Поля `fields`, значения которых в `before` и `after` различаются. Сравнение по JSON:
 * списки телефонов сравниваются по составу и порядку (основной — первым).
 */
export function diffFields<T extends object>(
  before: T,
  after: T,
  fields: readonly (keyof T & string)[],
): FieldChange[] {
  const changes: FieldChange[] = []
  for (const field of fields) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
      changes.push({ field, before: before[field] ?? null, after: after[field] ?? null })
    }
  }
  return changes
}

/** Кто и в каком проекте меняет. */
export interface ChangeAuthor {
  db: Kysely<Database>
  projectId: string
  /** `user.id`; null — ключ API или система. */
  actorId: string | null
  /** Автор — ключ API (тикет crm-api/01); тогда `actorId` — null. */
  actorApiKeyId?: string | null
}

/**
 * Пишет изменения записи `entity` одной вставкой. `db` — транзакция проекта (withProject):
 * row-level security пропустит строки только с `projectId` текущего проекта.
 */
export async function recordChanges(
  author: ChangeAuthor,
  entity: { type: ChangeLogEntity; id: string },
  changes: readonly FieldChange[],
): Promise<void> {
  if (changes.length === 0) return
  await author.db
    .insertInto('change_log')
    .values(
      changes.map((change) => ({
        project_id: author.projectId,
        actor_id: author.actorId,
        actor_api_key_id: author.actorApiKeyId ?? null,
        entity_type: entity.type,
        entity_id: entity.id,
        field: change.field,
        before: JSON.stringify(change.before ?? null),
        after: JSON.stringify(change.after ?? null),
      })),
    )
    .execute()
}

/**
 * Окончательно удаляет запись из корзины вместе с её историей (в «было → стало» лежат
 * персональные данные) — функцией базы purge_from_trash: у роли приложения нет права DELETE на
 * эти таблицы. Запись не в корзине текущего проекта — ошибка базы (SQLSTATE CL001).
 */
export async function purgeFromTrash(
  author: ChangeAuthor,
  entity: { type: ChangeLogEntity; id: string },
): Promise<void> {
  await sql`select purge_from_trash(${entity.type}, ${entity.id}::uuid)`.execute(author.db)
}
