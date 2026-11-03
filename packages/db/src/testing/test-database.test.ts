import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb } from '../index.ts'
import { migrateToLatest, migrationFolder } from '../migrate.ts'
import { startTestDatabase, type TestDatabase } from './index.ts'

const fixtureMigrations = fileURLToPath(new URL('./fixtures/migrations', import.meta.url))

describe('тестовая база (embedded PostgreSQL)', () => {
  let testDb: TestDatabase
  let db: ReturnType<typeof createDb>

  beforeAll(async () => {
    testDb = await startTestDatabase()
    db = createDb(testDb.connectionString)
  })

  afterAll(async () => {
    await db?.destroy()
    await testDb?.stop()
  })

  it('поднимает настоящий PostgreSQL версии 16 или новее', async () => {
    const { rows } = await sql<{ version: string }>`select version()`.execute(db)
    expect(rows[0]?.version).toMatch(/^PostgreSQL \d+/)

    const num = await sql<{ server_version_num: string }>`show server_version_num`.execute(db)
    expect(Number(num.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(160000)
  })

  it('мигратор применяет миграцию из папки: таблица создана, запись в kysely_migration есть', async () => {
    const results = await migrateToLatest(db, fixtureMigrations)
    expect(results.map((r) => [r.migrationName, r.status])).toEqual([
      ['0001_create_fixture_probe', 'Success'],
    ])

    const table = await sql<{ name: string | null }>`
      select to_regclass('public.fixture_probe')::text as name
    `.execute(db)
    expect(table.rows[0]?.name).toBe('fixture_probe')

    const applied = await sql<{ name: string }>`select name from kysely_migration`.execute(db)
    expect(applied.rows.map((r) => r.name)).toEqual(['0001_create_fixture_probe'])

    // Повторный прогон ничего не применяет: миграция уже записана.
    expect(await migrateToLatest(db, fixtureMigrations)).toEqual([])
  })

  it('папка миграций по умолчанию — packages/db/migrations', async () => {
    expect(migrationFolder).toBe(fileURLToPath(new URL('../../migrations', import.meta.url)))
    await expect(stat(migrationFolder).then((s) => s.isDirectory())).resolves.toBe(true)
  })
})
