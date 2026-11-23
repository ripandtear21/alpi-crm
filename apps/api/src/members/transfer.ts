import type { BulkJobProgress } from '@alpi/shared'
import { can } from '@alpi/shared'
import { Hono } from 'hono'
import { recordInRequest } from '../audit/record.ts'
import { type BulkDeps, type BulkJobSummary, COLUMNS, summary } from '../bulk/routes.ts'
import { ownerAllowed } from '../deals/scope.ts'
import { openDealsOf, readTransferParams, TRANSFER_DEALS_ACTION } from '../deals/transfer.ts'
import { type PermissionsEnv, requireStandalone } from '../middleware/permissions.ts'
import { PROJECT_TEAMS, resolveViewer } from '../roles/scope.ts'
import type { MemberErrorCode } from './service.ts'

// Передача открытых сделок участника (тикет crm-deals/09): `POST /v1/members/:userId/
// transfer-deals` (снаружи — /api/v1/...). Одному участнику проекта или в общую очередь
// (`toUserId: null`). Право — «передача сделок» (`transfer_deals`) и «сделки: изменять»; чьи
// сделки и кому — оба в охвате изменения сделок: тимлид передаёт только в своей команде.
// Передачу выполняет массовая операция (действие deals/transfer.ts): здесь — проверки, строка
// bulk_job, запись в журнал опасных действий и постановка в очередь, одной транзакцией.
//
// Отдельный маршрут, а не POST /v1/bulk-jobs: у тимлида нет права «массовые операции», а
// получатель проверяется до запуска (422), а не только по записи в журнале ошибок.
//
// Журнал — то же событие bulk.started, что у любой массовой операции (решено без владельца —
// подтвердить): запуск передачи и есть запуск массовой операции, а фильтр журнала по
// bulk.started находит все массовые изменения сразу. Чьи сделки и кому — в подробностях.

type Status = 400 | 403 | 404 | 422

export function memberTransferRoutes({ actions, enqueue }: BulkDeps) {
  return new Hono<PermissionsEnv>().post(
    '/:userId/transfer-deals',
    requireStandalone('transfer_deals'),
    async (c) => {
      const fail = (status: Status, code: MemberErrorCode, details?: unknown) =>
        c.json(details === undefined ? { code } : { code, details }, status)
      const { permissions } = c.var.access
      if (!can(permissions, 'deals', 'edit')) return fail(403, 'PERMISSION_DENIED')
      if (!actions.has(TRANSFER_DEALS_ACTION)) {
        throw new Error('действие передачи сделок не зарегистрировано в реестре массовых операций')
      }

      const body = (await c.req.json().catch(() => null)) as unknown
      const toUserId =
        typeof body === 'object' && body !== null && 'toUserId' in body
          ? (body as { toUserId: unknown }).toUserId
          : undefined
      const fromUserId = c.req.param('userId')
      const params = readTransferParams({ fromUserId, toUserId })
      if (!params) return fail(400, 'INVALID_MEMBER', { path: 'toUserId' })

      const db = c.var.db
      // Участник текущего проекта, в том числе отключённый: его сделки тоже можно передать.
      const source = await db
        .selectFrom('project_member')
        .select('user_id')
        .where('user_id', '=', params.fromUserId)
        .executeTakeFirst()
      if (!source) return fail(404, 'MEMBER_NOT_FOUND')

      const viewer = await resolveViewer(db, c.var.session.user.id, PROJECT_TEAMS)
      const scope = permissions.scopes.deals.write
      if (
        !ownerAllowed(params.fromUserId, scope, viewer) ||
        !ownerAllowed(params.toUserId, scope, viewer)
      ) {
        return fail(403, 'PERMISSION_DENIED')
      }
      if (params.toUserId !== null) {
        const recipient = await db
          .selectFrom('project_member')
          .select('user_id')
          .where('user_id', '=', params.toUserId)
          .where('disabled_at', 'is', null)
          .executeTakeFirst()
        if (!recipient) return fail(422, 'OWNER_NOT_MEMBER')
      }

      const { count } = await openDealsOf(db, params.fromUserId)
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .executeTakeFirstOrThrow()
      const row = await db
        .insertInto('bulk_job')
        .values({
          project_id: c.var.projectId,
          initiator_id: c.var.session.user.id,
          action: TRANSFER_DEALS_ACTION,
          // Какие сделки — по параметрам действия (открытые сделки fromUserId) на момент старта.
          selection: JSON.stringify({ filter: {} }),
          params: JSON.stringify(params),
        })
        .returning(COLUMNS)
        .executeTakeFirstOrThrow()
      await recordInRequest(c, {
        action: 'bulk.started',
        entity: { type: 'bulk_job', id: row.id },
        details: {
          action: TRANSFER_DEALS_ACTION,
          selection: 'filter',
          fromUserId: params.fromUserId,
          toUserId: params.toUserId,
          count: Number(count),
        },
      })
      // В той же транзакции: откатился запуск — задачи в очереди нет, и наоборот.
      await enqueue(db, { projectId: c.var.projectId, bulkJobId: row.id })
      const job: BulkJobSummary & BulkJobProgress = summary(row)
      return c.json<BulkJobSummary>(job, 202)
    },
  )
}
