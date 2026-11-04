import { createProject as createProjectAsService, withProject } from '@alpi/db'
import {
  fullPermissions,
  ROLE_TEMPLATES,
  type RolePermissions,
  type RoleSummary,
} from '@alpi/shared'
import { Hono } from 'hono'
import { type Kysely, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AccessEnv, accessGuard } from '../auth/access-guard.ts'
import { type PermissionsEnv, requirePermission } from '../middleware/permissions.ts'
import { projectContext } from '../middleware/project-context.ts'
import { type ApiHarness, type SignedInUser, startApiHarness } from '../testing/api-harness.ts'
import { NO_TEAMS, resolveViewer, scopePredicate, type Viewer } from './scope.ts'

// Роли проекта, защиты администратора, проверка прав и охват — на настоящем PostgreSQL,
// API ходит ролью приложения (row-level security действует).

const MANAGER = ROLE_TEMPLATES.find((t) => t.key === 'manager')?.permissions as RolePermissions

describe('роли и права проекта', () => {
  let h: ApiHarness
  let systemOwner: SignedInUser

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_roles')
    systemOwner = await h.signIn('owner')
  })

  afterAll(async () => {
    await h?.stop()
  })

  async function rolesOf(user: SignedInUser, projectId: string): Promise<RoleSummary[]> {
    const res = await user.api('GET', '/roles', { project: projectId })
    expect(res.status).toBe(200)
    return (await res.json()) as RoleSummary[]
  }

  function roleByKey(roles: RoleSummary[], key: string): RoleSummary {
    const role = roles.find((r) => r.templateKey === key)
    if (!role) throw new Error(`нет роли-шаблона ${key}`)
    return role
  }

  async function storedRole(roleId: string) {
    return h.owner
      .selectFrom('role')
      .select(['name', 'is_admin', 'permissions'])
      .where('id', '=', roleId)
      .executeTakeFirstOrThrow()
  }

  describe('шаблоны ролей', () => {
    it('создаются вместе с проектом; создатель — администратор', async () => {
      const project = await h.createProject(systemOwner, 'Шаблони')
      const roles = await rolesOf(systemOwner, project.id)

      expect(roles.map((r) => [r.templateKey, r.name, r.isAdmin, r.memberCount])).toEqual([
        ['admin', 'Адміністратор', true, 1],
        ['head', 'Керівник', false, 0],
        ['teamlead', 'Тімлід', false, 0],
        ['manager', 'Менеджер', false, 0],
      ])
      // Права шаблонов совпадают с каталогом packages/shared (снимок в миграции не разошёлся).
      for (const role of roles) {
        expect({ key: role.templateKey, permissions: role.permissions }).toEqual({
          key: role.templateKey,
          permissions: ROLE_TEMPLATES.find((t) => t.key === role.templateKey)?.permissions,
        })
        expect(
          (await storedRole(role.id)).permissions,
          `хранимые права ${role.templateKey}`,
        ).toEqual(ROLE_TEMPLATES.find((t) => t.key === role.templateKey)?.permissions)
      }
      const creator = await h.owner
        .selectFrom('project_member')
        .select('role_id')
        .where('project_id', '=', project.id)
        .where('user_id', '=', systemOwner.id)
        .executeTakeFirstOrThrow()
      expect(creator.role_id).toBe(roleByKey(roles, 'admin').id)
    })

    it('создаются и при создании проекта служебной ролью', async () => {
      const project = await createProjectAsService(h.owner, { code: 'service', name: 'Служебний' })
      const keys = await h.owner
        .selectFrom('role')
        .select('template_key')
        .where('project_id', '=', project.id)
        .orderBy('template_key')
        .execute()
      expect(keys.map((k) => k.template_key)).toEqual(['admin', 'head', 'manager', 'teamlead'])
    })
  })

  describe('защита роли «администратор»', () => {
    let projectId: string
    let adminRole: RoleSummary

    beforeAll(async () => {
      projectId = (await h.createProject(systemOwner, 'Захист')).id
      adminRole = roleByKey(await rolesOf(systemOwner, projectId), 'admin')
    })

    it('API: не изменить и не удалить — 409, строка в базе прежняя', async () => {
      const before = await storedRole(adminRole.id)
      const attempts: [string, unknown][] = [
        ['PUT', { permissions: MANAGER }],
        ['PUT', { name: 'Не адмін' }],
        ['DELETE', undefined],
      ]
      for (const [method, body] of attempts) {
        const res = await systemOwner.api(method as 'PUT' | 'DELETE', `/roles/${adminRole.id}`, {
          project: projectId,
          ...(body === undefined ? {} : { body }),
        })
        expect({ method, body, status: res.status }).toEqual({ method, body, status: 409 })
        expect(await res.json()).toEqual({ code: 'ADMIN_ROLE_LOCKED' })
      }
      expect(await storedRole(adminRole.id)).toEqual(before)
    })

    it('база: роль приложения не урезает, не удаляет и не снимает признак администратора', async () => {
      const attempts = [
        sql`update role set permissions = '{}'::jsonb where is_admin`,
        sql`update role set name = 'Інша' where is_admin`,
        sql`update role set is_admin = false where is_admin`,
        sql`delete from role where is_admin`,
      ]
      for (const statement of attempts) {
        await expect(
          withProject(h.appDb, projectId, (trx) => statement.execute(trx)),
        ).rejects.toMatchObject({ code: 'AR001' })
      }
      // Сделать администратором другую роль тоже нельзя: признак не меняется.
      await expect(
        withProject(h.appDb, projectId, (trx) =>
          sql`update role set is_admin = true where template_key = 'head'`.execute(trx),
        ),
      ).rejects.toMatchObject({ code: 'AR001' })
      // Вторая роль администратора в проекте не вставляется.
      await expect(
        withProject(h.appDb, projectId, (trx) =>
          sql`insert into role (project_id, name, template_key, is_admin, permissions)
              values (${projectId}, 'Ще адмін', 'admin', true, '{}')`.execute(trx),
        ),
      ).rejects.toThrow(/role_one_admin_per_project/)
      expect((await storedRole(adminRole.id)).is_admin).toBe(true)
    })

    it('администратор действует со всеми правами каталога', async () => {
      expect(adminRole.permissions).toEqual(fullPermissions())
    })
  })

  describe('последний администратор', () => {
    let projectId: string
    let roles: RoleSummary[]
    let second: SignedInUser

    beforeAll(async () => {
      projectId = (await h.createProject(systemOwner, 'Останній')).id
      roles = await rolesOf(systemOwner, projectId)
      second = await h.signIn()
      await h.addMember(projectId, second.id, 'manager')
    })

    const assign = (userId: string, key: string) =>
      systemOwner.api('PUT', `/members/${userId}/role`, {
        project: projectId,
        body: { roleId: roleByKey(roles, key).id },
      })

    it('с единственного администратора роль не снимается — 409 LAST_ADMIN', async () => {
      const res = await assign(systemOwner.id, 'manager')
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ code: 'LAST_ADMIN' })
      const admins = await rolesOf(systemOwner, projectId)
      expect(roleByKey(admins, 'admin').memberCount).toBe(1)
    })

    it('когда есть второй администратор — снимается; затем второго снять нельзя', async () => {
      expect((await assign(second.id, 'admin')).status).toBe(200)
      expect((await assign(systemOwner.id, 'head')).status).toBe(200)

      // Владелец системы теперь «керівник»: права «пользователи и роли» у него нет, и
      // статус владельца системы его не добавляет.
      const denied = await assign(second.id, 'manager')
      expect(denied.status).toBe(403)
      expect(await denied.json()).toEqual({ code: 'PERMISSION_DENIED' })

      const self = await second.api('PUT', `/members/${second.id}/role`, {
        project: projectId,
        body: { roleId: roleByKey(roles, 'manager').id },
      })
      expect(self.status).toBe(409)
      expect(await self.json()).toEqual({ code: 'LAST_ADMIN' })

      // Удалить участие последнего администратора база тоже не даёт.
      await expect(
        withProject(h.appDb, projectId, (trx) =>
          trx.deleteFrom('project_member').where('user_id', '=', second.id).execute(),
        ),
      ).rejects.toMatchObject({ code: 'AR002' })

      // Возвращаем владельцу системы роль администратора (второй администратор назначает).
      const back = await second.api('PUT', `/members/${systemOwner.id}/role`, {
        project: projectId,
        body: { roleId: roleByKey(roles, 'admin').id },
      })
      expect(back.status).toBe(200)
    })

    it('параллельные снятия двух последних администраторов: одно отклоняется', async () => {
      // Сейчас администраторы — владелец системы и second. Две транзакции снимают по одному.
      const manager = roleByKey(roles, 'manager').id
      let firstUpdated!: () => void
      const updated = new Promise<void>((resolve) => {
        firstUpdated = resolve
      })
      let releaseFirst!: () => void
      const release = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      const demote = (db: Kysely<never>, userId: string) =>
        sql`update project_member set role_id = ${manager} where user_id = ${userId}`.execute(db)

      const first = withProject(h.appDb, projectId, async (trx) => {
        await demote(trx as never, systemOwner.id)
        firstUpdated()
        await release
      })
      await updated
      const secondTx = withProject(h.appDb, projectId, (trx) => demote(trx as never, second.id))
      // Вторая транзакция ждёт блокировку роли администратора, пока первая не завершится.
      await new Promise((resolve) => setTimeout(resolve, 300))
      releaseFirst()
      const results = await Promise.allSettled([first, secondTx])
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected'])
      expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ code: 'AR002' })
      expect(roleByKey(await rolesOf(second, projectId), 'admin').memberCount).toBe(1)
    })

    it('проект удаляется вместе с ролями и участниками', async () => {
      const project = await h.createProject(systemOwner, 'Видалення')
      await h.owner.deleteFrom('project').where('id', '=', project.id).execute()
      const left = await h.owner
        .selectFrom('role')
        .select('id')
        .where('project_id', '=', project.id)
        .execute()
      expect(left).toEqual([])
    })
  })

  describe('проверка прав', () => {
    let projectId: string
    let manager: SignedInUser
    let roles: RoleSummary[]

    beforeAll(async () => {
      projectId = (await h.createProject(systemOwner, 'Права')).id
      roles = await rolesOf(systemOwner, projectId)
      manager = await h.signIn()
      await h.addMember(projectId, manager.id, 'manager')
    })

    it('без права «пользователи и роли» — 403 PERMISSION_DENIED на каждый маршрут', async () => {
      const head = roleByKey(roles, 'head').id
      const requests: ['GET' | 'POST' | 'PUT' | 'DELETE', string, unknown][] = [
        ['GET', '/roles', undefined],
        ['POST', '/roles', { name: 'Своя', permissions: MANAGER }],
        ['PUT', `/roles/${head}`, { name: 'Інша' }],
        ['DELETE', `/roles/${head}`, undefined],
        ['PUT', `/members/${manager.id}/role`, { roleId: roleByKey(roles, 'admin').id }],
      ]
      for (const [method, path, body] of requests) {
        const res = await manager.api(method, path, {
          project: projectId,
          ...(body === undefined ? {} : { body }),
        })
        expect({ method, path, status: res.status }).toEqual({ method, path, status: 403 })
        expect(await res.json()).toEqual({ code: 'PERMISSION_DENIED' })
      }
      // Ничего не изменилось: роль менеджера осталась, «керівник» на месте.
      const member = await h.owner
        .selectFrom('project_member')
        .select('role_id')
        .where('user_id', '=', manager.id)
        .where('project_id', '=', projectId)
        .executeTakeFirstOrThrow()
      expect(member.role_id).toBe(roleByKey(roles, 'manager').id)
      expect((await rolesOf(systemOwner, projectId)).length).toBe(4)
    })

    it('владелец системы с ролью «менеджер» прав сверх роли не получает', async () => {
      const otherOwner = await h.signIn('owner')
      await h.addMember(projectId, otherOwner.id, 'manager')
      const res = await otherOwner.api('GET', '/roles', { project: projectId })
      expect(res.status).toBe(403)
    })

    it('право проверяется по действию: «смотреть» без «создавать»', async () => {
      const viewer = await h.signIn()
      const created = await systemOwner.api('POST', '/roles', {
        project: projectId,
        body: {
          name: 'Дивиться ролі',
          permissions: { ...MANAGER, actions: { ...MANAGER.actions, users_roles: ['view'] } },
        },
      })
      expect(created.status).toBe(201)
      const role = (await created.json()) as RoleSummary
      await h.owner
        .insertInto('project_member')
        .values({ project_id: projectId, user_id: viewer.id, role_id: role.id })
        .execute()

      expect((await viewer.api('GET', '/roles', { project: projectId })).status).toBe(200)
      const post = await viewer.api('POST', '/roles', {
        project: projectId,
        body: { name: 'Ще одна', permissions: MANAGER },
      })
      expect(post.status).toBe(403)
    })

    it('requirePermission на произвольном маршруте: есть право — 200, нет — 403', async () => {
      const probe = new Hono<AccessEnv>()
        .use('*', accessGuard(h.auth))
        .use('*', projectContext(h.appDb))
        .get('/deals', requirePermission('deals', 'view'), (c) => c.text('угоди'))
        .delete('/deals', requirePermission('deals', 'delete'), (c) => c.text('видалено'))
        .route(
          '/access',
          new Hono<PermissionsEnv>().get('/', requirePermission('deals', 'view'), (c) =>
            c.json(c.get('access')),
          ),
        )
      const call = (method: 'GET' | 'DELETE', path: string) =>
        manager.call(probe, method, path, { project: projectId })
      expect((await call('GET', '/deals')).status).toBe(200)
      const del = await call('DELETE', '/deals')
      expect(del.status).toBe(403)
      expect(await del.json()).toEqual({ code: 'PERMISSION_DENIED' })
      const access = (await (await call('GET', '/access')).json()) as { isAdmin: boolean }
      expect(access.isAdmin).toBe(false)
    })
  })

  describe('управление ролями', () => {
    let projectId: string
    let roles: RoleSummary[]

    beforeAll(async () => {
      projectId = (await h.createProject(systemOwner, 'Конструктор')).id
      roles = await rolesOf(systemOwner, projectId)
    })

    it('создать, изменить, назначить, удалить свою роль', async () => {
      const created = await systemOwner.api('POST', '/roles', {
        project: projectId,
        body: { name: '  Стажер  ', permissions: { actions: { deals: ['view'] } } },
      })
      expect(created.status).toBe(201)
      const role = (await created.json()) as RoleSummary
      expect(role).toMatchObject({ name: 'Стажер', templateKey: null, isAdmin: false })
      expect(role.permissions.actions.deals).toEqual(['view'])
      expect(role.permissions.scopes.deals).toEqual({ read: 'own', write: 'own' })

      const taken = await systemOwner.api('POST', '/roles', {
        project: projectId,
        body: { name: 'Стажер', permissions: {} },
      })
      expect(taken.status).toBe(409)
      expect(await taken.json()).toEqual({ code: 'ROLE_NAME_TAKEN' })

      const edited = await systemOwner.api('PUT', `/roles/${role.id}`, {
        project: projectId,
        body: {
          permissions: {
            actions: { deals: ['view', 'edit'] },
            scopes: { deals: { read: 'all', write: 'own' } },
            standalone: ['export'],
          },
        },
      })
      expect(edited.status).toBe(200)
      const after = (await edited.json()) as RoleSummary
      expect(after.name).toBe('Стажер')
      expect(after.permissions.actions.deals).toEqual(['view', 'edit'])
      expect(after.permissions.scopes.deals).toEqual({ read: 'all', write: 'own' })
      expect(after.permissions.standalone).toEqual(['export'])

      const member = await h.signIn()
      await h.addMember(projectId, member.id, 'manager')
      const assigned = await systemOwner.api('PUT', `/members/${member.id}/role`, {
        project: projectId,
        body: { roleId: role.id },
      })
      expect(assigned.status).toBe(200)

      const inUse = await systemOwner.api('DELETE', `/roles/${role.id}`, { project: projectId })
      expect(inUse.status).toBe(409)
      expect(await inUse.json()).toEqual({ code: 'ROLE_IN_USE' })

      await systemOwner.api('PUT', `/members/${member.id}/role`, {
        project: projectId,
        body: { roleId: roleByKey(roles, 'manager').id },
      })
      const deleted = await systemOwner.api('DELETE', `/roles/${role.id}`, { project: projectId })
      expect(deleted.status).toBe(204)
      expect((await rolesOf(systemOwner, projectId)).map((r) => r.id)).not.toContain(role.id)
    })

    it('права не по каталогу — 400 INVALID_ROLE, роль не создана', async () => {
      const bodies = [
        { name: 'X', permissions: { actions: { spaceships: ['view'] } } },
        { name: 'X', permissions: { actions: { deals: ['fly'] } } },
        { name: 'X', permissions: { actions: { deals: ['edit'] } } },
        { name: 'X', permissions: { scopes: { products: { read: 'all' } } } },
        { name: 'X', permissions: { scopes: { deals: { read: 'galaxy' } } } },
        { name: 'X', permissions: { standalone: ['launch'] } },
        { name: 'X', permissions: { fieldGroups: { g1: 'secret' } } },
        { name: '   ', permissions: {} },
        { name: 'X', permissions: 'all' },
      ]
      for (const body of bodies) {
        const res = await systemOwner.api('POST', '/roles', { project: projectId, body })
        expect({ body, status: res.status }).toEqual({ body, status: 400 })
        expect(((await res.json()) as { code: string }).code).toBe('INVALID_ROLE')
      }
      expect((await rolesOf(systemOwner, projectId)).length).toBe(4)
    })

    it('роль и участник другого проекта недоступны — 404', async () => {
      const other = await h.createProject(systemOwner, 'Інший')
      const foreignRole = roleByKey(await rolesOf(systemOwner, other.id), 'head')
      const put = await systemOwner.api('PUT', `/roles/${foreignRole.id}`, {
        project: projectId,
        body: { name: 'Чужа' },
      })
      expect(put.status).toBe(404)
      const assign = await systemOwner.api('PUT', `/members/${systemOwner.id}/role`, {
        project: projectId,
        body: { roleId: foreignRole.id },
      })
      expect(assign.status).toBe(404)
      expect(await assign.json()).toEqual({ code: 'ROLE_NOT_FOUND' })
      expect((await storedRole(foreignRole.id)).name).toBe('Керівник')
    })
  })

  describe('охват записей', () => {
    // Тестовая таблица с ответственным и командой — как будущие сделки. Охват смотрит на
    // ответственного: строка с «нашей» командой, но чужим ответственным в «команду» не входит.
    interface ProbeDb {
      scope_probe: { id: string; owner_user_id: string | null; team_id: string | null }
    }
    let db: Kysely<ProbeDb>

    beforeAll(async () => {
      db = h.owner as unknown as Kysely<ProbeDb>
      await sql`create table scope_probe (id text primary key, owner_user_id text, team_id text)`.execute(
        db,
      )
      await db
        .insertInto('scope_probe')
        .values([
          { id: 'mine', owner_user_id: 'u-me', team_id: 't-1' },
          { id: 'teammate', owner_user_id: 'u-mate', team_id: 't-1' },
          { id: 'same-team-id-stranger', owner_user_id: 'u-stranger', team_id: 't-1' },
          { id: 'stranger', owner_user_id: 'u-stranger', team_id: 't-2' },
          { id: 'queue', owner_user_id: null, team_id: null },
        ])
        .execute()
    })

    const viewer: Viewer = { userId: 'u-me', teamUserIds: ['u-mate'] }

    async function visible(scope: 'own' | 'team' | 'all', who: Viewer = viewer) {
      const rows = await db
        .selectFrom('scope_probe')
        .select('id')
        .where((eb) => scopePredicate(eb, scope, who, 'scope_probe.owner_user_id'))
        .orderBy('id')
        .execute()
      return rows.map((r) => r.id)
    }

    it('«свои» — только где пользователь ответственный', async () => {
      expect(await visible('own')).toEqual(['mine'])
    })

    it('«команда» — ответственный из команды пользователя, включая его самого', async () => {
      expect(await visible('team')).toEqual(['mine', 'teammate'])
    })

    it('«все» — все строки, и без ответственного тоже', async () => {
      expect(await visible('all')).toEqual([
        'mine',
        'queue',
        'same-team-id-stranger',
        'stranger',
        'teammate',
      ])
    })

    it('пока команд нет (NO_TEAMS), «команда» равна «свои»', async () => {
      const alone = await resolveViewer(h.owner, 'u-me', NO_TEAMS)
      expect(alone).toEqual({ userId: 'u-me', teamUserIds: [] })
      expect(await visible('team', alone)).toEqual(['mine'])
    })

    it('значение пользователя уходит параметром, а не текстом запроса', () => {
      const compiled = db
        .selectFrom('scope_probe')
        .select('id')
        .where((eb) =>
          scopePredicate(
            eb,
            'team',
            { userId: "x' or 1=1 --", teamUserIds: ['y'] },
            'owner_user_id',
          ),
        )
        .compile()
      expect(compiled.sql).toContain('"owner_user_id" in ($1, $2)')
      expect(compiled.parameters).toEqual(["x' or 1=1 --", 'y'])
    })
  })

  describe('роль приложения и учётные записи', () => {
    it('не может менять "user".role (роль владельца системы), но может банить', async () => {
      const user = await h.signIn()
      await expect(
        sql`update "user" set role = 'admin' where id = ${user.id}`.execute(h.appDb),
      ).rejects.toThrow(/permission denied for table user/)
      await sql`update "user" set banned = true, ban_reason = 'тест' where id = ${user.id}`.execute(
        h.appDb,
      )
      const row = await h.owner
        .selectFrom('user')
        .select(['role', 'banned'])
        .where('id', '=', user.id)
        .executeTakeFirstOrThrow()
      expect(row).toEqual({ role: 'user', banned: true })
    })
  })
})
