// Воронки, этапы и справочник причин проигрыша в ответах API (тикет crm-deals/02):
// `/api/v1/pipelines`, `/api/v1/pipelines/:id/stages`, `/api/v1/lost-reasons`.

/** Код воронки: латиница в нижнем регистре, цифры, `-` и `_`; уникален в проекте. */
export const PIPELINE_CODE = /^[a-z][a-z0-9_-]{0,39}$/

/** Наибольшая длина названия воронки, этапа, группы и причины. */
export const MAX_DIRECTORY_NAME_LENGTH = 80

/** Этап воронки. Удалённые этапы в ответы не попадают. */
export interface StageSummary {
  id: string
  pipelineId: string
  name: string
  /** Порядок в воронке: 1, 2, 3… */
  position: number
}

/** Воронка проекта со своими этапами по порядку. */
export interface PipelineSummary {
  id: string
  code: string
  name: string
  position: number
  /** «Воронка допродаж»: не больше одной в проекте. */
  isUpsell: boolean
  /** Время архивации в ISO 8601; null — воронка действует. */
  archivedAt: string | null
  stages: StageSummary[]
}

/** Причина проигрыша. Архивная не предлагается при проигрыше, но остаётся у старых сделок. */
export interface LostReasonSummary {
  id: string
  groupId: string
  name: string
  position: number
  archivedAt: string | null
}

/** Группа причин проигрыша со своими причинами по порядку. */
export interface LostReasonGroupSummary {
  id: string
  name: string
  position: number
  archivedAt: string | null
  reasons: LostReasonSummary[]
}

/** Коды ошибок API воронок и причин проигрыша (вдобавок к PERMISSION_DENIED). */
export type PipelinesErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  /** Воронка с таким кодом в проекте уже есть. */
  | 'PIPELINE_CODE_TAKEN'
  /** «Воронка допродаж» в проекте уже отмечена. */
  | 'UPSELL_PIPELINE_EXISTS'
  /** На этапе есть открытые сделки: удалить нельзя, пока их не перенесли. */
  | 'STAGE_HAS_OPEN_DEALS'
  /** Новый порядок — не ровно те же записи. */
  | 'INVALID_ORDER'
  | 'LOST_REASON_GROUP_NAME_TAKEN'
  | 'LOST_REASON_NAME_TAKEN'
