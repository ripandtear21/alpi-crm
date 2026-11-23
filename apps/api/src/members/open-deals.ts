import type { Database } from '@alpi/db'
import type { Kysely } from 'kysely'
import { openDealsOf } from '../deals/transfer.ts'

// Правило «нельзя отключить участника с открытыми сделками, пока они не переданы» (spec.md,
// раздел 4, «Уход сотрудника»; тикет crm-deals/09). Открытая сделка участника — он
// ответственный, статус open, в том числе в архиве (архив — отметка, а не статус); удалённые в
// корзину не считаются. Передаёт их POST /v1/members/:userId/transfer-deals (transfer.ts).

/** Сколько открытых сделок у участника в текущем проекте. */
export interface OpenDealsChecker {
  /** `db` — транзакция проекта (row-level security показывает только его сделки). */
  countOpenDeals(db: Kysely<Database>, userId: string): Promise<number>
}

/** Открытые сделки участника — по таблице deal. */
export const OPEN_MEMBER_DEALS: OpenDealsChecker = {
  async countOpenDeals(db, userId) {
    const row = await openDealsOf(db, userId)
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow()
    return Number(row.count)
  },
}
