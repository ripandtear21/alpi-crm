import { z } from '@hono/zod-openapi'
import { requirePermission } from '../middleware/permissions.ts'
import {
  IdSchema,
  IsoTimeSchema,
  jsonBody,
  jsonContent,
  keyRoute,
  PageQuerySchema,
  pageSchema,
  pathParams,
} from '../openapi/openapi.ts'
import { ENTITY_RESOURCE, type EntityType } from '../timeline/entity.ts'

// Заметки записи, открытые ключу API (тикет crm-api/04; spec.md эпика, «Заметки по ключу»), в
// описании OpenAPI: список, создание, изменение и удаление своей заметки. Файлы ключу не
// открыты. Те же маршруты обслуживают сессию apps/web (кроме PUT — только сессия). Примеры —
// выдуманные.

/** Наибольшая заметка (как в таблице note). */
export const MAX_NOTE_LENGTH = 20_000

const TAGS = { deal: 'Сделки', contact: 'Контакты', organization: 'Организации' } as const
const RECORD = { deal: 'сделки', contact: 'контакта', organization: 'организации' } as const

const EXAMPLE_IDS = {
  record: '3f6b2c1e-8a4d-4e7f-9b21-5c0d7e9a1b42',
  note: '5c1e7a3b-9d2f-4b6e-8a0c-4e7d1b9f3a26',
  apiKey: '1b8d4f6a-2c9e-4a7b-9e3d-6f0a2c8e4b17',
}

const NOTE_EXAMPLE = {
  id: EXAMPLE_IDS.note,
  text: 'Клієнт просить передзвонити після 18:00.',
  authorId: null,
  authorApiKeyId: EXAMPLE_IDS.apiKey,
  authorName: 'Інтеграція n8n',
  createdAt: '2026-11-04T10:20:00.000Z',
  updatedAt: '2026-11-04T10:20:00.000Z',
}

export const NoteSchema = z
  .object({
    id: IdSchema,
    text: z.string(),
    authorId: z.string().nullable().openapi({ description: 'Автор-пользователь; null — ключ API' }),
    authorApiKeyId: IdSchema.nullable().openapi({ description: 'Автор — ключ API; иначе null' }),
    authorName: z.string().nullable().openapi({
      description: 'Имя пользователя или название ключа API',
    }),
    createdAt: IsoTimeSchema,
    updatedAt: IsoTimeSchema,
  })
  .openapi('Note')

const NoteBody = z.strictObject({ text: z.string().max(MAX_NOTE_LENGTH) })

const RecordParams = pathParams({ id: EXAMPLE_IDS.record })
const NoteParams = pathParams({ id: EXAMPLE_IDS.record, noteId: EXAMPLE_IDS.note })

const noteResponse = (status: 200 | 201, description: string) => ({
  [status]: { description, content: jsonContent(NoteSchema, NOTE_EXAMPLE) },
})

/** Маршруты заметок записи вида `type` для `openapi()`. */
export function noteRoutes(type: EntityType) {
  const resource = ENTITY_RESOURCE[type]
  const tags = [TAGS[type]]
  const record = RECORD[type]
  return {
    list: keyRoute({
      method: 'get',
      path: '/{id}/notes',
      tags,
      summary: `Заметки ${record}`,
      description: 'Новые сверху; курсорная выдача. Запись вне охвата чтения — 404.',
      middleware: [requirePermission(resource, 'view')],
      request: { params: RecordParams, query: PageQuerySchema },
      responses: {
        200: {
          description: 'Страница заметок',
          content: jsonContent(pageSchema(NoteSchema), { data: [NOTE_EXAMPLE], next_cursor: null }),
        },
      },
    }),
    create: keyRoute({
      method: 'post',
      path: '/{id}/notes',
      tags,
      summary: `Добавить заметку ${record}`,
      description:
        'Автор заметки — ключ запроса. Нужно право «изменять» и запись в охвате изменения.',
      middleware: [requirePermission(resource, 'edit')],
      request: { params: RecordParams, ...jsonBody(NoteBody, { text: NOTE_EXAMPLE.text }) },
      responses: noteResponse(201, 'Заметка создана'),
    }),
    update: keyRoute({
      method: 'patch',
      path: '/{id}/notes/{noteId}',
      tags,
      summary: `Изменить заметку ${record}`,
      description: 'Только свою заметку (автор — этот ключ); чужую — 403.',
      middleware: [requirePermission(resource, 'edit')],
      request: { params: NoteParams, ...jsonBody(NoteBody, { text: 'Передзвонити завтра.' }) },
      responses: noteResponse(200, 'Заметка после изменения'),
    }),
    remove: keyRoute({
      method: 'delete',
      path: '/{id}/notes/{noteId}',
      tags,
      summary: `Удалить заметку ${record}`,
      description:
        'Только свою заметку (автор — этот ключ), с правом «изменять» запись; чужую — 403.',
      middleware: [requirePermission(resource, 'view')],
      request: { params: NoteParams },
      responses: { 204: { description: 'Заметка удалена' } },
    }),
  }
}
