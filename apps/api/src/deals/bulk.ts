import type { Database } from '@alpi/db'
import { type FilterError, parseFilter, type RolePermissions } from '@alpi/shared'
import { type Kysely, sql, type Transaction } from 'kysely'
import {
  type BulkAction,
  type BulkContext,
  BulkRecordError,
  BulkSelectionError,
} from '../bulk/registry.ts'
import { type FieldChange, recordChanges } from '../change-log/record.ts'
import { catalogFor, loadFilterCatalog } from '../filters/custom.ts'
import { dealsWhere } from './board.ts'
import { dealInScope, ownerAllowed } from './scope.ts'

// Массовые действия списка сделок (тикет crm-deals/12) на каркасе тикета 04 (bulk/runner.ts:
// порции, прогресс, журнал ошибок, права заново на каждой порции): архивировать, вернуть из
// архива, передать (другому ответственному или в общую очередь), сменить этап в пределах
// воронки, удалить в корзину. Выбор — список id или фильтр списка (формат packages/shared/src/
// filters): фильтр разворачивается той же функцией выдачи, что у списка и канбана
// (deals/board.ts, dealsWhere), с охватом чтения инициатора. Менять можно только сделки в
// охвате изменения: остальные каркас пишет в журнал операции (OUT_OF_SCOPE) и не трогает.
// Каждое изменение пишется в историю сделки «было → стало». Запускает только человек (ADR 0003).

export const DEAL_BULK_ACTIONS = {
  archive: 'deals.archive',
  unarchive: 'deals.unarchive',
  assign: 'deals.assign',
  stage: 'deals.stage',
  trash: 'deals.trash',
} as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_USER_ID = 100

/** Сделки по фильтру списка: охват чтения инициатора, без корзины, архив — по фильтру. */
async function selectByFilter(
  trx: Transaction<Database>,
  filter: Record<string, unknown>,
  ctx: BulkContext,
): Promise<string[]> {
  // Пользовательские поля — те, что инициатор видит сейчас (тикет crm-fields/07). Условие по
  // полю, которое с запуска ушло в архив или стало скрытым, не отбрасывается молча (выбор стал
  // бы шире), а останавливает операцию.
  const custom = await loadFilterCatalog(trx, ctx.access.permissions, 'deal')
  const parsed = parseFilter('deals', filter, custom)
  // Фильтр проверен при запуске (validate) тем же каталогом; сюда неверный попадает, только
  // если поле фильтра с запуска стало недоступно или строку bulk_job меняли в обход API.
  if (!parsed.ok) {
    throw new BulkSelectionError(`массовая операция сделок: ${filterProblem(parsed.error)}`)
  }
  const viewer = {
    actorId: ctx.initiatorId,
    scope: ctx.access.permissions.scopes.deals,
    viewer: ctx.viewer,
  }
  const filters = { status: 'any', archived: 'any', filter: parsed.filter, custom } as const
  const rows = await trx
    .selectFrom('deal')
    .select('deal.id')
    .where((eb) => dealsWhere(eb, viewer, filters, undefined))
    .orderBy('deal.id')
    .execute()
  return rows.map((row) => row.id)
}

/** Сделки из `ids`, которые инициатор может менять: охват изменения, не в корзине. */
async function writable(
  trx: Transaction<Database>,
  ids: readonly string[],
  ctx: BulkContext,
): Promise<ReadonlySet<string>> {
  if (ids.length === 0) return new Set()
  const rows = await trx
    .selectFrom('deal')
    .select('id')
    .where('id', 'in', [...ids])
    .where('deleted_at', 'is', null)
    .where(
      dealInScope(sql.ref('deal.owner_id'), ctx.access.permissions.scopes.deals.write, ctx.viewer),
    )
    .execute()
  return new Set(rows.map((row) => row.id))
}

const filterProblem = (error: FilterError) => `фильтр: ${error.path || 'корень'} — ${error.message}`

/**
 * Проверка фильтра при запуске — целиком, с каталогом пользовательских полей, которые инициатор
 * видит. Скрытое от его роли поле и неизвестный код дают один и тот же ответ («неизвестное
 * поле»): ответ не выдаёт, что скрытое поле есть. Выбор записей (selectByFilter) проверяет
 * фильтр ещё раз на момент старта: поле могли убрать в архив или скрыть после запуска.
 */
async function validateFilter(input: {
  filter?: Record<string, unknown>
  db: Kysely<Database>
  permissions: RolePermissions
}): Promise<string | null> {
  if (input.filter === undefined) return null
  const custom = await catalogFor(input.db, input.permissions, 'deal', JSON.stringify(input.filter))
  const parsed = parseFilter('deals', input.filter, custom)
  return parsed.ok ? null : filterProblem(parsed.error)
}

/** Сделка под блокировкой до конца порции; в корзине (удалили, пока шла операция) — ошибка. */
async function lockDeal(trx: Transaction<Database>, id: string) {
  const deal = await trx
    .selectFrom('deal')
    .select([
      'project_id',
      'pipeline_id',
      'stage_id',
      'status',
      'owner_id',
      'primary_contact_id',
      'archived_at',
      'deleted_at',
    ])
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  if (!deal || deal.deleted_at !== null) throw new BulkRecordError('DEAL_NOT_FOUND')
  return deal
}

const iso = (value: Date | string | null) => (value === null ? null : new Date(value).toISOString())

async function log(
  trx: Kysely<Database>,
  projectId: string,
  ctx: BulkContext,
  id: string,
  changes: FieldChange[],
) {
  await recordChanges(
    { db: trx, projectId, actorId: ctx.initiatorId },
    { type: 'deal', id },
    changes,
  )
}

/** Общее у действий: выбор по фильтру и охват изменения. */
const base = {
  select: selectByFilter,
  inScope: writable,
} satisfies Pick<BulkAction, 'select' | 'inScope'>

export const archiveDeals: BulkAction = {
  ...base,
  requires: { resource: 'deals', action: 'edit' },
  validate: validateFilter,
  async apply(trx, id, ctx) {
    const deal = await lockDeal(trx, id)
    if (deal.archived_at !== null) return
    const { archived_at } = await trx
      .updateTable('deal')
      .set({ archived_at: sql`now()`, updated_at: sql`now()` })
      .where('id', '=', id)
      .returning('archived_at')
      .executeTakeFirstOrThrow()
    await log(trx, deal.project_id, ctx, id, [
      { field: 'archivedAt', before: null, after: iso(archived_at) },
    ])
  },
}

export const unarchiveDeals: BulkAction = {
  ...base,
  requires: { resource: 'deals', action: 'edit' },
  validate: validateFilter,
  async apply(trx, id, ctx) {
    const deal = await lockDeal(trx, id)
    if (deal.archived_at === null) return
    // «Одна открытая сделка у человека в воронке»: открытая сделка из архива не возвращается,
    // если у контакта уже есть другая открытая в этой воронке. Индекс базы
    // (deal_one_open_per_contact) держит то же при одновременных запросах.
    if (deal.status === 'open') {
      const conflict = await trx
        .selectFrom('deal')
        .select('id')
        .where('pipeline_id', '=', deal.pipeline_id)
        .where('primary_contact_id', '=', deal.primary_contact_id)
        .where('status', '=', 'open')
        .where('archived_at', 'is', null)
        .where('deleted_at', 'is', null)
        .where('id', '<>', id)
        .executeTakeFirst()
      if (conflict) {
        throw new BulkRecordError(
          'OPEN_DEAL_EXISTS',
          `у контакта уже есть открытая сделка в этой воронке: ${conflict.id}`,
        )
      }
    }
    try {
      await trx
        .updateTable('deal')
        .set({ archived_at: null, updated_at: sql`now()` })
        .where('id', '=', id)
        .execute()
    } catch (error) {
      if ((error as { constraint?: unknown }).constraint === 'deal_one_open_per_contact') {
        throw new BulkRecordError(
          'OPEN_DEAL_EXISTS',
          'у контакта уже есть открытая сделка в этой воронке',
        )
      }
      throw error
    }
    await log(trx, deal.project_id, ctx, id, [
      { field: 'archivedAt', before: iso(deal.archived_at), after: null },
    ])
  },
}

/** Новый ответственный: id участника или null — общая очередь. */
function readOwner(params: Record<string, unknown>): string | null | undefined {
  const { ownerId } = params
  if (ownerId === null) return null
  return typeof ownerId === 'string' && ownerId !== '' && ownerId.length <= MAX_USER_ID
    ? ownerId
    : undefined
}

export const assignDeals: BulkAction = {
  ...base,
  // Передача — «массовые операции» плюс «передача сделок» (тикет 12).
  requires: { resource: 'deals', action: 'edit' },
  alsoRequires: 'transfer_deals',
  async validate({ params, ...input }) {
    if (readOwner(params) === undefined) return 'ожидается ownerId — участник проекта или null'
    return validateFilter(input)
  },
  async inScope(trx, ids, ctx) {
    // Новый ответственный — тоже в охвате изменения: тимлид передаёт только внутри команды.
    const owner = readOwner(ctx.params)
    if (owner === undefined) return new Set()
    if (!ownerAllowed(owner, ctx.access.permissions.scopes.deals.write, ctx.viewer)) {
      return new Set()
    }
    return writable(trx, ids, ctx)
  },
  async apply(trx, id, ctx) {
    const owner = readOwner(ctx.params)
    if (owner === undefined) throw new Error('массовая передача: неверные параметры')
    const deal = await lockDeal(trx, id)
    if (deal.owner_id === owner) return
    if (owner !== null) {
      // FOR SHARE: отключение участника ждёт конца порции; уже отключённый — ошибка записи.
      const member = await trx
        .selectFrom('project_member')
        .select('user_id')
        .where('user_id', '=', owner)
        .where('disabled_at', 'is', null)
        .forShare()
        .executeTakeFirst()
      if (!member) throw new BulkRecordError('OWNER_NOT_MEMBER', 'получатель не участник проекта')
    }
    await trx
      .updateTable('deal')
      .set({ owner_id: owner, updated_at: sql`now()` })
      .where('id', '=', id)
      .execute()
    await log(trx, deal.project_id, ctx, id, [
      { field: 'ownerId', before: deal.owner_id, after: owner },
    ])
  },
}

function readStage(params: Record<string, unknown>): string | undefined {
  const { stageId } = params
  return typeof stageId === 'string' && UUID.test(stageId) ? stageId.toLowerCase() : undefined
}

/** SQLSTATE триггера deal_stage_live (migrations/0010_deals.ts). */
const STAGE_DELETED = 'DL001'

export const changeDealsStage: BulkAction = {
  ...base,
  requires: { resource: 'deals', action: 'edit' },
  async validate({ params, ...input }) {
    if (readStage(params) === undefined) return 'ожидается stageId — этап воронки'
    return validateFilter(input)
  },
  async apply(trx, id, ctx) {
    const stageId = readStage(ctx.params)
    if (stageId === undefined) throw new Error('массовая смена этапа: неверные параметры')
    const deal = await lockDeal(trx, id)
    if (deal.stage_id === stageId) return
    const stage = await trx
      .selectFrom('stage')
      .select(['pipeline_id', 'deleted_at'])
      .where('id', '=', stageId)
      .executeTakeFirst()
    if (!stage || stage.deleted_at !== null) throw new BulkRecordError('STAGE_NOT_FOUND')
    // Смена этапа — только в пределах воронки сделки; перенос между воронками — отдельное
    // действие карточки.
    if (stage.pipeline_id !== deal.pipeline_id) {
      throw new BulkRecordError('STAGE_NOT_IN_PIPELINE', 'этап другой воронки')
    }
    try {
      await trx
        .updateTable('deal')
        .set({ stage_id: stageId, stage_changed_at: sql`now()`, updated_at: sql`now()` })
        .where('id', '=', id)
        .execute()
    } catch (error) {
      if ((error as { code?: unknown }).code === STAGE_DELETED) {
        throw new BulkRecordError('STAGE_DELETED')
      }
      throw error
    }
    await log(trx, deal.project_id, ctx, id, [
      { field: 'stageId', before: deal.stage_id, after: stageId },
    ])
  },
}

export const trashDeals: BulkAction = {
  ...base,
  // Удаление в корзину — «массовые операции» плюс «сделки: удалять».
  requires: { resource: 'deals', action: 'delete' },
  validate: validateFilter,
  async apply(trx, id, ctx) {
    const deal = await lockDeal(trx, id)
    const { deleted_at } = await trx
      .updateTable('deal')
      .set({ deleted_at: sql`now()`, deleted_by: ctx.initiatorId })
      .where('id', '=', id)
      .returning('deleted_at')
      .executeTakeFirstOrThrow()
    await log(trx, deal.project_id, ctx, id, [
      { field: 'deletedAt', before: null, after: iso(deleted_at) },
    ])
  },
}

/** Действия тикета 12 для реестра массовых операций (index.ts). */
export const DEAL_BULK_REGISTRY: ReadonlyArray<readonly [string, BulkAction]> = [
  [DEAL_BULK_ACTIONS.archive, archiveDeals],
  [DEAL_BULK_ACTIONS.unarchive, unarchiveDeals],
  [DEAL_BULK_ACTIONS.assign, assignDeals],
  [DEAL_BULK_ACTIONS.stage, changeDealsStage],
  [DEAL_BULK_ACTIONS.trash, trashDeals],
]
