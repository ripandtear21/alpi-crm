import type { Database } from '@alpi/db'
import type { Scope } from '@alpi/shared'
import { type Kysely, sql } from 'kysely'
import { type Refusal, refuse } from '../contacts/http.ts'
import { contactScopePredicate } from '../contacts/scope.ts'
import { dealInScope } from '../deals/scope.ts'
import type { Viewer } from '../roles/scope.ts'
import type { MergeEntity } from './registry.ts'

// Слитая запись по id (тикет crm-intake/01, пункт 25; тикет crm-intake/02; ADR 0005) — одна
// функция для контактов и сделок (тикет crm-intake/12): запрос к ней по ключу или сессии — 404
// с кодом CONTACT_MERGED или DEAL_MERGED и id оставшейся записи. В цепочке (A слит в B, B потом
// в C) — id последней оставшейся. Кроме него в ответе — слияние, которое скрыло эту запись, и до
// какого времени его можно откатить: экран «об'єднано з X» показывает по ним кнопку отката.
//
// Оставшаяся вне охвата чтения пользователя — обычный 404 CONTACT_NOT_FOUND или DEAL_NOT_FOUND:
// ответ не выдаёт ни слияния, ни id чужой записи (решено без владельца — подтвердить).

/** Подробности ответа 404 CONTACT_MERGED и DEAL_MERGED. */
export interface MergedDetails {
  /** Последняя оставшаяся запись цепочки. */
  merged_into_id: string
  /**
   * Слияние, которое скрыло запрошенную запись; null — его нет или это слияние сделок, сделанное
   * вместе со слиянием контактов (тикет crm-intake/04): откатывается только с ним.
   */
  merge_id: string | null
  /** До какого времени слияние можно откатить (ISO 8601); null — слияния нет. */
  undo_until: string | null
}

/** Коды отказа по виду записи. */
interface MergedCodes {
  contact: 'CONTACT_MERGED' | 'CONTACT_NOT_FOUND'
  deal: 'DEAL_MERGED' | 'DEAL_NOT_FOUND'
}

const CODES = {
  contact: { merged: 'CONTACT_MERGED', notFound: 'CONTACT_NOT_FOUND' },
  deal: { merged: 'DEAL_MERGED', notFound: 'DEAL_NOT_FOUND' },
} as const

/**
 * Отказ для записи `id` вида `entity`, если она слита с другой: 404 CONTACT_MERGED или
 * DEAL_MERGED (последняя оставшаяся в охвате чтения `scope`, в корзине или нет) или 404
 * CONTACT_NOT_FOUND или DEAL_NOT_FOUND. null — запись не слита или её нет: решает вызывающий.
 */
export async function mergedRefusal<E extends MergeEntity>(
  db: Kysely<Database>,
  entity: E,
  id: string,
  scope: Scope,
  viewer: Viewer,
): Promise<Refusal<MergedCodes[E]> | null> {
  const codes = CODES[entity] as { merged: MergedCodes[E]; notFound: MergedCodes[E] }
  // Вся цепочка — одним рекурсивным запросом; `union` убирает повтор строки, так что и цикл в
  // данных (его быть не должно) запрос не зациклит.
  const { rows } = await sql<{ id: string; next: string | null }>`
    with recursive chain(id, next) as (
      select t.id, t.merged_into_id from ${sql.table(entity)} t where t.id = ${id}
      union
      select t.id, t.merged_into_id from ${sql.table(entity)} t join chain on t.id = chain.next
    )
    select id, next from chain
  `.execute(db)
  if (!rows.find((row) => row.id === id)?.next) return null
  const last = rows.find((row) => row.next === null)?.id
  if (last === undefined) return refuse(404, codes.notFound)
  const visible =
    entity === 'contact'
      ? await db
          .selectFrom('contact')
          .select('id')
          .where('id', '=', last)
          .where((eb) => contactScopePredicate(eb, scope, viewer))
          .executeTakeFirst()
      : await db
          .selectFrom('deal')
          .select('id')
          .where('id', '=', last)
          .where(dealInScope(sql.ref('deal.owner_id'), scope, viewer))
          .executeTakeFirst()
  if (!visible) return refuse(404, codes.notFound)
  const merge = await db
    .selectFrom('merge_record')
    .select(['id', 'undo_until'])
    .where('entity_type', '=', entity)
    .where('merged_id', '=', id)
    .where('undone_at', 'is', null)
    // Слияние сделок вместе со слиянием контактов (тикет crm-intake/04) отдельно не откатить: без
    // merge_id карточка скрытой сделки не предлагает откат. У слияний контактов parent_id нет.
    .where('parent_id', 'is', null)
    .orderBy('merged_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  const details: MergedDetails = {
    merged_into_id: last,
    merge_id: merge?.id ?? null,
    undo_until: merge ? new Date(merge.undo_until).toISOString() : null,
  }
  return refuse(404, codes.merged, { ...details })
}
