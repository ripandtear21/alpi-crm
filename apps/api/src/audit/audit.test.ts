import { randomBytes, randomUUID } from 'node:crypto'
import { purgeExpiredFailedSignIns, withProject } from '@alpi/db'
import { type AuditActor, type AuditPage, ROLE_TEMPLATES } from '@alpi/shared'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SIGN_IN_RATE_LIMIT } from '../auth/auth.ts'
import {
  type ApiHarness,
  ORIGIN,
  type SignedInUser,
  startApiHarness,
} from '../testing/api-harness.ts'
import { totp } from '../testing/totp.ts'

// Журнал входов и опасных действий (тикет crm-foundation/07) на настоящем PostgreSQL: API
// ходит ролью приложения, журнал читаем служебной ролью (системный журнал роль приложения не
// читает) или через экран журнала.

const MANAGER = ROLE_TEMPLATES.find((t) => t.key === 'manager')?.permissions

describe('журнал действий', () => {
  let h: ApiHarness
  let systemOwner: SignedInUser

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_audit')
    systemOwner = await h.signIn('owner')
  })

  afterAll(async () => {
    await h?.stop()
  })

  function randomIp() {
    const [a = 0, b = 0, c = 0] = randomBytes(3)
    return `10.${a}.${b}.${c}`
  }

  /** Браузер без входа: свой адрес и свои cookie. */
  function anonymous(ip = randomIp()) {
    const jar = new Map<string, string>()
    async function post(path: string, body: unknown) {
      const headers = new Headers({
        origin: ORIGIN,
        'x-forwarded-for': ip,
        'content-type': 'application/json',
      })
      if (jar.size > 0) {
        headers.set('cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '))
      }
      const res = await h.app.request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
      for (const cookie of res.headers.getSetCookie()) {
        const [pair = ''] = cookie.split(';')
        const eq = pair.indexOf('=')
        jar.set(pair.slice(0, eq), pair.slice(eq + 1))
      }
      return res
    }
    return { ip, post }
  }

  /** Системный журнал пользователя — служебной ролью. */
  async function systemEvents(filter: { actorId?: string; ip?: string; email?: string }) {
    let query = h.owner
      .selectFrom('system_audit_log')
      .select([
        'action',
        'actor_id',
        sql<string | null>`host(ip)`.as('ip'),
        'entity_type',
        'entity_id',
        'details',
        'attempted_email',
      ])
      .orderBy('occurred_at')
      .orderBy(sql`ctid`)
    if (filter.actorId) query = query.where('actor_id', '=', filter.actorId)
    if (filter.ip) query = query.where(sql`host(ip)`, '=', filter.ip)
    if (filter.email) query = query.where('attempted_email', '=', filter.email)
    return query.execute()
  }

  async function auditPage(user: SignedInUser, projectId: string, params = ''): Promise<AuditPage> {
    const res = await user.api('GET', `/audit${params}`, { project: projectId })
    expect(res.status).toBe(200)
    return (await res.json()) as AuditPage
  }

  async function roleIdOf(projectId: string, templateKey: string) {
    const row = await h.owner
      .selectFrom('role')
      .select('id')
      .where('project_id', '=', projectId)
      .where('template_key', '=', templateKey)
      .executeTakeFirstOrThrow()
    return row.id
  }

  describe('вход и выход', () => {
    it('первый вход, включение 2FA, выход и вход с кодом пишутся с адресом клиента', async () => {
      const user = await h.signIn()
      expect((await user.api('POST', '/auth/sign-out', { body: {} })).status).toBe(200)

      const browser = anonymous(user.ip)
      const password = await browser.post('/auth/sign-in/email', {
        email: user.email,
        password: user.password,
      })
      expect(password.status).toBe(200)
      expect(await password.json()).toMatchObject({ twoFactorRedirect: true })
      const code = await browser.post('/auth/two-factor/verify-totp', {
        code: totp(user.totpSecret),
      })
      expect(code.status).toBe(200)

      const events = await systemEvents({ actorId: user.id })
      expect(events.map((e) => [e.action, e.details])).toEqual([
        ['auth.sign_in', { method: 'password' }],
        ['auth.two_factor_enabled', {}],
        ['auth.sign_out', {}],
        ['auth.password_accepted', { method: 'password' }],
        ['auth.sign_in', { method: 'totp' }],
      ])
      for (const event of events) {
        expect(event).toMatchObject({ ip: user.ip, entity_type: 'user', entity_id: user.id })
      }
    })

    it('неудачный вход: неверный пароль — с учётной записью, email и адресом', async () => {
      const user = await h.signIn()
      const browser = anonymous()
      const res = await browser.post('/auth/sign-in/email', {
        email: user.email,
        password: 'не-той-пароль-123',
      })
      expect(res.status).toBe(401)

      expect(await systemEvents({ ip: browser.ip })).toEqual([
        {
          action: 'auth.sign_in_failed',
          actor_id: user.id,
          ip: browser.ip,
          entity_type: 'user',
          entity_id: user.id,
          details: { stage: 'password', reason: 'INVALID_EMAIL_OR_PASSWORD' },
          attempted_email: user.email,
        },
      ])
    })

    it('неудачный вход с несуществующим email: email попытки сохраняется, автора нет', async () => {
      const email = `${randomUUID()}@nobody.test`
      const browser = anonymous()
      const res = await browser.post('/auth/sign-in/email', { email, password: 'щось-зовсім-інше' })
      expect(res.status).toBe(401)

      expect(await systemEvents({ ip: browser.ip })).toEqual([
        {
          action: 'auth.sign_in_failed',
          actor_id: null,
          ip: browser.ip,
          entity_type: null,
          entity_id: null,
          details: { stage: 'password', reason: 'INVALID_EMAIL_OR_PASSWORD' },
          attempted_email: email,
        },
      ])
    })

    it('в поле email не email (например, пароль) — в журнал не попадает', async () => {
      const browser = anonymous()
      for (const [value, rejected] of [
        ['Tr0ub4dor&3-секрет', 'not_an_email'],
        [`${'a'.repeat(250)}@example.test`, 'too_long'],
      ] as const) {
        const res = await browser.post('/auth/sign-in/email', { email: value, password: 'x' })
        expect(res.status).toBeGreaterThanOrEqual(400)
        const [event] = (await systemEvents({ ip: browser.ip })).slice(-1)
        expect(event).toMatchObject({
          action: 'auth.sign_in_failed',
          attempted_email: null,
          details: { stage: 'password', attemptedEmailRejected: rejected },
        })
      }
      const all = await h.owner
        .selectFrom('system_audit_log')
        .select('id')
        .where(sql<boolean>`details::text like '%Tr0ub4dor%'`)
        .execute()
      expect(all).toEqual([])
    })

    it('неверный код 2FA при входе — неудачный вход второго шага', async () => {
      const user = await h.signIn()
      const browser = anonymous()
      await browser.post('/auth/sign-in/email', { email: user.email, password: user.password })
      const wrong = String((Number(totp(user.totpSecret)) + 1) % 1_000_000).padStart(6, '0')
      const res = await browser.post('/auth/two-factor/verify-totp', { code: wrong })
      expect(res.status).toBe(401)

      const events = await systemEvents({ ip: browser.ip })
      expect(events.map((e) => [e.action, e.actor_id, e.details])).toEqual([
        ['auth.password_accepted', user.id, { method: 'password' }],
        [
          'auth.sign_in_failed',
          user.id,
          { stage: 'second_factor', method: 'totp', reason: 'INVALID_CODE' },
        ],
      ])
    })

    it('отключение 2FA пишется', async () => {
      const user = await h.signIn()
      const res = await user.api('POST', '/auth/two-factor/disable', {
        body: { password: user.password },
      })
      expect(res.status).toBe(200)
      const actions = (await systemEvents({ actorId: user.id })).map((e) => e.action)
      expect(actions.at(-1)).toBe('auth.two_factor_disabled')
    })

    it('неудачные входы пишутся не чаще, чем пропускает ограничитель попыток', async () => {
      const browser = anonymous()
      const statuses: number[] = []
      for (let i = 0; i < SIGN_IN_RATE_LIMIT.max + 3; i++) {
        const res = await browser.post('/auth/sign-in/email', {
          email: `${randomUUID()}@flood.test`,
          password: 'неправильний-пароль',
        })
        statuses.push(res.status)
      }
      expect(statuses.filter((s) => s === 429)).toHaveLength(3)
      expect(await systemEvents({ ip: browser.ip })).toHaveLength(SIGN_IN_RATE_LIMIT.max)
    })
  })

  describe('события проекта', () => {
    it('смена роли участника пишется с «было → стало»', async () => {
      const project = await h.createProject(systemOwner, 'Ролі')
      const member = await h.signIn()
      await h.addMember(project.id, member.id, 'manager')
      const managerRole = await roleIdOf(project.id, 'manager')
      const headRole = await roleIdOf(project.id, 'head')

      const res = await systemOwner.api('PUT', `/members/${member.id}/role`, {
        project: project.id,
        body: { roleId: headRole },
      })
      expect(res.status).toBe(200)

      const page = await auditPage(systemOwner, project.id, '?action=member.role_changed')
      expect(page.items).toHaveLength(1)
      expect(page.items[0]).toMatchObject({
        action: 'member.role_changed',
        actor: { id: systemOwner.id },
        ip: systemOwner.ip,
        entityType: 'user',
        entityId: member.id,
        entityName: 'Користувач',
        details: {
          before: { roleId: managerRole, roleName: 'Менеджер' },
          after: { roleId: headRole, roleName: 'Керівник' },
        },
      })
    })

    it('создание, изменение и удаление роли пишутся; отказ базы не пишется', async () => {
      const project = await h.createProject(systemOwner, 'Свої ролі')
      const created = await systemOwner.api('POST', '/roles', {
        project: project.id,
        body: { name: 'Стажер', permissions: MANAGER },
      })
      expect(created.status).toBe(201)
      const { id } = (await created.json()) as { id: string }
      const duplicate = await systemOwner.api('POST', '/roles', {
        project: project.id,
        body: { name: 'Стажер', permissions: MANAGER },
      })
      expect(duplicate.status).toBe(409)
      const renamed = await systemOwner.api('PUT', `/roles/${id}`, {
        project: project.id,
        body: { name: 'Практикант' },
      })
      expect(renamed.status).toBe(200)
      expect(
        (await systemOwner.api('DELETE', `/roles/${id}`, { project: project.id })).status,
      ).toBe(204)

      const page = await auditPage(systemOwner, project.id)
      expect(page.items.map((e) => [e.action, e.entityId, e.details])).toEqual([
        ['role.deleted', id, { before: { name: 'Практикант', permissions: MANAGER } }],
        ['role.updated', id, { before: { name: 'Стажер' }, after: { name: 'Практикант' } }],
        ['role.created', id, { after: { name: 'Стажер', permissions: MANAGER } }],
      ])
    })

    it('администратор проекта A не видит журнал проекта B', async () => {
      const adminA = await h.signIn('owner')
      const adminB = await h.signIn('owner')
      const projectA = await h.createProject(adminA, 'A')
      const projectB = await h.createProject(adminB, 'B')
      const created = await adminB.api('POST', '/roles', {
        project: projectB.id,
        body: { name: 'Таємна роль', permissions: MANAGER },
      })
      expect(created.status).toBe(201)

      // Чужой проект в заголовке — отказ, как для любого раздела проекта.
      const foreign = await adminA.api('GET', '/audit', { project: projectB.id })
      expect(foreign.status).toBe(403)
      // В своём проекте — только свои записи.
      expect((await auditPage(adminA, projectA.id)).items).toEqual([])
      expect((await auditPage(adminB, projectB.id)).items).toHaveLength(1)
      // И на уровне базы: роль приложения в контексте A строк B не видит.
      const visible = await withProject(h.appDb, projectA.id, (trx) =>
        trx.selectFrom('audit_log').select('project_id').execute(),
      )
      expect(visible.every((row) => row.project_id === projectA.id)).toBe(true)
      await expect(
        withProject(h.appDb, projectA.id, (trx) =>
          trx
            .insertInto('audit_log')
            .values({ project_id: projectB.id, action: 'role.created', actor_id: null })
            .execute(),
        ),
      ).rejects.toThrow(/row-level security/)
    })

    it('журнал видит только роль с правом «настройки проекта»', async () => {
      const project = await h.createProject(systemOwner, 'Права журналу')
      const head = await h.signIn()
      await h.addMember(project.id, head.id, 'head')
      const res = await head.api('GET', '/audit', { project: project.id })
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ code: 'PERMISSION_DENIED' })
      expect((await head.api('GET', '/audit/actors', { project: project.id })).status).toBe(403)
    })

    it('страницы новые сверху по курсору, фильтр по пользователю, список авторов', async () => {
      const project = await h.createProject(systemOwner, 'Сторінки')
      const second = await h.signIn()
      await h.addMember(project.id, second.id, 'admin')
      for (const [user, name] of [
        [systemOwner, 'Р1'],
        [second, 'Р2'],
        [systemOwner, 'Р3'],
      ] as const) {
        const res = await user.api('POST', '/roles', {
          project: project.id,
          body: { name, permissions: MANAGER },
        })
        expect(res.status).toBe(201)
      }

      const first = await auditPage(systemOwner, project.id, '?limit=2')
      expect(first.items.map((e) => e.details.after)).toMatchObject([
        { name: 'Р3' },
        { name: 'Р2' },
      ])
      expect(first.nextCursor).not.toBeNull()
      const rest = await auditPage(systemOwner, project.id, `?limit=2&cursor=${first.nextCursor}`)
      expect(rest.items.map((e) => e.details.after)).toMatchObject([{ name: 'Р1' }])
      expect(rest.nextCursor).toBeNull()

      const bySecond = await auditPage(systemOwner, project.id, `?actor=${second.id}`)
      expect(bySecond.items.map((e) => e.actor?.id)).toEqual([second.id])

      const actorsRes = await systemOwner.api('GET', '/audit/actors', { project: project.id })
      const actors = (await actorsRes.json()) as AuditActor[]
      expect(actors.map((a) => a.id).sort()).toEqual([systemOwner.id, second.id].sort())

      for (const bad of ['?action=auth.sign_in', '?cursor=zzz', '?limit=0', '?limit=101']) {
        const res = await systemOwner.api('GET', `/audit${bad}`, { project: project.id })
        expect(res.status, bad).toBe(400)
      }
    })
  })

  describe('только добавление', () => {
    it('роль приложения не меняет и не удаляет записи журналов и не читает системный', async () => {
      const project = await h.createProject(systemOwner, 'Незмінний')
      await withProject(h.appDb, project.id, async (trx) => {
        await sql`savepoint s`.execute(trx)
        for (const statement of [
          sql`update audit_log set action = 'role.deleted'`,
          sql`delete from audit_log`,
          sql`truncate audit_log`,
          sql`update system_audit_log set action = 'auth.sign_in'`,
          sql`delete from system_audit_log`,
          sql`truncate system_audit_log`,
          sql`select count(*) from system_audit_log`,
        ]) {
          await expect(statement.execute(trx), statement.compile(trx).sql).rejects.toThrow(
            /permission denied/,
          )
          await sql`rollback to savepoint s`.execute(trx)
        }
      })
      // Служебная функция очистки под ролью приложения тоже не работает.
      await expect(purgeExpiredFailedSignIns(h.appDb)).rejects.toThrow(/permission denied/)
    })

    it('очистка удаляет только неудачные входы старше 90 дней', async () => {
      const marker = randomIp()
      const at = (days: number) => sql<Date>`now() - make_interval(days => ${days})`
      await h.owner
        .insertInto('system_audit_log')
        .values([
          { action: 'auth.sign_in_failed', ip: marker, occurred_at: at(91) },
          { action: 'auth.sign_in_failed', ip: marker, occurred_at: at(89) },
          { action: 'auth.sign_in', ip: marker, occurred_at: at(400) },
        ])
        .execute()

      expect(await purgeExpiredFailedSignIns(h.owner)).toBeGreaterThanOrEqual(1)
      const left = await h.owner
        .selectFrom('system_audit_log')
        .select(['action', sql<number>`extract(day from now() - occurred_at)::int`.as('age')])
        .where(sql`host(ip)`, '=', marker)
        .orderBy('occurred_at')
        .execute()
      expect(left).toEqual([
        { action: 'auth.sign_in', age: 400 },
        { action: 'auth.sign_in_failed', age: 89 },
      ])
    })
  })

  describe('системный журнал', () => {
    it('виден владельцу системы постранично и с фильтром, другим — нет', async () => {
      const user = await h.signIn()
      const denied = await user.api('GET', '/system-audit')
      expect(denied.status).toBe(403)

      const page = await systemOwner.api(
        'GET',
        `/system-audit?action=auth.two_factor_enabled&actor=${user.id}`,
      )
      expect(page.status).toBe(200)
      const body = (await page.json()) as AuditPage
      expect(body.items).toHaveLength(1)
      expect(body.items[0]).toMatchObject({
        action: 'auth.two_factor_enabled',
        actor: { id: user.id, email: user.email },
        ip: user.ip,
      })

      const first = (await (
        await systemOwner.api('GET', '/system-audit?limit=1')
      ).json()) as AuditPage
      expect(first.items).toHaveLength(1)
      const next = (await (
        await systemOwner.api('GET', `/system-audit?limit=1&cursor=${first.nextCursor}`)
      ).json()) as AuditPage
      expect(next.items).toHaveLength(1)
      expect(next.items[0]?.id).not.toBe(first.items[0]?.id)

      expect((await systemOwner.api('GET', '/system-audit?action=role.created')).status).toBe(400)
    })
  })

  describe('вход под чужой учётной записью', () => {
    it('выключен даже для владельца системы', async () => {
      const target = await h.signIn()
      const res = await systemOwner.api('POST', '/auth/admin/impersonate-user', {
        body: { userId: target.id },
      })
      expect(res.status).toBe(404)
      const impersonated = await h.owner
        .selectFrom('session')
        .select('id')
        .where('impersonated_by', 'is not', null)
        .execute()
      expect(impersonated).toEqual([])
    })
  })

  describe('действия владельца системы с учётными записями', () => {
    it('создание, бан, снятие бана и отзыв сессий пишутся; удаление выключено', async () => {
      const email = `${randomUUID()}@example.test`
      const created = await systemOwner.api('POST', '/auth/admin/create-user', {
        body: { email, password: randomBytes(18).toString('base64url'), name: 'Новий' },
      })
      expect(created.status).toBe(200)
      const { user } = (await created.json()) as { user: { id: string } }
      for (const path of ['ban-user', 'unban-user', 'revoke-user-sessions']) {
        const res = await systemOwner.api('POST', `/auth/admin/${path}`, {
          body: { userId: user.id, ...(path === 'ban-user' ? { banReason: 'тест' } : {}) },
        })
        expect(res.status, path).toBe(200)
      }
      const removed = await systemOwner.api('POST', '/auth/admin/remove-user', {
        body: { userId: user.id },
      })
      expect(removed.status).toBe(404)
      expect(
        await h.owner.selectFrom('user').select('id').where('id', '=', user.id).execute(),
      ).toHaveLength(1)

      const events = await h.owner
        .selectFrom('system_audit_log')
        .select(['action', 'actor_id', 'details'])
        .where('entity_id', '=', user.id)
        .orderBy('occurred_at')
        .orderBy(sql`ctid`)
        .execute()
      expect(events).toEqual([
        { action: 'admin.user_created', actor_id: systemOwner.id, details: { role: null } },
        {
          action: 'admin.user_banned',
          actor_id: systemOwner.id,
          details: { reason: 'тест', expiresIn: null },
        },
        { action: 'admin.user_unbanned', actor_id: systemOwner.id, details: {} },
        { action: 'admin.sessions_revoked', actor_id: systemOwner.id, details: {} },
      ])
    })
  })

  describe('сбой записи в журнал', () => {
    /** Пока выполняется `fn`, любая вставка в `table` падает с ошибкой. */
    async function withBrokenJournal(table: 'audit_log' | 'system_audit_log', fn: () => unknown) {
      await sql`
        create function public.test_broken_journal() returns trigger language plpgsql
        as $$ begin raise exception 'журнал недоступен'; end $$
      `.execute(h.owner)
      await sql`
        create trigger test_broken_journal before insert on ${sql.table(table)}
          for each row execute function public.test_broken_journal()
      `.execute(h.owner)
      try {
        await fn()
      } finally {
        await sql`drop trigger test_broken_journal on ${sql.table(table)}`.execute(h.owner)
        await sql`drop function public.test_broken_journal()`.execute(h.owner)
      }
    }

    async function sessionsOf(userId: string) {
      const rows = await h.owner
        .selectFrom('session')
        .select('id')
        .where('user_id', '=', userId)
        .execute()
      return rows.map((r) => r.id).sort()
    }

    it('вход не состоялся: ответ 500, созданная сессия удалена', async () => {
      const user = await h.signIn()
      const before = await sessionsOf(user.id)
      const browser = anonymous()
      // Пароль принят при рабочем журнале; код — уже при сломанном.
      const password = await browser.post('/auth/sign-in/email', {
        email: user.email,
        password: user.password,
      })
      expect(password.status).toBe(200)
      await withBrokenJournal('system_audit_log', async () => {
        const code = await browser.post('/auth/two-factor/verify-totp', {
          code: totp(user.totpSecret),
        })
        expect(code.status).toBe(500)
        // И шаг пароля при сломанном журнале не оставляет сессии.
        const again = await anonymous().post('/auth/sign-in/email', {
          email: user.email,
          password: user.password,
        })
        expect(again.status).toBe(500)
      })
      expect(await sessionsOf(user.id)).toEqual(before)
    })

    it('выход не состоялся: ответ 500, сессия жива; с рабочим журналом выход пишется', async () => {
      const user = await h.signIn()
      await withBrokenJournal('system_audit_log', async () => {
        expect((await user.api('POST', '/auth/sign-out', { body: {} })).status).toBe(500)
      })
      expect((await user.api('GET', '/me')).status).toBe(200)
      expect((await user.api('POST', '/auth/sign-out', { body: {} })).status).toBe(200)
      expect((await user.api('GET', '/me')).status).toBe(401)
      const actions = (await systemEvents({ actorId: user.id })).map((e) => e.action)
      expect(actions.filter((a) => a === 'auth.sign_out')).toHaveLength(1)
    })

    it('смена роли и создание роли откатываются вместе с записью', async () => {
      const project = await h.createProject(systemOwner, 'Відкат')
      const member = await h.signIn()
      await h.addMember(project.id, member.id, 'manager')
      const managerRole = await roleIdOf(project.id, 'manager')
      const headRole = await roleIdOf(project.id, 'head')

      await withBrokenJournal('audit_log', async () => {
        const assigned = await systemOwner.api('PUT', `/members/${member.id}/role`, {
          project: project.id,
          body: { roleId: headRole },
        })
        expect(assigned.status).toBe(500)
        const created = await systemOwner.api('POST', '/roles', {
          project: project.id,
          body: { name: 'Без сліду', permissions: MANAGER },
        })
        expect(created.status).toBe(500)
      })

      const stored = await h.owner
        .selectFrom('project_member')
        .select('role_id')
        .where('project_id', '=', project.id)
        .where('user_id', '=', member.id)
        .executeTakeFirstOrThrow()
      expect(stored.role_id).toBe(managerRole)
      const roles = await h.owner
        .selectFrom('role')
        .select('id')
        .where('project_id', '=', project.id)
        .where('name', '=', 'Без сліду')
        .execute()
      expect(roles).toEqual([])
    })
  })

  describe('общий потолок неудачных входов', () => {
    it('за минуту больше 100 неудачных входов — email попытки не пишется, попытка пишется', async () => {
      const marker = randomIp()
      await h.owner
        .insertInto('system_audit_log')
        .values(
          Array.from({ length: 100 }, () => ({
            action: 'auth.sign_in_failed',
            ip: marker,
            attempted_email: 'flood@example.test',
          })),
        )
        .execute()
      try {
        const browser = anonymous()
        const email = `${randomUUID()}@flood.test`
        const res = await browser.post('/auth/sign-in/email', { email, password: 'хибний-пароль' })
        expect(res.status).toBe(401)
        expect(await systemEvents({ ip: browser.ip })).toEqual([
          expect.objectContaining({
            action: 'auth.sign_in_failed',
            attempted_email: null,
            details: {
              stage: 'password',
              reason: 'INVALID_EMAIL_OR_PASSWORD',
              attemptedEmailRejected: 'flood',
            },
          }),
        ])
      } finally {
        await h.owner.deleteFrom('system_audit_log').where(sql`host(ip)`, '=', marker).execute()
      }
    })
  })
})
