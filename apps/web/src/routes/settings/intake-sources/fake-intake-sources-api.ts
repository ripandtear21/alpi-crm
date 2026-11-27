import {
  fullPermissions,
  type InboundReplayStatus,
  type InboundRequestView,
  type IntakeSourceSummary,
  type PipelineSummary,
  type RolePermissions,
} from '@alpi/shared'
import { RolesApiError } from '../roles-api.ts'
import type { IntakeSourcesApi } from './intake-sources-api.ts'

// Подставной клиент экрана «Джерела» для тестов и снимков экрана: источники, журнал входящих и
// «провести заново» в памяти; ключи, имена, телефоны и email выдуманные. `permissions` — права
// пользователя; `isAdmin` — администратор ли он (иначе ход «провести заново» отвечает 403, как
// API); `replayRunningPolls` — сколько запросов хода после запуска задача ещё «идёт»;
// `replayFails` — задача кончается сбоем («не завершилось»); `replayStatusError` — запрос хода
// отвечает этим кодом (не 403); `calls` — что вызывали.

export interface FakeIntakeSourcesApi extends IntakeSourcesApi {
  sources: IntakeSourceSummary[]
  journal: Map<string, InboundRequestView[]>
  calls: { method: string; sourceId?: string; input?: unknown }[]
  /** Ключи, которые выдал подставной API (создание и смена ключа). */
  issuedKeys: string[]
}

const AUTHOR = { id: 'user-1', name: 'Ірина Тестова' }
const DAY_MS = 24 * 60 * 60 * 1000

let counter = 0
function fakeUuid(prefix: string): string {
  counter += 1
  return `00000000-0000-4000-${prefix}-${String(counter).padStart(12, '0')}`
}

/** Выдуманный ключ нужной формы: `alpi_src_` и 43 символа; первые 12 у каждого свои. */
function fakeKey(): string {
  counter += 1
  return `alpi_src_${String(counter % 1000).padStart(3, '0')}${'k'.repeat(40)}`
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

function pipeline(name: string, archivedAt: string | null = null): PipelineSummary {
  return {
    id: fakeUuid('9700'),
    code: name,
    name,
    position: 1,
    isUpsell: false,
    archivedAt,
    stages: [],
  }
}

function source(
  name: string,
  pipelineOf: PipelineSummary,
  extra: Partial<IntakeSourceSummary> = {},
): IntakeSourceSummary {
  return {
    id: fakeUuid('9800'),
    name,
    pipeline: { id: pipelineOf.id, name: pipelineOf.name },
    keyPrefix: fakeKey().slice(0, 12),
    createdAt: ago(10 * DAY_MS),
    createdBy: AUTHOR,
    lastUsedAt: null,
    disabledAt: null,
    disabledBy: null,
    ...extra,
  }
}

function request(
  sourceId: string,
  receivedAt: string,
  fields: Partial<InboundRequestView> & Pick<InboundRequestView, 'outcome' | 'statusCode' | 'body'>,
): InboundRequestView {
  return {
    id: fakeUuid('9900'),
    channel: 'intake.registration',
    sourceId,
    receivedAt,
    errorCode: null,
    eventId: null,
    result: null,
    warnings: [],
    replayOf: null,
    ...fields,
  }
}

/** Журнал источника: принятый запрос, его повтор, ошибка и проведённый заново (новые сверху). */
function sampleJournal(sourceId: string): InboundRequestView[] {
  const ids = {
    registration_id: '00000000-0000-4000-9a00-000000000001',
    contact_id: '00000000-0000-4000-9a00-000000000002',
    deal_id: '00000000-0000-4000-9a00-000000000003',
  }
  const acceptedBody =
    '{"event_id":"form-0001","phone":"+380501234567","name":"Олена Тестова","form":"Вебінар"}'
  const accepted = request(sourceId, ago(3 * 60 * 60 * 1000), {
    outcome: 'accepted',
    statusCode: 201,
    eventId: 'form-0001',
    body: acceptedBody,
    result: ids,
    warnings: ['OWNER_NOT_FOUND'],
  })
  const repeat = request(sourceId, ago(2 * 60 * 60 * 1000), {
    outcome: 'repeat',
    statusCode: 200,
    eventId: 'form-0001',
    body: acceptedBody,
    result: ids,
  })
  const error = request(sourceId, ago(60 * 60 * 1000), {
    outcome: 'error',
    statusCode: 400,
    errorCode: 'CONTACT_KEYS_REQUIRED',
    eventId: 'form-0002',
    body: '{"event_id":"form-0002","name":"Без телефону"}',
  })
  const replayed = request(sourceId, ago(10 * 60 * 1000), {
    outcome: 'repeat',
    statusCode: 200,
    eventId: 'form-0001',
    body: acceptedBody,
    result: ids,
    replayOf: accepted.id,
  })
  return [replayed, error, repeat, accepted]
}

export function fakeIntakeSourcesApi({
  permissions = fullPermissions(),
  isAdmin = true,
  replayRunningPolls = 0,
  replayFails = false,
  replayStatusError = null,
}: {
  permissions?: RolePermissions
  isAdmin?: boolean
  replayRunningPolls?: number
  replayFails?: boolean
  replayStatusError?: number | null
} = {}): FakeIntakeSourcesApi {
  const sales = pipeline('Продажі')
  const archived = pipeline('Стара воронка', ago(DAY_MS))
  const webinar = source('Лендинг вебінару', sales, { lastUsedAt: ago(10 * 60 * 1000) })
  const tilda = source('Tilda: старі форми', sales, {
    disabledAt: ago(2 * DAY_MS),
    disabledBy: AUTHOR,
  })
  const sources = [webinar, tilda]
  const journal = new Map<string, InboundRequestView[]>([
    [webinar.id, sampleJournal(webinar.id)],
    [tilda.id, []],
  ])
  const calls: FakeIntakeSourcesApi['calls'] = []
  const issuedKeys: string[] = []
  let replay: InboundReplayStatus = { latest: null }
  let runningPolls = 0

  const find = (id: string) => {
    const found = sources.find((s) => s.id === id)
    if (!found) throw new RolesApiError(404, 'INTAKE_SOURCE_NOT_FOUND')
    return found
  }
  const issue = (target: IntakeSourceSummary) => {
    const key = fakeKey()
    issuedKeys.push(key)
    target.keyPrefix = key.slice(0, 12)
    return { source: { ...target }, key }
  }

  return {
    sources,
    journal,
    calls,
    issuedKeys,
    access: async () => ({ userId: AUTHOR.id, permissions }),
    list: async () => sources.map((s) => ({ ...s })),
    pipelines: async () => [sales, archived],
    create: async (_projectId, input) => {
      calls.push({ method: 'create', input })
      if (sources.some((s) => s.name === input.name)) {
        throw new RolesApiError(409, 'INTAKE_SOURCE_NAME_TAKEN')
      }
      const chosen = [sales, archived].find((p) => p.id === input.pipelineId) ?? sales
      const created = source(input.name, chosen, { createdAt: new Date().toISOString() })
      sources.unshift(created)
      journal.set(created.id, [])
      return issue(created)
    },
    reissueKey: async (_projectId, id) => {
      calls.push({ method: 'reissueKey', sourceId: id })
      return issue(find(id))
    },
    disable: async (_projectId, id) => {
      calls.push({ method: 'disable', sourceId: id })
      const target = find(id)
      if (target.disabledAt) throw new RolesApiError(409, 'INTAKE_SOURCE_DISABLED')
      target.disabledAt = new Date().toISOString()
      target.disabledBy = AUTHOR
      return { ...target }
    },
    enable: async (_projectId, id) => {
      calls.push({ method: 'enable', sourceId: id })
      const target = find(id)
      if (!target.disabledAt) throw new RolesApiError(409, 'INTAKE_SOURCE_ENABLED')
      target.disabledAt = null
      target.disabledBy = null
      return { ...target }
    },
    requests: async (_projectId, id, query) => {
      calls.push({ method: 'requests', sourceId: id, input: query })
      const rows = (journal.get(id) ?? []).filter(
        (row) => !query.outcome || row.outcome === query.outcome,
      )
      return { data: rows, next_cursor: null }
    },
    replayStatus: async () => {
      calls.push({ method: 'replayStatus' })
      if (replayStatusError !== null) throw new RolesApiError(replayStatusError, '')
      if (!isAdmin) return null
      const latest = replay.latest
      if (latest && latest.finishedAt === null) {
        if (runningPolls > 0) {
          runningPolls -= 1
        } else {
          replay = {
            latest: {
              ...latest,
              finishedAt: new Date().toISOString(),
              failed: replayFails,
              counts: replayFails ? null : { accepted: 1, repeats: 3, errors: 1 },
            },
          }
        }
      }
      return replay
    },
    replay: async (_projectId, since) => {
      calls.push({ method: 'replay', input: since })
      if (!isAdmin) throw new RolesApiError(403, 'PERMISSION_DENIED')
      if (Date.parse(since) < Date.now() - 30 * DAY_MS) {
        throw new RolesApiError(422, 'REPLAY_TOO_OLD')
      }
      const until = new Date().toISOString()
      runningPolls = replayRunningPolls
      replay = {
        latest: {
          since,
          until,
          startedAt: until,
          startedBy: AUTHOR,
          finishedAt: null,
          failed: false,
          counts: null,
        },
      }
      return { since, until }
    },
  }
}
