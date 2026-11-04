import { assertRestrictedRole, createDb } from '@alpi/db'
import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { createAuth } from './auth/auth.ts'
import { readApiEnv } from './config.ts'

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
const app = createApp({ auth, db })

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`API слушает порт ${info.port}`)
})
