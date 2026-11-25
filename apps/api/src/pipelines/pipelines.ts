import type { Database } from '@alpi/db'
import { PIPELINE_CODE, type PipelineSummary, type StageSummary } from '@alpi/shared'
import { Hono } from 'hono'
import { type Kysely, sql } from 'kysely'
import { recordInRequest } from '../audit/record.ts'
import { moveRulesOffStage } from '../fields/stage-rules.ts'
import { type PermissionsEnv, requirePermission } from '../middleware/permissions.ts'
import { inSavepoint } from '../roles/roles.ts'
import { getCardFields, putCardFields } from './card-fields.ts'
import {
  type Ctx,
  fail,
  invalid,
  isoOrNull,
  readBody,
  readIds,
  readName,
  reorder,
  UUID,
  uniqueRefusal,
} from './directory.ts'
import type { StageDealsChecker } from './stage-deals.ts'

// Воронки и этапы проекта (тикет crm-deals/02): `/api/v1/pipelines`. Читает каждый с правом
// «сделки: смотреть» (канбан и карточка сделки показывают воронки и этапы); меняет — право
// «воронки и этапы». Охвата у воронок нет: это настройки проекта, а не записи с ответственным.
// Код воронки уникален в проекте, «воронка допродаж» — не больше одной: это держит база
// (migrations/0008_pipelines.ts). Каждое изменение пишется в журнал проекта той же транзакцией.
// Ни один запрос не трогает сделки (ADR 0003): архив воронки и удаление этапа меняют только
// отметку; удаление этапа ещё переводит правила обязательности полей на следующий этап
// (fields/stage-rules.ts). Поля карточки канбана воронки — card-fields.ts (тикет crm-fields/07).

interface PipelineRow {
  id: string
  code: string
  name: string
  position: number
  is_upsell: boolean
  archived_at: Date | string | null
}

interface StageRow {
  id: string
  pipeline_id: string
  name: string
  position: number
}

function stageSummary(row: StageRow): StageSummary {
  return { id: row.id, pipelineId: row.pipeline_id, name: row.name, position: row.position }
}

/** Действующие (не удалённые) этапы воронок `pipelineIds` по порядку. */
async function liveStages(db: Kysely<Database>, pipelineIds: string[]): Promise<StageRow[]> {
  if (pipelineIds.length === 0) return []
  return db
    .selectFrom('stage')
    .select(['id', 'pipeline_id', 'name', 'position'])
    .where('pipeline_id', 'in', pipelineIds)
    .where('deleted_at', 'is', null)
    .orderBy('position')
    .orderBy('created_at')
    .orderBy('id')
    .execute()
}

/** Воронки проекта (или одна — `pipelineId`) с действующими этапами, по порядку. */
export async function listPipelines(
  db: Kysely<Database>,
  pipelineId?: string,
): Promise<PipelineSummary[]> {
  let query = db
    .selectFrom('pipeline')
    .select(['id', 'code', 'name', 'position', 'is_upsell', 'archived_at'])
    .orderBy('position')
    .orderBy('created_at')
    .orderBy('id')
  if (pipelineId !== undefined) query = query.where('id', '=', pipelineId)
  const pipelines: PipelineRow[] = await query.execute()
  const stages = await liveStages(
    db,
    pipelines.map((p) => p.id),
  )
  return pipelines.map((p) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    position: p.position,
    isUpsell: p.is_upsell,
    archivedAt: isoOrNull(p.archived_at),
    stages: stages.filter((s) => s.pipeline_id === p.id).map(stageSummary),
  }))
}

async function pipelineSummary(db: Kysely<Database>, id: string): Promise<PipelineSummary> {
  const [pipeline] = await listPipelines(db, id)
  if (!pipeline) throw new Error('воронка пропала в той же транзакции')
  return pipeline
}

/** Воронка текущего проекта, заблокированная до конца транзакции; undefined — нет такой. */
async function lockPipeline(db: Kysely<Database>, id: string): Promise<PipelineRow | undefined> {
  if (!UUID.test(id)) return undefined
  return db
    .selectFrom('pipeline')
    .select(['id', 'code', 'name', 'position', 'is_upsell', 'archived_at'])
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
}

/** Действующий этап воронки, заблокированный до конца транзакции. */
async function lockStage(
  db: Kysely<Database>,
  pipelineId: string,
  stageId: string,
): Promise<StageRow | undefined> {
  if (!UUID.test(stageId)) return undefined
  return db
    .selectFrom('stage')
    .select(['id', 'pipeline_id', 'name', 'position'])
    .where('id', '=', stageId)
    .where('pipeline_id', '=', pipelineId)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst()
}

async function nextPosition(
  db: Kysely<Database>,
  table: 'pipeline' | 'stage',
  pipelineId?: string,
): Promise<number> {
  let query = db.selectFrom(table).select((eb) => eb.fn.max('position').as('max'))
  if (table === 'stage' && pipelineId !== undefined) {
    query = query.where('pipeline_id', '=', pipelineId)
  }
  const row = await query.executeTakeFirst()
  return Number(row?.max ?? 0) + 1
}

function readCode(value: unknown): string | null {
  return typeof value === 'string' && PIPELINE_CODE.test(value) ? value : null
}

interface PipelineChange {
  name?: string
  code?: string
  isUpsell?: boolean
  archived?: boolean
}

/** Изменение воронки из тела; строка — какое поле неверно. */
function readPipelineChange(body: Record<string, unknown>): PipelineChange | string {
  const change: PipelineChange = {}
  if (body.name !== undefined) {
    const name = readName(body.name)
    if (!name) return 'name'
    change.name = name
  }
  if (body.code !== undefined) {
    const code = readCode(body.code)
    if (!code) return 'code'
    change.code = code
  }
  if (body.isUpsell !== undefined) {
    if (typeof body.isUpsell !== 'boolean') return 'isUpsell'
    change.isUpsell = body.isUpsell
  }
  if (body.archived !== undefined) {
    if (typeof body.archived !== 'boolean') return 'archived'
    change.archived = body.archived
  }
  return Object.keys(change).length === 0 ? '' : change
}

async function createPipeline(c: Ctx) {
  const body = await readBody(c)
  const name = readName(body?.name)
  if (!name) return invalid(c, 'name')
  const code = readCode(body?.code)
  if (!code) return invalid(c, 'code')
  if (body?.isUpsell !== undefined && typeof body.isUpsell !== 'boolean') {
    return invalid(c, 'isUpsell')
  }
  const isUpsell = body?.isUpsell === true
  const db = c.get('db')
  let id: string
  try {
    id = await inSavepoint(db, async () => {
      const row = await db
        .insertInto('pipeline')
        .values({
          project_id: c.get('projectId'),
          code,
          name,
          is_upsell: isUpsell,
          position: await nextPosition(db, 'pipeline'),
          created_by: c.get('session').user.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      return row.id
    })
  } catch (error) {
    const code = uniqueRefusal(error)
    if (code) return fail(c, 409, code)
    throw error
  }
  await recordInRequest(c, {
    action: 'pipeline.created',
    entity: { type: 'pipeline', id },
    details: { after: { name, code, isUpsell } },
  })
  return c.json<PipelineSummary>(await pipelineSummary(db, id), 201)
}

async function updatePipeline(c: Ctx) {
  const body = await readBody(c)
  if (!body) return invalid(c, '')
  const change = readPipelineChange(body)
  if (typeof change === 'string') return invalid(c, change)
  const db = c.get('db')
  const pipeline = await lockPipeline(db, c.req.param('id') ?? '')
  if (!pipeline) return fail(c, 404, 'NOT_FOUND')

  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  const set: Record<string, unknown> = {}
  if (change.name !== undefined && change.name !== pipeline.name) {
    before.name = pipeline.name
    after.name = change.name
    set.name = change.name
  }
  if (change.code !== undefined && change.code !== pipeline.code) {
    before.code = pipeline.code
    after.code = change.code
    set.code = change.code
  }
  if (change.isUpsell !== undefined && change.isUpsell !== pipeline.is_upsell) {
    before.isUpsell = pipeline.is_upsell
    after.isUpsell = change.isUpsell
    set.is_upsell = change.isUpsell
  }
  if (change.archived !== undefined && change.archived !== (pipeline.archived_at !== null)) {
    before.archived = pipeline.archived_at !== null
    after.archived = change.archived
    set.archived_at = change.archived ? sql`now()` : null
  }
  if (Object.keys(set).length > 0) {
    try {
      await inSavepoint(db, () =>
        db
          .updateTable('pipeline')
          .set({ ...set, updated_at: sql`now()` })
          .where('id', '=', pipeline.id)
          .execute(),
      )
    } catch (error) {
      const code = uniqueRefusal(error)
      if (code) return fail(c, 409, code)
      throw error
    }
    await recordInRequest(c, {
      action: 'pipeline.updated',
      entity: { type: 'pipeline', id: pipeline.id },
      details: { name: change.name ?? pipeline.name, before, after },
    })
  }
  return c.json<PipelineSummary>(await pipelineSummary(db, pipeline.id))
}

async function reorderPipelines(c: Ctx) {
  const ids = readIds(await readBody(c))
  if (!ids) return invalid(c, 'ids')
  const db = c.get('db')
  const current = await db
    .selectFrom('pipeline')
    .select('id')
    .orderBy('position')
    .forUpdate()
    .execute()
  if (
    !(await reorder(
      db,
      'pipeline',
      current.map((r) => r.id),
      ids,
    ))
  ) {
    return fail(c, 400, 'INVALID_ORDER')
  }
  await recordInRequest(c, { action: 'pipeline.reordered', details: { after: { ids } } })
  return c.json<PipelineSummary[]>(await listPipelines(db))
}

async function listStages(c: Ctx) {
  const id = c.req.param('id') ?? ''
  const db = c.get('db')
  const exists =
    UUID.test(id) &&
    (await db.selectFrom('pipeline').select('id').where('id', '=', id).executeTakeFirst())
  if (!exists) return fail(c, 404, 'NOT_FOUND')
  return c.json<StageSummary[]>((await liveStages(db, [id])).map(stageSummary))
}

async function createStage(c: Ctx) {
  const name = readName((await readBody(c))?.name)
  if (!name) return invalid(c, 'name')
  const db = c.get('db')
  const pipeline = await lockPipeline(db, c.req.param('id') ?? '')
  if (!pipeline) return fail(c, 404, 'NOT_FOUND')
  const row = await db
    .insertInto('stage')
    .values({
      project_id: c.get('projectId'),
      pipeline_id: pipeline.id,
      name,
      position: await nextPosition(db, 'stage', pipeline.id),
      created_by: c.get('session').user.id,
    })
    .returning(['id', 'pipeline_id', 'name', 'position'])
    .executeTakeFirstOrThrow()
  await recordInRequest(c, {
    action: 'stage.created',
    entity: { type: 'stage', id: row.id },
    details: { pipeline: pipeline.name, after: { name } },
  })
  return c.json<StageSummary>(stageSummary(row), 201)
}

async function updateStage(c: Ctx) {
  const name = readName((await readBody(c))?.name)
  if (!name) return invalid(c, 'name')
  const db = c.get('db')
  const pipeline = await lockPipeline(db, c.req.param('id') ?? '')
  const stage = pipeline && (await lockStage(db, pipeline.id, c.req.param('stageId') ?? ''))
  if (!pipeline || !stage) return fail(c, 404, 'NOT_FOUND')
  if (name !== stage.name) {
    await db
      .updateTable('stage')
      .set({ name, updated_at: sql`now()` })
      .where('id', '=', stage.id)
      .execute()
    await recordInRequest(c, {
      action: 'stage.updated',
      entity: { type: 'stage', id: stage.id },
      details: { pipeline: pipeline.name, before: { name: stage.name }, after: { name } },
    })
  }
  return c.json<StageSummary>(stageSummary({ ...stage, name }))
}

async function reorderStages(c: Ctx) {
  const ids = readIds(await readBody(c))
  if (!ids) return invalid(c, 'ids')
  const db = c.get('db')
  const pipeline = await lockPipeline(db, c.req.param('id') ?? '')
  if (!pipeline) return fail(c, 404, 'NOT_FOUND')
  const current = await db
    .selectFrom('stage')
    .select('id')
    .where('pipeline_id', '=', pipeline.id)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .execute()
  if (
    !(await reorder(
      db,
      'stage',
      current.map((r) => r.id),
      ids,
    ))
  ) {
    return fail(c, 400, 'INVALID_ORDER')
  }
  await recordInRequest(c, {
    action: 'stage.reordered',
    entity: { type: 'pipeline', id: pipeline.id },
    details: { pipeline: pipeline.name, after: { ids } },
  })
  return c.json<StageSummary[]>((await liveStages(db, [pipeline.id])).map(stageSummary))
}

async function deleteStage(c: Ctx, stageDeals: StageDealsChecker) {
  const db = c.get('db')
  const pipeline = await lockPipeline(db, c.req.param('id') ?? '')
  const stage = pipeline && (await lockStage(db, pipeline.id, c.req.param('stageId') ?? ''))
  if (!pipeline || !stage) return fail(c, 404, 'NOT_FOUND')
  if (await stageDeals.hasOpenDeals(db, stage.id)) return fail(c, 409, 'STAGE_HAS_OPEN_DEALS')
  // Правила «обязательно с этапа» — на следующий этап до отметки: база не даёт удалить этап, на
  // который ссылается правило (crm-fields/01).
  const movedFieldRules = await moveRulesOffStage(db, pipeline.id, stage.id)
  // Мягкое удаление: закрытые сделки на этапе остаются, в канбане и списках этапа нет.
  await db
    .updateTable('stage')
    .set({ deleted_at: sql`now()`, updated_at: sql`now()` })
    .where('id', '=', stage.id)
    .execute()
  await recordInRequest(c, {
    action: 'stage.deleted',
    entity: { type: 'stage', id: stage.id },
    details: {
      pipeline: pipeline.name,
      before: { name: stage.name },
      ...(movedFieldRules > 0 ? { movedFieldRules } : {}),
    },
  })
  return c.body(null, 204)
}

/** Маршруты воронок и этапов: `/api/v1/pipelines`. */
export function pipelinesRoutes({ stageDeals }: { stageDeals: StageDealsChecker }) {
  return (
    new Hono<PermissionsEnv>()
      .get('/', requirePermission('deals', 'view'), async (c) =>
        c.json<PipelineSummary[]>(await listPipelines(c.get('db'))),
      )
      .post('/', requirePermission('pipelines', 'create'), createPipeline)
      // /order — до /:id: иначе «order» читался бы как id воронки.
      .put('/order', requirePermission('pipelines', 'edit'), reorderPipelines)
      .put('/:id', requirePermission('pipelines', 'edit'), updatePipeline)
      .get('/:id/card-fields', requirePermission('deals', 'view'), getCardFields)
      .put('/:id/card-fields', requirePermission('pipelines', 'edit'), putCardFields)
      .get('/:id/stages', requirePermission('deals', 'view'), listStages)
      .post('/:id/stages', requirePermission('pipelines', 'create'), createStage)
      .put('/:id/stages/order', requirePermission('pipelines', 'edit'), reorderStages)
      .put('/:id/stages/:stageId', requirePermission('pipelines', 'edit'), updateStage)
      .delete('/:id/stages/:stageId', requirePermission('pipelines', 'delete'), (c) =>
        deleteStage(c, stageDeals),
      )
  )
}
