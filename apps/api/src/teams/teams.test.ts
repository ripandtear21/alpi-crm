import { withProject } from '@alpi/db'
import type { MemberSummary, TeamSummary } from '@alpi/shared'
import { type Kysely, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PROJECT_TEAMS, resolveViewer, scopePredicate, type Viewer } from '../roles/scope.ts'
import { type ApiHarness, type SignedInUser, startApiHarness } from '../testing/api-harness.ts'

// Команды проекта: один тимлид, участник не больше чем в одной команде, тимлид в своей команде,
// охват «команда» по этим командам — на настоящем PostgreSQL, API ходит ролью приложения.

describe('команды проекта', () => {
  let h: ApiHarness
  let systemOwner: SignedInUser
  let projectId: string

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_teams')
    systemOwner = await h.signIn('owner')
    projectId = (await h.createProject(systemOwner, 'Команди')).id
  })

  afterAll(async () => {
    await h?.stop()
  })

  const asAdmin = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) =>
    systemOwner.api(method, path, { project: projectId, ...(body === undefined ? {} : { body }) })

  async function body(res: Response) {
    return { status: res.status, body: res.status === 204 ? null : await res.json() }
  }

  async function newMember(templateKey = 'manager'): Promise<string> {
    const user = await h.signIn()
    await h.addMember(projectId, user.id, templateKey)
    return user.id
  }

  async function createTeam(name: string, leadUserId: string): Promise<TeamSummary> {
    const res = await asAdmin('POST', '/teams', { name, leadUserId })
    expect(res.status).toBe(201)
    return (await res.json()) as TeamSummary
  }

  async function teamOf(userId: string): Promise<string | null> {
    const row = await h.owner
      .selectFrom('project_member')
      .select('team_id')
      .where('project_id', '=', projectId)
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow()
    return row.team_id
  }

  async function teams(): Promise<TeamSummary[]> {
    return (await (await asAdmin('GET', '/teams')).json()) as TeamSummary[]
  }

  /** Запрос ролью приложения в контексте проекта, как его делает API. */
  const inProject = <T>(fn: (trx: Kysely<never>) => Promise<T>) =>
    withProject(h.appDb, projectId, (trx) => fn(trx as unknown as Kysely<never>))

  describe('менеджер не больше чем в одной команде', () => {
    it('перевод в другую команду уводит из прежней', async () => {
      const a = await createTeam('Альфа', await newMember('teamlead'))
      const b = await createTeam('Бета', await newMember('teamlead'))
      const manager = await newMember()

      expect((await asAdmin('PUT', `/members/${manager}/team`, { teamId: a.id })).status).toBe(200)
      const moved = await asAdmin('PUT', `/members/${manager}/team`, { teamId: b.id })
      expect(moved.status).toBe(200)
      expect(((await moved.json()) as MemberSummary).teamId).toBe(b.id)

      const byId = new Map((await teams()).map((t) => [t.id, t.memberUserIds]))
      expect(byId.get(a.id)).not.toContain(manager)
      expect(byId.get(b.id)).toContain(manager)
      expect(await teamOf(manager)).toBe(b.id)
    })

    it('база: второе участие с другой командой не записать', async () => {
      const a = await createTeam('Гамма', await newMember('teamlead'))
      const b = await createTeam('Дельта', await newMember('teamlead'))
      const manager = await newMember()
      await asAdmin('PUT', `/members/${manager}/team`, { teamId: a.id })
      const managerRole = await h.owner
        .selectFrom('project_member')
        .select('role_id')
        .where('user_id', '=', manager)
        .where('project_id', '=', projectId)
        .executeTakeFirstOrThrow()
      await expect(
        withProject(h.appDb, projectId, (trx) =>
          trx
            .insertInto('project_member')
            .values({
              project_id: projectId,
              user_id: manager,
              role_id: managerRole.role_id,
              team_id: b.id,
            })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23505' })
      expect(await teamOf(manager)).toBe(a.id)
    })
  })

  describe('у команды один тимлид, и он в своей команде', () => {
    it('команда без тимлида не создаётся — ни через API, ни в базе', async () => {
      expect(await body(await asAdmin('POST', '/teams', { name: 'Без тімліда' }))).toEqual({
        status: 400,
        body: { code: 'INVALID_TEAM', details: { path: 'leadUserId' } },
      })
      await expect(
        inProject((trx) =>
          sql`insert into team (project_id, name) values (${projectId}, 'Без тімліда')`.execute(
            trx,
          ),
        ),
      ).rejects.toMatchObject({ code: '23502' })
    })

    it('тимлид при создании входит в команду; смена тимлида — прежний остаётся участником', async () => {
      const first = await newMember('teamlead')
      const second = await newMember()
      const team = await createTeam('Епсилон', first)
      expect(team).toMatchObject({ leadUserId: first, memberUserIds: [first] })
      expect(await teamOf(first)).toBe(team.id)

      const res = await asAdmin('PUT', `/teams/${team.id}`, { leadUserId: second })
      expect(res.status).toBe(200)
      const changed = (await res.json()) as TeamSummary
      expect(changed.leadUserId).toBe(second)
      expect([...changed.memberUserIds].sort()).toEqual([first, second].sort())
    })

    it('один пользователь ведёт не больше одной команды', async () => {
      const lead = await newMember('teamlead')
      await createTeam('Дзета', lead)
      expect(
        await body(await asAdmin('POST', '/teams', { name: 'Ета', leadUserId: lead })),
      ).toEqual({ status: 409, body: { code: 'LEADS_OTHER_TEAM' } })
    })

    it('тимлида не вывести из его команды и не отключить — 409', async () => {
      const lead = await newMember('teamlead')
      const team = await createTeam('Тета', lead)
      expect(await body(await asAdmin('PUT', `/members/${lead}/team`, { teamId: null }))).toEqual({
        status: 409,
        body: { code: 'MEMBER_IS_TEAM_LEAD' },
      })
      expect(await body(await asAdmin('POST', `/members/${lead}/disable`))).toEqual({
        status: 409,
        body: { code: 'MEMBER_IS_TEAM_LEAD' },
      })
      expect(await teamOf(lead)).toBe(team.id)
    })

    it('база: тимлид вне своей команды и отключённый тимлид не записываются', async () => {
      const lead = await newMember('teamlead')
      const outsider = await newMember()
      const team = await createTeam('Йота', lead)
      // Тимлид — не участник команды: отложенный ключ отклоняет при фиксации.
      await expect(
        inProject((trx) =>
          sql`update team set lead_user_id = ${outsider} where id = ${team.id}`.execute(trx),
        ),
      ).rejects.toMatchObject({ code: '23503', constraint: 'team_lead_in_team' })
      await expect(
        inProject((trx) =>
          sql`update project_member set team_id = null where user_id = ${lead}`.execute(trx),
        ),
      ).rejects.toMatchObject({ code: '23503', constraint: 'team_lead_in_team' })
      await expect(
        inProject((trx) =>
          sql`update project_member set disabled_at = now() where user_id = ${lead}`.execute(trx),
        ),
      ).rejects.toMatchObject({ code: 'TM002' })

      await asAdmin('POST', `/members/${outsider}/disable`)
      expect(
        await body(await asAdmin('PUT', `/teams/${team.id}`, { leadUserId: outsider })),
      ).toEqual({ status: 409, body: { code: 'TEAM_LEAD_DISABLED' } })
      await expect(
        inProject(async (trx) => {
          await sql`update project_member set team_id = ${team.id} where user_id = ${outsider}`.execute(
            trx,
          )
          await sql`update team set lead_user_id = ${outsider} where id = ${team.id}`.execute(trx)
        }),
      ).rejects.toMatchObject({ code: 'TM001' })
    })
  })

  describe('название и удаление', () => {
    it('переименование; занятое название — 409', async () => {
      const a = await createTeam('Каппа', await newMember('teamlead'))
      await createTeam('Лямбда', await newMember('teamlead'))
      expect((await asAdmin('PUT', `/teams/${a.id}`, { name: 'Каппа-2' })).status).toBe(200)
      expect(await body(await asAdmin('PUT', `/teams/${a.id}`, { name: 'Лямбда' }))).toEqual({
        status: 409,
        body: { code: 'TEAM_NAME_TAKEN' },
      })
    })

    it('удаление выводит участников из команды', async () => {
      const lead = await newMember('teamlead')
      const manager = await newMember()
      const team = await createTeam('Мю', lead)
      await asAdmin('PUT', `/members/${manager}/team`, { teamId: team.id })
      expect((await asAdmin('DELETE', `/teams/${team.id}`)).status).toBe(204)
      expect(await teamOf(lead)).toBeNull()
      expect(await teamOf(manager)).toBeNull()
    })
  })

  describe('охват «команда» по командам проекта', () => {
    // Тестовая таблица с ответственным — как будущие сделки.
    interface ProbeDb {
      team_scope_probe: { id: string; owner_user_id: string | null }
    }
    let lead: string
    let mate: string
    let me: string
    let stranger: string
    let loner: string
    let foreignMate: string

    beforeAll(async () => {
      lead = await newMember('teamlead')
      mate = await newMember()
      me = await newMember()
      stranger = await newMember()
      loner = await newMember()
      const ours = await createTeam('Ню', lead)
      await createTeam('Ксі', stranger)
      for (const user of [mate, me]) {
        await asAdmin('PUT', `/members/${user}/team`, { teamId: ours.id })
      }
      // Тот же пользователь-коллега в команде другого проекта не входит в нашу.
      const other = (await h.createProject(systemOwner, 'Інший')).id
      const foreign = await h.signIn()
      foreignMate = foreign.id
      await h.addMember(other, foreignMate, 'teamlead')
      await systemOwner.api('POST', '/teams', {
        project: other,
        body: { name: 'Ню', leadUserId: foreignMate },
      })

      const db = h.owner as unknown as Kysely<ProbeDb>
      await sql`create table team_scope_probe (id text primary key, owner_user_id text)`.execute(db)
      await db
        .insertInto('team_scope_probe')
        .values([
          { id: 'lead', owner_user_id: lead },
          { id: 'mate', owner_user_id: mate },
          { id: 'me', owner_user_id: me },
          { id: 'stranger', owner_user_id: stranger },
          { id: 'loner', owner_user_id: loner },
          { id: 'foreign', owner_user_id: foreignMate },
          { id: 'queue', owner_user_id: null },
        ])
        .execute()
    })

    async function viewerOf(userId: string): Promise<Viewer> {
      return withProject(h.appDb, projectId, (trx) => resolveViewer(trx, userId, PROJECT_TEAMS))
    }

    async function visible(viewer: Viewer): Promise<string[]> {
      const db = h.owner as unknown as Kysely<ProbeDb>
      const rows = await db
        .selectFrom('team_scope_probe')
        .select('id')
        .where((eb) => scopePredicate(eb, 'team', viewer, 'team_scope_probe.owner_user_id'))
        .orderBy('id')
        .execute()
      return rows.map((r) => r.id)
    }

    it('тимлид видит записи всех участников своей команды', async () => {
      expect(await visible(await viewerOf(lead))).toEqual(['lead', 'mate', 'me'])
    })

    it('менеджер с охватом «команда» видит записи коллег и тимлида своей команды', async () => {
      expect(await visible(await viewerOf(me))).toEqual(['lead', 'mate', 'me'])
    })

    it('другая команда и пользователь вне команд — отдельно', async () => {
      expect(await visible(await viewerOf(stranger))).toEqual(['stranger'])
      expect(await visible(await viewerOf(loner))).toEqual(['loner'])
    })

    it('команда считается в проекте запроса: вне контекста проекта команды не видно', async () => {
      // Без проекта row-level security не показывает ни одного участника.
      expect(await PROJECT_TEAMS.teamUserIds(h.appDb, lead)).toEqual([])
    })
  })
})
