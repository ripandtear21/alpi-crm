import type { Database } from '@alpi/db'
import type { Kysely } from 'kysely'
import type { DealRow } from './store.ts'

// Требования этапа (тикет crm-deals/11; spec.md эпика, «Не входит»): какие поля сделки должны
// быть заполнены, чтобы перейти на этап. Смена этапа (deals.ts, changeStage) спрашивает эту
// точку расширения; непустой список — ответ 422 STAGE_REQUIREMENTS_MISSING со списком полей,
// сделка остаётся на месте. Правило одно для экрана и API (ADR 0003): экран показывает тот же
// список из ответа. Пока пользовательских полей нет, требований нет; наполнит эпик полей.

export interface StageRequirements {
  /**
   * Незаполненные поля, без которых сделка `deal` не перейдёт на этап `stageId` (имена полей
   * ответа API: `expectedCloseDate`, `organizationId`…); пустой список — можно.
   * `db` — транзакция проекта.
   */
  missingFields(db: Kysely<Database>, deal: DealRow, stageId: string): Promise<string[]>
}

/** Требований нет. */
export const NO_STAGE_REQUIREMENTS: StageRequirements = {
  async missingFields() {
    return []
  },
}
