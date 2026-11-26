import type { Database } from '@alpi/db'
import { type Kysely, sql } from 'kysely'
import type { BulkAction } from '../bulk/registry.ts'
import { BulkRecordError } from '../bulk/registry.ts'
import { type ChangeAuthor, recordChanges } from '../change-log/record.ts'
import { emitDealChanges } from '../events/deal-events.ts'
import { dealInScope, ownerAllowed } from './scope.ts'

// Передача открытых сделок участника одному менеджеру или в общую очередь (тикет crm-deals/09;
// spec.md MVP, раздел 4, «Уход сотрудника»). Действие массовой операции тикета 04: каркас
// (bulk/runner.ts) режет сделки на порции и на каждой порции заново проверяет права
// инициатора; запускает его маршрут POST /v1/members/:userId/transfer-deals
// (members/transfer.ts). Каждая переданная сделка получает запись «ответственный: было →
// стало» в истории и событие deal.owner_changed (events/deal-events.ts) с автором — инициатором
// операции. Сделки передаются только по команде человека (ADR 0003): ни автоматики, ни раздачи
// по команде.

/** Код действия в реестре массовых операций. */
export const TRANSFER_DEALS_ACTION = 'deals.transfer'

/** Параметры операции: чьи сделки и кому; `toUserId: null` — в общую очередь. */
export interface TransferParams {
  fromUserId: string
  toUserId: string | null
}

/** Наибольшая длина id пользователя в параметрах (id Better Auth — 32 символа). */
const MAX_USER_ID = 100

const isUserId = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && value.length <= MAX_USER_ID

/** Параметры из запроса; null — не годятся. */
export function readTransferParams(params: Record<string, unknown>): TransferParams | null {
  const { fromUserId, toUserId } = params
  if (!isUserId(fromUserId)) return null
  if (toUserId !== null && !isUserId(toUserId)) return null
  if (toUserId === fromUserId) return null
  return { fromUserId, toUserId }
}

/**
 * Открытые сделки ответственного `ownerId` в текущем проекте (`db` — транзакция проекта):
 * статус open, в том числе архивные (архив — отметка, а не статус), без удалённых в корзину и
 * слитых с другой сделкой (тикет crm-intake/02: скрытая сделка не мешает отключить участника).
 */
export function openDealsOf(db: Kysely<Database>, ownerId: string) {
  return db
    .selectFrom('deal')
    .where('owner_id', '=', ownerId)
    .where('status', '=', 'open')
    .where('deleted_at', 'is', null)
    .where('merged_into_id', 'is', null)
}

function params(ctx: { params: Record<string, unknown> }): TransferParams {
  const read = readTransferParams(ctx.params)
  // Параметры проверены при запуске; сюда неверные попадают, только если строку bulk_job
  // меняли в обход API.
  if (!read) throw new Error('массовая операция передачи сделок: неверные параметры')
  return read
}

export const transferDeals: BulkAction = {
  requires: { resource: 'deals', action: 'edit' },
  // У тимлида нет «массовых операций», а сделки своей команды он передаёт: см. registry.ts.
  standalone: 'transfer_deals',

  validate({ params }) {
    return readTransferParams(params)
      ? null
      : 'ожидается fromUserId — участник и toUserId — другой участник или null'
  },

  async select(trx, _filter, ctx) {
    const { fromUserId } = params(ctx)
    // Участник вне охвата изменения инициатора — не выбираем ничего. Иначе запуск через общий
    // POST /v1/bulk-jobs (тимлиду его открывает standalone выше) дал бы операцию, где каждая
    // запись падает с OUT_OF_SCOPE, а GET /v1/bulk-jobs/:id показал бы число и id чужих
    // открытых сделок. Здесь, а не в validate: у validate нет ни роли, ни охвата инициатора, а
    // select разворачивается правами на момент старта операции (runner.ts, prepare).
    if (!ownerAllowed(fromUserId, ctx.access.permissions.scopes.deals.write, ctx.viewer)) {
      return []
    }
    const rows = await openDealsOf(trx, fromUserId).select('id').orderBy('id').execute()
    return rows.map((r) => r.id)
  },

  async inScope(trx, ids, ctx) {
    const { toUserId } = params(ctx)
    const scope = ctx.access.permissions.scopes.deals.write
    // Получатель — тоже в охвате изменения: тимлид передаёт только внутри своей команды.
    if (!ownerAllowed(toUserId, scope, ctx.viewer)) return new Set()
    const rows = await trx
      .selectFrom('deal')
      .select('id')
      .where('id', 'in', [...ids])
      .where(dealInScope(sql.ref('deal.owner_id'), scope, ctx.viewer))
      .execute()
    return new Set(rows.map((r) => r.id))
  },

  async apply(trx, id, ctx) {
    const { fromUserId, toUserId } = params(ctx)
    const deal = await trx
      .selectFrom('deal')
      .select([
        'project_id',
        'pipeline_id',
        'stage_id',
        'owner_id',
        'status',
        'lost_reason_id',
        'archived_at',
        'deleted_at',
        'merged_into_id',
      ])
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst()
    // Пока операция шла, сделку закрыли, удалили или уже передали другому: у участника её
    // больше нет — делать нечего, чужую передачу не перебиваем.
    if (
      deal?.status !== 'open' ||
      deal.deleted_at !== null ||
      deal.merged_into_id !== null ||
      deal.owner_id !== fromUserId
    ) {
      return
    }
    if (toUserId !== null) {
      // FOR SHARE: отключение получателя (FOR UPDATE его участия) ждёт конца порции и потом
      // увидит переданные ему сделки; уже отключённый — ошибка этой записи.
      const recipient = await trx
        .selectFrom('project_member')
        .select('user_id')
        .where('user_id', '=', toUserId)
        .where('disabled_at', 'is', null)
        .forShare()
        .executeTakeFirst()
      if (!recipient) {
        throw new BulkRecordError('OWNER_NOT_MEMBER', 'получатель не участник проекта')
      }
    }
    await trx
      .updateTable('deal')
      .set({ owner_id: toUserId, updated_at: sql`now()` })
      .where('id', '=', id)
      .execute()
    const author: ChangeAuthor = { db: trx, projectId: deal.project_id, actorId: ctx.initiatorId }
    await recordChanges(author, { type: 'deal', id }, [
      { field: 'ownerId', before: fromUserId, after: toUserId },
    ])
    await emitDealChanges(author, { ...deal, id }, { ...deal, id, owner_id: toUserId })
  },
}
