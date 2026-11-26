import { z } from '@hono/zod-openapi'
import { requirePermission } from '../middleware/permissions.ts'
import { IdSchema, IsoTimeSchema, jsonContent, keyRoute, pathParams } from '../openapi/openapi.ts'

// Справочники сделок, открытые ключу API только для чтения (тикет crm-api/04): воронки с
// этапами, этапы воронки, причины проигрыша. Право — «сделки: смотреть». Справочник отдаётся
// целиком, массивом, как его читает apps/web (решено без владельца — подтвердить): он короткий,
// курсор ему не нужен. Изменение справочников ключу не открыто. Примеры — выдуманные.

const EXAMPLE_IDS = {
  pipeline: '0c9e5a7b-2d14-4f63-8e8a-1b7c3d5f9a20',
  stage: '6a1d4f2e-9b3c-4d8a-a7e5-2f0b8c6d4e13',
  nextStage: '9d2e7b4a-1c6f-4a3e-b8d5-7e0f2a9c6b31',
  group: '1e5b9d3f-7a2c-4e8b-9c6d-0f4a8e2b6d71',
  reason: '4d0a8e2c-7b5f-4c1d-8e9a-6f3b1c7d2e58',
}

const STAGES_EXAMPLE = [
  { id: EXAMPLE_IDS.stage, pipelineId: EXAMPLE_IDS.pipeline, name: 'Нова заявка', position: 1 },
  { id: EXAMPLE_IDS.nextStage, pipelineId: EXAMPLE_IDS.pipeline, name: 'Дзвінок', position: 2 },
]

const StageSchema = z
  .object({
    id: IdSchema,
    pipelineId: IdSchema,
    name: z.string(),
    position: z.number().int().openapi({ description: 'Порядок в воронке: 1, 2, 3…' }),
  })
  .openapi('Stage')

const PipelineSchema = z
  .object({
    id: IdSchema,
    code: z.string(),
    name: z.string(),
    position: z.number().int(),
    isUpsell: z.boolean().openapi({ description: '«Воронка допродаж»' }),
    archivedAt: IsoTimeSchema.nullable().openapi({ description: 'null — воронка действует' }),
    stages: z.array(StageSchema),
  })
  .openapi('Pipeline')

const LostReasonSchema = z
  .object({
    id: IdSchema,
    groupId: IdSchema,
    name: z.string(),
    position: z.number().int(),
    archivedAt: IsoTimeSchema.nullable().openapi({
      description: 'Архивная причина не принимается при проигрыше; null — действует',
    }),
  })
  .openapi('LostReason')

const LostReasonGroupSchema = z
  .object({
    id: IdSchema,
    name: z.string(),
    position: z.number().int(),
    archivedAt: IsoTimeSchema.nullable(),
    reasons: z.array(LostReasonSchema),
  })
  .openapi('LostReasonGroup')

const view = requirePermission('deals', 'view')

export const listPipelinesRoute = keyRoute({
  method: 'get',
  path: '/',
  tags: ['Справочники'],
  summary: 'Воронки с этапами',
  description: 'Все воронки проекта (и архивные — с `archivedAt`) с этапами по порядку.',
  middleware: [view],
  responses: {
    200: {
      description: 'Воронки',
      content: jsonContent(z.array(PipelineSchema), [
        {
          id: EXAMPLE_IDS.pipeline,
          code: 'english',
          name: 'Англійська',
          position: 1,
          isUpsell: false,
          archivedAt: null,
          stages: STAGES_EXAMPLE,
        },
      ]),
    },
  },
})

export const listStagesRoute = keyRoute({
  method: 'get',
  path: '/{id}/stages',
  tags: ['Справочники'],
  summary: 'Этапы воронки',
  description: 'Действующие этапы воронки по порядку. Воронки нет в проекте — 404.',
  middleware: [view],
  request: { params: pathParams({ id: EXAMPLE_IDS.pipeline }) },
  responses: {
    200: { description: 'Этапы', content: jsonContent(z.array(StageSchema), STAGES_EXAMPLE) },
  },
})

export const listLostReasonsRoute = keyRoute({
  method: 'get',
  path: '/',
  tags: ['Справочники'],
  summary: 'Причины проигрыша',
  description: 'Группы причин с причинами по порядку; архивные — с `archivedAt`.',
  middleware: [view],
  responses: {
    200: {
      description: 'Группы причин',
      content: jsonContent(z.array(LostReasonGroupSchema), [
        {
          id: EXAMPLE_IDS.group,
          name: 'Ціна',
          position: 1,
          archivedAt: null,
          reasons: [
            {
              id: EXAMPLE_IDS.reason,
              groupId: EXAMPLE_IDS.group,
              name: 'Дорого',
              position: 1,
              archivedAt: null,
            },
          ],
        },
      ]),
    },
  },
})
