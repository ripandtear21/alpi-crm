import { randomBytes } from 'node:crypto'
import { type Generated, type Kysely, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { NO_BULK_ACTIONS } from '../bulk/registry.ts'
import { type ApiHarness, startApiHarness } from '../testing/api-harness.ts'
import { purgeProjectTrash, TRASH_RETENTION_DAYS, type TrashRegistry } from '../trash/purge.ts'
import { type Jobs, QUEUES, startJobs } from './jobs.ts'

// Фоновые задачи по расписанию (тикет crm-deals/04) на настоящем PostgreSQL: pg-boss ходит
// ролью приложения в схему pgboss из миграции 0009. Корзина — на тестовой таблице trash_probe.

interface ProbeDb {
  trash_probe: { id: Generated<string>; project_id: string; deleted_at: Date | null; label: string }
}
const probe = (db: unknown) => db as Kysely<ProbeDb>

/** Тестовая запись корзины: окончательно удаляет пролежавшее дольше срока, без фильтра проекта. */
const TRASH: TrashRegistry = new Map([
  [
    'probe',
    {
      async purgeExpired(trx, cutoff) {
        const result = await probe(trx)
          .deleteFrom('trash_probe')
          .where('deleted_at', '<', cutoff)
          .executeTakeFirst()
        return Number(result.numDeletedRows)
      },
    },
  ],
])

describe('фоновые задачи по расписанию', () => {
  let h: ApiHarness
  let jobs: Jobs
  let projectA: string
  let projectB: string

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_jobs')
    await sql`
      create table trash_probe (
        id uuid primary key default gen_random_uuid(),
        project_id uuid not null references project (id) on delete cascade,
        label text not null,
        deleted_at timestamptz
      )
    `.execute(h.owner)
    await sql`alter table trash_probe enable row level security`.execute(h.owner)
    await sql`
      create policy project_isolation on trash_probe
        using (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
        with check (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
    `.execute(h.owner)
    await sql`grant select, insert, update, delete on trash_probe to alpi_app`.execute(h.owner)

    jobs = await startJobs({
      connectionString: h.appUrl,
      db: h.appDb,
      bulkActions: NO_BULK_ACTIONS,
      trashPurgers: TRASH,
      pollingIntervalSeconds: 0.5,
    })
    const owner = await h.signIn('owner')
    projectA = (await h.createProject(owner, 'Кошик А')).id
    projectB = (await h.createProject(owner, 'Кошик Б')).id
  })

  afterAll(async () => {
    await jobs?.stop()
    await h?.stop()
  })

  const daysAgo = (days: number) => sql<Date>`now() - make_interval(days => ${days})`

  async function labels(projectId: string) {
    const rows = await probe(h.owner)
      .selectFrom('trash_probe')
      .select('label')
      .where('project_id', '=', projectId)
      .orderBy('label')
      .execute()
    return rows.map((r) => r.label)
  }

  it('pg-boss стартует ролью приложения на схеме из миграции; расписание — ежедневно', async () => {
    expect(await jobs.boss.schemaVersion()).toBeGreaterThan(0)
    const schedules = await jobs.boss.getSchedules()
    expect(
      schedules
        .map((s) => ({ name: s.name, cron: s.cron, tz: s.options?.tz }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ).toEqual([
      { name: QUEUES.signInPurge, cron: '30 3 * * *', tz: 'Europe/Kyiv' },
      { name: QUEUES.trashPurge, cron: '0 3 * * *', tz: 'Europe/Kyiv' },
    ])
  })

  describe('корзина', () => {
    it(`удалённое ${TRASH_RETENTION_DAYS + 1} дней назад удаляется, 29 дней назад — остаётся, другой проект не тронут`, async () => {
      await probe(h.owner)
        .insertInto('trash_probe')
        .values([
          { project_id: projectA, label: 'a-31', deleted_at: daysAgo(31) as never },
          { project_id: projectA, label: 'a-29', deleted_at: daysAgo(29) as never },
          { project_id: projectA, label: 'a-live', deleted_at: null },
          { project_id: projectB, label: 'b-31', deleted_at: daysAgo(31) as never },
        ])
        .execute()

      // Запись реестра удаляет без фильтра по проекту: границу держит withProject и RLS.
      expect(await purgeProjectTrash(h.appDb, projectA, TRASH)).toEqual({ probe: 1 })
      expect(await labels(projectA)).toEqual(['a-29', 'a-live'])
      expect(await labels(projectB)).toEqual(['b-31'])

      // Задача по расписанию обходит все проекты, каждый — в своём withProject.
      await jobs.boss.send(QUEUES.trashPurge)
      await vi.waitFor(async () => expect(await labels(projectB)).toEqual([]), {
        timeout: 20_000,
        interval: 200,
      })
      expect(await labels(projectA)).toEqual(['a-29', 'a-live'])
    })
  })

  describe('очистка журнала входов', () => {
    it('неудачный вход старше 90 дней удалён, младше — на месте, другие записи не тронуты', async () => {
      const [a = 0, b = 0, c = 0] = randomBytes(3)
      const marker = `10.${a}.${b}.${c}`
      await h.owner
        .insertInto('system_audit_log')
        .values([
          { action: 'auth.sign_in_failed', ip: marker, occurred_at: daysAgo(91) },
          { action: 'auth.sign_in_failed', ip: marker, occurred_at: daysAgo(89) },
          { action: 'auth.sign_in', ip: marker, occurred_at: daysAgo(400) },
        ])
        .execute()
      const left = () =>
        h.owner
          .selectFrom('system_audit_log')
          .select(['action', sql<number>`extract(day from now() - occurred_at)::int`.as('age')])
          .where(sql`host(ip)`, '=', marker)
          .orderBy('occurred_at')
          .execute()

      await jobs.boss.send(QUEUES.signInPurge)
      await vi.waitFor(async () => expect(await left()).toHaveLength(2), {
        timeout: 20_000,
        interval: 200,
      })
      expect(await left()).toEqual([
        { action: 'auth.sign_in', age: 400 },
        { action: 'auth.sign_in_failed', age: 89 },
      ])
    })

    it('роль приложения сама удалить запись журнала не может', async () => {
      await expect(
        sql`delete from system_audit_log where action = 'auth.sign_in_failed'`.execute(h.appDb),
      ).rejects.toThrow(/permission denied/)
      await expect(sql`delete from audit_log`.execute(h.appDb)).rejects.toThrow(/permission denied/)
    })
  })
})
