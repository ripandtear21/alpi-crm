import { randomUUID } from 'node:crypto'
import { withProject } from '@alpi/db'
import { ROLE_TEMPLATES } from '@alpi/shared'
import { type Kysely, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.ts'
import { type Jobs, startJobs } from '../jobs/jobs.ts'
import { scopePredicate } from '../roles/scope.ts'
import { type ApiHarness, type SignedInUser, startApiHarness } from '../testing/api-harness.ts'
import { NO_TRASH_PURGERS } from '../trash/purge.ts'
import { type BulkAction, BulkRecordError } from './registry.ts'
import type { BulkJobDetails, BulkJobSummary } from './routes.ts'
import { runBulkJob } from './runner.ts'

// Массовые операции (тикет crm-deals/04) на настоящем PostgreSQL: API и обработчик pg-boss
// ходят ролью приложения, тестовое действие меняет тестовую таблицу bulk_probe (данные проекта
// с RLS, как будущие сделки).

const BATCH = 100

/** Что видел обработчик тестового действия: для проверки порций и изоляции. */
const seen = { processed: new Set<number>(), projects: new Set<string>() }

/** Тестовая таблица без типов Kysely. */
const probe = (db: Kysely<never>) => db as unknown as Kysely<ProbeDb>
interface ProbeDb {
  bulk_probe: { id: string; project_id: string; owner_user_id: string; value: number }
  bulk_job: { id: string; processed: number }
}

const increment: BulkAction = {
  requires: { resource: 'deals', action: 'edit' },
  async select(trx) {
    // Фильтр тестового действия — «все записи проекта»: RLS оставляет только текущий проект.
    const rows = await probe(trx as never)
      .selectFrom('bulk_probe')
      .select('id')
      .orderBy('id')
      .execute()
    return rows.map((r) => r.id)
  },
  async inScope(trx, ids, ctx) {
    const rows = await probe(trx as never)
      .selectFrom('bulk_probe')
      .select('id')
      .where('id', 'in', [...ids])
      .where((eb) =>
        scopePredicate(eb, ctx.access.permissions.scopes.deals.write, ctx.viewer, 'owner_user_id'),
      )
      .execute()
    return new Set(rows.map((r) => r.id))
  },
  async apply(trx, id, ctx) {
    const db = probe(trx as never)
    // Без фильтра по проекту: видно только то, что пропускает RLS.
    for (const row of await db.selectFrom('bulk_probe').select('project_id').distinct().execute()) {
      seen.projects.add(row.project_id)
    }
    const job = await db
      .selectFrom('bulk_job')
      .select('processed')
      .where('id', '=', ctx.bulkJobId)
      .executeTakeFirstOrThrow()
    seen.processed.add(job.processed)
    const row = await db
      .updateTable('bulk_probe')
      .set((eb) => ({ value: eb('value', '+', 1) }))
      .where('id', '=', id)
      .returning('value')
      .executeTakeFirstOrThrow()
    // Запись со значением < 0 «сломана»: изменение до ошибки откатывается вместе с ней.
    if (row.value <= 0) throw new BulkRecordError('BROKEN', 'запись сломана')
  },
}

/** Сбой вне записи (например, база недоступна): порция падает целиком на каждой попытке. */
const crash: BulkAction = {
  ...increment,
  async inScope() {
    throw new Error('сбой вне записи')
  },
}

/** Действие с кодом ошибки и id, которые не влезают в столбцы журнала ошибок. */
const LONG_ID = 'x'.repeat(150)
const malformed: BulkAction = {
  requires: { resource: 'deals', action: 'edit' },
  select: async () => [LONG_ID],
  inScope: async (_trx, ids) => new Set(ids),
  async apply() {
    throw new BulkRecordError('bad code!', 'текст')
  },
}

/** То же действие, но вместо «массовых операций» — своё отдельное право (как передача сделок). */
const standalone: BulkAction = { ...increment, standalone: 'transfer_deals' }

const ACTIONS = new Map([
  ['probe.increment', increment],
  ['probe.standalone', standalone],
  ['probe.crash', crash],
  ['probe.malformed', malformed],
])

describe('массовые операции', () => {
  let h: ApiHarness
  let jobs: Jobs
  let app: ReturnType<typeof createApp>
  let admin: SignedInUser
  let projectA: string
  let projectB: string

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_bulk')
    await sql`
      create table bulk_probe (
        id uuid primary key default gen_random_uuid(),
        project_id uuid not null references project (id) on delete cascade,
        owner_user_id text,
        value integer not null default 0
      )
    `.execute(h.owner)
    await sql`alter table bulk_probe enable row level security`.execute(h.owner)
    await sql`
      create policy project_isolation on bulk_probe
        using (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
        with check (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
    `.execute(h.owner)
    await sql`grant select, insert, update, delete on bulk_probe to alpi_app`.execute(h.owner)

    jobs = await startJobs({
      connectionString: h.appUrl,
      db: h.appDb,
      bulkActions: ACTIONS,
      trashPurgers: NO_TRASH_PURGERS,
      bulkBatchSize: BATCH,
      // Без повторов: задача, провалившая попытку, сразу уходит в очередь мёртвых задач.
      bulkRetryLimit: 0,
      pollingIntervalSeconds: 0.5,
    })
    app = createApp({
      auth: h.auth,
      db: h.appDb,
      bulk: { actions: ACTIONS, enqueue: jobs.enqueueBulk },
    })
    admin = await h.signIn('owner')
    projectA = (await h.createProject(admin, 'Масові А')).id
    projectB = (await h.createProject(admin, 'Масові Б')).id
  })

  afterAll(async () => {
    await jobs?.stop()
    await h?.stop()
  })

  async function insertProbe(projectId: string, count: number, ownerUserId: string, value = 0) {
    const rows = await probe(h.owner as never)
      .insertInto('bulk_probe')
      .values(
        Array.from({ length: count }, () => ({
          project_id: projectId,
          owner_user_id: ownerUserId,
          value,
          id: randomUUID(),
        })),
      )
      .returning('id')
      .execute()
    return rows.map((r) => r.id)
  }

  async function values(ids: string[]) {
    const rows = await probe(h.owner as never)
      .selectFrom('bulk_probe')
      .select(['id', 'value'])
      .where('id', 'in', ids)
      .execute()
    return new Map(rows.map((r) => [r.id, r.value]))
  }

  function start(user: SignedInUser, projectId: string, body: unknown) {
    return user.call(app, 'POST', '/v1/bulk-jobs', { project: projectId, body })
  }

  async function waitFinished(user: SignedInUser, projectId: string, id: string) {
    return vi.waitFor(
      async () => {
        const res = await user.call(app, 'GET', `/v1/bulk-jobs/${id}`, { project: projectId })
        expect(res.status).toBe(200)
        const job = (await res.json()) as BulkJobDetails
        expect(['done', 'failed']).toContain(job.status)
        return job
      },
      { timeout: 20_000, interval: 200 },
    )
  }

  /** Участник с ролью: права шаблона `template`, охват изменений — `writeScope`. */
  async function memberWithRole(
    projectId: string,
    template: 'head' | 'manager' | 'teamlead',
    writeScope: 'own' | 'all',
    /** Отдельные права вместо шаблонных. */
    standalone?: string[],
  ) {
    const user = await h.signIn()
    const base = ROLE_TEMPLATES.find((t) => t.key === template)?.permissions
    if (!base) throw new Error(`нет шаблона ${template}`)
    const permissions = {
      ...base,
      scopes: { ...base.scopes, deals: { read: 'all', write: writeScope } },
      standalone: standalone ?? base.standalone,
    }
    const role = await h.owner
      .insertInto('role')
      .values({
        project_id: projectId,
        name: `${template}-${writeScope}-${randomUUID().slice(0, 8)}`,
        permissions: JSON.stringify(permissions),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await h.owner
      .insertInto('project_member')
      .values({ project_id: projectId, user_id: user.id, role_id: role.id })
      .execute()
    return { user, roleId: role.id }
  }

  it('1 000 записей: прогресс растёт порциями, итог «обработано 1 000, ошибок 0»', async () => {
    const ids = await insertProbe(projectA, 1000, admin.id)
    // Строки другого проекта: обработчик проекта A их не видит.
    await insertProbe(projectB, 5, admin.id)
    seen.processed.clear()
    seen.projects.clear()

    const res = await start(admin, projectA, { action: 'probe.increment', selection: { ids } })
    expect(res.status).toBe(202)
    const started = (await res.json()) as BulkJobSummary
    expect(started).toMatchObject({ action: 'probe.increment', status: 'queued' })

    const job = await waitFinished(admin, projectA, started.id)
    expect(job).toMatchObject({ status: 'done', total: 1000, processed: 1000, failed: 0 })
    expect(job.errors).toEqual([])
    expect(job.startedAt).not.toBeNull()
    expect(job.finishedAt).not.toBeNull()
    // Каждая порция видит прогресс, зафиксированный предыдущими: 0, 100, …, 900.
    expect([...seen.processed].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 1000 / BATCH }, (_, i) => i * BATCH),
    )
    expect([...seen.projects]).toEqual([projectA])
    expect(new Set((await values(ids)).values())).toEqual(new Set([1]))
  })

  it('ошибка одной записи не останавливает остальные и попадает в журнал', async () => {
    const good = await insertProbe(projectA, 9, admin.id)
    const [broken = ''] = await insertProbe(projectA, 1, admin.id, -1)
    const ids = [...good.slice(0, 4), broken, ...good.slice(4)]

    const res = await start(admin, projectA, { action: 'probe.increment', selection: { ids } })
    expect(res.status).toBe(202)
    const job = await waitFinished(admin, projectA, ((await res.json()) as BulkJobSummary).id)

    expect(job).toMatchObject({ status: 'done', total: 10, processed: 10, failed: 1 })
    expect(job.errors).toEqual([
      { position: 4, recordId: broken, code: 'BROKEN', message: 'запись сломана' },
    ])
    const after = await values(ids)
    expect(good.map((id) => after.get(id))).toEqual(Array(9).fill(1))
    // Изменение «сломанной» записи откатилось вместе с её ошибкой.
    expect(after.get(broken)).toBe(-1)
  })

  it('выбор по фильтру разворачивается в записи своего проекта', async () => {
    const project = (await h.createProject(admin, 'Фільтр')).id
    const ids = await insertProbe(project, 3, admin.id)
    const res = await start(admin, project, {
      action: 'probe.increment',
      selection: { filter: {} },
    })
    expect(res.status).toBe(202)
    const job = await waitFinished(admin, project, ((await res.json()) as BulkJobSummary).id)
    expect(job).toMatchObject({ status: 'done', total: 3, processed: 3, failed: 0 })
    expect(new Set((await values(ids)).values())).toEqual(new Set([1]))
  })

  it('запуск пишется в журнал проекта', async () => {
    const ids = await insertProbe(projectA, 2, admin.id)
    const res = await start(admin, projectA, { action: 'probe.increment', selection: { ids } })
    const { id } = (await res.json()) as BulkJobSummary
    const entry = await h.owner
      .selectFrom('audit_log')
      .select(['project_id', 'actor_id', 'action', 'entity_type', 'details'])
      .where('entity_id', '=', id)
      .executeTakeFirstOrThrow()
    expect(entry).toEqual({
      project_id: projectA,
      actor_id: admin.id,
      action: 'bulk.started',
      entity_type: 'bulk_job',
      details: { action: 'probe.increment', selection: 'ids', count: 2 },
    })
    await waitFinished(admin, projectA, id)
  })

  describe('права', () => {
    it('без права «массовые операции» запуск — 403', async () => {
      const { user } = await memberWithRole(projectA, 'manager', 'all')
      const ids = await insertProbe(projectA, 1, user.id)
      const res = await start(user, projectA, { action: 'probe.increment', selection: { ids } })
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ code: 'PERMISSION_DENIED' })
      expect(await values(ids)).toEqual(new Map([[ids[0], 0]]))
    })

    it('своё отдельное право действия заменяет «массовые операции» при запуске и на порциях', async () => {
      // Тимлид: «передача сделок» есть, «массовых операций» нет.
      const { user } = await memberWithRole(projectA, 'teamlead', 'own')
      const ids = await insertProbe(projectA, 2, user.id)
      const denied = await start(user, projectA, { action: 'probe.increment', selection: { ids } })
      expect(denied.status).toBe(403)
      const res = await start(user, projectA, { action: 'probe.standalone', selection: { ids } })
      expect(res.status).toBe(202)
      const job = await waitFinished(user, projectA, ((await res.json()) as BulkJobSummary).id)
      expect(job).toMatchObject({ status: 'done', processed: 2, failed: 0 })
      expect(new Set((await values(ids)).values())).toEqual(new Set([1]))

      // «Массовые операции» без своего права действия его не заменяют — 403.
      const { user: bulkOnly } = await memberWithRole(projectA, 'head', 'all', ['bulk_operations'])
      const other = await insertProbe(projectA, 1, bulkOnly.id)
      const refused = await start(bulkOnly, projectA, {
        action: 'probe.standalone',
        selection: { ids: other },
      })
      expect(refused.status).toBe(403)
      expect(await values(other)).toEqual(new Map([[other[0], 0]]))
      // Неизвестное действие без «массовых операций» — 403: ответ не выдаёт список действий.
      const { user: manager } = await memberWithRole(projectA, 'manager', 'all')
      const unknown = await start(manager, projectA, {
        action: 'deal.nope',
        selection: { ids: other },
      })
      expect(unknown.status).toBe(403)
    })

    it('неизвестное действие и пустой выбор — 400', async () => {
      const unknown = await start(admin, projectA, {
        action: 'deal.nope',
        selection: { ids: ['x'] },
      })
      expect(unknown.status).toBe(400)
      expect(await unknown.json()).toEqual({ code: 'UNKNOWN_ACTION' })
      const empty = await start(admin, projectA, {
        action: 'probe.increment',
        selection: { ids: [] },
      })
      expect(empty.status).toBe(400)
      expect(await empty.json()).toEqual({ code: 'INVALID_SELECTION' })
    })

    it('запись вне охвата инициатора не меняется и попадает в журнал ошибок', async () => {
      const { user } = await memberWithRole(projectA, 'head', 'own')
      const own = await insertProbe(projectA, 2, user.id)
      const [foreign = ''] = await insertProbe(projectA, 1, admin.id)
      const ids = [own[0] ?? '', foreign, own[1] ?? '']

      const res = await start(user, projectA, { action: 'probe.increment', selection: { ids } })
      expect(res.status).toBe(202)
      const job = await waitFinished(user, projectA, ((await res.json()) as BulkJobSummary).id)

      expect(job).toMatchObject({ status: 'done', processed: 3, failed: 1 })
      expect(job.errors).toEqual([
        { position: 1, recordId: foreign, code: 'OUT_OF_SCOPE', message: null },
      ])
      const after = await values(ids)
      expect([after.get(own[0] ?? ''), after.get(foreign), after.get(own[1] ?? '')]).toEqual([
        1, 0, 1,
      ])
    })

    it('права проверяются по текущей роли на каждой порции', async () => {
      const { user } = await memberWithRole(projectA, 'head', 'all')
      const ids = await insertProbe(projectA, 3, user.id)
      // Очередь-заглушка: операцию запускает тест сам, после смены роли.
      const queued: { projectId: string; bulkJobId: string }[] = []
      const manual = createApp({
        auth: h.auth,
        db: h.appDb,
        bulk: { actions: ACTIONS, enqueue: async (_trx, message) => void queued.push(message) },
      })
      const res = await user.call(manual, 'POST', '/v1/bulk-jobs', {
        project: projectA,
        body: { action: 'probe.increment', selection: { ids } },
      })
      expect(res.status).toBe(202)
      const [message] = queued
      if (!message) throw new Error('операция не поставлена в очередь')

      // Роль сменили на менеджера (без права «массовые операции») до начала обработки.
      await h.owner
        .updateTable('project_member')
        .set({
          role_id: h.owner
            .selectFrom('role')
            .select('id')
            .where('project_id', '=', projectA)
            .where('template_key', '=', 'manager'),
        })
        .where('project_id', '=', projectA)
        .where('user_id', '=', user.id)
        .execute()
      await runBulkJob(h.appDb, ACTIONS, message, { batchSize: 2 })

      const job = await withProject(h.appDb, projectA, (trx) =>
        trx
          .selectFrom('bulk_job')
          .select(['status', 'processed', 'failed'])
          .where('id', '=', message.bulkJobId)
          .executeTakeFirstOrThrow(),
      )
      expect(job).toEqual({ status: 'done', processed: 3, failed: 3 })
      const codes = await withProject(h.appDb, projectA, (trx) =>
        trx
          .selectFrom('bulk_job_error')
          .select('code')
          .where('bulk_job_id', '=', message.bulkJobId)
          .execute(),
      )
      expect(codes.map((r) => r.code)).toEqual(Array(3).fill('PERMISSION_DENIED'))
      expect(new Set((await values(ids)).values())).toEqual(new Set([0]))
    })
  })

  it('задача, провалившая все попытки, помечает операцию failed (очередь мёртвых задач)', async () => {
    const ids = await insertProbe(projectA, 2, admin.id)
    const res = await start(admin, projectA, { action: 'probe.crash', selection: { ids } })
    expect(res.status).toBe(202)
    const job = await waitFinished(admin, projectA, ((await res.json()) as BulkJobSummary).id)
    expect(job).toMatchObject({ status: 'failed', failure: 'PROCESSING_FAILED', processed: 0 })
    expect(job.finishedAt).not.toBeNull()
    expect(new Set((await values(ids)).values())).toEqual(new Set([0]))
  })

  it('неподходящий код ошибки и длинный id записи не ломают журнал ошибок', async () => {
    const res = await start(admin, projectA, {
      action: 'probe.malformed',
      selection: { filter: {} },
    })
    expect(res.status).toBe(202)
    const job = await waitFinished(admin, projectA, ((await res.json()) as BulkJobSummary).id)
    expect(job).toMatchObject({ status: 'done', total: 1, processed: 1, failed: 1 })
    expect(job.errors).toEqual([
      { position: 0, recordId: 'x'.repeat(100), code: 'FAILED', message: 'bad code!: текст' },
    ])
  })

  it('блокировка инициатора владельцем системы останавливает операцию на следующей порции', async () => {
    const { user } = await memberWithRole(projectA, 'head', 'all')
    const ids = await insertProbe(projectA, 3, user.id)
    const queued: { projectId: string; bulkJobId: string }[] = []
    let banned = false
    const banAfterFirst: BulkAction = {
      ...increment,
      async apply(trx, id, ctx) {
        await increment.apply(trx, id, ctx)
        if (banned) return
        banned = true
        const ban = await admin.api('POST', '/auth/admin/ban-user', { body: { userId: user.id } })
        expect(ban.status).toBe(200)
      },
    }
    const actions = new Map([['probe.ban', banAfterFirst]])
    const manual = createApp({
      auth: h.auth,
      db: h.appDb,
      bulk: { actions, enqueue: async (_trx, message) => void queued.push(message) },
    })
    const res = await user.call(manual, 'POST', '/v1/bulk-jobs', {
      project: projectA,
      body: { action: 'probe.ban', selection: { ids } },
    })
    expect(res.status).toBe(202)
    const [message] = queued
    if (!message) throw new Error('операция не поставлена в очередь')

    await runBulkJob(h.appDb, actions, message, { batchSize: 1 })

    const job = await withProject(h.appDb, projectA, (trx) =>
      trx
        .selectFrom('bulk_job')
        .select(['status', 'failure', 'processed', 'failed'])
        .where('id', '=', message.bulkJobId)
        .executeTakeFirstOrThrow(),
    )
    expect(job).toEqual({ status: 'failed', failure: 'INITIATOR_BANNED', processed: 1, failed: 0 })
    const after = await values(ids)
    expect(ids.map((id) => after.get(id))).toEqual([1, 0, 0])
  })

  describe('кто видит операцию', () => {
    it('инициатор видит свои, администратор — все в проекте, другой участник — только свои', async () => {
      const { user: head } = await memberWithRole(projectA, 'head', 'all')
      const ids = await insertProbe(projectA, 1, head.id)
      const mine = (await (
        await start(head, projectA, { action: 'probe.increment', selection: { ids } })
      ).json()) as BulkJobSummary
      const adminIds = await insertProbe(projectA, 1, admin.id)
      const adminJob = (await (
        await start(admin, projectA, { action: 'probe.increment', selection: { ids: adminIds } })
      ).json()) as BulkJobSummary

      const own = await head.call(app, 'GET', `/v1/bulk-jobs/${mine.id}`, { project: projectA })
      expect(own.status).toBe(200)
      const foreign = await head.call(app, 'GET', `/v1/bulk-jobs/${adminJob.id}`, {
        project: projectA,
      })
      expect(foreign.status).toBe(404)

      const headList = (await (
        await head.call(app, 'GET', '/v1/bulk-jobs', { project: projectA })
      ).json()) as BulkJobSummary[]
      expect(headList.map((j) => j.id)).toEqual([mine.id])

      const adminList = (await (
        await admin.call(app, 'GET', '/v1/bulk-jobs', { project: projectA })
      ).json()) as BulkJobSummary[]
      expect(adminList.map((j) => j.id)).toEqual(expect.arrayContaining([mine.id, adminJob.id]))
      expect(adminList.find((j) => j.id === mine.id)?.initiatorId).toBe(head.id)

      await waitFinished(head, projectA, mine.id)
      await waitFinished(admin, projectA, adminJob.id)
    })

    it('операция проекта A не видна в проекте B', async () => {
      const ids = await insertProbe(projectA, 1, admin.id)
      const job = (await (
        await start(admin, projectA, { action: 'probe.increment', selection: { ids } })
      ).json()) as BulkJobSummary
      await waitFinished(admin, projectA, job.id)

      const inB = await admin.call(app, 'GET', `/v1/bulk-jobs/${job.id}`, { project: projectB })
      expect(inB.status).toBe(404)
      const listB = (await (
        await admin.call(app, 'GET', '/v1/bulk-jobs', { project: projectB })
      ).json()) as BulkJobSummary[]
      expect(listB).toEqual([])
      // Без фильтра в коде: RLS не показывает строк A в контексте B.
      const rows = await withProject(h.appDb, projectB, (trx) =>
        trx.selectFrom('bulk_job').select('project_id').execute(),
      )
      expect(rows).toEqual([])
    })
  })

  it('остановка обработчика дожидается текущей задачи', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered: () => void = () => {}
    const inside = new Promise<void>((resolve) => {
      entered = resolve
    })
    const slow: BulkAction = {
      ...increment,
      async apply(trx, id, ctx) {
        entered()
        await gate
        await increment.apply(trx, id, ctx)
      },
    }
    const actions = new Map([['probe.slow', slow]])
    // Общий обработчик не знает probe.slow — гасим его, чтобы задачу взял только этот.
    await jobs.stop()
    const slowJobs = await startJobs({
      connectionString: h.appUrl,
      db: h.appDb,
      bulkActions: actions,
      trashPurgers: NO_TRASH_PURGERS,
      pollingIntervalSeconds: 0.5,
      schedule: false,
    })
    const slowApp = createApp({
      auth: h.auth,
      db: h.appDb,
      bulk: { actions, enqueue: slowJobs.enqueueBulk },
    })
    const ids = await insertProbe(projectA, 1, admin.id)
    const res = await admin.call(slowApp, 'POST', '/v1/bulk-jobs', {
      project: projectA,
      body: { action: 'probe.slow', selection: { ids } },
    })
    expect(res.status).toBe(202)
    const { id } = (await res.json()) as BulkJobSummary
    await inside

    let stopped = false
    const stopping = slowJobs.stop().then(() => {
      stopped = true
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(stopped).toBe(false)
    release()
    await stopping

    const job = await withProject(h.appDb, projectA, (trx) =>
      trx
        .selectFrom('bulk_job')
        .select(['status', 'processed'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    )
    expect(job).toEqual({ status: 'done', processed: 1 })
  })
})
