import type {
  BulkJobProgress,
  CreatedMemberResponse,
  MemberSummary,
  TeamSummary,
  TransferDealsRequest,
} from '@alpi/shared'
import { projectHeaders } from '../../components/project-switcher/projects-api.ts'
import { RolesApiError } from './roles-api.ts'

// Запросы участников и команд проекта к API (apps/api/src/members, apps/api/src/teams). Все — в
// контексте проекта. Отказ — RolesApiError с кодом ответа, как у API ролей: экраны разбирают
// коды одинаково; подробности отказа (число открытых сделок) — в MembersApiError.

/** Отказ API участников с подробностями ответа (`details`), если они есть. */
export class MembersApiError extends RolesApiError {
  readonly details: Record<string, unknown> | null

  constructor(status: number, code: string, details: Record<string, unknown> | null = null) {
    super(status, code)
    this.details = details
  }
}

export interface NewMemberInput {
  email: string
  roleId: string
  teamId: string | null
}

export interface MembersApi {
  list(projectId: string): Promise<MemberSummary[]>
  /** Добавить существующую учётную запись по email. */
  addExisting(projectId: string, input: NewMemberInput): Promise<MemberSummary>
  /** Завести учётную запись с временным паролем: он в ответе, один раз. */
  create(
    projectId: string,
    input: NewMemberInput & { name: string },
  ): Promise<CreatedMemberResponse>
  setRole(projectId: string, userId: string, roleId: string): Promise<MemberSummary>
  setTeam(projectId: string, userId: string, teamId: string | null): Promise<MemberSummary>
  setAcceptsNewDeals(projectId: string, userId: string, value: boolean): Promise<MemberSummary>
  disable(projectId: string, userId: string): Promise<MemberSummary>
  enable(projectId: string, userId: string): Promise<MemberSummary>
  /** Передать открытые сделки участника массовой операцией; toUserId null — в общую очередь. */
  transferDeals(
    projectId: string,
    userId: string,
    input: TransferDealsRequest,
  ): Promise<BulkJobProgress>
  /** Ход массовой операции. */
  bulkJob(projectId: string, jobId: string): Promise<BulkJobProgress>
  listTeams(projectId: string): Promise<TeamSummary[]>
  createTeam(projectId: string, input: { name: string; leadUserId: string }): Promise<TeamSummary>
  updateTeam(
    projectId: string,
    teamId: string,
    input: { name?: string; leadUserId?: string },
  ): Promise<TeamSummary>
  removeTeam(projectId: string, teamId: string): Promise<void>
}

export function createMembersApi(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): MembersApi {
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
      const payload = (await res.json().catch(() => null)) as {
        code?: unknown
        details?: unknown
      } | null
      const details = payload?.details
      throw new MembersApiError(
        res.status,
        typeof payload?.code === 'string' ? payload.code : '',
        typeof details === 'object' && details !== null && !Array.isArray(details)
          ? (details as Record<string, unknown>)
          : null,
      )
    }
    return (res.status === 204 ? undefined : await res.json()) as T
  }

  const member = (userId: string) => `/members/${encodeURIComponent(userId)}`

  return {
    list: (projectId) => send(projectId, 'GET', '/members'),
    addExisting: (projectId, input) => send(projectId, 'POST', '/members', input),
    create: (projectId, input) => send(projectId, 'POST', '/members/new', input),
    setRole: (projectId, userId, roleId) =>
      send(projectId, 'PUT', `${member(userId)}/role`, { roleId }),
    setTeam: (projectId, userId, teamId) =>
      send(projectId, 'PUT', `${member(userId)}/team`, { teamId }),
    setAcceptsNewDeals: (projectId, userId, value) =>
      send(projectId, 'PUT', `${member(userId)}/accepts-new-deals`, { acceptsNewDeals: value }),
    disable: (projectId, userId) => send(projectId, 'POST', `${member(userId)}/disable`),
    enable: (projectId, userId) => send(projectId, 'POST', `${member(userId)}/enable`),
    transferDeals: (projectId, userId, input) =>
      send(projectId, 'POST', `/v1${member(userId)}/transfer-deals`, input),
    bulkJob: (projectId, jobId) =>
      send(projectId, 'GET', `/v1/bulk-jobs/${encodeURIComponent(jobId)}`),
    listTeams: (projectId) => send(projectId, 'GET', '/teams'),
    createTeam: (projectId, input) => send(projectId, 'POST', '/teams', input),
    updateTeam: (projectId, teamId, input) => send(projectId, 'PUT', `/teams/${teamId}`, input),
    removeTeam: (projectId, teamId) => send(projectId, 'DELETE', `/teams/${teamId}`),
  }
}
