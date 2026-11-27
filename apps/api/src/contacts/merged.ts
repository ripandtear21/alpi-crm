import type { Database } from '@alpi/db'
import type { Scope } from '@alpi/shared'
import type { Kysely } from 'kysely'
import { mergedRefusal } from '../merge/merged.ts'
import type { Viewer } from '../roles/scope.ts'

// Слитый контакт по id (тикет crm-intake/01, пункт 25; ADR 0005): 404 CONTACT_MERGED с id
// последнего оставшегося контакта цепочки и слиянием, которое его скрыло. Обход цепочки и ответ
// — общие со сделками (merge/merged.ts, тикет crm-intake/12).

/**
 * Отказ для контакта `id`, если он слит с другим: 404 CONTACT_MERGED (оставшийся в охвате
 * чтения `scope`, в корзине или нет) или 404 CONTACT_NOT_FOUND. null — контакт не слит или его
 * нет: решает вызывающий.
 */
export function mergedContactRefusal(
  db: Kysely<Database>,
  id: string,
  scope: Scope,
  viewer: Viewer,
) {
  return mergedRefusal(db, 'contact', id, scope, viewer)
}
