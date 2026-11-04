import type { Database } from '@alpi/db'
import type { Kysely } from 'kysely'

// Правило «этап с открытыми сделками удалить нельзя» (тикет crm-deals/02). Сделок ещё нет:
// настоящую проверку подключит тикет 05 эпика crm-deals, до него действует заглушка «открытых
// сделок нет». Тикет 05 должен ещё и не дать сделке встать на этап, пока его удаляют: API
// блокирует строку этапа (FOR UPDATE) до вызова проверки.

/** Есть ли открытые сделки на этапе в текущем проекте. */
export interface StageDealsChecker {
  /** `db` — транзакция проекта (row-level security показывает только его сделки). */
  hasOpenDeals(db: Kysely<Database>, stageId: string): Promise<boolean>
}

/** Заглушка до сделок (тикет 05): открытых сделок нет ни на одном этапе. */
export const NO_STAGE_DEALS: StageDealsChecker = {
  async hasOpenDeals() {
    return false
  },
}
