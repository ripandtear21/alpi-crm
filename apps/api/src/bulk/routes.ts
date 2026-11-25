import type { BulkJobStatus, Database } from '@alpi/db'
import { hasStandalone } from '@alpi/shared'
import { Hono } from 'hono'
import type { Transaction } from 'kysely'
import { recordInRequest } from '../audit/record.ts'
import type { PermissionsEnv } from '../middleware/permissions.ts'
import type { ProjectEnv } from '../middleware/project-context.ts'
import { loadMemberAccess } from '../roles/access.ts'
import { type BulkActionRegistry, bulkAllowed, NO_BULK_ACTIONS } from './registry.ts'
import type { BulkJobMessage } from './runner.ts'

// Массовые операции (тикет crm-deals/04): `/api/v1/bulk-jobs` (API видит путь без /api).
// Запуск — с правом «массовые операции» и правом части системы, которое требует действие;
// дальше операцию выполняет фоновая задача (runner.ts), проверяя права заново на каждой порции.
// Смотреть операцию может её инициатор, администратор проекта — все операции проекта.

/** Наибольшее число записей, выбранных списком id (фильтр не ограничен). */
export const MAX_SELECTED_IDS = 10_000
/** Наибольшее число строк журнала ошибок в ответе. */
const MAX_ERRORS_IN_RESPONSE = 1_000
/** Сколько последних операций в списке. */
const LIST_LIMIT = 50

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Операция в ответах API. */
export interface BulkJobSummary {
  id: string
  initiatorId: string
  action: string
  status: BulkJobStatus
  /** Записей всего; null — выбор по фильтру ещё не развёрнут. */
  total: number | null
  /** Обработано записей, с ошибкой — тоже. */
  processed: number
  /** Записей с ошибкой: они не изменены. */
  failed: number
  /** Почему операция остановилась целиком (`status = 'failed'`). */
  failure: string | null
  /** Время в ISO 8601. */
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

/** Ошибка по записи: запись не изменена. */
export interface BulkJobRecordError {
  /** Место записи в порядке обработки, с нуля. */
  position: number
  recordId: string
  /** OUT_OF_SCOPE — вне охвата инициатора, PERMISSION_DENIED — нет права, FAILED — сбой. */
  code: string
  message: string | null
}

/** `GET /v1/bulk-jobs/:id`: прогресс и журнал ошибок (первые 1 000 строк). */
export interface BulkJobDetails extends BulkJobSummary {
  errors: BulkJobRecordError[]
}

export type BulkErrorCode =
  | 'PERMISSION_DENIED'
  | 'UNKNOWN_ACTION'
  | 'INVALID_SELECTION'
  | 'INVALID_PARAMS'
  | 'BULK_JOB_NOT_FOUND'

/** Действия и очередь: в API — реестр и pg-boss (apps/api/src/jobs/jobs.ts). */
export interface BulkDeps {
  actions: BulkActionRegistry
  /** Ставит операцию в очередь в той же транзакции проекта, что и строку bulk_job. */
  enqueue(trx: Transaction<Database>, message: BulkJobMessage): Promise<void>
}

/** Без очереди: действий нет, поэтому до enqueue запуск не доходит (400 UNKNOWN_ACTION). */
export const NO_BULK: BulkDeps = {
  actions: NO_BULK_ACTIONS,
  enqueue: async () => {
    throw new Error('очередь фоновых задач не подключена')
  },
}

/** Столбцы bulk_job для ответа; их же читает запуск передачи сделок (members/transfer.ts). */
export const COLUMNS = [
  'id',
  'initiator_id',
  'action',
  'status',
  'total',
  'processed',
  'failed',
  'failure',
  'created_at',
  'started_at',
  'finished_at',
] as const

type JobRow = {
  id: string
  initiator_id: string
  action: string
  status: BulkJobStatus
  total: number | null
  processed: number
  failed: number
  failure: string | null
  created_at: Date
  started_at: Date | string | null
  finished_at: Date | string | null
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString()
}

export function summary(row: JobRow): BulkJobSummary {
  return {
    id: row.id,
    initiatorId: row.initiator_id,
    action: row.action,
    status: row.status,
    total: row.total,
    processed: row.processed,
    failed: row.failed,
    failure: row.failure,
    createdAt: new Date(row.created_at).toISOString(),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type Selection = { ids: string[] } | { filter: Record<string, unknown> }

function parseSelection(value: unknown): Selection | null {
  if (!isObject(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 1) return null
  if (Array.isArray(value.ids)) {
    const ids = value.ids
    if (ids.length === 0 || ids.length > MAX_SELECTED_IDS) return null
    if (!ids.every((id) => typeof id === 'string' && UUID.test(id))) return null
    return { ids: [...new Set(ids as string[])] }
  }
  if (isObject(value.filter)) return { filter: value.filter }
  return null
}

/** Видна ли операция: своя — всегда, чужая — администратору проекта. */
async function viewerIsAdmin(c: { var: ProjectEnv['Variables'] }): Promise<boolean> {
  const access = await loadMemberAccess(c.var.db, c.var.session.user.id)
  return access?.isAdmin ?? false
}

export function bulkRoutes({ actions, enqueue }: BulkDeps) {
  return new Hono<PermissionsEnv>()
    .get('/', async (c) => {
      const isAdmin = await viewerIsAdmin(c)
      let query = c.var.db
        .selectFrom('bulk_job')
        .select(COLUMNS)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(LIST_LIMIT)
      if (!isAdmin) query = query.where('initiator_id', '=', c.var.session.user.id)
      const rows = await query.execute()
      return c.json<BulkJobSummary[]>(rows.map(summary))
    })
    .get('/:id', async (c) => {
      const id = c.req.param('id')
      const notFound = () => c.json({ code: 'BULK_JOB_NOT_FOUND' satisfies BulkErrorCode }, 404)
      if (!UUID.test(id)) return notFound()
      const row = await c.var.db
        .selectFrom('bulk_job')
        .select(COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst()
      // Чужая операция для не-администратора — как несуществующая: ответ не выдаёт, что она есть.
      if (!row || (row.initiator_id !== c.var.session.user.id && !(await viewerIsAdmin(c)))) {
        return notFound()
      }
      const errors = await c.var.db
        .selectFrom('bulk_job_error')
        .select(['position', 'record_id', 'code', 'message'])
        .where('bulk_job_id', '=', id)
        .orderBy('position')
        .limit(MAX_ERRORS_IN_RESPONSE)
        .execute()
      return c.json<BulkJobDetails>({
        ...summary(row),
        errors: errors.map((e) => ({
          position: e.position,
          recordId: e.record_id,
          code: e.code,
          message: e.message,
        })),
      })
    })
    .post('/', async (c) => {
      const fail = (status: 400 | 403, code: BulkErrorCode) => c.json({ code }, status)
      // Какое отдельное право нужно, зависит от действия: роль читаем здесь, а не в middleware.
      const access = await loadMemberAccess(c.var.db, c.var.session.user.id)
      if (!access) return fail(403, 'PERMISSION_DENIED')
      const { permissions } = access
      const body = (await c.req.json().catch(() => null)) as unknown
      if (!isObject(body)) return fail(400, 'INVALID_SELECTION')
      const action = typeof body.action === 'string' ? actions.get(body.action) : undefined
      if (!action || typeof body.action !== 'string') {
        // Без права «массовые операции» — 403, как и раньше: ответ не выдаёт, какие действия есть.
        return hasStandalone(permissions, 'bulk_operations')
          ? fail(400, 'UNKNOWN_ACTION')
          : fail(403, 'PERMISSION_DENIED')
      }
      // Право запуска — то же, что каркас проверяет на каждой порции (runner.ts, allowed).
      if (!bulkAllowed(permissions, action)) {
        return fail(403, 'PERMISSION_DENIED')
      }
      const selection = parseSelection(body.selection)
      if (!selection) return fail(400, 'INVALID_SELECTION')
      const params = body.params === undefined ? {} : body.params
      if (!isObject(params)) return fail(400, 'INVALID_PARAMS')
      const db = c.var.db
      const problem = await action.validate?.({
        params,
        ...('filter' in selection ? { filter: selection.filter } : {}),
        db,
        permissions,
      })
      if (problem) return c.json({ code: 'INVALID_PARAMS' satisfies BulkErrorCode, problem }, 400)

      const row = await db
        .insertInto('bulk_job')
        .values({
          project_id: c.var.projectId,
          initiator_id: c.var.session.user.id,
          action: body.action,
          selection: JSON.stringify(selection),
          params: JSON.stringify(params),
          ...('ids' in selection ? { total: selection.ids.length } : {}),
        })
        .returning(COLUMNS)
        .executeTakeFirstOrThrow()
      await recordInRequest(c, {
        action: 'bulk.started',
        entity: { type: 'bulk_job', id: row.id },
        details: {
          action: row.action,
          selection: 'ids' in selection ? 'ids' : 'filter',
          ...('ids' in selection ? { count: selection.ids.length } : {}),
        },
      })
      // В той же транзакции: откатился запуск — задачи в очереди нет, и наоборот.
      await enqueue(db, { projectId: c.var.projectId, bulkJobId: row.id })
      return c.json<BulkJobSummary>(summary(row), 202)
    })
}
