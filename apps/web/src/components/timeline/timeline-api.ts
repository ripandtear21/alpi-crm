import { type Page, readPage } from '@alpi/shared'
import { projectHeaders } from '../project-switcher/projects-api.ts'

// Лента записи (тикет crm-deals/07, экран — тикет 13): `/api/v1/{deals|contacts|organizations}/
// :id/timeline`, заметки `…/notes` и файлы `…/files` той же записи. Клиент не знает, какая это
// запись: вид и id приходят параметрами — ту же ленту показывают карточки контакта и
// организации (тикет 14).

/** Вид записи — сегмент пути API. */
export type TimelineEntity = 'deals' | 'contacts' | 'organizations'

export const TIMELINE_KINDS = ['note', 'file', 'change'] as const
export type TimelineKind = (typeof TIMELINE_KINDS)[number]

/** Наибольший файл — как в API (apps/api/src/files/files.ts, MAX_FILE_BYTES). */
export const MAX_FILE_BYTES = 25 * 1024 * 1024

/** Строка ленты, как её отдаёт API: поля вида — в `change`, `note` или `file`. */
export interface TimelineItem {
  kind: TimelineKind
  id: string
  occurredAt: string
  /** Кто сделал; null — система. */
  actorId: string | null
  actorName: string | null
  change?: { field: string; before: unknown; after: unknown }
  note?: { text: string; updatedAt: string }
  file?: { name: string; contentType: string; size: number }
}

export interface TimelinePage {
  items: TimelineItem[]
  nextCursor: string | null
}

export interface TimelineQuery {
  /** Только эти виды; не задано — все. */
  kinds?: readonly TimelineKind[] | undefined
  cursor?: string | null | undefined
}

/** Отказ API: код ответа и код ошибки из тела. */
export class TimelineApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string) {
    super(`API ответил ${status} ${code}`)
    this.status = status
    this.code = code
  }
}

export interface TimelineApi {
  page(
    projectId: string,
    entity: TimelineEntity,
    id: string,
    query?: TimelineQuery,
  ): Promise<TimelinePage>
  addNote(projectId: string, entity: TimelineEntity, id: string, text: string): Promise<void>
  updateNote(
    projectId: string,
    entity: TimelineEntity,
    id: string,
    noteId: string,
    text: string,
  ): Promise<void>
  deleteNote(projectId: string, entity: TimelineEntity, id: string, noteId: string): Promise<void>
  /** Загрузка: тело запроса — сам файл, имя — в `?name=`. */
  uploadFile(projectId: string, entity: TimelineEntity, id: string, file: File): Promise<void>
  /** Содержимое файла: скачивание идёт с заголовком проекта, поэтому не простой ссылкой. */
  downloadFile(projectId: string, entity: TimelineEntity, id: string, fileId: string): Promise<Blob>
  deleteFile(projectId: string, entity: TimelineEntity, id: string, fileId: string): Promise<void>
}

export function createTimelineApi(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): TimelineApi {
  async function send(
    projectId: string,
    method: string,
    path: string,
    body?: { json: unknown } | { raw: Blob },
  ): Promise<Response> {
    const headers = projectHeaders(projectId)
    let payload: BodyInit | undefined
    if (body && 'json' in body) {
      headers.set('content-type', 'application/json')
      payload = JSON.stringify(body.json)
    } else if (body) {
      headers.set('content-type', 'application/octet-stream')
      payload = body.raw
    }
    const res = await fetchImpl(`/api/v1${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      ...(payload === undefined ? {} : { body: payload }),
    })
    if (!res.ok) {
      const error = (await res.json().catch(() => null)) as { code?: unknown } | null
      throw new TimelineApiError(res.status, typeof error?.code === 'string' ? error.code : '')
    }
    return res
  }

  const base = (entity: TimelineEntity, id: string) => `/${entity}/${encodeURIComponent(id)}`

  return {
    async page(projectId, entity, id, query = {}) {
      const params = new URLSearchParams()
      if (query.kinds && query.kinds.length > 0) params.set('type', query.kinds.join(','))
      if (query.cursor) params.set('cursor', query.cursor)
      const search = params.size > 0 ? `?${params}` : ''
      const res = await send(projectId, 'GET', `${base(entity, id)}/timeline${search}`)
      // Страница `/api/v1` — `{ data, next_cursor }` (тикет crm-api/02).
      return readPage((await res.json()) as Page<TimelineItem>)
    },
    async addNote(projectId, entity, id, text) {
      await send(projectId, 'POST', `${base(entity, id)}/notes`, { json: { text } })
    },
    async updateNote(projectId, entity, id, noteId, text) {
      await send(projectId, 'PUT', `${base(entity, id)}/notes/${noteId}`, { json: { text } })
    },
    async deleteNote(projectId, entity, id, noteId) {
      await send(projectId, 'DELETE', `${base(entity, id)}/notes/${noteId}`)
    },
    async uploadFile(projectId, entity, id, file) {
      const name = encodeURIComponent(file.name)
      await send(projectId, 'POST', `${base(entity, id)}/files?name=${name}`, { raw: file })
    },
    async downloadFile(projectId, entity, id, fileId) {
      const res = await send(projectId, 'GET', `${base(entity, id)}/files/${fileId}`)
      return res.blob()
    },
    async deleteFile(projectId, entity, id, fileId) {
      await send(projectId, 'DELETE', `${base(entity, id)}/files/${fileId}`)
    },
  }
}
