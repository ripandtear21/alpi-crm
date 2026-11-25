import type { FieldViewer } from '../fields/access.ts'
import { type MissingFields, missingRequired, NOTHING_MISSING } from '../fields/requirements.ts'
import type { CustomValues } from '../fields/values.ts'

// Требования этапа (тикет crm-deals/11; наполнил тикет crm-fields/04): какие поля сделки должны
// быть заполнены, чтобы поставить её на этап или выиграть. Спрашивают создание сделки, смена
// этапа, выигрыш и перенос в другую воронку (deals.ts); непустой ответ — 422
// STAGE_REQUIREMENTS_MISSING (details — RequiredFieldsMissing из packages/shared), сделка
// остаётся на месте. Правило одно для экрана и API (ADR 0003): экран показывает тот же список
// из ответа и открывает форму заполнения.

/** Куда ставится сделка: этап воронки или выигрыш (этап не меняется). */
export type StageTarget =
  | { pipelineId: string; stageId: string }
  | { pipelineId: string; won: true }

export interface StageRequirements {
  /**
   * Незаполненные поля, без которых сделка со значениями `custom` (после изменения) не
   * встанет в `target`. `viewer` — транзакция проекта и права того, кто действует: поля скрытых
   * от него групп — только числом.
   */
  missingFields(
    viewer: FieldViewer,
    target: StageTarget,
    custom: CustomValues,
  ): Promise<MissingFields>
}

/** Обязательность пользовательских полей (fields/requirements.ts) — по умолчанию в API. */
export const CUSTOM_FIELD_REQUIREMENTS: StageRequirements = {
  missingFields(viewer, target, custom) {
    return missingRequired(viewer, { entity: 'deal', ...target }, custom)
  },
}

/** Требований нет (тесты, которым обязательность не нужна). */
export const NO_STAGE_REQUIREMENTS: StageRequirements = {
  async missingFields() {
    return NOTHING_MISSING
  },
}
