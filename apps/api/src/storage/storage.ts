import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// Хранилище содержимого файлов (тикет crm-deals/07): положить, отдать поток, удалить. Сейчас одна
// реализация — локальный диск, каталог из настройки STORAGE_DIR (config.ts); объектное
// хранилище (S3 и подобные) подключит эпик эксплуатации той же прослойкой.
//
// Ключ объекта строит API: «<id проекта>/<id файла>» (objectKey). Имя файла от пользователя в
// ключ и в путь на диске не попадает; ключ другого вида хранилище не принимает.

export interface FileStorage {
  /**
   * Кладёт содержимое под ключом `key`. Ошибка потока `body` (в том числе превышение предела
   * размера у вызывающего) пробрасывается, и объекта под ключом не остаётся.
   */
  put(key: string, body: AsyncIterable<Uint8Array>): Promise<void>
  /** Поток содержимого; объекта нет — ошибка. */
  stream(key: string): Promise<ReadableStream<Uint8Array>>
  /** Удаляет объект; объекта уже нет — не ошибка. */
  delete(key: string): Promise<void>
}

/** Ключ объекта файла `fileId` проекта `projectId` (оба — uuid). */
export function objectKey(projectId: string, fileId: string): string {
  return `${projectId.toLowerCase()}/${fileId.toLowerCase()}`
}

/** Сегменты ключа: строчные буквы, цифры и дефис — как у uuid. Ни «..», ни разделителей пути. */
const KEY = /^[0-9a-z-]+(\/[0-9a-z-]+)*$/

/** Хранилище на локальном диске: объект `a/b` — файл `<root>/a/b`. */
export function localDiskStorage(root: string): FileStorage {
  const base = path.resolve(root)

  function pathOf(key: string): string {
    if (!KEY.test(key)) throw new Error(`недопустимый ключ объекта: ${JSON.stringify(key)}`)
    const target = path.resolve(base, ...key.split('/'))
    // Вторая линия после проверки вида ключа: путь не выходит за каталог хранилища.
    const relative = path.relative(base, target)
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`ключ объекта вне каталога хранилища: ${JSON.stringify(key)}`)
    }
    return target
  }

  return {
    async put(key, body) {
      const target = pathOf(key)
      await mkdir(path.dirname(target), { recursive: true })
      // Сначала во временный файл рядом, потом переименование: недописанный объект не виден
      // под ключом ни при ошибке, ни при одновременном чтении.
      const partial = `${target}.${randomUUID()}.part`
      try {
        await pipeline(Readable.from(body), createWriteStream(partial, { flags: 'wx' }))
        await rename(partial, target)
      } catch (error) {
        await rm(partial, { force: true })
        throw error
      }
    },
    async stream(key) {
      // Открытие — сразу: объекта нет — ошибка здесь, а не посреди ответа.
      const handle = await open(pathOf(key), 'r')
      return Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array>
    },
    async delete(key) {
      await rm(pathOf(key), { force: true })
    },
  }
}

/** Хранилище не настроено (приложение без файлов: тесты других разделов). */
export const NO_FILE_STORAGE: FileStorage = {
  put: () => Promise.reject(new Error('хранилище файлов не настроено')),
  stream: () => Promise.reject(new Error('хранилище файлов не настроено')),
  delete: () => Promise.reject(new Error('хранилище файлов не настроено')),
}
