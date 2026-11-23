import {
  type TimelineApi,
  TimelineApiError,
  type TimelineEntity,
  type TimelineItem,
} from './timeline-api.ts'

// Подставной клиент ленты для тестов: строки в памяти, новые сверху, как отдаёт API. Заметки и
// файлы, добавленные через клиент, появляются в ленте от имени `actor`. `uploads` — загруженные
// файлы (для проверки, что большой файл до API не дошёл).

export interface FakeTimelineApi extends TimelineApi {
  items: TimelineItem[]
  uploads: File[]
  /** Кто «пишет» новые заметки и файлы. */
  actor: { id: string; name: string }
}

let counter = 0
function fakeId(): string {
  counter += 1
  return `00000000-0000-4000-9300-${String(counter).padStart(12, '0')}`
}

/** Время, которое позже всех строк ленты: новая строка встаёт сверху. */
function nextTime(items: TimelineItem[]): string {
  const latest = Math.max(0, ...items.map((item) => Date.parse(item.occurredAt)))
  return new Date(Math.max(Date.now(), latest + 1000)).toISOString()
}

export function fakeTimelineApi(items: TimelineItem[] = []): FakeTimelineApi {
  function sorted(): TimelineItem[] {
    return [...api.items].sort(
      (a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || b.id.localeCompare(a.id),
    )
  }
  function note(noteId: string): TimelineItem {
    const found = api.items.find((item) => item.kind === 'note' && item.id === noteId)
    if (!found) throw new TimelineApiError(404, 'NOTE_NOT_FOUND')
    return found
  }

  const api: FakeTimelineApi = {
    items: structuredClone(items),
    uploads: [],
    actor: { id: 'user-1', name: 'Власник' },
    async page(_projectId, _entity: TimelineEntity, _id, query = {}) {
      const kinds = query.kinds && query.kinds.length > 0 ? query.kinds : null
      const list = sorted().filter((item) => !kinds || kinds.includes(item.kind))
      return { items: structuredClone(list), nextCursor: null }
    },
    async addNote(_projectId, _entity, _id, text) {
      const at = nextTime(api.items)
      api.items.push({
        kind: 'note',
        id: fakeId(),
        occurredAt: at,
        actorId: api.actor.id,
        actorName: api.actor.name,
        note: { text, updatedAt: at },
      })
    },
    async updateNote(_projectId, _entity, _id, noteId, text) {
      const found = note(noteId)
      found.note = { text, updatedAt: new Date().toISOString() }
    },
    async deleteNote(_projectId, _entity, _id, noteId) {
      note(noteId)
      api.items = api.items.filter((item) => item.id !== noteId)
    },
    async uploadFile(_projectId, _entity, _id, file) {
      api.uploads.push(file)
      api.items.push({
        kind: 'file',
        id: fakeId(),
        occurredAt: nextTime(api.items),
        actorId: api.actor.id,
        actorName: api.actor.name,
        file: { name: file.name, contentType: file.type, size: file.size },
      })
    },
    async downloadFile() {
      return new Blob(['file'])
    },
    async deleteFile(_projectId, _entity, _id, fileId) {
      api.items = api.items.filter((item) => item.id !== fileId)
    },
  }
  return api
}
