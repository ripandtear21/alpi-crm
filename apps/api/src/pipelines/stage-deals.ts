import type { Database } from '@alpi/db'
import type { Kysely } from 'kysely'

// Правило «этап с открытыми сделками удалить нельзя» (тикет crm-deals/02, проверка — тикет 05).
// Открытая сделка — статус open; архивная открытая сделка тоже стоит на этапе (архив —
// отметка, а не статус), и открытая сделка в корзине — тоже: иначе после удаления этапа её
// нельзя было бы восстановить (открытая сделка стоит только на действующем этапе), а сама
// CRM сделку на другой этап не переставляет (ADR 0003). Решено без владельца — подтвердить.
// Сделка не встанет на этап, пока его удаляют: API блокирует строку этапа (FOR UPDATE) до
// вызова проверки, а сделка, становясь открытой на этапе, берёт FOR SHARE на него (триггер
// deal_stage_live, migrations/0010_deals.ts).

/** Есть ли открытые сделки на этапе в текущем проекте. */
export interface StageDealsChecker {
  /** `db` — транзакция проекта (row-level security показывает только его сделки). */
  hasOpenDeals(db: Kysely<Database>, stageId: string): Promise<boolean>
}

/** Открытые сделки этапа — по таблице deal, в том числе в архиве и в корзине, кроме слитых. */
export const OPEN_STAGE_DEALS: StageDealsChecker = {
  async hasOpenDeals(db, stageId) {
    const row = await db
      .selectFrom('deal')
      .select('id')
      .where('stage_id', '=', stageId)
      .where('status', '=', 'open')
      // Слитая сделка скрыта и этап не держит (тикет crm-intake/02): откат слияния открытой
      // сделки с удалённого этапа отвечает 409 STAGE_DELETED (apps/api/src/merge/deals.ts).
      .where('merged_into_id', 'is', null)
      .limit(1)
      .executeTakeFirst()
    return row !== undefined
  },
}
