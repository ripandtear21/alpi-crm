import type { Database } from '@alpi/db'
import type { Kysely } from 'kysely'

// Поиск совпадения контакта по ключам — телефону и email (тикет crm-deals/03). Сначала по
// телефону, затем по email; при конфликте (телефон — у одного контакта, email — у другого)
// выигрывает телефон, а ответ несёт признак конфликта. Его же позже использует приём
// регистраций.
//
// Ищет среди контактов текущего проекта (row-level security) вне корзины и не слитых с другим
// (тикет crm-intake/01: скрытый контакт совпадением не считается), без учёта охвата: что
// показать пользователю о найденном контакте, решает вызывающий.

/** Ключи поиска, уже нормализованные (normalizePhone, normalizeEmail из @alpi/shared). */
export interface ContactKeys {
  phones: readonly string[]
  emails: readonly string[]
}

export interface ContactMatch {
  contactId: string
  /** По какому ключу найден. */
  by: 'phone' | 'email'
  /** Телефон совпал с одним контактом, email — с другим. */
  conflict: boolean
}

/** Нулевой uuid: «исключить нечего» — такого id у контакта не бывает. */
const NO_CONTACT = '00000000-0000-0000-0000-000000000000'

/**
 * Первый по времени создания контакт с одним из телефонов, иначе — с одним из email.
 * `excludeId` — сам изменяемый контакт: совпадение с собой не совпадение.
 */
export async function findContactMatch(
  db: Kysely<Database>,
  keys: ContactKeys,
  options: { excludeId?: string } = {},
): Promise<ContactMatch | null> {
  const exclude = options.excludeId ?? NO_CONTACT
  const byPhone =
    keys.phones.length === 0
      ? undefined
      : await db
          .selectFrom('contact_phone as k')
          .innerJoin('contact as c', 'c.id', 'k.contact_id')
          .select('c.id')
          .where('k.phone', 'in', [...keys.phones])
          .where('c.deleted_at', 'is', null)
          .where('c.merged_into_id', 'is', null)
          .where('c.id', '<>', exclude)
          .orderBy('c.created_at')
          .orderBy('c.id')
          .limit(1)
          .executeTakeFirst()
  const byEmail =
    keys.emails.length === 0
      ? undefined
      : await db
          .selectFrom('contact_email as k')
          .innerJoin('contact as c', 'c.id', 'k.contact_id')
          .select('c.id')
          .where('k.email', 'in', [...keys.emails])
          .where('c.deleted_at', 'is', null)
          .where('c.merged_into_id', 'is', null)
          .where('c.id', '<>', exclude)
          .orderBy('c.created_at')
          .orderBy('c.id')
          .limit(1)
          .executeTakeFirst()
  if (byPhone) {
    return {
      contactId: byPhone.id,
      by: 'phone',
      conflict: byEmail !== undefined && byEmail.id !== byPhone.id,
    }
  }
  if (byEmail) return { contactId: byEmail.id, by: 'email', conflict: false }
  return null
}
