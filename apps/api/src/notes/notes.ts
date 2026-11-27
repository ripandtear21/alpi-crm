import type { Database } from '@alpi/db'
import type { Page } from '@alpi/shared'
import { OpenAPIHono } from '@hono/zod-openapi'
import { type Selectable, sql } from 'kysely'
import {
  type Ctx,
  fail,
  type Outcome,
  ok,
  readBody,
  readLimit,
  refusalHook,
  refuse,
  typed,
  UUID,
} from '../contacts/http.ts'
import { decodePageCursor, encodePageCursor, isoMicros } from '../filters/page.ts'
import { type PermissionsEnv, requirePermission } from '../middleware/permissions.ts'
import {
  ENTITY_COLUMN,
  ENTITY_RESOURCE,
  type EntityErrorCode,
  type EntityRef,
  type EntityType,
  entityCan,
  entityFor,
  targetValues,
} from '../timeline/entity.ts'
import { MAX_NOTE_LENGTH, noteRoutes } from './openapi.ts'

// Заметки к сделке, контакту или организации (тикет crm-deals/07): `/v1/{deals|contacts|
// organizations}/:id/notes`. Читает тот, кто видит запись; добавляет — кто может её менять.
// Заметку меняет и удаляет её автор (с правом «изменять» запись); чужую удаляет пользователь с
// правом «удалять» эту часть системы (решено без владельца — подтвердить). Всё — в охвате
// изменения записи.
//
// Ключ API (тикет crm-api/04): список, создание, PATCH и удаление (notes/openapi.ts). Автор
// заметки ключа — сам ключ (note.author_api_key_id), имя автора — название ключа. Менять и
// удалять ключ может только свою заметку, чужую — нет даже с правом «удалять» (решено без
// владельца — подтвердить). PUT — только сессия (apps/web).

export { MAX_NOTE_LENGTH }

export type NotesErrorCode =
  | EntityErrorCode
  /** Тело запроса не той формы: `details.path` — какое поле. */
  | 'INVALID_NOTE'
  | 'NOTE_NOT_FOUND'

type Result<T> = Outcome<T, NotesErrorCode>

/** Заметка в ответах API. */
export interface NoteView {
  id: string
  text: string
  /** Автор-пользователь; null — автор ключ API. */
  authorId: string | null
  /** Автор — ключ API (тикет crm-api/04); иначе null. */
  authorApiKeyId: string | null
  /** Имя пользователя или название ключа. */
  authorName: string | null
  createdAt: string
  updatedAt: string
}

type NoteRow = Selectable<Database['note']> & { author_name: string | null; cursor_at: string }

/** Сортировка заметок в курсоре (filters/page.ts): новые сверху. */
const NOTES_SORT = 'createdAt:desc'

const iso = (value: Date | string) => new Date(value).toISOString()

function view(row: NoteRow): NoteView {
  return {
    id: row.id,
    text: row.text,
    authorId: row.author_id,
    authorApiKeyId: row.author_api_key_id,
    authorName: row.author_name,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

/** Заметки записи с именем автора (пользователя или ключа); `noteId` — одна заметка. */
function selectNotes(c: Ctx, entity: EntityRef) {
  return c
    .get('db')
    .selectFrom('note')
    .leftJoin('user', 'user.id', 'note.author_id')
    .leftJoin('api_key', 'api_key.id', 'note.author_api_key_id')
    .selectAll('note')
    .select(sql<string | null>`coalesce("user".name, api_key.name)`.as('author_name'))
    .select(isoMicros('note.created_at').as('cursor_at'))
    .where(ENTITY_COLUMN[entity.type], '=', entity.id)
}

/** Автор запроса — автор заметки `note`: тот же пользователь или тот же ключ. */
function ownedBy(c: Ctx, note: NoteRow): boolean {
  const actor = c.get('actor')
  return actor.type === 'user'
    ? note.author_id === actor.userId
    : note.author_api_key_id === actor.apiKeyId
}

async function readText(c: Ctx): Promise<Result<string>> {
  const body = await readBody(c)
  if (!body) return refuse(400, 'INVALID_NOTE', { path: '' })
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (text === '' || text.length > MAX_NOTE_LENGTH) {
    return refuse(400, 'INVALID_NOTE', { path: 'text' })
  }
  return ok(text)
}

/** Заметки записи: новые сверху, курсорная выдача `/api/v1` (`?limit=`, `?cursor=`). */
async function listNotes(c: Ctx, type: EntityType): Promise<Result<Page<NoteView>>> {
  const limit = readLimit(c.req.query('limit'))
  if (limit === undefined) return refuse(400, 'INVALID_NOTE', { path: 'limit' })
  const rawCursor = c.req.query('cursor')
  const cursor =
    rawCursor === undefined ? undefined : decodePageCursor(rawCursor, NOTES_SORT, 'timestamptz')
  if (rawCursor !== undefined && !cursor) return refuse(400, 'INVALID_NOTE', { path: 'cursor' })
  const entity = await entityFor(c, type, c.req.param('id') ?? '', 'read')
  if (!entity.ok) return entity
  let query = selectNotes(c, entity.value)
    .orderBy('note.created_at', 'desc')
    .orderBy('note.id', 'desc')
    .limit(limit + 1)
  if (cursor) {
    query = query.where(
      sql<boolean>`(note.created_at, note.id) < (${cursor.v}::timestamptz, ${cursor.id}::uuid)`,
    )
  }
  const rows = await query.execute()
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return ok({
    data: page.map(view),
    next_cursor:
      rows.length > limit && last
        ? encodePageCursor(NOTES_SORT, { v: last.cursor_at, id: last.id })
        : null,
  })
}

async function createNote(c: Ctx, type: EntityType): Promise<Result<NoteView>> {
  const text = await readText(c)
  if (!text.ok) return text
  const entity = await entityFor(c, type, c.req.param('id') ?? '', 'write')
  if (!entity.ok) return entity
  const actor = c.get('actor')
  const { id } = await c
    .get('db')
    .insertInto('note')
    .values({
      project_id: c.get('projectId'),
      ...targetValues(entity.value),
      text: text.value,
      ...(actor.type === 'user'
        ? { author_id: actor.userId }
        : { author_id: null, author_api_key_id: actor.apiKeyId }),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return ok(
    view(await selectNotes(c, entity.value).where('note.id', '=', id).executeTakeFirstOrThrow()),
  )
}

/**
 * Заметка записи, которую автор запроса может менять (`action: 'edit'` — только автор) или
 * удалять (`'delete'` — автор или пользователь с правом «удалять»; ключ — только свою). Строка
 * блокируется до конца транзакции.
 */
async function ownNote(
  c: Ctx,
  type: EntityType,
  action: 'edit' | 'delete',
): Promise<Result<{ entity: EntityRef; note: NoteRow }>> {
  // Строка записи (FOR SHARE) — до строки заметки (тикет crm-intake/12): слияние контактов и
  // сделок держит записи FOR UPDATE и потом переносит их заметки; порядок «заметка, потом
  // запись» сцепился бы с ним (40P01).
  const entity = await entityFor(c, type, c.req.param('id') ?? '', 'read', { lock: true })
  if (!entity.ok) return entity
  const noteId = c.req.param('noteId') ?? ''
  const note = UUID.test(noteId)
    ? await selectNotes(c, entity.value)
        .where('note.id', '=', noteId)
        .forUpdate('note')
        .executeTakeFirst()
    : undefined
  if (!note) return refuse(404, 'NOTE_NOT_FOUND')
  const allowed = ownedBy(c, note)
    ? entityCan(c, type, 'edit')
    : action === 'delete' && c.get('actor').type === 'user' && entityCan(c, type, 'delete')
  if (!allowed) {
    return refuse(403, 'PERMISSION_DENIED')
  }
  const writable = await entityFor(c, type, entity.value.id, 'write')
  if (!writable.ok) return writable
  return ok({ entity: entity.value, note })
}

async function updateNote(c: Ctx, type: EntityType): Promise<Result<NoteView>> {
  const text = await readText(c)
  if (!text.ok) return text
  const found = await ownNote(c, type, 'edit')
  if (!found.ok) return found
  const { entity, note } = found.value
  await c
    .get('db')
    .updateTable('note')
    .set({ text: text.value, updated_at: new Date() })
    .where('id', '=', note.id)
    .execute()
  return ok(
    view(await selectNotes(c, entity).where('note.id', '=', note.id).executeTakeFirstOrThrow()),
  )
}

async function deleteNote(c: Ctx, type: EntityType): Promise<Result<null>> {
  const found = await ownNote(c, type, 'delete')
  if (!found.ok) return found
  await c.get('db').deleteFrom('note').where('id', '=', found.value.note.id).execute()
  return ok(null)
}

/** Маршруты заметок записи вида `type`; монтируются на путь раздела (`/v1/deals`…). */
export function notesRoutes(type: EntityType) {
  const resource = ENTITY_RESOURCE[type]
  const routes = noteRoutes(type)
  const hook = refusalHook('INVALID_NOTE')
  const respond = <T>(c: Ctx, outcome: Result<T>, status: 200 | 201 = 200) =>
    typed(outcome.ok ? c.json(outcome.value as object, status) : fail(c, outcome))
  const app = new OpenAPIHono<PermissionsEnv>()
  app.openapi(routes.list, async (c) => respond(c, await listNotes(c, type)), hook)
  app.openapi(routes.create, async (c) => respond(c, await createNote(c, type), 201), hook)
  app.openapi(routes.update, async (c) => respond(c, await updateNote(c, type)), hook)
  // Своя заметка удаляется с правом «изменять», чужая — с правом «удалять»: проверка в ownNote.
  app.openapi(
    routes.remove,
    async (c) => {
      const outcome = await deleteNote(c, type)
      return typed(outcome.ok ? c.body(null, 204) : fail(c, outcome))
    },
    hook,
  )
  // Карточка записи apps/web — PUT с теми же правилами, что PATCH; ключу закрыт.
  return app.put('/:id/notes/:noteId', requirePermission(resource, 'edit'), async (c) =>
    respond(c, await updateNote(c, type)),
  )
}
