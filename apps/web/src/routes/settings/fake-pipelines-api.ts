import type {
  LostReasonGroupSummary,
  LostReasonSummary,
  PipelineSummary,
  StageSummary,
} from '@alpi/shared'
import type { PipelinesApi } from './pipelines-api.ts'
import { RolesApiError } from './roles-api.ts'

// Подставной клиент воронок и причин проигрыша для тестов: данные в памяти, как их отдаёт API
// (порядок, архив, удалённые этапы не видны). `deny` — ответ 403, как без права «сделки:
// смотреть»; `failNextWith` — следующее изменение отклоняется с этим кодом (409).

export interface FakePipelinesApi extends PipelinesApi {
  pipelines: PipelineSummary[]
  groups: LostReasonGroupSummary[]
  failNextWith: string | null
}

let counter = 0
function fakeId(): string {
  counter += 1
  return `00000000-0000-4000-9000-${String(counter).padStart(12, '0')}`
}

function renumber<T extends { position: number }>(items: T[]): T[] {
  items.forEach((item, index) => {
    item.position = index + 1
  })
  return items
}

function arrange<T extends { id: string; position: number }>(items: T[], ids: string[]): T[] {
  if (ids.length !== items.length) throw new RolesApiError(400, 'INVALID_ORDER')
  const byId = new Map(items.map((item) => [item.id, item]))
  const ordered = ids.map((id) => {
    const item = byId.get(id)
    if (!item) throw new RolesApiError(400, 'INVALID_ORDER')
    return item
  })
  return renumber(ordered)
}

function stage(pipelineId: string, name: string, position: number): StageSummary {
  return { id: fakeId(), pipelineId, name, position }
}

/** Проект с воронкой «ALPI» из трёх этапов и группой причин «Якість ліда». */
export function fakePipelinesApi({ deny = false }: { deny?: boolean } = {}): FakePipelinesApi {
  const alpiId = fakeId()
  const groupId = fakeId()
  const reason = (name: string, position: number): LostReasonSummary => ({
    id: fakeId(),
    groupId,
    name,
    position,
    archivedAt: null,
  })

  function failIfAsked() {
    const code = api.failNextWith
    if (code) {
      api.failNextWith = null
      throw new RolesApiError(409, code)
    }
  }

  function pipeline(id: string): PipelineSummary {
    const found = api.pipelines.find((p) => p.id === id)
    if (!found) throw new RolesApiError(404, 'NOT_FOUND')
    return found
  }

  function group(id: string): LostReasonGroupSummary {
    const found = api.groups.find((g) => g.id === id)
    if (!found) throw new RolesApiError(404, 'NOT_FOUND')
    return found
  }

  const api: FakePipelinesApi = {
    pipelines: [
      {
        id: alpiId,
        code: 'alpi',
        name: 'ALPI',
        position: 1,
        isUpsell: false,
        archivedAt: null,
        stages: [
          stage(alpiId, 'Новий лід', 1),
          stage(alpiId, 'Передано в роботу', 2),
          stage(alpiId, 'Був на вебінарі', 3),
        ],
      },
    ],
    groups: [
      {
        id: groupId,
        name: 'Якість ліда',
        position: 1,
        archivedAt: null,
        reasons: [reason('Не дозвон', 1), reason('Не актуально', 2)],
      },
    ],
    failNextWith: null,
    async list() {
      if (deny) throw new RolesApiError(403, 'PERMISSION_DENIED')
      return structuredClone(api.pipelines)
    },
    async create(_projectId, input) {
      failIfAsked()
      if (api.pipelines.some((p) => p.code === input.code)) {
        throw new RolesApiError(409, 'PIPELINE_CODE_TAKEN')
      }
      const id = fakeId()
      const created: PipelineSummary = {
        id,
        code: input.code,
        name: input.name,
        position: api.pipelines.length + 1,
        isUpsell: input.isUpsell === true,
        archivedAt: null,
        stages: [],
      }
      api.pipelines.push(created)
      return structuredClone(created)
    },
    async update(_projectId, pipelineId, change) {
      failIfAsked()
      const found = pipeline(pipelineId)
      if (change.name !== undefined) found.name = change.name
      if (change.code !== undefined) found.code = change.code
      if (change.isUpsell !== undefined) found.isUpsell = change.isUpsell
      if (change.archived !== undefined) {
        found.archivedAt = change.archived ? '2026-11-04T12:00:00.000Z' : null
      }
      return structuredClone(found)
    },
    async reorder(_projectId, ids) {
      failIfAsked()
      api.pipelines = arrange(api.pipelines, ids)
      return structuredClone(api.pipelines)
    },
    async createStage(_projectId, pipelineId, name) {
      failIfAsked()
      const found = pipeline(pipelineId)
      const created = stage(pipelineId, name, found.stages.length + 1)
      found.stages.push(created)
      return structuredClone(created)
    },
    async renameStage(_projectId, pipelineId, stageId, name) {
      failIfAsked()
      const found = pipeline(pipelineId).stages.find((s) => s.id === stageId)
      if (!found) throw new RolesApiError(404, 'NOT_FOUND')
      found.name = name
      return structuredClone(found)
    },
    async reorderStages(_projectId, pipelineId, ids) {
      failIfAsked()
      const found = pipeline(pipelineId)
      found.stages = arrange(found.stages, ids)
      return structuredClone(found.stages)
    },
    async removeStage(_projectId, pipelineId, stageId) {
      failIfAsked()
      const found = pipeline(pipelineId)
      found.stages = renumber(found.stages.filter((s) => s.id !== stageId))
    },
    async listLostReasons() {
      if (deny) throw new RolesApiError(403, 'PERMISSION_DENIED')
      return structuredClone(api.groups)
    },
    async createGroup(_projectId, name) {
      failIfAsked()
      const created: LostReasonGroupSummary = {
        id: fakeId(),
        name,
        position: api.groups.length + 1,
        archivedAt: null,
        reasons: [],
      }
      api.groups.push(created)
      return structuredClone(created)
    },
    async updateGroup(_projectId, id, change) {
      failIfAsked()
      const found = group(id)
      if (change.name !== undefined) found.name = change.name
      if (change.archived !== undefined) {
        found.archivedAt = change.archived ? '2026-11-04T12:00:00.000Z' : null
      }
      return structuredClone(found)
    },
    async reorderGroups(_projectId, ids) {
      failIfAsked()
      api.groups = arrange(api.groups, ids)
      return structuredClone(api.groups)
    },
    async createReason(_projectId, id, name) {
      failIfAsked()
      const found = group(id)
      const created: LostReasonSummary = {
        id: fakeId(),
        groupId: id,
        name,
        position: found.reasons.length + 1,
        archivedAt: null,
      }
      found.reasons.push(created)
      return structuredClone(created)
    },
    async updateReason(_projectId, reasonId, change) {
      failIfAsked()
      const found = api.groups.flatMap((g) => g.reasons).find((r) => r.id === reasonId)
      if (!found) throw new RolesApiError(404, 'NOT_FOUND')
      if (change.name !== undefined) found.name = change.name
      if (change.archived !== undefined) {
        found.archivedAt = change.archived ? '2026-11-04T12:00:00.000Z' : null
      }
      return structuredClone(found)
    },
    async reorderReasons(_projectId, id, ids) {
      failIfAsked()
      const found = group(id)
      found.reasons = arrange(found.reasons, ids)
      return structuredClone(found)
    },
  }
  return api
}
