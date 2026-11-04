import type { CreatedMemberResponse, MemberSummary, TeamSummary } from '@alpi/shared'
import { projectHeaders } from '../../components/project-switcher/projects-api.ts'
import { RolesApiError } from './roles-api.ts'

// Запросы участников и команд проекта к API (apps/api/src/members, apps/api/src/teams). Все — в
// контексте проекта. Отказ — RolesApiError с кодом ответа, как у API ролей: экраны разбирают
// коды одинаково.

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
      const payload = (await res.json().catch(() => null)) as { code?: unknown } | null
      throw new RolesApiError(res.status, typeof payload?.code === 'string' ? payload.code : '')
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
    listTeams: (projectId) => send(projectId, 'GET', '/teams'),
    createTeam: (projectId, input) => send(projectId, 'POST', '/teams', input),
    updateTeam: (projectId, teamId, input) => send(projectId, 'PUT', `/teams/${teamId}`, input),
    removeTeam: (projectId, teamId) => send(projectId, 'DELETE', `/teams/${teamId}`),
  }
}
