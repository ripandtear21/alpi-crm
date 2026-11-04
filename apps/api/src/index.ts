import { assertRestrictedRole, createDb } from '@alpi/db'
import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { createAuth } from './auth/auth.ts'
import type { BulkActionRegistry } from './bulk/registry.ts'
import { readApiEnv } from './config.ts'
import { TRANSFER_DEALS_ACTION, transferDeals } from './deals/transfer.ts'
import { startJobs } from './jobs/jobs.ts'
import { localDiskStorage } from './storage/storage.ts'
import { NO_TRASH_PURGERS } from './trash/purge.ts'

const env = readApiEnv()
const port = Number(process.env.PORT ?? 3000)

const db = createDb(env.databaseUrl)
// Под суперпользователем, ролью с BYPASSRLS или владельцем таблиц изоляция проектов
// (row-level security) не действует — с такой ролью API не запускается.
await assertRestrictedRole(db)
const auth = createAuth({
  db,
  secret: env.authSecret,
  baseURL: env.authUrl,
  secureCookies: env.secureCookies,
  trustedProxies: env.trustedProxies,
})
// Фоновые задачи — в процессе API, той же ролью приложения (apps/api/src/jobs/jobs.ts).
// Реестр массовых действий (bulk/registry.ts): код «раздел.действие» → действие.
const bulkActions: BulkActionRegistry = new Map([[TRANSFER_DEALS_ACTION, transferDeals]])
const jobs = await startJobs({
  connectionString: env.databaseUrl,
  db,
  bulkActions,
  trashPurgers: NO_TRASH_PURGERS,
})
const app = createApp({
  auth,
  db,
  bulk: { actions: bulkActions, enqueue: jobs.enqueueBulk },
  storage: localDiskStorage(env.storageDir),
})

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`API слушает порт ${info.port}`)
})

// Остановка: новых запросов и задач не берём, текущие задачи дожидаемся, потом закрываем базу.
let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  console.log(`${signal}: API останавливается`)
  server.close()
  try {
    await jobs.stop()
  } finally {
    await db.destroy()
  }
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
