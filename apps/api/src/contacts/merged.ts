import type { Database } from '@alpi/db'
import type { Scope } from '@alpi/shared'
import type { Kysely } from 'kysely'
import type { Viewer } from '../roles/scope.ts'
import { type Refusal, refuse } from './http.ts'
import { contactScopePredicate } from './scope.ts'

// Слитый контакт по id (тикет crm-intake/01, пункт 25; ADR 0005): запрос к нему по ключу или
// сессии — 404 с кодом CONTACT_MERGED и id оставшегося контакта. В цепочке (A слит в B, B потом
// в C) — id последнего оставшегося. Кроме него в ответе — слияние, которое скрыло этот контакт,
// и до какого времени его можно откатить: экран «Контакт об'єднано з X» показывает по ним кнопку
// отката.
//
// Оставшийся вне охвата чтения пользователя — обычный 404 CONTACT_NOT_FOUND: ответ не выдаёт
// ни слияния, ни id чужого контакта (решено без владельца — подтвердить).

/** Наибольшая длина цепочки слияний, которую идём до конца: защита от цикла в данных. */
const MAX_CHAIN = 100

/** Подробности ответа 404 CONTACT_MERGED. */
export interface ContactMergedDetails {
  /** Последний оставшийся контакт цепочки. */
  merged_into_id: string
  /** Слияние, которое скрыло запрошенный контакт. */
  merge_id: string | null
  /** До какого времени слияние можно откатить (ISO 8601); null — слияния нет. */
  undo_until: string | null
}

/**
 * Отказ для контакта `id`, если он слит с другим: 404 CONTACT_MERGED (оставшийся в охвате
 * чтения `scope`, в корзине или нет) или 404 CONTACT_NOT_FOUND. null — контакт не слит или его
 * нет: решает вызывающий.
 */
export async function mergedContactRefusal(
  db: Kysely<Database>,
  id: string,
  scope: Scope,
  viewer: Viewer,
): Promise<Refusal<'CONTACT_MERGED' | 'CONTACT_NOT_FOUND'> | null> {
  const row = await db
    .selectFrom('contact')
    .select('merged_into_id')
    .where('id', '=', id)
    .executeTakeFirst()
  if (!row?.merged_into_id) return null
  let last = row.merged_into_id
  for (let step = 0; step < MAX_CHAIN; step++) {
    const next = await db
      .selectFrom('contact')
      .select('merged_into_id')
      .where('id', '=', last)
      .executeTakeFirst()
    if (!next?.merged_into_id) break
    last = next.merged_into_id
  }
  const visible = await db
    .selectFrom('contact')
    .select('id')
    .where('id', '=', last)
    .where((eb) => contactScopePredicate(eb, scope, viewer))
    .executeTakeFirst()
  if (!visible) return refuse(404, 'CONTACT_NOT_FOUND')
  const merge = await db
    .selectFrom('merge_record')
    .select(['id', 'undo_until'])
    .where('entity_type', '=', 'contact')
    .where('merged_id', '=', id)
    .where('undone_at', 'is', null)
    .orderBy('merged_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  const details: ContactMergedDetails = {
    merged_into_id: last,
    merge_id: merge?.id ?? null,
    undo_until: merge ? new Date(merge.undo_until).toISOString() : null,
  }
  return refuse(404, 'CONTACT_MERGED', { ...details })
}
