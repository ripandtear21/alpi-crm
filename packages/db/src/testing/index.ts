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

/**
 * Поднимает настоящий PostgreSQL (npm-пакет embedded-postgres, без Docker) во временной
 * папке на свободном порту. Вызывать в beforeAll, `stop()` — в afterAll.
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const root = await mkdtemp(path.join(tmpdir(), 'alpi-pg-'))
  const port = await findFreePort()
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
    await pg.stop().catch(() => {})
    await removeDir(root)
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

// На Windows файлы базы могут быть заняты ещё несколько мгновений после остановки сервера.
function removeDir(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
