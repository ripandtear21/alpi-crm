import type { Database } from '@alpi/db'
import type { Kysely } from 'kysely'

// Правило «этап с открытыми сделками удалить нельзя» (тикет crm-deals/02, проверка — тикет 05).
// Открытая сделка — статус open и не в корзине; архивная открытая сделка тоже стоит на этапе
// (архив — отметка, а не статус). Сделка не встанет на этап, пока его удаляют: API блокирует
// строку этапа (FOR UPDATE) до вызова проверки, а сделка, становясь открытой на этапе, берёт
// FOR SHARE на него (триггер deal_stage_live, migrations/0010_deals.ts).

/** Есть ли открытые сделки на этапе в текущем проекте. */
export interface StageDealsChecker {
  /** `db` — транзакция проекта (row-level security показывает только его сделки). */
  hasOpenDeals(db: Kysely<Database>, stageId: string): Promise<boolean>
}

/** Открытые сделки этапа — по таблице deal. */
export const OPEN_STAGE_DEALS: StageDealsChecker = {
  async hasOpenDeals(db, stageId) {
    const row = await db
      .selectFrom('deal')
      .select('id')
      .where('stage_id', '=', stageId)
      .where('status', '=', 'open')
      .where('deleted_at', 'is', null)
      .limit(1)
      .executeTakeFirst()
    return row !== undefined
  },
}
