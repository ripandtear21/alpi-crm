import type { BulkJobProgress, MemberSummary, TeamSummary } from '@alpi/shared'
import { type MembersApi, MembersApiError } from './members-api.ts'
import { RolesApiError } from './roles-api.ts'

// Подставной клиент участников и команд для тестов: данные в памяти, вызовы записываются.
// Роли — id ролей-шаблонов подставного клиента ролей (fake-roles-api.ts).

export const ADMIN_ROLE_ID = '00000000-0000-4000-8000-000000000001'
export const MANAGER_ROLE_ID = '00000000-0000-4000-8000-000000000004'
export const TEAMLEAD_ROLE_ID = '00000000-0000-4000-8000-000000000003'

export interface FakeMembersApi extends MembersApi {
  calls: { method: string; args: unknown[] }[]
  /** Следующее изменение отклоняется с этим кодом (409). */
  failNextWith: string | null
  members: MemberSummary[]
  teams: TeamSummary[]
  /** Открытые сделки участников: отключение с ними — 409 HAS_OPEN_DEALS с числом. */
  openDeals: Record<string, number>
  /** Массовые операции передачи: id → ход, который вернёт bulkJob (сразу законченный). */
  jobs: Map<string, BulkJobProgress>
}

export function fakeMembersApi(): FakeMembersApi {
  let nextId = 1
  const api: FakeMembersApi = {
    calls: [],
    failNextWith: null,
    members: [
      {
        userId: 'user-1',
        email: 'owner@example.test',
        name: 'Власник',
        roleId: ADMIN_ROLE_ID,
        teamId: null,
        acceptsNewDeals: true,
        disabled: false,
      },
      {
        userId: 'user-2',
        email: 'olena@example.test',
        name: 'Олена',
        roleId: MANAGER_ROLE_ID,
        teamId: null,
        acceptsNewDeals: true,
        disabled: false,
      },
    ],
    teams: [],
    openDeals: {},
    jobs: new Map(),
    async list() {
      return structuredClone(api.members)
    },
    async addExisting(_projectId, input) {
      record('addExisting', input)
      const added: MemberSummary = {
        userId: `user-${100 + nextId++}`,
        email: input.email,
        name: input.email,
        roleId: input.roleId,
        teamId: input.teamId,
        acceptsNewDeals: true,
        disabled: false,
      }
      api.members.push(added)
      return structuredClone(added)
    },
    async create(_projectId, input) {
      record('create', input)
      const member: MemberSummary = {
        userId: `user-${100 + nextId++}`,
        email: input.email,
        name: input.name,
        roleId: input.roleId,
        teamId: input.teamId,
        acceptsNewDeals: true,
        disabled: false,
      }
      api.members.push(member)
      return { member: structuredClone(member), temporaryPassword: 'Tmp-Pass-1234567' }
    },
    setRole: (_p, userId, roleId) => change('setRole', userId, { roleId }),
    setTeam: (_p, userId, teamId) => {
      const result = change('setTeam', userId, { teamId })
      syncTeams()
      return result
    },
    setAcceptsNewDeals: (_p, userId, value) =>
      change('setAcceptsNewDeals', userId, { acceptsNewDeals: value }),
    async disable(_p, userId) {
      const count = api.openDeals[userId] ?? 0
      if (count > 0) {
        record('disable', userId)
        throw new MembersApiError(409, 'HAS_OPEN_DEALS', { count })
      }
      return change('disable', userId, { disabled: true })
    },
    enable: (_p, userId) => change('enable', userId, { disabled: false }),
    async transferDeals(_projectId, userId, input) {
      record('transferDeals', userId, input)
      const total = api.openDeals[userId] ?? 0
      api.openDeals[userId] = 0
      const id = `job-${nextId++}`
      const started: BulkJobProgress = {
        id,
        status: 'queued',
        total: null,
        processed: 0,
        failed: 0,
        failure: null,
      }
      api.jobs.set(id, { ...started, status: 'done', total, processed: total })
      return structuredClone(started)
    },
    async bulkJob(_projectId, jobId) {
      const job = api.jobs.get(jobId)
      if (!job) throw new RolesApiError(404, 'BULK_JOB_NOT_FOUND')
      return structuredClone(job)
    },
    async listTeams() {
      return structuredClone(api.teams)
    },
    async createTeam(_projectId, input) {
      record('createTeam', input)
      const team: TeamSummary = { id: `team-${nextId++}`, ...input, memberUserIds: [] }
      api.teams.push(team)
      const lead = api.members.find((m) => m.userId === input.leadUserId)
      if (lead) lead.teamId = team.id
      syncTeams()
      return structuredClone(team)
    },
    async updateTeam(_projectId, teamId, input) {
      record('updateTeam', teamId, input)
      const team = api.teams.find((t) => t.id === teamId)
      if (!team) throw new RolesApiError(404, 'TEAM_NOT_FOUND')
      Object.assign(team, input)
      const lead = api.members.find((m) => m.userId === team.leadUserId)
      if (lead) lead.teamId = team.id
      syncTeams()
      return structuredClone(team)
    },
    async removeTeam(_projectId, teamId) {
      record('removeTeam', teamId)
      api.teams = api.teams.filter((t) => t.id !== teamId)
      for (const m of api.members) if (m.teamId === teamId) m.teamId = null
    },
  }

  function record(method: string, ...args: unknown[]) {
    api.calls.push({ method, args })
    const code = api.failNextWith
    if (code) {
      api.failNextWith = null
      throw new RolesApiError(409, code)
    }
  }

  async function change(method: string, userId: string, patch: Partial<MemberSummary>) {
    record(method, userId, patch)
    const member = api.members.find((m) => m.userId === userId)
    if (!member) throw new RolesApiError(404, 'MEMBER_NOT_FOUND')
    Object.assign(member, patch)
    return structuredClone(member)
  }

  function syncTeams() {
    for (const team of api.teams) {
      team.memberUserIds = api.members.filter((m) => m.teamId === team.id).map((m) => m.userId)
    }
  }

  return api
}
