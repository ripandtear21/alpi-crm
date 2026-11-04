import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startTestDatabase } from './index.ts'

describe('startTestDatabase при сбое запуска PostgreSQL', () => {
  const servers: Server[] = []
  let parentDir: string | undefined

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
    if (parentDir) {
      await rm(parentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })

  // Без ограничения ожидания pg.stop() вызов висел бы бесконечно, и тест падал бы по таймауту.
  // Время не сравниваем с порогом: под нагрузкой одна только initdb занимает больше 20 с.
  it('на занятом порту отклоняется, а не висит, отдаёт журнал запуска и удаляет временную папку', {
    timeout: 120_000,
  }, async () => {
    parentDir = await mkdtemp(path.join(tmpdir(), 'alpi-start-failure-'))
    const port = await occupyPort(servers)

    const error = await startTestDatabase({ port, parentDir }).then(
      () => undefined,
      (e: unknown) => e,
    )

    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('embedded PostgreSQL не запустился')
    // В журнале сервера есть строка о порте, который не удалось занять.
    expect(message).toContain(String(port))
    expect(await readdir(parentDir)).toEqual([])
  })
})

/**
 * Занимает один и тот же порт на 127.0.0.1 и ::1, чтобы PostgreSQL (listen_addresses =
 * localhost) не смог открыть ни одного сокета.
 */
async function occupyPort(servers: Server[]): Promise<number> {
  const v4 = await listen(0, '127.0.0.1')
  servers.push(v4)
  const address = v4.address()
  if (!address || typeof address !== 'object') {
    throw new Error('Не удалось получить порт')
  }
  // Если IPv6 на машине нет, PostgreSQL тоже не сможет на нём слушать.
  const v6 = await listen(address.port, '::1').catch(() => undefined)
  if (v6) {
    servers.push(v6)
  }
  return address.port
}

function listen(port: number, host: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, host, () => resolve(server))
  })
}
