import type { Database } from '@alpi/db'
import { KANBAN_CARD_FIELDS_LIMIT, type KanbanCardFields } from '@alpi/shared'
import { type Kysely, sql } from 'kysely'
import { recordInRequest } from '../audit/record.ts'
import { fieldVisible } from '../fields/access.ts'
import { type Ctx, fail, invalid, readBody, UUID } from './directory.ts'

// Поля на карточке канбана (тикет crm-fields/07): до 3 полей сделки на воронку, выбирает
// администратор в настройках воронки (для каждой воронки отдельно — решено без владельца,
// подтвердить). `GET /v1/pipelines/:id/card-fields` — право «сделки: смотреть»;
// `PUT /v1/pipelines/:id/card-fields` `{ fieldIds: [...] }` — право «воронки и этапы»: заменяет
// выбор целиком, порядок — порядок на карточке. Четвёртое поле — 422 TOO_MANY_CARD_FIELDS (и база
// не примет: позиция 1…3, migrations/0018_field_filters.ts); поле не сделки, в архиве, не
// видное в этой воронке или скрытое от роли — 422 CUSTOM_FIELD_UNKNOWN.
// Каждый показ берёт только действующие поля, видимые в воронке, из групп, не скрытых от роли
// смотрящего: поле, ушедшее в архив или из воронки, пропадает с карточки само.

/** Поле карточки: id, код (ключ значения в `custom`) и группа (доступ роли). */
export interface CardField {
  id: string
  code: string
  groupId: string
}

/** Поля карточки воронки `pipelineId` по порядку: действующие и видимые в воронке. */
export async function loadCardFields(
  db: Kysely<Database>,
  pipelineId: string,
): Promise<CardField[]> {
  const rows = await db
    .selectFrom('pipeline_card_field as c')
    .innerJoin('field_definition as f', 'f.id', 'c.field_id')
    .select(['f.id', 'f.code', 'f.group_id'])
    .where('c.pipeline_id', '=', pipelineId)
    .where('f.entity', '=', 'deal')
    .where('f.archived_at', 'is', null)
    .where('f.purge_requested_at', 'is', null)
    .where((eb) =>
      eb.or([
        eb('f.pipeline_visibility', '=', 'all'),
        eb.exists(
          eb
            .selectFrom('field_pipeline as p')
            .select('p.field_id')
            .whereRef('p.field_id', '=', 'f.id')
            .where('p.pipeline_id', '=', pipelineId),
        ),
      ]),
    )
    .orderBy('c.position')
    .execute()
  return rows.map((row) => ({ id: row.id, code: row.code, groupId: row.group_id }))
}

/** Поля карточки, которые видит роль того, кто спрашивает. */
async function visibleCardFields(c: Ctx, pipelineId: string): Promise<CardField[]> {
  const { permissions } = c.get('access')
  const fields = await loadCardFields(c.get('db'), pipelineId)
  return fields.filter((f) => fieldVisible(permissions, { groupId: f.groupId, entity: 'deal' }))
}

async function findPipeline(c: Ctx, lock: boolean) {
  const id = c.req.param('id') ?? ''
  if (!UUID.test(id)) return undefined
  const query = c.get('db').selectFrom('pipeline').select(['id', 'name']).where('id', '=', id)
  return (lock ? query.forUpdate() : query).executeTakeFirst()
}

export async function getCardFields(c: Ctx) {
  const pipeline = await findPipeline(c, false)
  if (!pipeline) return fail(c, 404, 'NOT_FOUND')
  const fields = await visibleCardFields(c, pipeline.id)
  return c.json<KanbanCardFields>({ fieldIds: fields.map((f) => f.id) })
}

export async function putCardFields(c: Ctx) {
  const body = await readBody(c)
  const raw = body?.fieldIds
  if (!body || Object.keys(body).some((key) => key !== 'fieldIds') || !Array.isArray(raw)) {
    return invalid(c, 'fieldIds')
  }
  if (!raw.every((id): id is string => typeof id === 'string' && UUID.test(id))) {
    return invalid(c, 'fieldIds')
  }
  const ids = raw.map((id) => id.toLowerCase())
  if (new Set(ids).size !== ids.length) return invalid(c, 'fieldIds')
  if (ids.length > KANBAN_CARD_FIELDS_LIMIT) {
    return c.json(
      { code: 'TOO_MANY_CARD_FIELDS', details: { limit: KANBAN_CARD_FIELDS_LIMIT } },
      422,
    )
  }
  const pipeline = await findPipeline(c, true)
  if (!pipeline) return fail(c, 404, 'NOT_FOUND')
  const db = c.get('db')
  const { permissions } = c.get('access')

  const fields =
    ids.length === 0
      ? []
      : await db
          .selectFrom('field_definition as f')
          .select(['f.id', 'f.group_id'])
          .where('f.id', 'in', ids)
          .where('f.entity', '=', 'deal')
          .where('f.archived_at', 'is', null)
          .where('f.purge_requested_at', 'is', null)
          .where((eb) =>
            eb.or([
              eb('f.pipeline_visibility', '=', 'all'),
              eb.exists(
                eb
                  .selectFrom('field_pipeline as p')
                  .select('p.field_id')
                  .whereRef('p.field_id', '=', 'f.id')
                  .where('p.pipeline_id', '=', pipeline.id),
              ),
            ]),
          )
          .forKeyShare()
          .execute()
  for (const id of ids) {
    const field = fields.find((f) => f.id === id)
    if (!field || !fieldVisible(permissions, { groupId: field.group_id, entity: 'deal' })) {
      return c.json({ code: 'CUSTOM_FIELD_UNKNOWN', details: { field: id } }, 422)
    }
  }

  const before = (
    await db
      .selectFrom('pipeline_card_field')
      .select('field_id')
      .where('pipeline_id', '=', pipeline.id)
      .orderBy('position')
      .execute()
  ).map((row) => row.field_id)
  if (before.join() !== ids.join()) {
    await db.deleteFrom('pipeline_card_field').where('pipeline_id', '=', pipeline.id).execute()
    if (ids.length > 0) {
      await db
        .insertInto('pipeline_card_field')
        .values(
          ids.map((fieldId, index) => ({
            project_id: c.get('projectId'),
            pipeline_id: pipeline.id,
            field_id: fieldId,
            position: index + 1,
          })),
        )
        .execute()
    }
    await db
      .updateTable('pipeline')
      .set({ updated_at: sql`now()` })
      .where('id', '=', pipeline.id)
      .execute()
    await recordInRequest(c, {
      action: 'pipeline.updated',
      entity: { type: 'pipeline', id: pipeline.id },
      details: { name: pipeline.name, before: { cardFields: before }, after: { cardFields: ids } },
    })
  }
  return c.json<KanbanCardFields>({
    fieldIds: (await visibleCardFields(c, pipeline.id)).map((f) => f.id),
  })
}
