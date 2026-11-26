import { randomUUID } from 'node:crypto'
import type { Database } from '@alpi/db'
import { Hono } from 'hono'
import type { Selectable } from 'kysely'
import { type Ctx, fail, type Outcome, ok, readLimit, refuse, UUID } from '../contacts/http.ts'
import { problem } from '../http/problem.ts'
import { type PermissionsEnv, requirePermission } from '../middleware/permissions.ts'
import { type FileStorage, objectKey } from '../storage/storage.ts'
import {
  ENTITY_COLUMN,
  ENTITY_PATH,
  ENTITY_RESOURCE,
  ENTITY_TYPES,
  type EntityErrorCode,
  type EntityRef,
  type EntityType,
  entityCan,
  entityFor,
  targetValues,
} from '../timeline/entity.ts'
import { detectContentType, SNIFF_BYTES } from './sniff.ts'

// Файлы к сделке, контакту или организации (тикет crm-deals/07): `/v1/{deals|contacts|
// organizations}/:id/files`. Права — как у заметок (notes/notes.ts): смотреть — кто видит
// запись; загружать — кто может её менять; удалять — автор файла или пользователь с правом
// «удалять» эту часть системы (решено без владельца — подтвердить).
//
// Загрузка — тело запроса целиком и есть файл (не multipart/form-data): POST
// `/:id/files?name=<исходное имя>`, `fetch(url, { method: 'POST', body: file })`. Так тело идёт
// потоком прямо в хранилище, без разбора формы и без новой зависимости.
// - Предел — 25 МБ: Content-Length больше — 413 сразу; без него — 413, как только пришёл лишний
//   байт: недописанный объект хранилище удаляет, на диск целиком такой файл не попадает.
// - Тип — по содержимому (files/sniff.ts), Content-Type запроса и расширение не важны.
// - Имя файла — только для показа и Content-Disposition; ключ объекта — id проекта и id файла.
// Скачивание — всегда вложением, с nosniff и запретом исполнять содержимое (CSP sandbox).

/** Наибольший файл: 25 МБ (тот же предел — в таблице file). */
export const MAX_FILE_BYTES = 25 * 1024 * 1024
const MAX_NAME_LENGTH = 255

export type FilesErrorCode =
  | EntityErrorCode
  /** Нет имени файла (`?name=`) или оно не годится: `details.path`. */
  | 'INVALID_FILE'
  | 'FILE_EMPTY'
  | 'FILE_NOT_FOUND'
  /** 413: больше MAX_FILE_BYTES; `details.maxBytes`. */
  | 'FILE_TOO_LARGE'
  /** 415: тип по содержимому не из разрешённых (files/sniff.ts). */
  | 'UNSUPPORTED_FILE_TYPE'

type Result<T> = Outcome<T, FilesErrorCode>

/** Файл в ответах API. */
export interface FileView {
  id: string
  name: string
  contentType: string
  size: number
  authorId: string
  authorName: string | null
  createdAt: string
}

type FileRow = Selectable<Database['file']> & { author_name: string | null }

function view(row: FileRow): FileView {
  return {
    id: row.id,
    name: row.name,
    contentType: row.content_type,
    size: Number(row.size),
    authorId: row.author_id,
    authorName: row.author_name,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

function selectFiles(c: Ctx, entity: EntityRef) {
  return c
    .get('db')
    .selectFrom('file')
    .leftJoin('user', 'user.id', 'file.author_id')
    .selectAll('file')
    .select('user.name as author_name')
    .where(ENTITY_COLUMN[entity.type], '=', entity.id)
}

/** Загрузка файла: POST `/v1/<раздел>/<id>/files` — у неё свой предел тела, не общий JSON. */
const UPLOAD_PATH = new RegExp(
  `^/v1/(${ENTITY_TYPES.map((type) => ENTITY_PATH[type]).join('|')})/[^/]+/files/?$`,
)

export function isFileUpload(method: string, path: string): boolean {
  return method === 'POST' && UPLOAD_PATH.test(path)
}

/**
 * Исходное имя без пути: последняя часть после / и \, без управляющих символов. Пустое, «.»,
 * «..» или длиннее 255 — undefined.
 */
export function readFileName(raw: string | undefined): string | undefined {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: управляющие символы и убираются
  const name = (raw?.split(/[/\\]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (name === '' || name === '.' || name === '..' || name.length > MAX_NAME_LENGTH) {
    return undefined
  }
  return name
}

/** Content-Disposition вложения: имя ASCII для старых клиентов и точное — в filename* (RFC 6266). */
export function attachmentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, '_')
  const exact = encodeURIComponent(name).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `attachment; filename="${fallback}"; filename*=UTF-8''${exact}`
}

class TooLarge extends Error {}

/** Тело запроса по кускам; больше `max` байт — TooLarge. `counter.bytes` — сколько прочитано. */
async function* limitedBody(
  body: ReadableStream<Uint8Array>,
  max: number,
  counter: { bytes: number },
): AsyncGenerator<Uint8Array, void, undefined> {
  const reader = body.getReader()
  let finished = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        finished = true
        return
      }
      counter.bytes += value.byteLength
      if (counter.bytes > max) throw new TooLarge()
      yield value
    }
  } finally {
    // Остаток тела не нужен (отказ по типу или размеру): поток закрывается.
    if (!finished) await reader.cancel().catch(() => undefined)
  }
}

function concat(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

const tooLarge = (c: Ctx) =>
  problem(c, 413, 'FILE_TOO_LARGE' satisfies FilesErrorCode, {
    details: { maxBytes: MAX_FILE_BYTES },
  })

async function uploadFile(c: Ctx, type: EntityType, storage: FileStorage): Promise<Response> {
  const name = readFileName(c.req.query('name'))
  if (!name) return fail(c, refuse(400, 'INVALID_FILE', { path: 'name' }))
  const declared = c.req.header('content-length')
  if (declared !== undefined && Number(declared) > MAX_FILE_BYTES) return tooLarge(c)
  // Вход — без блокировки строки сделки: поток тела (до 25 МБ) идёт долго, и FOR SHARE на всё
  // это время держал бы правку, этапы, корзину и слияние сделки (FOR UPDATE).
  const entity = await entityFor(c, type, c.req.param('id') ?? '', 'write', { lock: false })
  if (!entity.ok) return fail(c, entity)
  const body = c.req.raw.body
  if (!body) return fail(c, refuse(422, 'FILE_EMPTY'))

  // Начало файла — в памяти, для определения типа; остальное — потоком в хранилище.
  const counter = { bytes: 0 }
  const chunks = limitedBody(body, MAX_FILE_BYTES, counter)
  const head: Uint8Array[] = []
  let finished = false
  try {
    while (counter.bytes < SNIFF_BYTES) {
      const next = await chunks.next()
      if (next.done) {
        finished = true
        break
      }
      head.push(next.value)
    }
  } catch (error) {
    if (error instanceof TooLarge) return tooLarge(c)
    throw error
  }
  if (counter.bytes === 0) return fail(c, refuse(422, 'FILE_EMPTY'))
  const contentType = detectContentType(concat(head, counter.bytes).subarray(0, SNIFF_BYTES), name)
  if (!contentType) {
    await chunks.return()
    return problem(c, 415, 'UNSUPPORTED_FILE_TYPE' satisfies FilesErrorCode)
  }

  async function* whole(): AsyncGenerator<Uint8Array> {
    yield* head
    if (!finished) yield* chunks
  }
  const id = randomUUID()
  const projectId = c.get('projectId')
  const key = objectKey(projectId, id)
  try {
    await storage.put(key, whole())
  } catch (error) {
    if (error instanceof TooLarge) return tooLarge(c)
    throw error
  }
  // Повторная проверка с блокировкой FOR SHARE до конца транзакции — прямо перед записью строки:
  // за время потока запись могли слить (тикет crm-intake/02), убрать в корзину или вывести из
  // охвата. Слияние, начатое раньше, держит сделку FOR UPDATE — проверка ждёт его и получает
  // 404, файл не остаётся у скрытой сделки.
  const current = await entityFor(c, type, entity.value.id, 'write')
  if (!current.ok) {
    await storage.delete(key)
    return fail(c, current)
  }
  try {
    await c
      .get('db')
      .insertInto('file')
      .values({
        id,
        project_id: projectId,
        ...targetValues(entity.value),
        name,
        content_type: contentType,
        size: counter.bytes,
        storage_key: key,
        author_id: c.get('session').user.id,
      })
      .execute()
  } catch (error) {
    await storage.delete(key)
    throw error
  }
  const row = await selectFiles(c, entity.value).where('file.id', '=', id).executeTakeFirstOrThrow()
  return c.json<FileView>(view(row), 201)
}

async function listFiles(c: Ctx, type: EntityType): Promise<Result<FileView[]>> {
  const limit = readLimit(c.req.query('limit'))
  if (limit === undefined) return refuse(400, 'INVALID_FILE', { path: 'limit' })
  const entity = await entityFor(c, type, c.req.param('id') ?? '', 'read')
  if (!entity.ok) return entity
  const rows = await selectFiles(c, entity.value)
    .orderBy('file.created_at', 'desc')
    .orderBy('file.id', 'desc')
    .limit(limit)
    .execute()
  return ok(rows.map(view))
}

/** Файл видимой записи. */
async function findFile(
  c: Ctx,
  type: EntityType,
): Promise<Result<{ entity: EntityRef; file: FileRow }>> {
  const entity = await entityFor(c, type, c.req.param('id') ?? '', 'read')
  if (!entity.ok) return entity
  const fileId = c.req.param('fileId') ?? ''
  if (!UUID.test(fileId)) return refuse(404, 'FILE_NOT_FOUND')
  const file = await selectFiles(c, entity.value).where('file.id', '=', fileId).executeTakeFirst()
  return file ? ok({ entity: entity.value, file }) : refuse(404, 'FILE_NOT_FOUND')
}

async function downloadFile(c: Ctx, type: EntityType, storage: FileStorage): Promise<Response> {
  const found = await findFile(c, type)
  if (!found.ok) return fail(c, found)
  const { file } = found.value
  const content = await storage.stream(file.storage_key)
  return c.body(content, 200, {
    'Content-Type': file.content_type,
    'Content-Length': String(file.size),
    'Content-Disposition': attachmentDisposition(file.name),
    'X-Content-Type-Options': 'nosniff',
    // Если браузер всё же откроет ответ как страницу — без скриптов и без запросов наружу.
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, no-store',
  })
}

async function deleteFile(c: Ctx, type: EntityType, storage: FileStorage): Promise<Result<null>> {
  // Без блокировки строки (у роли приложения нет UPDATE на file): одновременное второе удаление
  // не найдёт строку, а удаление объекта повторять можно.
  const found = await findFile(c, type)
  if (!found.ok) return found
  const { entity, file } = found.value
  const allowed =
    file.author_id === c.get('session').user.id
      ? entityCan(c, type, 'edit')
      : entityCan(c, type, 'delete')
  if (!allowed) return refuse(403, 'PERMISSION_DENIED')
  const writable = await entityFor(c, type, entity.id, 'write')
  if (!writable.ok) return writable
  await c.get('db').deleteFrom('file').where('id', '=', file.id).execute()
  // shortcut: объект удаляется до фиксации транзакции запроса; если фиксация сорвётся, строка
  // останется без содержимого (скачивание — 500). Перенести удаление на «после фиксации», когда
  // у контекста проекта появится такой крючок (он же нужен уборке объектов при окончательном
  // удалении записи из корзины — эпик эксплуатации).
  await storage.delete(file.storage_key)
  return ok(null)
}

/** Маршруты файлов записи вида `type`; монтируются на путь раздела (`/v1/deals`…). */
export function filesRoutes(type: EntityType, storage: FileStorage) {
  const resource = ENTITY_RESOURCE[type]
  return (
    new Hono<PermissionsEnv>()
      .get('/:id/files', requirePermission(resource, 'view'), async (c) => {
        const outcome = await listFiles(c, type)
        return outcome.ok ? c.json<FileView[]>(outcome.value) : fail(c, outcome)
      })
      .post('/:id/files', requirePermission(resource, 'edit'), (c) => uploadFile(c, type, storage))
      .get('/:id/files/:fileId', requirePermission(resource, 'view'), (c) =>
        downloadFile(c, type, storage),
      )
      // Свой файл удаляется с правом «изменять», чужой — с правом «удалять»: проверка в deleteFile.
      .delete('/:id/files/:fileId', requirePermission(resource, 'view'), async (c) => {
        const outcome = await deleteFile(c, type, storage)
        return outcome.ok ? c.body(null, 204) : fail(c, outcome)
      })
  )
}
