import type {
  FieldDefinitionSummary,
  KanbanCardFields,
  LostReasonGroupSummary,
  LostReasonSummary,
  PipelineSummary,
  StageSummary,
} from '@alpi/shared'
import { projectHeaders } from '../../components/project-switcher/projects-api.ts'
import { RolesApiError } from './roles-api.ts'

// Запросы воронок, этапов и причин проигрыша к API (apps/api/src/pipelines/pipelines.ts,
// apps/api/src/lost-reasons/lost-reasons.ts): `/api/v1/...`, все — в контексте проекта.
// Отказ — RolesApiError с кодом ответа, как у остальных экранов настроек.

export interface PipelineInput {
  name: string
  code: string
  isUpsell?: boolean
}

export interface PipelineChange {
  name?: string
  code?: string
  isUpsell?: boolean
  archived?: boolean
}

/** Изменение группы или причины проигрыша. */
export interface DirectoryChange {
  name?: string
  archived?: boolean
}

export interface PipelinesApi {
  list(projectId: string): Promise<PipelineSummary[]>
  create(projectId: string, input: PipelineInput): Promise<PipelineSummary>
  update(projectId: string, pipelineId: string, change: PipelineChange): Promise<PipelineSummary>
  reorder(projectId: string, ids: string[]): Promise<PipelineSummary[]>
  createStage(projectId: string, pipelineId: string, name: string): Promise<StageSummary>
  renameStage(
    projectId: string,
    pipelineId: string,
    stageId: string,
    name: string,
  ): Promise<StageSummary>
  reorderStages(projectId: string, pipelineId: string, ids: string[]): Promise<StageSummary[]>
  removeStage(projectId: string, pipelineId: string, stageId: string): Promise<void>
  /** Пользовательские поля сделки, видимые пользователю, без архивных (тикет crm-fields/07). */
  dealFields(projectId: string): Promise<FieldDefinitionSummary[]>
  /** Поля карточки канбана воронки (до 3). */
  cardFields(projectId: string, pipelineId: string): Promise<KanbanCardFields>
  setCardFields(
    projectId: string,
    pipelineId: string,
    fieldIds: string[],
  ): Promise<KanbanCardFields>
  listLostReasons(projectId: string): Promise<LostReasonGroupSummary[]>
  createGroup(projectId: string, name: string): Promise<LostReasonGroupSummary>
  updateGroup(
    projectId: string,
    groupId: string,
    change: DirectoryChange,
  ): Promise<LostReasonGroupSummary>
  reorderGroups(projectId: string, ids: string[]): Promise<LostReasonGroupSummary[]>
  createReason(projectId: string, groupId: string, name: string): Promise<LostReasonSummary>
  updateReason(
    projectId: string,
    reasonId: string,
    change: DirectoryChange,
  ): Promise<LostReasonSummary>
  reorderReasons(projectId: string, groupId: string, ids: string[]): Promise<LostReasonGroupSummary>
}

export function createPipelinesApi(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): PipelinesApi {
  async function send<T>(
    projectId: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers = projectHeaders(projectId)
    if (body !== undefined) headers.set('content-type', 'application/json')
    const res = await fetchImpl(`/api/v1${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { code?: unknown } | null
      throw new RolesApiError(res.status, typeof payload?.code === 'string' ? payload.code : '')
    }
    return (res.status === 204 ? undefined : await res.json()) as T
  }

  const stages = (pipelineId: string) => `/pipelines/${pipelineId}/stages`
  return {
    list: (projectId) => send(projectId, 'GET', '/pipelines'),
    create: (projectId, input) => send(projectId, 'POST', '/pipelines', input),
    update: (projectId, pipelineId, change) =>
      send(projectId, 'PUT', `/pipelines/${pipelineId}`, change),
    reorder: (projectId, ids) => send(projectId, 'PUT', '/pipelines/order', { ids }),
    createStage: (projectId, pipelineId, name) =>
      send(projectId, 'POST', stages(pipelineId), { name }),
    renameStage: (projectId, pipelineId, stageId, name) =>
      send(projectId, 'PUT', `${stages(pipelineId)}/${stageId}`, { name }),
    reorderStages: (projectId, pipelineId, ids) =>
      send(projectId, 'PUT', `${stages(pipelineId)}/order`, { ids }),
    removeStage: (projectId, pipelineId, stageId) =>
      send(projectId, 'DELETE', `${stages(pipelineId)}/${stageId}`),
    dealFields: (projectId) => send(projectId, 'GET', '/fields?entity=deal'),
    cardFields: (projectId, pipelineId) =>
      send(projectId, 'GET', `/pipelines/${pipelineId}/card-fields`),
    setCardFields: (projectId, pipelineId, fieldIds) =>
      send(projectId, 'PUT', `/pipelines/${pipelineId}/card-fields`, { fieldIds }),
    listLostReasons: (projectId) => send(projectId, 'GET', '/lost-reasons'),
    createGroup: (projectId, name) => send(projectId, 'POST', '/lost-reasons/groups', { name }),
    updateGroup: (projectId, groupId, change) =>
      send(projectId, 'PUT', `/lost-reasons/groups/${groupId}`, change),
    reorderGroups: (projectId, ids) =>
      send(projectId, 'PUT', '/lost-reasons/groups/order', { ids }),
    createReason: (projectId, groupId, name) =>
      send(projectId, 'POST', '/lost-reasons', { groupId, name }),
    updateReason: (projectId, reasonId, change) =>
      send(projectId, 'PUT', `/lost-reasons/${reasonId}`, change),
    reorderReasons: (projectId, groupId, ids) =>
      send(projectId, 'PUT', `/lost-reasons/groups/${groupId}/order`, { ids }),
  }
}
