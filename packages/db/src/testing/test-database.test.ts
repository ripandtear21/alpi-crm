import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb } from '../index.ts'
import { migrateToLatest } from '../migrate.ts'
import { startTestDatabase, type TestDatabase } from './index.ts'

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

  it('мигратор применяет миграции из packages/db/migrations без ошибок', async () => {
    const results = await migrateToLatest(db)
    expect(results.every((r) => r.status === 'Success')).toBe(true)
  })
})
