import type { Database } from '@alpi/db'
import { Hono } from 'hono'
import type { Selectable } from 'kysely'
import {
  type Ctx,
  fail,
  type Outcome,
  ok,
  readBody,
  readLimit,
  refuse,
  UUID,
} from '../contacts/http.ts'
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

// Заметки к сделке, контакту или организации (тикет crm-deals/07): `/v1/{deals|contacts|
// organizations}/:id/notes`. Читает тот, кто видит запись; добавляет — кто может её менять.
// Заметку меняет и удаляет её автор (с правом «изменять» запись); чужую удаляет пользователь с
// правом «удалять» эту часть системы (решено без владельца — подтвердить). Всё — в охвате
// изменения записи.

/** Наибольшая заметка (как в таблице note). */
export const MAX_NOTE_LENGTH = 20_000

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
  authorId: string
  authorName: string | null
  createdAt: string
  updatedAt: string
}

type NoteRow = Selectable<Database['note']> & { author_name: string | null }

const iso = (value: Date | string) => new Date(value).toISOString()

function view(row: NoteRow): NoteView {
  return {
    id: row.id,
    text: row.text,
    authorId: row.author_id,
    authorName: row.author_name,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

/** Заметки записи с именем автора; `noteId` — одна заметка. */
function selectNotes(c: Ctx, entity: EntityRef) {
  return c
    .get('db')
    .selectFrom('note')
    .leftJoin('user', 'user.id', 'note.author_id')
    .selectAll('note')
    .select('user.name as author_name')
    .where(ENTITY_COLUMN[entity.type], '=', entity.id)
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

async function listNotes(c: Ctx, type: EntityType): Promise<Result<NoteView[]>> {
  const limit = readLimit(c.req.query('limit'))
  if (limit === undefined) return refuse(400, 'INVALID_NOTE', { path: 'limit' })
  const entity = await entityFor(c, type, c.req.param('id') ?? '', 'read')
  if (!entity.ok) return entity
  const rows = await selectNotes(c, entity.value)
    .orderBy('note.created_at', 'desc')
    .orderBy('note.id', 'desc')
    .limit(limit)
    .execute()
  return ok(rows.map(view))
}

async function createNote(c: Ctx, type: EntityType): Promise<Result<NoteView>> {
  const text = await readText(c)
  if (!text.ok) return text
  const entity = await entityFor(c, type, c.req.param('id') ?? '', 'write')
  if (!entity.ok) return entity
  const { id } = await c
    .get('db')
    .insertInto('note')
    .values({
      project_id: c.get('projectId'),
      ...targetValues(entity.value),
      text: text.value,
      author_id: c.get('session').user.id,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return ok(
    view(await selectNotes(c, entity.value).where('note.id', '=', id).executeTakeFirstOrThrow()),
  )
}

/**
 * Заметка записи, которую пользователь может менять (`action: 'edit'` — только автор) или
 * удалять (`'delete'` — автор или право «удалять»). Строка блокируется до конца транзакции.
 */
async function ownNote(
  c: Ctx,
  type: EntityType,
  action: 'edit' | 'delete',
): Promise<Result<{ entity: EntityRef; note: NoteRow }>> {
  const entity = await entityFor(c, type, c.req.param('id') ?? '', 'read')
  if (!entity.ok) return entity
  const noteId = c.req.param('noteId') ?? ''
  const note = UUID.test(noteId)
    ? await selectNotes(c, entity.value)
        .where('note.id', '=', noteId)
        .forUpdate('note')
        .executeTakeFirst()
    : undefined
  if (!note) return refuse(404, 'NOTE_NOT_FOUND')
  const allowed =
    note.author_id === c.get('session').user.id
      ? entityCan(c, type, 'edit')
      : action === 'delete' && entityCan(c, type, 'delete')
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
  const respond = <T>(c: Ctx, outcome: Result<T>, status: 200 | 201 = 200) =>
    outcome.ok ? c.json(outcome.value as object, status) : fail(c, outcome)
  return (
    new Hono<PermissionsEnv>()
      .get('/:id/notes', requirePermission(resource, 'view'), async (c) =>
        respond(c, await listNotes(c, type)),
      )
      .post('/:id/notes', requirePermission(resource, 'edit'), async (c) =>
        respond(c, await createNote(c, type), 201),
      )
      .put('/:id/notes/:noteId', requirePermission(resource, 'edit'), async (c) =>
        respond(c, await updateNote(c, type)),
      )
      // Своя заметка удаляется с правом «изменять», чужая — с правом «удалять»: проверка в ownNote.
      .delete('/:id/notes/:noteId', requirePermission(resource, 'view'), async (c) => {
        const outcome = await deleteNote(c, type)
        return outcome.ok ? c.body(null, 204) : fail(c, outcome)
      })
  )
}
