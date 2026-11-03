import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import EmbeddedPostgres from 'embedded-postgres'

export interface TestDatabase {
  /** Строка подключения суперпользователя к базе `postgres`. */
  connectionString: string
  /** Гасит PostgreSQL и удаляет временную папку с данными. */
  stop(): Promise<void>
}

export interface StartTestDatabaseOptions {
  /** Порт сервера. По умолчанию — свободный порт; задают тесты сбоя запуска. */
  port?: number
  /** Где создать временную папку `alpi-pg-*`. По умолчанию — системная временная папка. */
  parentDir?: string
}

/**
 * Поднимает настоящий PostgreSQL (npm-пакет embedded-postgres, без Docker) во временной
 * папке на свободном порту. Вызывать в beforeAll, `stop()` — в afterAll.
 */
export async function startTestDatabase(
  options: StartTestDatabaseOptions = {},
): Promise<TestDatabase> {
  // Порт — до создания папки: если его не получить, удалять будет нечего.
  const port = options.port ?? (await findFreePort())
  const root = await mkdtemp(path.join(options.parentDir ?? tmpdir(), 'alpi-pg-'))
  const user = 'postgres'
  const password = 'postgres'
  const log: string[] = []
  const pg = new EmbeddedPostgres({
    databaseDir: path.join(root, 'data'),
    port,
    user,
    password,
    authMethod: 'scram-sha-256',
    persistent: false,
    // Вывод initdb и сервера копим и показываем только при ошибке запуска.
    onLog: (message) => log.push(String(message)),
    onError: (message) => log.push(String(message)),
  })

  try {
    await pg.initialise()
    await pg.start()
  } catch (error) {
    // Если сервер уже завершился (например, порт занят), pg.stop() ждёт событие exit,
    // которое уже прошло, и не вернётся никогда — поэтому ожидание ограничено.
    await withTimeout(pg.stop(), STOP_AFTER_FAILED_START_MS).catch(() => {})
    // Ошибка удаления не должна заслонить причину сбоя: она уходит в журнал.
    await removeDir(root).catch((rmError: unknown) => {
      log.push(`Не удалось удалить временную папку ${root}: ${String(rmError)}`)
    })
    throw new Error(`embedded PostgreSQL не запустился:\n${log.join('\n')}`, { cause: error })
  }

  return {
    connectionString: `postgres://${user}:${password}@127.0.0.1:${port}/postgres`,
    async stop() {
      await pg.stop()
      await removeDir(root)
    },
  }
}

// shortcut: порт освобождается до запуска PostgreSQL, и его может занять другой процесс;
// переделать на повтор с новым портом, если тесты начнут падать с «address already in use».
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port)
        } else {
          reject(new Error('Не удалось получить свободный порт'))
        }
      })
    })
  })
}

/** Сколько ждать остановки сервера после неудачного запуска. */
const STOP_AFTER_FAILED_START_MS = 5_000

/** Отклоняется, если `promise` не завершился за `ms`; таймер снимается сразу после исхода. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Не завершилось за ${ms} мс`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

// На Windows файлы базы могут быть заняты ещё несколько мгновений после остановки сервера.
function removeDir(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
