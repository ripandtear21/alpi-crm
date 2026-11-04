import type { Database } from '@alpi/db'
import type { Kysely } from 'kysely'

// Правило «нельзя отключить участника с открытыми сделками, пока они не переданы» (spec.md,
// раздел 4, «Уход сотрудника»). Сделок ещё нет: интерфейс реализует эпик сделок, а до него
// действует заглушка «открытых сделок нет».

/** Есть ли у участника открытые сделки в текущем проекте. */
export interface OpenDealsChecker {
  /** `db` — транзакция проекта (row-level security показывает только его сделки). */
  hasOpenDeals(db: Kysely<Database>, userId: string): Promise<boolean>
}

/** Заглушка до эпика сделок: открытых сделок нет ни у кого. */
export const NO_OPEN_DEALS: OpenDealsChecker = {
  async hasOpenDeals() {
    return false
  },
}
