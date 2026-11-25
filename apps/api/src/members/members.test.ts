import {
  type CreatedMemberResponse,
  type MemberSummary,
  type ProjectSummary,
  ROLE_TEMPLATES,
  type RolePermissions,
  type RoleSummary,
  type TeamSummary,
} from '@alpi/shared'
import { Hono } from 'hono'
import { sql } from 'kysely'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { type AccessEnv, accessGuard } from '../auth/access-guard.ts'
import { projectContext } from '../middleware/project-context.ts'
import {
  type ApiHarness,
  type SignedInUser,
  startApiHarness,
  type Target,
} from '../testing/api-harness.ts'
import { problemOf } from '../testing/problem.ts'
import { totp } from '../testing/totp.ts'
import { membersRoutes } from './members.ts'
import type { OpenDealsChecker } from './open-deals.ts'

// Участники проекта: список, добавление существующего и нового пользователя, назначение роли и
// команды, отключение участия — на настоящем PostgreSQL, API ходит ролью приложения.

const MANAGER = ROLE_TEMPLATES.find((t) => t.key === 'manager')?.permissions as RolePermissions

// Кадровик: «пользователи и роли» (смотреть, создавать, изменять), сделки — смотреть свои.
const HR = {
  ...MANAGER,
  actions: {
    ...Object.fromEntries(Object.keys(MANAGER.actions).map((k) => [k, []])),
    deals: ['view'],
    users_roles: ['view', 'create', 'edit'],
  },
  standalone: [],
} as unknown as RolePermissions
// Узкая роль: прав не больше, чем у кадровика.
const NARROW = { ...HR, actions: { ...HR.actions, users_roles: [] } } as RolePermissions

describe('участники проекта', () => {
  let h: ApiHarness
  let systemOwner: SignedInUser
  let projectId: string
  let roles: RoleSummary[]

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_members')
    systemOwner = await h.signIn('owner')
    projectId = (await h.createProject(systemOwner, 'Учасники')).id
    roles = await rolesOf(projectId)
  })

  afterAll(async () => {
    await h?.stop()
  })

  async function rolesOf(id: string): Promise<RoleSummary[]> {
    const res = await systemOwner.api('GET', '/roles', { project: id })
    expect(res.status).toBe(200)
    return (await res.json()) as RoleSummary[]
  }

  const roleId = (key: string, list = roles) => {
    const role = list.find((r) => r.templateKey === key)
    if (!role) throw new Error(`нет роли ${key}`)
    return role.id
  }

  const asAdmin = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) =>
    systemOwner.api(method, path, { project: projectId, ...(body === undefined ? {} : { body }) })

  async function member(userId: string, id = projectId) {
    return h.owner
      .selectFrom('project_member')
      .select(['role_id', 'team_id', 'accepts_new_deals', 'disabled_at', 'disabled_by'])
      .where('project_id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst()
  }

  async function newMember(templateKey = 'manager'): Promise<SignedInUser> {
    const user = await h.signIn()
    await h.addMember(projectId, user.id, templateKey)
    return user
  }

  async function body(res: Response) {
    return { status: res.status, body: await res.json() }
  }

  /** Отказ в формате RFC 9457: статус и тело без общей части (type, title, status). */
  async function refusal(res: Response) {
    return { status: res.status, body: await problemOf(res) }
  }

  describe('список и добавление', () => {
    it('список: роль, команда, приём сделок, отключён ли', async () => {
      const res = await asAdmin('GET', '/members')
      expect(res.status).toBe(200)
      const list = (await res.json()) as MemberSummary[]
      expect(list.find((m) => m.userId === systemOwner.id)).toEqual({
        userId: systemOwner.id,
        email: systemOwner.email,
        name: 'Власник',
        roleId: roleId('admin'),
        teamId: null,
        acceptsNewDeals: true,
        disabled: false,
      })
    })

    it('существующий пользователь по email: входит в проект с выданной ролью', async () => {
      const user = await h.signIn()
      expect((await user.api('GET', '/project', { project: projectId })).status).toBe(403)
      const res = await asAdmin('POST', '/members', {
        email: `  ${user.email.toUpperCase()} `,
        roleId: roleId('manager'),
      })
      expect(res.status).toBe(201)
      expect(((await res.json()) as MemberSummary).roleId).toBe(roleId('manager'))
      expect((await user.api('GET', '/project', { project: projectId })).status).toBe(200)
      expect(
        await body(
          await asAdmin('POST', '/members', { email: user.email, roleId: roleId('head') }),
        ),
      ).toEqual({ status: 409, body: { code: 'MEMBER_EXISTS' } })
      expect((await member(user.id))?.role_id).toBe(roleId('manager'))
    })

    it('неизвестный email — 404; неверное тело — 400', async () => {
      expect(
        await body(
          await asAdmin('POST', '/members', {
            email: 'nobody@example.test',
            roleId: roleId('manager'),
          }),
        ),
      ).toEqual({ status: 404, body: { code: 'USER_NOT_FOUND' } })
      expect(
        (await asAdmin('POST', '/members', { email: 'not-an-email', roleId: roleId('manager') }))
          .status,
      ).toBe(400)
      expect(
        (await asAdmin('POST', '/members', { email: 'a@example.test', roleId: 'x' })).status,
      ).toBe(400)
    })
  })

  describe('новый пользователь с временным паролем', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('пароль показан один раз; при первом входе — сначала смена пароля, потом 2FA', async () => {
      const logged: unknown[][] = []
      for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          logged.push(args)
        })
      }
      const email = `new-${Date.now()}@example.test`
      const res = await asAdmin('POST', '/members/new', {
        email,
        name: 'Новенький',
        roleId: roleId('manager'),
      })
      expect(res.status).toBe(201)
      expect(res.headers.get('cache-control')).toBe('no-store')
      const created = (await res.json()) as CreatedMemberResponse
      const password = created.temporaryPassword
      expect(password).toMatch(/^[A-Za-z0-9_-]{16}$/)
      expect(created.member).toMatchObject({ email, name: 'Новенький', roleId: roleId('manager') })
      // Пароль не попал в журнал и не хранится открытым текстом.
      expect(JSON.stringify(logged)).not.toContain(password)
      const account = await h.owner
        .selectFrom('account')
        .select('password')
        .where('user_id', '=', created.member.userId)
        .executeTakeFirstOrThrow()
      expect(account.password).not.toContain(password)
      const user = await h.owner
        .selectFrom('user')
        .select(['role', 'must_change_password'])
        .where('id', '=', created.member.userId)
        .executeTakeFirstOrThrow()
      // Не владелец системы, пароль нужно сменить.
      expect(user).toEqual({ role: 'user', must_change_password: true })

      const browser = h.browser()
      // Второй вход тем же временным паролем — как тот, кто создал учётную запись.
      const creatorCopy = h.browser()
      for (const b of [browser, creatorCopy]) {
        expect(
          (await b.api('POST', '/auth/sign-in/email', { body: { email, password } })).status,
        ).toBe(200)
      }
      // До смены пароля — ни API, ни проекта, ни настройки 2FA.
      for (const [method, path, options] of [
        ['GET', '/me', {}],
        ['GET', '/project', { project: projectId }],
        ['POST', '/auth/two-factor/enable', { body: { password } }],
      ] as const) {
        expect({ path, ...(await refusal(await browser.api(method, path, options))) }).toEqual({
          path,
          status: 403,
          body: { code: 'PASSWORD_CHANGE_REQUIRED' },
        })
      }
      expect((await browser.api('GET', '/auth/get-session')).status).toBe(200)
      // Неудачная смена (неверный текущий пароль) флаг не снимает.
      const wrong = await browser.api('POST', '/auth/change-password', {
        body: { currentPassword: 'wrong-password-1', newPassword: 'new-password-123' },
      })
      expect(wrong.status).toBe(400)
      expect((await browser.api('GET', '/me')).status).toBe(403)
      // «Смена» на тот же пароль — отказ, флаг остаётся.
      expect(
        await body(
          await browser.api('POST', '/auth/change-password', {
            body: { currentPassword: password, newPassword: password },
          }),
        ),
      ).toMatchObject({ status: 400, body: { code: 'PASSWORD_UNCHANGED' } })
      expect((await browser.api('GET', '/me')).status).toBe(403)

      // Клиент не просит закрыть другие сессии — сервер закрывает их сам.
      const newPassword = 'new-password-123'
      const changed = await browser.api('POST', '/auth/change-password', {
        body: { currentPassword: password, newPassword, revokeOtherSessions: false },
      })
      expect(changed.status).toBe(200)
      expect(await (await creatorCopy.api('GET', '/auth/get-session')).json()).toBeNull()
      expect(
        (
          await h.owner
            .selectFrom('user')
            .select('must_change_password')
            .where('id', '=', created.member.userId)
            .executeTakeFirstOrThrow()
        ).must_change_password,
      ).toBe(false)
      // Теперь — настройка 2FA, и только она.
      expect(await refusal(await browser.api('GET', '/me'))).toEqual({
        status: 403,
        body: { code: 'TWO_FACTOR_SETUP_REQUIRED' },
      })
      const enabled = await browser.api('POST', '/auth/two-factor/enable', {
        body: { password: newPassword },
      })
      expect(enabled.status).toBe(200)
      const { totpURI } = (await enabled.json()) as { totpURI: string }
      const secret = new URL(totpURI).searchParams.get('secret') ?? ''
      expect(
        (
          await browser.api('POST', '/auth/two-factor/verify-totp', {
            body: { code: totp(secret) },
          })
        ).status,
      ).toBe(200)
      expect((await browser.api('GET', '/project', { project: projectId })).status).toBe(200)
    })

    it('email уже занят — 409 EMAIL_TAKEN, учётная запись не создана', async () => {
      const res = await asAdmin('POST', '/members/new', {
        email: systemOwner.email,
        name: 'Двійник',
        roleId: roleId('manager'),
      })
      expect(await body(res)).toEqual({ status: 409, body: { code: 'EMAIL_TAKEN' } })
    })
  })

  describe('журнал действий', () => {
    async function journal(entityId: string) {
      return h.owner
        .selectFrom('audit_log')
        .select(['action', 'actor_id', 'entity_type', 'details'])
        .where('project_id', '=', projectId)
        .where('entity_id', '=', entityId)
        .orderBy('occurred_at')
        .orderBy('id')
        .execute()
    }

    /** Пока выполняется `fn`, любая вставка в журнал проекта падает с ошибкой. */
    async function withBrokenJournal(fn: () => Promise<void>) {
      await sql`
        create function public.test_broken_members_journal() returns trigger language plpgsql
        as $$ begin raise exception 'журнал недоступен'; end $$
      `.execute(h.owner)
      await sql`
        create trigger test_broken_members_journal before insert on audit_log
          for each row execute function public.test_broken_members_journal()
      `.execute(h.owner)
      try {
        await fn()
      } finally {
        await sql`drop trigger test_broken_members_journal on audit_log`.execute(h.owner)
        await sql`drop function public.test_broken_members_journal()`.execute(h.owner)
      }
    }

    it('добавление, смена роли, отключение и включение пишутся той же транзакцией', async () => {
      const user = await h.signIn()
      expect(
        (await asAdmin('POST', '/members', { email: user.email, roleId: roleId('manager') }))
          .status,
      ).toBe(201)
      expect(
        (await asAdmin('PUT', `/members/${user.id}/role`, { roleId: roleId('head') })).status,
      ).toBe(200)
      expect((await asAdmin('POST', `/members/${user.id}/disable`)).status).toBe(200)
      expect((await asAdmin('POST', `/members/${user.id}/enable`)).status).toBe(200)
      expect(await journal(user.id)).toEqual([
        {
          action: 'member.added',
          actor_id: systemOwner.id,
          entity_type: 'user',
          details: {
            after: {
              roleId: roleId('manager'),
              roleName: 'Менеджер',
              teamId: null,
              teamName: null,
            },
          },
        },
        {
          action: 'member.role_changed',
          actor_id: systemOwner.id,
          entity_type: 'user',
          details: {
            before: { roleId: roleId('manager'), roleName: 'Менеджер' },
            after: { roleId: roleId('head'), roleName: 'Керівник' },
          },
        },
        { action: 'member.disabled', actor_id: systemOwner.id, entity_type: 'user', details: {} },
        { action: 'member.enabled', actor_id: systemOwner.id, entity_type: 'user', details: {} },
      ])
    })

    it('новая учётная запись — member.created без временного пароля', async () => {
      const res = await asAdmin('POST', '/members/new', {
        email: `journal-${Date.now()}@example.test`,
        name: 'Журнальний',
        roleId: roleId('manager'),
      })
      expect(res.status).toBe(201)
      const { member, temporaryPassword } = (await res.json()) as CreatedMemberResponse
      const rows = await journal(member.userId)
      expect(rows.map((r) => r.action)).toEqual(['member.created'])
      expect(JSON.stringify(rows)).not.toContain(temporaryPassword)
    })

    it('журнал не пишется — действие откатывается (500)', async () => {
      const outsider = await h.signIn()
      const enabled = await newMember()
      await withBrokenJournal(async () => {
        const added = await asAdmin('POST', '/members', {
          email: outsider.email,
          roleId: roleId('manager'),
        })
        expect(added.status).toBe(500)
        expect((await asAdmin('POST', `/members/${enabled.id}/disable`)).status).toBe(500)
        expect(
          (await asAdmin('PUT', `/members/${enabled.id}/role`, { roleId: roleId('head') })).status,
        ).toBe(500)
      })
      expect(await member(outsider.id)).toBeUndefined()
      expect(await member(enabled.id)).toMatchObject({
        disabled_at: null,
        role_id: roleId('manager'),
      })
      expect(await journal(enabled.id)).toEqual([])
    })

    it('владельцу системы /admin/update-user и /admin/set-user-password выключены', async () => {
      const user = await h.signIn()
      const updated = await systemOwner.api('POST', '/auth/admin/update-user', {
        body: { userId: user.id, data: { name: 'Підмінений' } },
      })
      expect(updated.status).toBe(404)
      const password = await systemOwner.api('POST', '/auth/admin/set-user-password', {
        body: { userId: user.id, newPassword: 'owner-knows-it-1' },
      })
      expect(password.status).toBe(404)
      const row = await h.owner
        .selectFrom('user')
        .select('name')
        .where('id', '=', user.id)
        .executeTakeFirstOrThrow()
      expect(row.name).toBe('Користувач')
      const browser = h.browser()
      expect(
        (
          await browser.api('POST', '/auth/sign-in/email', {
            body: { email: user.email, password: 'owner-knows-it-1' },
          })
        ).status,
      ).toBe(401)
    })
  })

  describe('отключение участия', () => {
    let calls: string[]
    let openDeals: number
    // Приложение с подставной проверкой открытых сделок: те же слои, что в createApp.
    let withStub: Target

    beforeAll(() => {
      const stub: OpenDealsChecker = {
        async countOpenDeals(_db, userId) {
          calls.push(userId)
          return openDeals
        },
      }
      withStub = new Hono<AccessEnv>()
        .use('*', accessGuard(h.auth))
        .use('*', projectContext(h.appDb))
        .route('/members', membersRoutes({ auth: h.auth, openDeals: stub }))
    })

    const disable = (userId: string) =>
      systemOwner.call(withStub, 'POST', `/members/${userId}/disable`, { project: projectId })

    it('вызывает проверку открытых сделок и отказывает, если они есть', async () => {
      const user = await newMember()
      calls = []
      openDeals = 2
      expect(await body(await disable(user.id))).toEqual({
        status: 409,
        body: { code: 'HAS_OPEN_DEALS', details: { count: 2 } },
      })
      expect(calls).toEqual([user.id])
      expect((await member(user.id))?.disabled_at).toBeNull()
      expect((await user.api('GET', '/project', { project: projectId })).status).toBe(200)

      openDeals = 0
      const res = await disable(user.id)
      expect(res.status).toBe(200)
      expect(((await res.json()) as MemberSummary).disabled).toBe(true)
      expect(calls).toEqual([user.id, user.id])
    })

    it('отключённый не входит в проект (403) и не видит его в списке; включение возвращает', async () => {
      const user = await newMember()
      const res = await asAdmin('POST', `/members/${user.id}/disable`)
      expect(res.status).toBe(200)
      const row = await member(user.id)
      expect(row?.disabled_at).not.toBeNull()
      expect(row?.disabled_by).toBe(systemOwner.id)
      expect(await refusal(await user.api('GET', '/project', { project: projectId }))).toEqual({
        status: 403,
        body: { code: 'PROJECT_FORBIDDEN' },
      })
      const projects = (await (await user.api('GET', '/projects')).json()) as ProjectSummary[]
      expect(projects.map((p) => p.id)).not.toContain(projectId)
      // Участие и учётная запись остаются: отключённый — в истории.
      expect(
        ((await (await asAdmin('GET', '/members')).json()) as MemberSummary[]).find(
          (m) => m.userId === user.id,
        ),
      ).toMatchObject({ disabled: true })

      expect((await asAdmin('POST', `/members/${user.id}/enable`)).status).toBe(200)
      expect((await user.api('GET', '/project', { project: projectId })).status).toBe(200)
    })

    it('последнего администратора не отключить — 409 LAST_ADMIN; второго — можно', async () => {
      expect(await body(await asAdmin('POST', `/members/${systemOwner.id}/disable`))).toEqual({
        status: 409,
        body: { code: 'LAST_ADMIN' },
      })
      expect((await member(systemOwner.id))?.disabled_at).toBeNull()
      const second = await newMember('admin')
      expect((await asAdmin('POST', `/members/${second.id}/disable`)).status).toBe(200)
      // Отключённый администратор не считается: первого всё ещё не отключить.
      expect((await asAdmin('POST', `/members/${systemOwner.id}/disable`)).status).toBe(409)
    })

    it('«принимает новые сделки» меняется', async () => {
      const user = await newMember()
      const res = await asAdmin('PUT', `/members/${user.id}/accepts-new-deals`, {
        acceptsNewDeals: false,
      })
      expect(res.status).toBe(200)
      expect((await member(user.id))?.accepts_new_deals).toBe(false)
      expect(
        (await asAdmin('PUT', `/members/${user.id}/accepts-new-deals`, { acceptsNewDeals: 'no' }))
          .status,
      ).toBe(400)
    })
  })

  describe('право «пользователи и роли» не даёт захватить проект', () => {
    // X — кадровик, Y — менеджер (прав больше, чем у кадровика), N — участник с узкой ролью.
    let hr: RoleSummary
    let narrow: RoleSummary
    let x: SignedInUser
    let y: SignedInUser
    let n: SignedInUser
    let team: TeamSummary

    async function createRole(name: string, permissions: RolePermissions) {
      const res = await asAdmin('POST', '/roles', { name, permissions })
      expect(res.status).toBe(201)
      return (await res.json()) as RoleSummary
    }

    beforeAll(async () => {
      hr = await createRole('Кадровик', HR)
      narrow = await createRole('Вузька', NARROW)
      x = await newMember()
      y = await newMember()
      n = await newMember()
      for (const [user, role] of [
        [x, hr],
        [n, narrow],
      ] as const) {
        expect((await asAdmin('PUT', `/members/${user.id}/role`, { roleId: role.id })).status).toBe(
          200,
        )
      }
      const created = await asAdmin('POST', '/teams', { name: 'Захоплення', leadUserId: y.id })
      expect(created.status).toBe(201)
      team = (await created.json()) as TeamSummary
    })

    const asX = (method: 'POST' | 'PUT', path: string, payload?: unknown) =>
      x.api(method, path, {
        project: projectId,
        ...(payload === undefined ? {} : { body: payload }),
      })

    async function expectDenied(res: Response, code: string) {
      expect(await body(res)).toEqual({ status: 403, body: { code } })
    }

    it('добавить существующего с ролью администратора или шире своей — нельзя', async () => {
      const outsider = await h.signIn()
      await expectDenied(
        await asX('POST', '/members', { email: outsider.email, roleId: roleId('admin') }),
        'ADMIN_ONLY',
      )
      await expectDenied(
        await asX('POST', '/members', { email: outsider.email, roleId: roleId('manager') }),
        'EXCEEDS_OWN_PERMISSIONS',
      )
      expect(await member(outsider.id)).toBeUndefined()
      // Не шире своей — можно.
      expect(
        (await asX('POST', '/members', { email: outsider.email, roleId: narrow.id })).status,
      ).toBe(201)
    })

    it('завести нового с ролью администратора — нельзя, учётная запись не создаётся', async () => {
      const email = `escalate-${Date.now()}@example.test`
      await expectDenied(
        await asX('POST', '/members/new', { email, name: 'Захоплювач', roleId: roleId('admin') }),
        'ADMIN_ONLY',
      )
      await expectDenied(
        await asX('POST', '/members/new', {
          email,
          name: 'Захоплювач',
          roleId: roleId('manager'),
        }),
        'EXCEEDS_OWN_PERMISSIONS',
      )
      const users = await h.owner
        .selectFrom('user')
        .select('id')
        .where('email', '=', email)
        .execute()
      expect(users).toEqual([])
    })

    it('участие администратора, своё участие и участие того, у кого прав больше, — нельзя', async () => {
      await expectDenied(await asX('POST', `/members/${systemOwner.id}/disable`), 'ADMIN_ONLY')
      await expectDenied(await asX('POST', `/members/${x.id}/disable`), 'OWN_MEMBERSHIP')
      await expectDenied(
        await asX('POST', `/members/${y.id}/disable`),
        'TARGET_EXCEEDS_OWN_PERMISSIONS',
      )
      await expectDenied(
        await asX('PUT', `/members/${y.id}/accepts-new-deals`, { acceptsNewDeals: false }),
        'TARGET_EXCEEDS_OWN_PERMISSIONS',
      )
      expect((await member(systemOwner.id))?.disabled_at).toBeNull()
      expect((await member(y.id))?.disabled_at).toBeNull()
      expect((await member(x.id))?.team_id).toBeNull()
      // Участника с узкой ролью — можно.
      expect((await asX('POST', `/members/${n.id}/disable`)).status).toBe(200)
      expect((await asX('POST', `/members/${n.id}/enable`)).status).toBe(200)
    })

    it('команды и их состав меняет только администратор — и через новую учётную запись тоже', async () => {
      // Атака: завести учётную запись (её временный пароль X видит) сразу в чужую команду.
      const email = `team-${Date.now()}@example.test`
      await expectDenied(
        await asX('POST', '/members/new', {
          email,
          name: 'Агент',
          roleId: narrow.id,
          teamId: team.id,
        }),
        'TEAMS_ADMIN_ONLY',
      )
      expect(
        await h.owner.selectFrom('user').select('id').where('email', '=', email).execute(),
      ).toEqual([])
      // Существующего — тоже не сразу в команду.
      const outsider = await h.signIn()
      await expectDenied(
        await asX('POST', '/members', {
          email: outsider.email,
          roleId: narrow.id,
          teamId: team.id,
        }),
        'TEAMS_ADMIN_ONLY',
      )
      expect(await member(outsider.id)).toBeUndefined()

      // Без команды завести можно, но ни тимлидом, ни в команду её не поставить.
      const created = await asX('POST', '/members/new', {
        email,
        name: 'Агент',
        roleId: narrow.id,
      })
      expect(created.status).toBe(201)
      const agent = ((await created.json()) as CreatedMemberResponse).member.userId
      await expectDenied(
        await asX('POST', '/teams', { name: 'Агентурна', leadUserId: agent }),
        'TEAMS_ADMIN_ONLY',
      )
      await expectDenied(
        await asX('PUT', `/teams/${team.id}`, { leadUserId: agent }),
        'TEAMS_ADMIN_ONLY',
      )
      for (const userId of [agent, n.id, x.id]) {
        await expectDenied(
          await asX('PUT', `/members/${userId}/team`, { teamId: team.id }),
          'TEAMS_ADMIN_ONLY',
        )
      }
      await expectDenied(
        await asX('PUT', `/teams/${team.id}`, { name: 'Інша' }),
        'TEAMS_ADMIN_ONLY',
      )
      expect((await x.api('DELETE', `/teams/${team.id}`, { project: projectId })).status).toBe(403)
      const stored = await h.owner
        .selectFrom('team')
        .select(['name', 'lead_user_id'])
        .where('id', '=', team.id)
        .executeTakeFirstOrThrow()
      expect(stored).toEqual({ name: 'Захоплення', lead_user_id: y.id })
      for (const userId of [agent, n.id, x.id]) expect((await member(userId))?.team_id).toBeNull()
    })
  })

  describe('чужой проект', () => {
    let other: string
    let otherUser: SignedInUser
    let otherTeam: TeamSummary
    let otherRoles: RoleSummary[]
    let local: SignedInUser

    beforeAll(async () => {
      other = (await h.createProject(systemOwner, 'Чужий')).id
      otherRoles = await rolesOf(other)
      otherUser = await h.signIn()
      await h.addMember(other, otherUser.id, 'manager')
      const res = await systemOwner.api('POST', '/teams', {
        project: other,
        body: { name: 'Чужа команда', leadUserId: otherUser.id },
      })
      expect(res.status).toBe(201)
      otherTeam = (await res.json()) as TeamSummary
      local = await newMember()
    })

    it('id участника, команды и роли другого проекта отклоняются — 404, чужое не меняется', async () => {
      const attempts: [string, 'POST' | 'PUT' | 'DELETE', string, unknown, string][] = [
        ['участник', 'PUT', `/members/${otherUser.id}/team`, { teamId: null }, 'MEMBER_NOT_FOUND'],
        ['участник', 'POST', `/members/${otherUser.id}/disable`, undefined, 'MEMBER_NOT_FOUND'],
        [
          'участник',
          'PUT',
          `/members/${otherUser.id}/role`,
          { roleId: roleId('manager') },
          'MEMBER_NOT_FOUND',
        ],
        ['команда', 'PUT', `/members/${local.id}/team`, { teamId: otherTeam.id }, 'TEAM_NOT_FOUND'],
        [
          'роль',
          'POST',
          '/members',
          { email: otherUser.email, roleId: roleId('manager', otherRoles) },
          'ROLE_NOT_FOUND',
        ],
        ['команда', 'PUT', `/teams/${otherTeam.id}`, { name: 'Наша' }, 'TEAM_NOT_FOUND'],
        ['команда', 'DELETE', `/teams/${otherTeam.id}`, undefined, 'TEAM_NOT_FOUND'],
        [
          'тимлид',
          'POST',
          '/teams',
          { name: 'З чужим тимлідом', leadUserId: otherUser.id },
          'MEMBER_NOT_FOUND',
        ],
      ]
      for (const [what, method, path, payload, code] of attempts) {
        const res = await asAdmin(method, path, payload)
        expect({ what, path, ...(await body(res)) }).toEqual({
          what,
          path,
          status: 404,
          body: { code },
        })
      }
      expect(await member(otherUser.id, other)).toMatchObject({
        team_id: otherTeam.id,
        disabled_at: null,
      })
      expect((await member(local.id))?.team_id).toBeNull()
      const stored = await h.owner
        .selectFrom('team')
        .select('name')
        .where('id', '=', otherTeam.id)
        .executeTakeFirstOrThrow()
      expect(stored.name).toBe('Чужа команда')
    })
  })

  it('без права «пользователи и роли» — 403 на каждый маршрут участников и команд', async () => {
    const manager = await newMember('manager')
    const routes: ['GET' | 'POST' | 'PUT' | 'DELETE', string, unknown][] = [
      ['GET', '/members', undefined],
      ['POST', '/members', { email: 'a@example.test', roleId: roleId('manager') }],
      ['POST', '/members/new', { email: 'a@example.test', name: 'A', roleId: roleId('manager') }],
      ['PUT', `/members/${manager.id}/role`, { roleId: roleId('manager') }],
      ['PUT', `/members/${manager.id}/team`, { teamId: null }],
      ['PUT', `/members/${manager.id}/accepts-new-deals`, { acceptsNewDeals: false }],
      ['POST', `/members/${manager.id}/disable`, undefined],
      ['POST', `/members/${manager.id}/enable`, undefined],
      ['GET', '/teams', undefined],
      ['POST', '/teams', { name: 'T', leadUserId: manager.id }],
      ['PUT', `/teams/${crypto.randomUUID()}`, { name: 'T' }],
      ['DELETE', `/teams/${crypto.randomUUID()}`, undefined],
    ]
    for (const [method, path, payload] of routes) {
      const res = await manager.api(method, path, {
        project: projectId,
        ...(payload === undefined ? {} : { body: payload }),
      })
      expect({ method, path, ...(await refusal(res)) }).toEqual({
        method,
        path,
        status: 403,
        body: { code: 'PERMISSION_DENIED' },
      })
    }
  })
})
