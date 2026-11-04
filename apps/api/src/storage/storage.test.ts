import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type FileStorage, localDiskStorage, objectKey } from './storage.ts'

// Хранилище файлов на локальном диске (тикет crm-deals/07): положить, отдать, удалить; ключ не
// выводит за каталог; оборванная запись не оставляет объекта.

const PROJECT = '0b0f6c1e-6a52-4b8e-9b1f-1d2c3e4f5a6b'
const FILE = 'f1e2d3c4-b5a6-4789-8abc-def012345678'

async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield new TextEncoder().encode(part)
}

/** Все файлы под каталогом, пути относительно него. */
async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort()
}

describe('localDiskStorage', () => {
  let root: string
  let storage: FileStorage

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'alpi-storage-'))
    storage = localDiskStorage(root)
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('кладёт, отдаёт потоком и удаляет объект по ключу проекта', async () => {
    const key = objectKey(PROJECT, FILE)
    expect(key).toBe(`${PROJECT}/${FILE}`)
    await storage.put(key, chunks('при', 'віт'))
    expect(await listFiles(root)).toEqual([path.join(PROJECT, FILE)])
    expect(await new Response(await storage.stream(key)).text()).toBe('привіт')

    await storage.delete(key)
    expect(await listFiles(root)).toEqual([])
    await expect(storage.stream(key)).rejects.toThrow(/ENOENT/)
    // Повторное удаление — не ошибка.
    await storage.delete(key)
  })

  it('не принимает ключ, который выводит за каталог или несёт имя файла', async () => {
    for (const key of [
      '../x',
      `${PROJECT}/../../x`,
      '/etc/passwd',
      'a\\b',
      'a//b',
      'Отчёт.pdf',
      '',
    ]) {
      await expect(storage.put(key, chunks('x'))).rejects.toThrow(/ключ объекта/)
      await expect(storage.stream(key)).rejects.toThrow(/ключ объекта/)
      await expect(storage.delete(key)).rejects.toThrow(/ключ объекта/)
    }
    expect(await listFiles(root)).toEqual([])
  })

  it('оборванная запись не оставляет ни объекта, ни временного файла', async () => {
    async function* broken(): AsyncIterable<Uint8Array> {
      yield new Uint8Array(1024)
      throw new Error('обрыв')
    }
    const key = objectKey(PROJECT, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    await expect(storage.put(key, broken())).rejects.toThrow('обрыв')
    expect(await listFiles(root)).toEqual([])
  })
})
