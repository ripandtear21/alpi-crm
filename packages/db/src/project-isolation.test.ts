import { Kysely, PostgresDialect, sql } from 'kysely'
import { NO_MIGRATIONS } from 'kysely/migration'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, createProject, type Database, withProject } from './index.ts'
import { createMigrator, migrateToLatest } from './migrate.ts'
import { startTestDatabase, type TestDatabase } from './testing/index.ts'

// Настоящие миграции из packages/db/migrations и row-level security на embedded PostgreSQL.
// owner — суперпользователь, под которым идут миграции (служебный доступ);
// app — отдельная роль входа, член alpi_app: не суперпользователь, без BYPASSRLS, не владелец.

const APP_USER = 'alpi_test_app'
const APP_PASSWORD = 'alpi_test_app'

const migrationNames = [
  '0001_project_isolation',
  '0002_auth',
  '0003_projects',
  '0004_roles',
  '0005_audit',
  '0006_teams',
  '0007_jobs_bulk',
  '0008_pipelines',
  '0009_contacts',
  '0010_deals',
  '0011_products',
  '0012_notes_files',
  '0013_search',
  '0014_saved_filters',
]

const tablesOfMigration = [
  'project',
  'project_member',
  'external_link',
  // 0002_auth — таблицы Better Auth
  'user',
  'session',
  'account',
  'verification',
  'two_factor',
  'rate_limit',
  // 0004_roles
  'role',
  // 0005_audit
  'audit_log',
  'system_audit_log',
  // 0006_teams
  'team',
  // 0007_jobs_bulk (таблицы pg-boss — в своей схеме pgboss, не здесь)
  'bulk_job',
  'bulk_job_error',
  // 0008_pipelines
  'pipeline',
  'stage',
  'lost_reason_group',
  'lost_reason',
  // 0009_contacts
  'organization',
  'contact',
  'contact_phone',
  'contact_email',
  'change_log',
  // 0010_deals
  'deal',
  'deal_participant',
  // 0011_products
  'product',
  'deal_product',
  // 0012_notes_files
  'note',
  'file',
  // 0014_saved_filters
  'saved_filter',
]

describe('схема и изоляция проектов', () => {
  let testDb: TestDatabase
  let owner: Kysely<Database>
  let app: Kysely<Database>
  let projectA: string
  let projectB: string

  beforeAll(async () => {
    testDb = await startTestDatabase()
    owner = createDb(testDb.connectionString)
    await migrateToLatest(owner)

    await sql`create role ${sql.id(APP_USER)} login password ${sql.lit(APP_PASSWORD)} in role alpi_app`.execute(
      owner,
    )
    const url = new URL(testDb.connectionString)
    url.username = APP_USER
    url.password = APP_PASSWORD
    // Одно соединение в пуле: проверки «после withProject» идут по тому же соединению,
    // на котором проект был выставлен.
    app = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url.href, max: 1 }) }),
    })

    const projects = await owner
      .insertInto('project')
      .values([
        { code: 'alpi', name: 'ALPI' },
        { code: 'franch', name: 'Франч' },
      ])
      .returning(['id', 'code'])
      .execute()
    projectA = projects.find((p) => p.code === 'alpi')?.id ?? ''
    projectB = projects.find((p) => p.code === 'franch')?.id ?? ''

    await owner
      .insertInto('external_link')
      .values([
        {
          project_id: projectA,
          entity_type: 'deal',
          entity_id: 'a1',
          source: 'pipedrive',
          external_id: '1',
        },
        {
          project_id: projectA,
          entity_type: 'deal',
          entity_id: 'a2',
          source: 'pipedrive',
          external_id: '2',
        },
        {
          project_id: projectB,
          entity_type: 'deal',
          entity_id: 'b1',
          source: 'pipedrive',
          external_id: '1',
        },
      ])
      .execute()
    // project_member.user_id ссылается на учётную запись.
    await owner
      .insertInto('user')
      .values([
        { id: 'user-1', name: 'Перший', email: 'user-1@example.test' },
        { id: 'user-2', name: 'Другий', email: 'user-2@example.test' },
      ])
      .execute()
    await owner
      .insertInto('project_member')
      .values([
        { project_id: projectA, user_id: 'user-1', role_id: adminRoleOf(projectA) },
        { project_id: projectB, user_id: 'user-1', role_id: adminRoleOf(projectB) },
        { project_id: projectB, user_id: 'user-2', role_id: adminRoleOf(projectB) },
      ])
      .execute()
  })

  /** Роль администратора проекта (шаблон, созданный вместе с проектом) — подзапросом. */
  function adminRoleOf(projectId: string) {
    return owner
      .selectFrom('role')
      .select('id')
      .where('project_id', '=', projectId)
      .where('is_admin', '=', true)
  }

  afterAll(async () => {
    await app?.destroy()
    await owner?.destroy()
    await testDb?.stop()
  })

  describe('миграции из packages/db/migrations', () => {
    it('применены на чистую базу: таблицы есть, миграция записана', async () => {
      const applied = await sql<{ name: string }>`select name from kysely_migration`.execute(owner)
      expect(applied.rows.map((r) => r.name)).toEqual(migrationNames)
      expect(await existingTables(owner)).toEqual([...tablesOfMigration].sort())
    })

    it('откатываются до пустой схемы и применяются заново', async () => {
      // Откат на отдельной базе того же кластера, чтобы не трогать данные остальных тестов.
      await sql`create database rollback_check`.execute(owner)
      const url = new URL(testDb.connectionString)
      url.pathname = '/rollback_check'
      const scratch = createDb(url.href)
      try {
        await migrateToLatest(scratch)
        expect(await existingTables(scratch)).toEqual([...tablesOfMigration].sort())
        expect(await pgBossVersion(scratch)).toBeGreaterThan(0)

        const down = await createMigrator(scratch).migrateTo(NO_MIGRATIONS)
        expect(down.error).toBeUndefined()
        expect(down.results?.map((r) => [r.migrationName, r.direction, r.status])).toEqual(
          [...migrationNames].reverse().map((name) => [name, 'Down', 'Success']),
        )
        expect(await existingTables(scratch)).toEqual([])
        expect(await pgBossVersion(scratch)).toBeNull()

        const again = await migrateToLatest(scratch)
        expect(again.map((r) => [r.migrationName, r.status])).toEqual(
          migrationNames.map((name) => [name, 'Success']),
        )
        expect(await existingTables(scratch)).toEqual([...tablesOfMigration].sort())
        expect(await pgBossVersion(scratch)).toBeGreaterThan(0)
      } finally {
        await scratch.destroy()
      }
    })

    it('external_link уникальна по (проект, тип, источник, внешний id)', async () => {
      await expect(
        owner
          .insertInto('external_link')
          .values({
            project_id: projectA,
            entity_type: 'deal',
            entity_id: 'a3',
            source: 'pipedrive',
            external_id: '1',
          })
          .execute(),
      ).rejects.toThrow(/duplicate key value violates unique constraint/)
    })

    it('участник проекта — только существующая учётная запись', async () => {
      await expect(
        owner
          .insertInto('project_member')
          .values({ project_id: projectA, user_id: 'no-such-user', role_id: adminRoleOf(projectA) })
          .execute(),
      ).rejects.toThrow(/project_member_user_id_fkey/)
    })
  })

  describe('row-level security', () => {
    it('select * from external_link без where внутри withProject(A) возвращает только строки A', async () => {
      const rows = await withProject(app, projectA, (trx) =>
        trx.selectFrom('external_link').selectAll().execute(),
      )
      expect(rows.map((r) => r.entity_id).sort()).toEqual(['a1', 'a2'])
      expect(rows.every((r) => r.project_id === projectA)).toBe(true)

      const raw = await withProject(app, projectB, (trx) =>
        sql<{ entity_id: string }>`select * from external_link`.execute(trx),
      )
      expect(raw.rows.map((r) => r.entity_id)).toEqual(['b1'])
    })

    it('project_member внутри withProject видит только участников своего проекта', async () => {
      const rows = await withProject(app, projectB, (trx) =>
        trx.selectFrom('project_member').select(['user_id', 'project_id']).execute(),
      )
      expect(rows.map((r) => r.user_id).sort()).toEqual(['user-1', 'user-2'])
      expect(rows.every((r) => r.project_id === projectB)).toBe(true)
    })

    it('без выставленного проекта — ноль строк, в том числе после конца транзакции withProject', async () => {
      expect(await app.selectFrom('external_link').selectAll().execute()).toEqual([])

      await withProject(app, projectA, (trx) =>
        trx.selectFrom('external_link').selectAll().execute(),
      )
      // То же соединение (пул из одного): значение было локальным для транзакции.
      expect(await app.selectFrom('external_link').selectAll().execute()).toEqual([])
      expect(await app.selectFrom('project_member').selectAll().execute()).toEqual([])
    })

    it('внутри withProject(A) нельзя записать или перенести строку в проект B', async () => {
      await expect(
        withProject(app, projectA, (trx) =>
          trx
            .insertInto('external_link')
            .values({
              project_id: projectB,
              entity_type: 'deal',
              entity_id: 'x',
              source: 'bitrix',
              external_id: '99',
            })
            .execute(),
        ),
      ).rejects.toThrow(/row-level security/)

      await expect(
        withProject(app, projectA, (trx) =>
          trx.updateTable('external_link').set({ project_id: projectB }).execute(),
        ),
      ).rejects.toThrow(/row-level security/)

      // Чужие строки для update и delete невидимы: ничего не изменено.
      const deleted = await withProject(app, projectA, (trx) =>
        trx.deleteFrom('external_link').where('project_id', '=', projectB).executeTakeFirst(),
      )
      expect(deleted.numDeletedRows).toBe(0n)
      const all = await owner.selectFrom('external_link').select('entity_id').execute()
      expect(all.map((r) => r.entity_id).sort()).toEqual(['a1', 'a2', 'b1'])
    })

    it('служебная роль (владелец, под ней идут миграции) видит строки всех проектов', async () => {
      const rows = await owner.selectFrom('external_link').select('project_id').execute()
      expect(new Set(rows.map((r) => r.project_id))).toEqual(new Set([projectA, projectB]))
    })

    it('каждая таблица с project_id под RLS и с политикой', async () => {
      const { rows } = await sql<{ table: string; rls: boolean; policies: number }>`
        select c.relname as table, c.relrowsecurity as rls,
          (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and exists (
            select from pg_attribute a
            where a.attrelid = c.oid and a.attname = 'project_id' and not a.attisdropped
          )
        order by c.relname
      `.execute(owner)
      expect(rows).toEqual([
        { table: 'audit_log', rls: true, policies: 1 },
        { table: 'bulk_job', rls: true, policies: 1 },
        { table: 'bulk_job_error', rls: true, policies: 1 },
        { table: 'change_log', rls: true, policies: 1 },
        { table: 'contact', rls: true, policies: 1 },
        { table: 'contact_email', rls: true, policies: 1 },
        { table: 'contact_phone', rls: true, policies: 1 },
        { table: 'deal', rls: true, policies: 1 },
        { table: 'deal_participant', rls: true, policies: 1 },
        { table: 'deal_product', rls: true, policies: 1 },
        { table: 'external_link', rls: true, policies: 1 },
        { table: 'file', rls: true, policies: 1 },
        { table: 'lost_reason', rls: true, policies: 1 },
        { table: 'lost_reason_group', rls: true, policies: 1 },
        { table: 'note', rls: true, policies: 1 },
        { table: 'organization', rls: true, policies: 1 },
        { table: 'pipeline', rls: true, policies: 1 },
        { table: 'product', rls: true, policies: 1 },
        { table: 'project_member', rls: true, policies: 1 },
        { table: 'role', rls: true, policies: 1 },
        { table: 'saved_filter', rls: true, policies: 1 },
        { table: 'stage', rls: true, policies: 1 },
        { table: 'team', rls: true, policies: 1 },
      ])
    })

    it('withProject отказывает при id проекта не в формате uuid', async () => {
      await expect(withProject(app, 'alpi', async () => 1)).rejects.toThrow(/uuid/)
    })
  })

  // Представления *_search (0013_search) выполняются с правами владельца таблиц, и политика
  // RLS на них не действует: проект ограничивает только условие в самом представлении.
  describe('представления поиска *_search для роли приложения', () => {
    /** Для каждого представления — id, которые оно должно отдать в проекте. */
    type SearchIds = Record<string, string[]>
    const seeded = new Map<string, SearchIds>()

    /** По одной строке в каждую таблицу поиска проекта; текст одинаков у обоих проектов. */
    async function seedSearchRows(projectId: string): Promise<SearchIds> {
      const organization = await owner
        .insertInto('organization')
        .values({ project_id: projectId, name: 'Поиск Тов' })
        .returning('id')
        .executeTakeFirstOrThrow()
      const contact = await owner
        .insertInto('contact')
        .values({ project_id: projectId, first_name: 'Поиск', last_name: 'Тестовий' })
        .returning('id')
        .executeTakeFirstOrThrow()
      await owner
        .insertInto('contact_phone')
        .values({ project_id: projectId, contact_id: contact.id, phone: '+380501112233' })
        .execute()
      await owner
        .insertInto('contact_email')
        .values({ project_id: projectId, contact_id: contact.id, email: 'poshuk@example.test' })
        .execute()
      const pipeline = await owner
        .insertInto('pipeline')
        .values({ project_id: projectId, code: 'search_iso', name: 'Пошук', position: 1 })
        .returning('id')
        .executeTakeFirstOrThrow()
      const stage = await owner
        .insertInto('stage')
        .values({ project_id: projectId, pipeline_id: pipeline.id, name: 'Новий', position: 1 })
        .returning('id')
        .executeTakeFirstOrThrow()
      const deal = await owner
        .insertInto('deal')
        .values({
          project_id: projectId,
          title: 'Поиск сделка',
          pipeline_id: pipeline.id,
          stage_id: stage.id,
          primary_contact_id: contact.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      return {
        contact_email_search: [contact.id],
        contact_phone_search: [contact.id],
        contact_search: [contact.id],
        deal_search: [deal.id],
        organization_search: [organization.id],
      }
    }

    /** id из представления под ролью приложения (внутри withProject или без проекта). */
    async function idsOf(view: string, projectId: string | null): Promise<string[]> {
      const query = (db: Kysely<Database>) =>
        sql<{ id: string }>`select id from ${sql.table(view)}`.execute(db)
      const { rows } =
        projectId === null ? await query(app) : await withProject(app, projectId, query)
      return rows.map((r) => r.id).sort()
    }

    beforeAll(async () => {
      seeded.set(projectA, await seedSearchRows(projectA))
      seeded.set(projectB, await seedSearchRows(projectB))
    })

    it('в схеме ровно эти представления поиска — каждое проверено ниже', async () => {
      const { rows } = await sql<{ viewname: string }>`
        select viewname from pg_views
        where schemaname = 'public' and viewname like '%\\_search'
        order by viewname
      `.execute(owner)
      expect(rows.map((r) => r.viewname)).toEqual(Object.keys(seeded.get(projectA) ?? {}).sort())
    })

    it('внутри withProject(A) каждое отдаёт только строки A, внутри withProject(B) — только B', async () => {
      for (const project of [projectA, projectB]) {
        for (const [view, ids] of Object.entries(seeded.get(project) ?? {})) {
          expect({ view, ids: await idsOf(view, project) }).toEqual({ view, ids: [...ids].sort() })
        }
      }
    })

    it('без выставленного app.project_id каждое отдаёт ноль строк', async () => {
      for (const view of Object.keys(seeded.get(projectA) ?? {})) {
        expect({ view, ids: await idsOf(view, null) }).toEqual({ view, ids: [] })
      }
    })
  })

  describe('роль приложения', () => {
    it('не суперпользователь, без BYPASSRLS, не владеет таблицами и не член роли владельца', async () => {
      const roles = await sql<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>`
        select rolname, rolsuper, rolbypassrls from pg_roles
        where rolname in ('alpi_app', ${APP_USER}) order by rolname
      `.execute(owner)
      expect(roles.rows).toEqual([
        { rolname: 'alpi_app', rolsuper: false, rolbypassrls: false },
        { rolname: APP_USER, rolsuper: false, rolbypassrls: false },
      ])

      const owners = await sql<{ tablename: string; owned_by_app: boolean }>`
        select tablename, pg_has_role(${APP_USER}, tableowner, 'MEMBER') as owned_by_app
        from pg_tables where schemaname = 'public' order by tablename
      `.execute(owner)
      expect(owners.rows.length).toBeGreaterThanOrEqual(tablesOfMigration.length)
      expect(owners.rows.filter((r) => r.owned_by_app)).toEqual([])
    })

    it('схема pg-boss: роль приложения пользуется очередью, но ничем в схеме не владеет', async () => {
      const objects = await sql<{ kind: string; name: string; owned_by_app: boolean }>`
        select 'schema' as kind, n.nspname as name,
          pg_has_role(${APP_USER}, n.nspowner, 'MEMBER') as owned_by_app
        from pg_namespace n where n.nspname = 'pgboss'
        union all
        select 'table', c.relname, pg_has_role(${APP_USER}, c.relowner, 'MEMBER')
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'pgboss' and c.relkind in ('r', 'p')
      `.execute(owner)
      expect(objects.rows.some((r) => r.kind === 'table' && r.name === 'job')).toBe(true)
      expect(objects.rows.filter((r) => r.owned_by_app)).toEqual([])

      // Права очереди есть: читать и писать строки, звать функции pg-boss.
      const queues = await sql<{ n: number }>`select count(*)::int as n from pgboss.queue`.execute(
        app,
      )
      expect(queues.rows[0]?.n).toBeGreaterThanOrEqual(0)
      // Менять схему — нет.
      await expect(sql`create table pgboss.intruder (id int)`.execute(app)).rejects.toThrow(
        /permission denied/,
      )
      await expect(sql`drop table pgboss.job`.execute(app)).rejects.toThrow(/must be owner/)
    })

    it('не может отключить RLS ни на таблице, ни для своей сессии', async () => {
      await expect(
        sql`alter table external_link disable row level security`.execute(app),
      ).rejects.toThrow(/must be owner/)
      await expect(
        sql`alter table project_member no force row level security`.execute(app),
      ).rejects.toThrow(/must be owner/)
      await expect(
        sql`drop policy project_isolation on external_link`.execute(app),
      ).rejects.toThrow(/must be owner/)

      // row_security = off для роли без BYPASSRLS — ошибка запроса, а не все строки.
      await expect(
        app.transaction().execute(async (trx) => {
          await sql`set local row_security = off`.execute(trx)
          return sql`select * from external_link`.execute(trx)
        }),
      ).rejects.toThrow(/row-level security/)
    })

    it('не может создавать таблицы в схеме public', async () => {
      await expect(sql`create table intruder (id int)`.execute(app)).rejects.toThrow(
        /permission denied for schema public/,
      )
    })
  })

  // На project нет RLS: любое право записи у роли приложения задело бы чужой проект.
  describe('таблица project для роли приложения — только чтение', () => {
    it('из всех прав на project у alpi_app и у роли входа есть только SELECT', async () => {
      const { rows } = await sql<{ role: string; privilege: string }>`
        select r.role, p.privilege
        from unnest(array['alpi_app', ${APP_USER}]) as r(role)
        cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
          'REFERENCES', 'TRIGGER']) as p(privilege)
        where has_table_privilege(r.role, 'project', p.privilege)
        order by r.role
      `.execute(owner)
      expect(rows).toEqual([
        { role: 'alpi_app', privilege: 'SELECT' },
        { role: APP_USER, privilege: 'SELECT' },
      ])
    })

    it('delete проекта B внутри withProject(A) отказывает, строки B целы', async () => {
      await expect(
        withProject(app, projectA, (trx) =>
          trx.deleteFrom('project').where('id', '=', projectB).execute(),
        ),
      ).rejects.toThrow(/permission denied for table project/)
      await expect(
        withProject(app, projectA, (trx) => sql`delete from project`.execute(trx)),
      ).rejects.toThrow(/permission denied for table project/)

      expect(await rowsOfProject(owner, projectB)).toEqual({
        project: 1,
        external_link: 1,
        project_member: 2,
      })
    })

    it('update проекта B внутри withProject(A) отказывает, проект не изменён', async () => {
      await expect(
        withProject(app, projectA, (trx) =>
          trx.updateTable('project').set({ name: 'Чужой' }).where('id', '=', projectB).execute(),
        ),
      ).rejects.toThrow(/permission denied for table project/)

      const b = await owner
        .selectFrom('project')
        .select(['code', 'name'])
        .where('id', '=', projectB)
        .executeTakeFirst()
      expect(b).toEqual({ code: 'franch', name: 'Франч' })
    })

    it('createProject: роль приложения создать проект не может, служебная роль — может', async () => {
      await expect(createProject(app, { code: 'intruder', name: 'Чужак' })).rejects.toThrow(
        /permission denied for table project/,
      )
      expect(
        await owner.selectFrom('project').select('id').where('code', '=', 'intruder').execute(),
      ).toEqual([])

      const created = await createProject(owner, { code: 'third', name: 'Третий' })
      expect(created).toMatchObject({
        code: 'third',
        name: 'Третий',
        default_locale: 'uk',
        timezone: 'Europe/Kyiv',
      })
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/)

      // Созданный проект виден приложению: project оно читает.
      const seen = await withProject(app, created.id, (trx) =>
        trx.selectFrom('project').select(['id', 'code']).where('id', '=', created.id).execute(),
      )
      expect(seen).toEqual([{ id: created.id, code: 'third' }])
    })
  })
})

async function rowsOfProject(
  db: Kysely<Database>,
  projectId: string,
): Promise<{ project: number; external_link: number; project_member: number }> {
  const { rows } = await sql<{ project: number; external_link: number; project_member: number }>`
    select
      (select count(*)::int from project where id = ${projectId}) as project,
      (select count(*)::int from external_link where project_id = ${projectId}) as external_link,
      (select count(*)::int from project_member where project_id = ${projectId}) as project_member
  `.execute(db)
  return rows[0] ?? { project: 0, external_link: 0, project_member: 0 }
}

/** Версия схемы pg-boss в базе; null — схемы нет. */
async function pgBossVersion(db: Kysely<Database>): Promise<number | null> {
  const { rows } = await sql<{ exists: boolean }>`
    select to_regclass('pgboss.version') is not null as exists
  `.execute(db)
  if (!rows[0]?.exists) return null
  const version = await sql<{ version: string }>`select version from pgboss.version`.execute(db)
  return Number(version.rows[0]?.version ?? 0)
}

async function existingTables(db: Kysely<Database>): Promise<string[]> {
  const { rows } = await sql<{ tablename: string }>`
    select tablename from pg_tables
    where schemaname = 'public' and tablename not like 'kysely_%'
    order by tablename
  `.execute(db)
  return rows.map((r) => r.tablename)
}
