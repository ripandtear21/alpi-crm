// Стенд сквозного теста (тикет crm-deals/16) — отдельный процесс Node, его запускает и гасит
// e2e/global-setup.ts. Поднимает свою базу и всё, что нужно браузеру:
//   1. embedded PostgreSQL во временной папке (@alpi/db/testing);
//   2. миграции служебной ролью и роль входа API — как мигратор (packages/db/src/cli/migrate.ts);
//   3. тестовые данные pnpm seed (runSeed) со своим файлом учётных данных во временной папке —
//      файл .seed-credentials.json в корне репозитория не трогается;
//   4. API (apps/api/src/index.ts) дочерним процессом на свободном порту;
//   5. сборку клиента (apps/web/dist) и прокси /api → API — как Caddy в docker-compose.
// Готовность — строка `E2E_READY <json>` в stdout. Остановка — конец stdin (его закрывает
// global-setup, а при аварийном завершении раннера — сама ОС), SIGINT или SIGTERM: стенд
// гасит API, сервер клиента и PostgreSQL и удаляет временные папки. Журнал — в stderr.
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAuth } from '../../apps/api/src/auth/auth.ts'
import { runSeed } from '../../apps/api/src/cli/seed.ts'
import {
  assertRestrictedRole,
  createDb,
  ensureAppLoginRole,
  migrateToLatest,
} from '../../packages/db/src/index.ts'
import { startTestDatabase, type TestDatabase } from '../../packages/db/src/testing/index.ts'
import { READY_PREFIX, type StackInfo } from './env.ts'

/**
 * Доля объёма pnpm seed: 250 сделок ALPI вместо 5000 — сценарию хватает, а массовый архив
 * шага 7 и сид укладываются в секунды.
 */
const SEED_SCALE = '0.05'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const WEB_DIST = path.join(ROOT, 'apps/web/dist')
const API_ENTRY = path.join(ROOT, 'apps/api/src/index.ts')

const log = (message: string) => process.stderr.write(`[e2e stack] ${message}\n`)

let db: TestDatabase | undefined
let api: ChildProcess | undefined
let web: Server | undefined
let workDir: string | undefined
let stopping: Promise<void> | undefined

function stop(code: number): Promise<void> {
  stopping ??= (async () => {
    log('остановка')
    web?.closeAllConnections()
    web?.close()
    if (api && api.exitCode === null) {
      const exited = new Promise((resolve) => api?.once('exit', resolve))
      api.kill()
      await Promise.race([exited, delay(5_000)])
    }
    await db?.stop().catch((error: unknown) => log(`PostgreSQL не остановлен: ${String(error)}`))
    if (workDir) await rm(workDir, { recursive: true, force: true, maxRetries: 5 })
    log('остановлен')
    process.exit(code)
  })()
  return stopping
}

process.stdin.on('end', () => void stop(0))
process.stdin.on('error', () => void stop(0))
process.stdin.resume()
process.on('SIGINT', () => void stop(0))
process.on('SIGTERM', () => void stop(0))

try {
  const info = await start()
  process.stdout.write(`${READY_PREFIX}${JSON.stringify(info)}\n`)
} catch (error) {
  log(`стенд не поднялся: ${error instanceof Error ? (error.stack ?? error.message) : error}`)
  await stop(1)
}

async function start(): Promise<StackInfo> {
  await stat(path.join(WEB_DIST, 'index.html')).catch(() => {
    throw new Error(`нет сборки клиента ${WEB_DIST}: сначала pnpm --filter @alpi/web build`)
  })
  workDir = await mkdtemp(path.join(tmpdir(), 'alpi-e2e-'))
  const storageDir = path.join(workDir, 'files')
  const credentialsFile = path.join(workDir, 'seed-credentials.json')

  db = await startTestDatabase()
  const serviceUrl = db.connectionString
  const appUrl = withUser(serviceUrl, 'alpi_e2e', randomBytes(12).toString('hex'))
  log(`PostgreSQL: ${new URL(serviceUrl).port}`)

  // Порт клиента нужен до сида: BETTER_AUTH_URL — origin сайта, с него приходят запросы входа.
  web = createServer()
  const webPort = await listen(web)
  const baseURL = `http://127.0.0.1:${webPort}`
  const authSecret = randomBytes(32).toString('base64')

  const serviceDb = createDb(serviceUrl)
  try {
    await migrateToLatest(serviceDb)
    const app = new URL(appUrl)
    await ensureAppLoginRole(serviceDb, {
      user: app.username,
      password: decodeURIComponent(app.password),
    })
    const appDb = createDb(appUrl)
    try {
      await assertRestrictedRole(appDb)
    } finally {
      await appDb.destroy()
    }
    const env = { ...process.env, NODE_ENV: 'development' }
    const auth = createAuth({
      db: serviceDb,
      secret: authSecret,
      baseURL,
      secureCookies: false,
    })
    const code = await runSeed(
      {
        serviceDb,
        databaseUrl: serviceUrl,
        appDatabaseUrl: appUrl,
        auth,
        authUrl: baseURL,
        env,
        credentialsFile,
        out: { log, error: log },
      },
      ['--scale', SEED_SCALE],
    )
    if (code !== 0) throw new Error(`seed завершился с кодом ${code}`)
  } finally {
    await serviceDb.destroy()
  }

  const apiPort = await freePort()
  api = spawn(process.execPath, [API_ENTRY], {
    cwd: path.dirname(API_ENTRY),
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(apiPort),
      DATABASE_URL: appUrl,
      BETTER_AUTH_SECRET: authSecret,
      BETTER_AUTH_URL: baseURL,
      STORAGE_DIR: storageDir,
      TRUSTED_PROXIES: '',
      // Вебхуки (тикеты crm-api/06–08): ключ шифрования секретов подписи и разрешение
      // http://127.0.0.1 — приёмник событий сценария crm-api слушает в процессе Playwright.
      WEBHOOK_SECRET_KEY: randomBytes(32).toString('base64'),
      WEBHOOK_ALLOW_INSECURE_URLS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  api.stdout?.on('data', (chunk: Buffer) => process.stderr.write(`[api] ${chunk}`))
  api.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[api] ${chunk}`))
  api.once('exit', (code) => {
    if (!stopping) {
      log(`API завершился сам (код ${code})`)
      void stop(1)
    }
  })
  await waitForHealth(`http://127.0.0.1:${apiPort}/health`)
  web.on('request', (req, res) => serveWeb(req, res, apiPort))
  log(`клиент: ${baseURL}, API: ${apiPort}`)
  return { baseURL, credentialsFile }
}

/** Та же база, другой пользователь: строка подключения роли входа API. */
function withUser(connectionString: string, user: string, password: string): string {
  const url = new URL(connectionString)
  url.username = user
  url.password = password
  return url.toString()
}

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

// shortcut: порт освобождается до запуска API, и его может занять другой процесс; переделать
// на повтор с новым портом, если запуски начнут падать с «address already in use».
async function freePort(): Promise<number> {
  const probe = createServer()
  const port = await listen(probe)
  await new Promise((resolve) => probe.close(resolve))
  return port
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (stopping) throw new Error('API завершился, не ответив на /health')
    const ok = await fetch(url)
      .then((res) => res.ok)
      .catch(() => false)
    if (ok) return
    await delay(250)
  }
  throw new Error(`API не ответил на ${url} за 60 с`)
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
}

/** Как Caddy (apps/web/Caddyfile): /api/* — на API без префикса, остальное — сборка клиента. */
function serveWeb(req: IncomingMessage, res: ServerResponse, apiPort: number) {
  const url = req.url ?? '/'
  if (url === '/api' || url.startsWith('/api/')) {
    const upstream = request(
      {
        host: '127.0.0.1',
        port: apiPort,
        method: req.method,
        path: url.slice('/api'.length) || '/',
        headers: { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress ?? '127.0.0.1' },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        upstreamRes.pipe(res)
      },
    )
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.pipe(upstream)
    return
  }
  void sendStatic(url, res)
}

async function sendStatic(url: string, res: ServerResponse) {
  const pathname = decodeURIComponent(new URL(url, 'http://localhost').pathname)
  let file = path.join(WEB_DIST, path.normalize(pathname))
  if (!file.startsWith(WEB_DIST)) file = path.join(WEB_DIST, 'index.html')
  const isFile = await stat(file)
    .then((s) => s.isFile())
    .catch(() => false)
  // Адреса экранов (/p/alpi/deals) — одностраничное приложение: отдаём index.html.
  if (!isFile) file = path.join(WEB_DIST, 'index.html')
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
  })
  createReadStream(file).pipe(res)
}
