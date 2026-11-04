import { createDb } from '@alpi/db'
import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { createAuth } from './auth/auth.ts'
import { readApiEnv } from './config.ts'

const env = readApiEnv()
const port = Number(process.env.PORT ?? 3000)

const db = createDb(env.databaseUrl)
const auth = createAuth({
  db,
  secret: env.authSecret,
  baseURL: env.authUrl,
  secureCookies: env.secureCookies,
})
const app = createApp({ auth })

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`API слушает порт ${info.port}`)
})
