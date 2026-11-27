// Тестовые данные для разработки, ручной проверки и приёмки (тикет crm-deals/10):
//   pnpm seed [--scale <доля>] [--allow-remote]   — создать (повторный запуск досоздаёт недостающее)
//   pnpm seed --reset [--allow-remote]            — удалить только созданное этой командой
// Работает служебной ролью (владелец таблиц) из MIGRATION_DATABASE_URL, как мигратор; схему
// не мигрирует — сначала pnpm --filter @alpi/db migrate. Пользователей заводит через Better
// Auth (нужны BETTER_AUTH_SECRET и BETTER_AUTH_URL, как у API), их пароли и секреты 2FA
// печатает и пишет в .seed-credentials.json в корне репозитория (файл вне git). Функции
// приложения (приём регистраций, слияние, надсмотрщик) — ролью приложения из DATABASE_URL, как
// API: изоляцию проектов в них держит row-level security. Данные эпика
// crm-intake (тикет crm-intake/10): источники регистраций, регистрации, журнал входящих, готовые
// дубли и слияния; ключи источников — только в том же файле, в вывод не печатаются.
// На проде не запускается: NODE_ENV=production — отказ; нелокальная база — только с
// --allow-remote.
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createDb, type Database } from '@alpi/db'
import type { Kysely } from 'kysely'
import { parse } from 'pg-connection-string'
import { type Auth, createAuth } from '../auth/auth.ts'
import { readApiEnv } from '../config.ts'
import { startEventQueue } from '../jobs/jobs.ts'
import { writeIntake } from '../seed/intake-store.ts'
import { buildSeedPlan } from '../seed/plan.ts'
import { findSeedProject, resetProjects, writeProject } from '../seed/store.ts'
import {
  deleteSeedUsers,
  ensureUsers,
  readCredentials,
  readSourceKeys,
  type SeedCredential,
  type SourceKey,
  writeCredentials,
  writeSourceKeys,
} from '../seed/users.ts'

const USAGE = 'Использование: pnpm seed [--scale <доля от 0 до 1>] [--reset] [--allow-remote]'

/** Файл учётных данных по умолчанию: корень репозитория (в .gitignore). */
export const DEFAULT_CREDENTIALS_FILE = fileURLToPath(
  new URL('../../../../.seed-credentials.json', import.meta.url),
)

interface Output {
  log(message: string): void
  error(message: string): void
}

export interface SeedDeps {
  /** Подключение служебной ролью. */
  serviceDb: Kysely<Database>
  /** Строка подключения `serviceDb`: по ней проверяется, что база локальная. */
  databaseUrl: string
  /**
   * Строка подключения ролью приложения (DATABASE_URL): им работают функции приёма, слияния и
   * надсмотрщика, им же — очередь pg-boss их задач. Тоже должна быть локальной.
   */
  appDatabaseUrl: string
  auth: Auth
  /** Публичный адрес сайта (BETTER_AUTH_URL): origin запросов включения 2FA. */
  authUrl: string
  env?: NodeJS.ProcessEnv
  credentialsFile?: string
  out?: Output
  now?: Date
}

/** Адреса локальной базы; путь (начинается с «/») — unix-сокет на этой же машине. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

/**
 * Причина отказа запускаться против этой базы; null — можно. Хост — так, как его выберет `pg`:
 * из строки подключения (в том числе `?host=`), без него — PGHOST, без него — localhost.
 * PGHOST, `hostaddr` и PGHOSTADDR проверяются и сами по себе: локальными должны быть все.
 */
export function refusal(
  env: NodeJS.ProcessEnv,
  databaseUrl: string,
  allowRemote: boolean,
): string | null {
  if (env.NODE_ENV?.trim().toLowerCase() === 'production') {
    return 'NODE_ENV=production: тестовые данные на проде не создаются и не удаляются'
  }
  if (allowRemote) return null
  let parsed: ReturnType<typeof parse>
  try {
    parsed = parse(databaseUrl)
  } catch {
    return 'строку подключения к базе не удалось разобрать'
  }
  const hosts = [
    parsed.host || env.PGHOST || 'localhost',
    env.PGHOST,
    parsed.hostaddr,
    env.PGHOSTADDR,
  ].filter((host): host is string => Boolean(host))
  const remote = hosts.find((host) => !LOCAL_HOSTS.has(host) && !host.startsWith('/'))
  if (remote !== undefined) {
    return `база на ${remote} — не локальная; если это точно база разработки, добавьте --allow-remote`
  }
  return null
}

interface SeedArgs {
  reset: boolean
  allowRemote: boolean
  scale: number
}

function parseArgs(args: string[]): SeedArgs | null {
  const parsed: SeedArgs = { reset: false, allowRemote: false, scale: 1 }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--reset') parsed.reset = true
    else if (arg === '--allow-remote') parsed.allowRemote = true
    else if (arg === '--scale') {
      const scale = Number(args[++i])
      if (!(scale > 0 && scale <= 1)) return null
      parsed.scale = scale
    } else return null
  }
  return parsed
}

/**
 * Создаёт (или с `--reset` удаляет) тестовые данные. Код выхода: 0 — готово, 1 — отказ
 * (прод, нелокальная база, чужой проект с тем же кодом), 2 — неверные аргументы.
 */
export async function runSeed(deps: SeedDeps, args: string[]): Promise<number> {
  const out = deps.out ?? console
  const parsed = parseArgs(args)
  if (!parsed) {
    out.error(USAGE)
    return 2
  }
  const env = deps.env ?? process.env
  const refused = [deps.databaseUrl, deps.appDatabaseUrl]
    .map((url) => refusal(env, url, parsed.allowRemote))
    .find((reason) => reason !== null)
  if (refused !== undefined) {
    out.error(`seed не запущен: ${refused}`)
    return 1
  }
  const started = performance.now()
  const credentialsFile = deps.credentialsFile ?? DEFAULT_CREDENTIALS_FILE
  const plan = buildSeedPlan({ scale: parsed.scale, now: deps.now })

  if (parsed.reset) {
    const projects = await resetProjects(deps.serviceDb)
    const users = await deleteSeedUsers(
      deps.serviceDb,
      plan.users.map((u) => u.email),
    )
    const known = await readCredentials(credentialsFile)
    await writeCredentials(
      credentialsFile,
      known.filter((c) => !users.deleted.includes(c.email)),
    )
    // Ключи удалённых источников больше не нужны.
    const keys = await readSourceKeys(credentialsFile)
    const left =
      keys.length === 0
        ? new Set<string>()
        : new Set(
            (
              await deps.serviceDb
                .selectFrom('intake_source')
                .select('id')
                .where(
                  'id',
                  'in',
                  keys.map((k) => k.sourceId),
                )
                .execute()
            ).map((r) => r.id),
          )
    await writeSourceKeys(
      credentialsFile,
      keys.filter((k) => left.has(k.sourceId)),
    )
    const d = projects.deleted
    out.log(
      `Удалено: сделок ${d.deals}, контактов ${d.contacts}, организаций ${d.organizations}, товаров ${d.products}, пользователей ${users.deleted.length}`,
    )
    const k = projects.kept
    if (k.deal + k.contact + k.organization + k.product > 0) {
      out.log(
        `Оставлены записи seed, на которые ссылаются записи, созданные руками: сделок ${k.deal}, контактов ${k.contact}, организаций ${k.organization}, товаров ${k.product}`,
      )
    }
    if (projects.deletedProjects.length > 0) {
      out.log(`Проекты удалены целиком: ${projects.deletedProjects.join(', ')}`)
    }
    if (projects.keptProjects.length > 0) {
      out.log(
        `Проекты оставлены (в них есть записи, созданные не командой seed): ${projects.keptProjects.join(', ')}`,
      )
    }
    if (users.kept.length > 0) {
      out.log(`Пользователи оставлены (на них ссылаются другие записи): ${users.kept.join(', ')}`)
    }
    out.log(`Готово за ${seconds(started)} с`)
    return 0
  }

  // Чужой проект с тем же кодом — отказ до любых записей.
  try {
    for (const project of plan.projects) await findSeedProject(deps.serviceDb, project.code)
  } catch (error) {
    out.error(`seed не запущен: ${(error as Error).message}`)
    return 1
  }

  const users = await ensureUsers(
    deps.serviceDb,
    deps.auth,
    deps.authUrl,
    plan.users,
    await readCredentials(credentialsFile),
    // Файл дописывается после каждого пользователя: при сбое пароли созданных не теряются.
    (credentials) => writeCredentials(credentialsFile, credentials),
  )
  out.log(`Пользователи: создано ${users.created}, всего ${plan.users.length}`)

  const adminId = users.ids.get(plan.adminKey)
  if (!adminId) throw new Error('нет администратора seed')
  const knownKeys = await readSourceKeys(credentialsFile)
  let sourceKeys: SourceKey[] = knownKeys.filter(
    (k) => !plan.projects.some((p) => p.code === k.project),
  )
  // Роль приложения и очередь pg-boss: приём регистраций и слияние ставят задачи событий и
  // поиска дублей той же транзакцией (обрабатывает их потом фоновый процесс API).
  const appDb = createDb(deps.appDatabaseUrl)
  const queue = await startEventQueue(deps.appDatabaseUrl)
  try {
    for (const project of plan.projects) {
      const counts = await writeProject(deps.serviceDb, project, users.ids, plan.adminKey)
      out.log(
        `«${project.name}»: создано товаров ${counts.products}, организаций ${counts.organizations}, контактов ${counts.contacts}, сделок ${counts.deals}` +
          (counts.skippedDeals > 0
            ? `; пропущено сделок ${counts.skippedDeals} (у человека уже есть открытая сделка в воронке)`
            : ''),
      )
      const intake = await writeIntake(deps.serviceDb, appDb, project, adminId, knownKeys)
      sourceKeys = [...sourceKeys, ...intake.keys]
      // Ключи — в файл сразу: при сбое следующего проекта ключи этого не теряются.
      await writeSourceKeys(credentialsFile, sourceKeys)
      const c = intake.counts
      out.log(
        `«${project.name}»: создано источников ${c.sources}, регистраций ${c.registrations}, строк журнала входящих ${c.inbound}, слияний ${c.merges}; пар дублей в проекте ${c.pairs}`,
      )
    }
  } finally {
    await queue.stop()
    await appDb.destroy()
  }

  printCredentials(out, users.credentials, credentialsFile)
  out.log(`Ключи источников регистраций — только в ${credentialsFile} (в вывод не печатаются)`)
  if (users.unknown.length > 0) {
    out.log(
      `Пароль неизвестен (нет в ${credentialsFile}): ${users.unknown.join(', ')} — pnpm seed --reset и заново`,
    )
  }
  out.log(`Готово за ${seconds(started)} с`)
  return 0
}

function seconds(started: number): string {
  return ((performance.now() - started) / 1000).toFixed(1)
}

function printCredentials(out: Output, credentials: SeedCredential[], file: string) {
  if (credentials.length === 0) return
  out.log(`Вход (тот же список — в ${file}):`)
  for (const c of credentials) {
    out.log(`  ${c.email}  ${c.role}  пароль ${c.password}  секрет 2FA ${c.totpSecret}`)
  }
}

function isMain(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMain()) {
  const url = process.env.MIGRATION_DATABASE_URL
  if (!url) {
    console.error('Не задана переменная окружения MIGRATION_DATABASE_URL (служебная роль)')
    process.exit(1)
  }
  const env = readApiEnv()
  const db = createDb(url)
  try {
    const auth = createAuth({
      db,
      secret: env.authSecret,
      baseURL: env.authUrl,
      secureCookies: env.secureCookies,
    })
    process.exitCode = await runSeed(
      {
        serviceDb: db,
        databaseUrl: url,
        appDatabaseUrl: env.databaseUrl,
        auth,
        authUrl: env.authUrl,
      },
      process.argv.slice(2),
    )
  } finally {
    await db.destroy()
  }
}
