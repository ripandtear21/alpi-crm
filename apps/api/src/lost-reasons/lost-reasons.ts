import type { Database } from '@alpi/db'
import type { LostReasonGroupSummary, LostReasonSummary } from '@alpi/shared'
import { Hono } from 'hono'
import { type Kysely, sql } from 'kysely'
import { recordInRequest } from '../audit/record.ts'
import { type PermissionsEnv, requirePermission } from '../middleware/permissions.ts'
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
} from '../pipelines/directory.ts'
import { inSavepoint } from '../roles/roles.ts'

// Справочник причин проигрыша (тикет crm-deals/02): группа → причина, `/api/v1/lost-reasons`.
// Читает каждый с правом «сделки: смотреть» (причину выбирают при проигрыше); меняет — право
// «воронки и этапы»: отдельной части системы для причин в каталоге прав нет (решено без
// владельца — подтвердить). Причины и группы не удаляются, а уходят в архив: архивная причина
// не предлагается при проигрыше, но остаётся у старых сделок. Названия групп уникальны в
// проекте, причин — в группе (migrations/0008_pipelines.ts).

interface GroupRow {
  id: string
  name: string
  position: number
  archived_at: Date | string | null
}

interface ReasonRow extends GroupRow {
  group_id: string
}

function reasonSummary(row: ReasonRow): LostReasonSummary {
  return {
    id: row.id,
    groupId: row.group_id,
    name: row.name,
    position: row.position,
    archivedAt: isoOrNull(row.archived_at),
  }
}

/** Группы с причинами по порядку, архивные — тоже (с отметкой). */
export async function listLostReasons(db: Kysely<Database>): Promise<LostReasonGroupSummary[]> {
  const groups = await db
    .selectFrom('lost_reason_group')
    .select(['id', 'name', 'position', 'archived_at'])
    .orderBy('position')
    .orderBy('created_at')
    .orderBy('id')
    .execute()
  const reasons = await db
    .selectFrom('lost_reason')
    .select(['id', 'group_id', 'name', 'position', 'archived_at'])
    .orderBy('position')
    .orderBy('created_at')
    .orderBy('id')
    .execute()
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    position: g.position,
    archivedAt: isoOrNull(g.archived_at),
    reasons: reasons.filter((r) => r.group_id === g.id).map(reasonSummary),
  }))
}

async function groupSummary(db: Kysely<Database>, id: string): Promise<LostReasonGroupSummary> {
  const group = (await listLostReasons(db)).find((g) => g.id === id)
  if (!group) throw new Error('группа причин пропала в той же транзакции')
  return group
}

async function lockGroup(db: Kysely<Database>, id: string): Promise<GroupRow | undefined> {
  if (!UUID.test(id)) return undefined
  return db
    .selectFrom('lost_reason_group')
    .select(['id', 'name', 'position', 'archived_at'])
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
}

async function lockReason(db: Kysely<Database>, id: string): Promise<ReasonRow | undefined> {
  if (!UUID.test(id)) return undefined
  return db
    .selectFrom('lost_reason')
    .select(['id', 'group_id', 'name', 'position', 'archived_at'])
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
}

async function nextPosition(db: Kysely<Database>, groupId?: string): Promise<number> {
  const row =
    groupId === undefined
      ? await db
          .selectFrom('lost_reason_group')
          .select((eb) => eb.fn.max('position').as('max'))
          .executeTakeFirst()
      : await db
          .selectFrom('lost_reason')
          .select((eb) => eb.fn.max('position').as('max'))
          .where('group_id', '=', groupId)
          .executeTakeFirst()
  return Number(row?.max ?? 0) + 1
}

/** Изменение группы или причины: название и/или архив; строка — какое поле неверно. */
function readChange(
  body: Record<string, unknown> | null,
): { name?: string; archived?: boolean } | string {
  if (!body) return ''
  const change: { name?: string; archived?: boolean } = {}
  if (body.name !== undefined) {
    const name = readName(body.name)
    if (!name) return 'name'
    change.name = name
  }
  if (body.archived !== undefined) {
    if (typeof body.archived !== 'boolean') return 'archived'
    change.archived = body.archived
  }
  return Object.keys(change).length === 0 ? '' : change
}

/**
 * Применяет изменение к строке группы или причины: только изменившиеся поля, в точке
 * сохранения (нарушение уникальности названия — 409). Возвращает было/стало для журнала или
 * код отказа.
 */
async function applyChange(
  db: Kysely<Database>,
  table: 'lost_reason_group' | 'lost_reason',
  row: GroupRow,
  change: { name?: string; archived?: boolean },
) {
  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  const set: { name?: string; archived_at?: ReturnType<typeof sql<Date>> | null } = {}
  if (change.name !== undefined && change.name !== row.name) {
    before.name = row.name
    after.name = change.name
    set.name = change.name
  }
  if (change.archived !== undefined && change.archived !== (row.archived_at !== null)) {
    before.archived = row.archived_at !== null
    after.archived = change.archived
    set.archived_at = change.archived ? sql<Date>`now()` : null
  }
  if (Object.keys(set).length === 0) return { changed: false as const }
  try {
    await inSavepoint(db, () =>
      db
        .updateTable(table)
        .set({ ...set, updated_at: sql`now()` })
        .where('id', '=', row.id)
        .execute(),
    )
  } catch (error) {
    const code = uniqueRefusal(error)
    if (code) return { refused: code }
    throw error
  }
  return { changed: true as const, before, after }
}

async function createGroup(c: Ctx) {
  const name = readName((await readBody(c))?.name)
  if (!name) return invalid(c, 'name')
  const db = c.get('db')
  let row: GroupRow
  try {
    row = await inSavepoint(db, async () =>
      db
        .insertInto('lost_reason_group')
        .values({
          project_id: c.get('projectId'),
          name,
          position: await nextPosition(db),
          created_by: c.get('session').user.id,
        })
        .returning(['id', 'name', 'position', 'archived_at'])
        .executeTakeFirstOrThrow(),
    )
  } catch (error) {
    const code = uniqueRefusal(error)
    if (code) return fail(c, 409, code)
    throw error
  }
  await recordInRequest(c, {
    action: 'lost_reason_group.created',
    entity: { type: 'lost_reason_group', id: row.id },
    details: { after: { name } },
  })
  return c.json<LostReasonGroupSummary>(
    { id: row.id, name, position: row.position, archivedAt: null, reasons: [] },
    201,
  )
}

async function updateGroup(c: Ctx) {
  const change = readChange(await readBody(c))
  if (typeof change === 'string') return invalid(c, change)
  const db = c.get('db')
  const group = await lockGroup(db, c.req.param('id') ?? '')
  if (!group) return fail(c, 404, 'NOT_FOUND')
  const result = await applyChange(db, 'lost_reason_group', group, change)
  if ('refused' in result) return fail(c, 409, result.refused)
  if (result.changed) {
    await recordInRequest(c, {
      action: 'lost_reason_group.updated',
      entity: { type: 'lost_reason_group', id: group.id },
      details: { name: change.name ?? group.name, before: result.before, after: result.after },
    })
  }
  return c.json<LostReasonGroupSummary>(await groupSummary(db, group.id))
}

async function reorderGroups(c: Ctx) {
  const ids = readIds(await readBody(c))
  if (!ids) return invalid(c, 'ids')
  const db = c.get('db')
  const current = await db.selectFrom('lost_reason_group').select('id').forUpdate().execute()
  if (
    !(await reorder(
      db,
      'lost_reason_group',
      current.map((r) => r.id),
      ids,
    ))
  ) {
    return fail(c, 400, 'INVALID_ORDER')
  }
  await recordInRequest(c, { action: 'lost_reason_group.reordered', details: { after: { ids } } })
  return c.json<LostReasonGroupSummary[]>(await listLostReasons(db))
}

async function reorderReasons(c: Ctx) {
  const ids = readIds(await readBody(c))
  if (!ids) return invalid(c, 'ids')
  const db = c.get('db')
  const group = await lockGroup(db, c.req.param('id') ?? '')
  if (!group) return fail(c, 404, 'NOT_FOUND')
  const current = await db
    .selectFrom('lost_reason')
    .select('id')
    .where('group_id', '=', group.id)
    .forUpdate()
    .execute()
  if (
    !(await reorder(
      db,
      'lost_reason',
      current.map((r) => r.id),
      ids,
    ))
  ) {
    return fail(c, 400, 'INVALID_ORDER')
  }
  await recordInRequest(c, {
    action: 'lost_reason.reordered',
    entity: { type: 'lost_reason_group', id: group.id },
    details: { group: group.name, after: { ids } },
  })
  return c.json<LostReasonGroupSummary>(await groupSummary(db, group.id))
}

async function createReason(c: Ctx) {
  const body = await readBody(c)
  const name = readName(body?.name)
  if (!name) return invalid(c, 'name')
  if (typeof body?.groupId !== 'string') return invalid(c, 'groupId')
  const db = c.get('db')
  const group = await lockGroup(db, body.groupId)
  if (!group) return fail(c, 404, 'NOT_FOUND')
  let row: ReasonRow
  try {
    row = await inSavepoint(db, async () =>
      db
        .insertInto('lost_reason')
        .values({
          project_id: c.get('projectId'),
          group_id: group.id,
          name,
          position: await nextPosition(db, group.id),
          created_by: c.get('session').user.id,
        })
        .returning(['id', 'group_id', 'name', 'position', 'archived_at'])
        .executeTakeFirstOrThrow(),
    )
  } catch (error) {
    const code = uniqueRefusal(error)
    if (code) return fail(c, 409, code)
    throw error
  }
  await recordInRequest(c, {
    action: 'lost_reason.created',
    entity: { type: 'lost_reason', id: row.id },
    details: { group: group.name, after: { name } },
  })
  return c.json<LostReasonSummary>(reasonSummary(row), 201)
}

async function updateReason(c: Ctx) {
  const change = readChange(await readBody(c))
  if (typeof change === 'string') return invalid(c, change)
  const db = c.get('db')
  const reason = await lockReason(db, c.req.param('id') ?? '')
  if (!reason) return fail(c, 404, 'NOT_FOUND')
  const result = await applyChange(db, 'lost_reason', reason, change)
  if ('refused' in result) return fail(c, 409, result.refused)
  if (result.changed) {
    await recordInRequest(c, {
      action: 'lost_reason.updated',
      entity: { type: 'lost_reason', id: reason.id },
      details: { name: change.name ?? reason.name, before: result.before, after: result.after },
    })
  }
  const row = await db
    .selectFrom('lost_reason')
    .select(['id', 'group_id', 'name', 'position', 'archived_at'])
    .where('id', '=', reason.id)
    .executeTakeFirstOrThrow()
  return c.json<LostReasonSummary>(reasonSummary(row))
}

/** Маршруты справочника причин проигрыша: `/api/v1/lost-reasons`. */
export function lostReasonsRoutes() {
  return (
    new Hono<PermissionsEnv>()
      .get('/', requirePermission('deals', 'view'), async (c) =>
        c.json<LostReasonGroupSummary[]>(await listLostReasons(c.get('db'))),
      )
      .post('/', requirePermission('pipelines', 'create'), createReason)
      .post('/groups', requirePermission('pipelines', 'create'), createGroup)
      // …/order — до …/:id: иначе «order» читался бы как id группы.
      .put('/groups/order', requirePermission('pipelines', 'edit'), reorderGroups)
      .put('/groups/:id', requirePermission('pipelines', 'edit'), updateGroup)
      .put('/groups/:id/order', requirePermission('pipelines', 'edit'), reorderReasons)
      .put('/:id', requirePermission('pipelines', 'edit'), updateReason)
  )
}
