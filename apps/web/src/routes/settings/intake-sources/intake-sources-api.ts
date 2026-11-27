import type {
  InboundOutcome,
  InboundReplayQueued,
  InboundReplayStatus,
  InboundRequestView,
  IntakeSourceCreateInput,
  IntakeSourceSummary,
  IntakeSourceWithKey,
  Page,
  PipelineSummary,
  ProjectAccess,
} from '@alpi/shared'
import { projectHeaders } from '../../../components/project-switcher/projects-api.ts'
import { RolesApiError } from '../roles-api.ts'

// Запросы экрана «Налаштування → Джерела» (тикет crm-intake/07) к API источников регистраций
// (тикет 03, apps/api/src/intake/sources.ts), журнала входящих и «провести заново» (тикет 06,
// intake/replay.ts): в контексте проекта, по сессии. Отказ — RolesApiError с кодом ответа, как у
// остальных экранов настроек. Ключ источника приходит только в ответе на создание и смену ключа
// и нигде не сохраняется.

/** Фильтр журнала входящих источника: итог и курсор страницы. */
export interface InboundQuery {
  outcome?: InboundOutcome
  cursor?: string
}

export interface IntakeSourcesApi {
  access(projectId: string): Promise<ProjectAccess>
  list(projectId: string): Promise<IntakeSourceSummary[]>
  /** Воронки проекта: для выбора воронки нового источника. */
  pipelines(projectId: string): Promise<PipelineSummary[]>
  create(projectId: string, input: IntakeSourceCreateInput): Promise<IntakeSourceWithKey>
  reissueKey(projectId: string, sourceId: string): Promise<IntakeSourceWithKey>
  disable(projectId: string, sourceId: string): Promise<IntakeSourceSummary>
  enable(projectId: string, sourceId: string): Promise<IntakeSourceSummary>
  /** Журнал входящих источника за 30 дней: новые сверху, с сырым телом. */
  requests(
    projectId: string,
    sourceId: string,
    query: InboundQuery,
  ): Promise<Page<InboundRequestView>>
  /** Последний запуск «провести заново»; null — пользователь не администратор проекта (403). */
  replayStatus(projectId: string): Promise<InboundReplayStatus | null>
  /** «Провести заново вхідні з моменту `since`» (ISO): задача ставится в очередь. */
  replay(projectId: string, since: string): Promise<InboundReplayQueued>
}

export function createIntakeSourcesApi(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): IntakeSourcesApi {
  async function send<T>(
    projectId: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers = projectHeaders(projectId)
    if (body !== undefined) headers.set('content-type', 'application/json')
    const res = await fetchImpl(`/api${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { code?: unknown } | null
      throw new RolesApiError(res.status, typeof payload?.code === 'string' ? payload.code : '')
    }
    return (await res.json()) as T
  }

  const base = '/v1/intake-sources'
  return {
    access: (projectId) => send(projectId, 'GET', '/project/access'),
    list: (projectId) => send(projectId, 'GET', base),
    pipelines: (projectId) => send(projectId, 'GET', '/v1/pipelines'),
    create: (projectId, input) => send(projectId, 'POST', base, input),
    reissueKey: (projectId, id) => send(projectId, 'POST', `${base}/${id}/reissue-key`),
    disable: (projectId, id) => send(projectId, 'POST', `${base}/${id}/disable`),
    enable: (projectId, id) => send(projectId, 'POST', `${base}/${id}/enable`),
    requests: (projectId, id, query) => {
      const params = new URLSearchParams()
      if (query.outcome) params.set('outcome', query.outcome)
      if (query.cursor) params.set('cursor', query.cursor)
      const search = params.toString()
      return send(projectId, 'GET', `${base}/${id}/requests${search ? `?${search}` : ''}`)
    },
    replayStatus: async (projectId) => {
      try {
        return await send<InboundReplayStatus>(projectId, 'GET', '/v1/inbound/replay')
      } catch (error) {
        if (error instanceof RolesApiError && error.status === 403) return null
        throw error
      }
    },
    replay: (projectId, since) => send(projectId, 'POST', '/v1/inbound/replay', { since }),
  }
}
