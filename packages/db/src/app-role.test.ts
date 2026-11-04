import { randomBytes } from 'node:crypto'
import { type Kysely, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertRestrictedRole, ensureAppLoginRole } from './app-role.ts'
import { createDb, type Database } from './index.ts'
import { migrateToLatest } from './migrate.ts'
import { startTestDatabase, type TestDatabase } from './testing/index.ts'

// Роль, под которой ходит API: защита при старте и создание роли входа после миграций.

describe('роль приложения', () => {
  let testDb: TestDatabase
  let owner: Kysely<Database>
  const opened: Kysely<Database>[] = []

  beforeAll(async () => {
    testDb = await startTestDatabase()
    owner = createDb(testDb.connectionString)
    await migrateToLatest(owner)
  })

  afterAll(async () => {
    await Promise.all(opened.map((db) => db.destroy()))
    await owner?.destroy()
    await testDb?.stop()
  })

  function connectAs(user: string, password: string): Kysely<Database> {
    const url = new URL(testDb.connectionString)
    url.username = user
    url.password = password
    const db = createDb(url.href)
    opened.push(db)
    return db
  }

  async function createLogin(user: string, attributes: string): Promise<string> {
    const password = randomBytes(12).toString('hex')
    await sql.raw(`create role ${user} login password '${password}' ${attributes}`).execute(owner)
    return password
  }

  it('ensureAppLoginRole создаёт роль входа, с которой проверка при старте проходит', async () => {
    const password = randomBytes(12).toString('base64url')
    await ensureAppLoginRole(owner, { user: 'alpi_api', password })
    await expect(assertRestrictedRole(connectAs('alpi_api', password))).resolves.toBeUndefined()
  })

  it('повторный вызов меняет пароль и снимает лишние права', async () => {
    await createLogin('alpi_api_again', 'bypassrls')
    const password = `with'quote-${randomBytes(8).toString('hex')}`
    await ensureAppLoginRole(owner, { user: 'alpi_api_again', password })
    await expect(
      assertRestrictedRole(connectAs('alpi_api_again', password)),
    ).resolves.toBeUndefined()
  })

  it('ensureAppLoginRole отказывает, если роль приложения — служебная роль миграций', async () => {
    await expect(ensureAppLoginRole(owner, { user: 'postgres', password: 'x' })).rejects.toThrow(
      /совпадает со служебной ролью/,
    )
    await expect(ensureAppLoginRole(owner, { user: 'Bad-Name', password: 'x' })).rejects.toThrow(
      /Имя роли/,
    )
  })

  it('проверка при старте отклоняет суперпользователя', async () => {
    await expect(assertRestrictedRole(owner)).rejects.toThrow(/суперпользователь/)
  })

  it('проверка при старте отклоняет роль с BYPASSRLS', async () => {
    const password = await createLogin('alpi_bypass', 'bypassrls in role alpi_app')
    await expect(assertRestrictedRole(connectAs('alpi_bypass', password))).rejects.toThrow(
      /BYPASSRLS/,
    )
  })

  // Через SET ROLE в такую группу row-level security обходится, даже если у самой роли входа
  // SUPERUSER и BYPASSRLS нет.
  it('проверка при старте отклоняет члена группы с BYPASSRLS, в том числе через промежуточную группу', async () => {
    await sql`create role alpi_bypass_group nologin bypassrls`.execute(owner)
    await sql`create role alpi_middle_group nologin in role alpi_bypass_group`.execute(owner)
    const password = await createLogin(
      'alpi_in_bypass_group',
      'in role alpi_app, alpi_middle_group',
    )
    await expect(assertRestrictedRole(connectAs('alpi_in_bypass_group', password))).rejects.toThrow(
      /член ролей с SUPERUSER или BYPASSRLS: alpi_bypass_group/,
    )
  })

  it('проверка при старте отклоняет члена группы-суперпользователя', async () => {
    await sql`create role alpi_super_group nologin superuser`.execute(owner)
    const password = await createLogin('alpi_in_super_group', 'in role alpi_app, alpi_super_group')
    await expect(assertRestrictedRole(connectAs('alpi_in_super_group', password))).rejects.toThrow(
      /член ролей с SUPERUSER или BYPASSRLS: alpi_super_group/,
    )
  })

  it('проверка при старте отклоняет владельца таблиц', async () => {
    const password = await createLogin('alpi_table_owner', 'in role alpi_app')
    await sql`create table owned_probe (id int)`.execute(owner)
    await sql`alter table owned_probe owner to alpi_table_owner`.execute(owner)
    await expect(assertRestrictedRole(connectAs('alpi_table_owner', password))).rejects.toThrow(
      /владеет таблицами: public\.owned_probe/,
    )
  })

  it('проверка при старте отклоняет роль не из alpi_app', async () => {
    const password = await createLogin('alpi_outsider', '')
    await expect(assertRestrictedRole(connectAs('alpi_outsider', password))).rejects.toThrow(
      /не член роли alpi_app/,
    )
  })
})
