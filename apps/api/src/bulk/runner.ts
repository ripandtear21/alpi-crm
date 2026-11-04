import { type Database, withProject } from '@alpi/db'
import { can, hasStandalone } from '@alpi/shared'
import { type Kysely, sql, type Transaction } from 'kysely'
import { loadMemberAccess, type MemberAccess } from '../roles/access.ts'
import { PROJECT_TEAMS, resolveViewer } from '../roles/scope.ts'
import {
  type BulkAction,
  type BulkActionRegistry,
  type BulkContext,
  BulkRecordError,
} from './registry.ts'

// Выполнение массовой операции (тикет crm-deals/04). Вызывает обработчик очереди pg-boss
// (apps/api/src/jobs/jobs.ts); каждая порция — своя транзакция проекта (withProject), поэтому
// прогресс виден по мере работы, а повтор задачи после сбоя продолжает с первой
// необработанной записи: изменения порции и её прогресс фиксируются вместе.

/** Сообщение очереди: какая операция какого проекта. */
export interface BulkJobMessage {
  projectId: string
  bulkJobId: string
}

/** Записей в порции. */
export const BULK_BATCH_SIZE = 100

/** Наибольшая длина текста ошибки в журнале (столбец bulk_job_error.message). */
const MAX_MESSAGE = 500
/** Пределы столбцов bulk_job_error (migrations/0007_jobs_bulk.ts). */
const MAX_RECORD_ID = 100
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,59}$/

/**
 * Почему операция остановилась целиком (`bulk_job.failure`): коды для клиента.
 * - ACTION_NOT_REGISTERED — действия больше нет в реестре;
 * - PERMISSION_DENIED — фильтр нечем развернуть: у инициатора нет прав на действие;
 * - INITIATOR_BANNED — учётную запись инициатора заблокировал владелец системы;
 * - PROCESSING_FAILED — задача упала после всех повторов pg-boss (в том числе процесс убит, и
 *   срок задачи истёк): её отметку ставит обработчик очереди мёртвых задач (jobs/jobs.ts).
 */
export type BulkJobFailure =
  | 'ACTION_NOT_REGISTERED'
  | 'PERMISSION_DENIED'
  | 'INITIATOR_BANNED'
  | 'PROCESSING_FAILED'

export interface RunOptions {
  batchSize?: number
  /** Сигнал остановки обработчика: проверяется между порциями. */
  signal?: AbortSignal
}

/**
 * Выполняет операцию до конца. Закончилась (`done`) или остановлена целиком (`failed`) —
 * повторный вызов ничего не делает. Ошибка базы или действия вне записи (например, в
 * `inScope`) пробрасывается: порция откатывается, и повтор задачи начнёт её заново.
 */
export async function runBulkJob(
  db: Kysely<Database>,
  actions: BulkActionRegistry,
  message: BulkJobMessage,
  options: RunOptions = {},
): Promise<void> {
  const batchSize = options.batchSize ?? BULK_BATCH_SIZE
  const action = await withProject(db, message.projectId, (trx) =>
    prepare(trx, actions, message.bulkJobId),
  )
  if (!action) return
  while (
    await withProject(db, message.projectId, (trx) =>
      runPortion(trx, action, message.bulkJobId, batchSize),
    )
  ) {
    if (options.signal?.aborted) {
      throw new Error('обработчик остановлен: операция продолжится с той же записи при повторе')
    }
  }
}

/** Останавливает операцию целиком; законченную (`done`, `failed`) не трогает. */
export async function failBulkJob(
  trx: Transaction<Database>,
  bulkJobId: string,
  failure: BulkJobFailure,
): Promise<void> {
  await trx
    .updateTable('bulk_job')
    .set({ status: 'failed', failure, finished_at: sql`now()` })
    .where('id', '=', bulkJobId)
    .where('status', 'in', ['queued', 'running'])
    .execute()
}

/** Разворачивает выбор в список записей при первом запуске; null — делать нечего. */
async function prepare(
  trx: Transaction<Database>,
  actions: BulkActionRegistry,
  bulkJobId: string,
): Promise<BulkAction | null> {
  const job = await trx
    .selectFrom('bulk_job')
    .select(['id', 'initiator_id', 'action', 'selection', 'params', 'record_ids', 'status'])
    .where('id', '=', bulkJobId)
    .forUpdate()
    .executeTakeFirst()
  if (!job || job.status === 'done' || job.status === 'failed') return null
  const action = actions.get(job.action)
  if (!action) {
    await failBulkJob(trx, job.id, 'ACTION_NOT_REGISTERED')
    return null
  }
  if (await isBanned(trx, job.initiator_id)) {
    await failBulkJob(trx, job.id, 'INITIATOR_BANNED')
    return null
  }
  if (job.record_ids !== null) return action

  let ids: string[]
  const selection = job.selection
  if (Array.isArray(selection.ids)) {
    ids = selection.ids.map(String)
  } else {
    // Фильтр разворачивается правами инициатора на момент старта.
    const access = await loadMemberAccess(trx, job.initiator_id)
    if (!access || !allowed(access, action)) {
      await failBulkJob(trx, job.id, 'PERMISSION_DENIED')
      return null
    }
    const ctx = await context(trx, job, access)
    ids = await action.select(trx, (selection.filter ?? {}) as Record<string, unknown>, ctx)
  }
  ids = [...new Set(ids)]
  await trx
    .updateTable('bulk_job')
    .set({
      record_ids: ids,
      total: ids.length,
      status: 'running',
      started_at: sql`now()`,
      ...(ids.length === 0 ? { status: 'done', finished_at: sql`now()` } : {}),
    })
    .where('id', '=', job.id)
    .execute()
  return ids.length === 0 ? null : action
}

/** Одна порция; true — записи ещё остались. */
async function runPortion(
  trx: Transaction<Database>,
  action: BulkAction,
  bulkJobId: string,
  batchSize: number,
): Promise<boolean> {
  const job = await trx
    .selectFrom('bulk_job')
    .select([
      'id',
      'project_id',
      'initiator_id',
      'params',
      'status',
      'processed',
      'total',
      // Массивы PostgreSQL нумеруются с 1, срез [a:b] включает обе границы.
      sql<string[] | null>`record_ids[processed + 1 : processed + ${batchSize}]`.as('portion'),
    ])
    .where('id', '=', bulkJobId)
    .forUpdate()
    .executeTakeFirst()
  if (job?.status !== 'running') return false
  // Заблокированный пользователь не действует нигде: операция останавливается целиком.
  if (await isBanned(trx, job.initiator_id)) {
    await failBulkJob(trx, job.id, 'INITIATOR_BANNED')
    return false
  }
  const portion = job.portion ?? []
  const errors: { position: number; record_id: string; code: string; message: string | null }[] = []
  const fail = (index: number, code: string, message: string | null = null) => {
    // Код и id приходят и от действия: приводим к пределам столбцов, иначе вставка журнала
    // падала бы и роняла порцию на каждом повторе. Неподходящий код — FAILED, сам он — в тексте.
    const valid = ERROR_CODE.test(code)
    const text = valid ? message : [code, message].filter(Boolean).join(': ')
    errors.push({
      position: job.processed + index,
      record_id: (portion[index] ?? '').slice(0, MAX_RECORD_ID),
      code: valid ? code : 'FAILED',
      message: text ? text.slice(0, MAX_MESSAGE) : null,
    })
  }

  // Права — по текущей роли инициатора: роль могли сменить или участие отключить.
  const access = await loadMemberAccess(trx, job.initiator_id)
  if (!access || !allowed(access, action)) {
    portion.forEach((_, i) => {
      fail(i, 'PERMISSION_DENIED')
    })
  } else {
    const ctx = await context(trx, job, access)
    const inScope = await action.inScope(trx, portion, ctx)
    for (const [i, id] of portion.entries()) {
      if (!inScope.has(id)) {
        fail(i, 'OUT_OF_SCOPE')
        continue
      }
      // Точка сохранения на запись: ошибка откатывает только её изменения.
      await sql`savepoint bulk_record`.execute(trx)
      try {
        await action.apply(trx, id, ctx)
      } catch (error) {
        await sql`rollback to savepoint bulk_record`.execute(trx)
        if (error instanceof BulkRecordError) {
          fail(i, error.code, error.message === error.code ? null : error.message)
        } else {
          // Текст чужой ошибки (базы, библиотеки) пользователю не показываем: он в журнале сервера.
          console.error(`массовая операция ${job.id}: запись ${id}`, error)
          fail(i, 'FAILED')
        }
      }
      await sql`release savepoint bulk_record`.execute(trx)
    }
  }

  if (errors.length > 0) {
    await trx
      .insertInto('bulk_job_error')
      .values(errors.map((e) => ({ ...e, project_id: job.project_id, bulk_job_id: job.id })))
      .execute()
  }
  const processed = job.processed + portion.length
  const finished = portion.length === 0 || processed >= (job.total ?? 0)
  await trx
    .updateTable('bulk_job')
    .set((eb) => ({
      processed,
      failed: eb('failed', '+', errors.length),
      ...(finished ? { status: 'done' as const, finished_at: sql`now()` } : {}),
    }))
    .where('id', '=', job.id)
    .execute()
  return !finished
}

async function isBanned(trx: Transaction<Database>, userId: string): Promise<boolean> {
  const user = await trx
    .selectFrom('user')
    .select('banned')
    .where('id', '=', userId)
    .executeTakeFirst()
  return user?.banned ?? true
}

function allowed(access: MemberAccess, action: BulkAction): boolean {
  return (
    hasStandalone(access.permissions, action.standalone ?? 'bulk_operations') &&
    can(access.permissions, action.requires.resource, action.requires.action)
  )
}

async function context(
  trx: Transaction<Database>,
  job: { id: string; initiator_id: string; params: Record<string, unknown> },
  access: MemberAccess,
): Promise<BulkContext> {
  return {
    bulkJobId: job.id,
    initiatorId: job.initiator_id,
    access,
    viewer: await resolveViewer(trx, job.initiator_id, PROJECT_TEAMS),
    params: job.params,
  }
}
