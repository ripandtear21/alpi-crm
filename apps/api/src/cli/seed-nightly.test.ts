import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scanAllDuplicates } from '../duplicates/finder.ts'
import { type ApiHarness, ORIGIN, startApiHarness } from '../testing/api-harness.ts'
import { runSeed } from './seed.ts'

// Ночной проход надсмотрщика за дублями на данных `pnpm seed` полного объёма (тикет
// crm-intake/10): порог тикета crm-intake/05 — 5 минут (решено без владельца — подтвердить).
// Время прохода тест печатает строкой `[seed-nightly]`. seed сам прогоняет надсмотрщика после
// заполнения, поэтому ночной проход ничего не добавляет и не удаляет.

const LIMIT_MS = 5 * 60 * 1000
const SLOW = 600_000

describe('ночной проход на данных pnpm seed полного объёма', () => {
  let h: ApiHarness

  beforeAll(async () => {
    h = await startApiHarness('alpi_seed_nightly')
  })

  afterAll(async () => {
    await h?.stop()
  })

  it(
    'укладывается в 5 минут и не меняет пары, найденные seed',
    async () => {
      const credentialsFile = path.join(
        await mkdtemp(path.join(tmpdir(), 'alpi-seed-nightly-')),
        'creds.json',
      )
      const seedStarted = performance.now()
      const code = await runSeed(
        {
          serviceDb: h.owner,
          databaseUrl: h.appUrl,
          appDatabaseUrl: h.appUrl,
          auth: h.auth,
          authUrl: ORIGIN,
          env: { NODE_ENV: 'test' },
          credentialsFile,
          out: { log: () => {}, error: () => {} },
        },
        [],
      )
      expect(code).toBe(0)
      const seedMs = performance.now() - seedStarted

      const { rows } = await sql<{ contacts: number; deals: number; regs: number; pairs: number }>`
        select
          (select count(*)::int from contact) as contacts,
          (select count(*)::int from deal) as deals,
          (select count(*)::int from registration) as regs,
          (select count(*)::int from duplicate_pair) as pairs
      `.execute(h.owner)
      const volume = rows[0]
      expect(volume?.regs).toBeGreaterThan(1000)
      expect(volume?.pairs).toBeGreaterThan(0)

      const started = performance.now()
      // Ролью приложения, как фоновая задача API: на служебную роль политики проектов не действуют.
      const result = await scanAllDuplicates(h.appDb)
      const ms = performance.now() - started
      console.log(
        `[seed-nightly] ночной проход: ${Math.round(ms)} мс (seed: ${Math.round(seedMs)} мс); ` +
          `контактов ${volume?.contacts}, сделок ${volume?.deals}, регистраций ${volume?.regs}, ` +
          `пар ${volume?.pairs}`,
      )
      expect(ms).toBeLessThan(LIMIT_MS)
      expect(result).toEqual({ added: 0, removed: 0 })
    },
    SLOW,
  )
})
