import { type Database, purgeExpiredFailedSignIns, withProject } from '@alpi/db'
import type { Kysely, Transaction } from 'kysely'
import { fromKysely, PgBoss } from 'pg-boss'
import type { BulkActionRegistry } from '../bulk/registry.ts'
import { BULK_BATCH_SIZE, type BulkJobMessage, failBulkJob, runBulkJob } from '../bulk/runner.ts'
import { FIELD_PURGE_BATCH_SIZE, type FieldPurgeMessage, purgeField } from '../fields/purge.ts'
import { FIELD_RETYPE_BATCH_SIZE, type FieldRetypeMessage, retypeField } from '../fields/retype.ts'
import { purgeTrash, type TrashRegistry } from '../trash/purge.ts'
import {
  buildFieldIndex,
  FIELD_INDEX_BATCH_SIZE,
  type FieldIndexMessage,
  pendingFieldIndexes,
} from './field-index.ts'
import { purgeIdempotencyRecords } from './idempotency-purge.ts'

// Фоновые задачи на pg-boss (тикет crm-deals/04). Обработчик работает в процессе API (решено без
// владельца, подтвердить; отдельный процесс — эпик эксплуатации) и ходит в базу той же ролью
// приложения, что и API: схему pgboss и её права создаёт миграция 0007_jobs_bulk под служебной
// ролью, поэтому pg-boss запускается с migrate: false и только сверяет версию схемы.
//
// Задачи:
// - bulk-job — массовая операция проекта (bulk/runner.ts), каждая порция — в withProject;
// - trash-purge — ежедневно: окончательное удаление из корзины старше 30 дней (trash/purge.ts),
//   проекты по одному, каждый в своём withProject;
// - failed-sign-in-purge — ежедневно: записи о неудачных входах старше 90 дней (служебная
//   функция базы, packages/db/src/audit.ts);
// - idempotency-purge — ежедневно: ответы для повтора по Idempotency-Key старше 24 часов
//   (idempotency-purge.ts, тикет crm-api/02), проекты по одному, каждый в своём withProject;
// - field-purge — окончательное удаление пользовательского поля по запросу администратора
//   (fields/purge.ts): ключ поля уходит из `custom` записей порциями, потом описание;
// - field-retype — смена типа поля с данными по запросу администратора (fields/retype.ts):
//   значения в `custom` переписываются порциями, потом поле получает новый тип;
// - field-index — копия значений поля с отметкой «часто фильтруют» для быстрого фильтра
//   (field-index.ts, тикет crm-fields/07). При старте задача ставится заново всем полям, у
//   которых копия строится (отмеченные служебными скриптами, потерявшие задачу).
// Задачи по расписанию трогают только корзину, журнал входов и ответы Idempotency-Key и никогда
// не меняют сделки (ADR 0003).

/** Схема таблиц pg-boss; та же константа — в packages/db/migrations/0007_jobs_bulk.ts. */
export const PGBOSS_SCHEMA = 'pgboss'

export const QUEUES = {
  bulk: 'bulk-job',
  /**
   * Очередь мёртвых задач bulk-job: сюда pg-boss кладёт копию задачи, которая провалила все
   * попытки — и упав с ошибкой, и когда процесс убит, а срок задачи истёк (тот же путь в
   * pg-boss). Её обработчик помечает операцию failed, чтобы она не осталась «идёт» навсегда.
   */
  bulkDead: 'bulk-job-dead',
  trashPurge: 'trash-purge',
  signInPurge: 'failed-sign-in-purge',
  idempotencyPurge: 'idempotency-purge',
  fieldPurge: 'field-purge',
  fieldRetype: 'field-retype',
  fieldIndex: 'field-index',
} as const

/** Время расписания — киевское: ночью, когда в CRM никто не работает. */
const TIMEZONE = 'Europe/Kyiv'
const TRASH_PURGE_CRON = '0 3 * * *'
const SIGN_IN_PURGE_CRON = '30 3 * * *'
const IDEMPOTENCY_PURGE_CRON = '45 3 * * *'

/** Повторов массовой операции после сбоя: каждая продолжает с первой необработанной записи. */
const BULK_RETRY_LIMIT = 5
/** Пауза перед первым повтором, с; дальше растёт (retryBackoff). */
const BULK_RETRY_DELAY = 30

export interface JobsOptions {
  /** Строка подключения ролью приложения (та же DATABASE_URL, что у API). */
  connectionString: string
  /** Подключение ролью приложения: задачи данных проекта идут через withProject. */
  db: Kysely<Database>
  bulkActions: BulkActionRegistry
  trashPurgers: TrashRegistry
  bulkBatchSize?: number
  /** Записей в порции окончательного удаления поля; по умолчанию FIELD_PURGE_BATCH_SIZE. */
  fieldPurgeBatchSize?: number
  /** Записей в порции смены типа поля; по умолчанию FIELD_RETYPE_BATCH_SIZE. */
  fieldRetypeBatchSize?: number
  /** Записей в порции копии «часто фильтруют»; по умолчанию FIELD_INDEX_BATCH_SIZE. */
  fieldIndexBatchSize?: number
  /** Повторов массовой операции; по умолчанию BULK_RETRY_LIMIT. Тесты ставят 0. */
  bulkRetryLimit?: number
  /** Как часто опрашивать очередь, с; по умолчанию — как у pg-boss. Тесты ставят 0.5. */
  pollingIntervalSeconds?: number
  /** Ставить расписание и выполнять задачи по нему; по умолчанию да. */
  schedule?: boolean
  /** Сколько остановка ждёт текущих задач, мс. */
  stopTimeoutMs?: number
}

export interface Jobs {
  boss: PgBoss
  /** Ставит массовую операцию в очередь той же транзакцией проекта, что создала bulk_job. */
  enqueueBulk(trx: Transaction<Database>, message: BulkJobMessage): Promise<void>
  /** Ставит окончательное удаление поля в очередь той же транзакцией проекта, что его запросила. */
  enqueueFieldPurge(trx: Transaction<Database>, message: FieldPurgeMessage): Promise<void>
  /** Ставит смену типа поля с данными в очередь той же транзакцией проекта, что её запросила. */
  enqueueFieldRetype(trx: Transaction<Database>, message: FieldRetypeMessage): Promise<void>
  /** Ставит построение копии «часто фильтруют» той же транзакцией проекта, что отметила поле. */
  enqueueFieldIndex(trx: Transaction<Database>, message: FieldIndexMessage): Promise<void>
  /** Перестаёт брать задачи и дожидается текущих (не дольше stopTimeoutMs). Повторный вызов — тот же. */
  stop(): Promise<void>
}

export async function startJobs(options: JobsOptions): Promise<Jobs> {
  const schedule = options.schedule ?? true
  const boss = new PgBoss({
    connectionString: options.connectionString,
    schema: PGBOSS_SCHEMA,
    application_name: 'alpi-api-jobs',
    max: 4,
    migrate: false,
    createSchema: false,
    schedule,
  })
  boss.on('error', (error) => {
    console.error('pg-boss:', error)
  })
  await boss.start()

  const polling =
    options.pollingIntervalSeconds === undefined
      ? {}
      : { pollingIntervalSeconds: options.pollingIntervalSeconds }

  // shortcut: одна операция ждёт не дольше часа — потом pg-boss считает задачу зависшей и
  // повторяет её с той же записи; поднять срок, если операции на сотни тысяч записей станут нормой.
  await boss.createQueue(QUEUES.bulkDead, { retryLimit: 5, retryDelay: 60 })
  await boss.createQueue(QUEUES.bulk, {
    retryLimit: options.bulkRetryLimit ?? BULK_RETRY_LIMIT,
    retryDelay: BULK_RETRY_DELAY,
    retryBackoff: true,
    expireInSeconds: 60 * 60,
    deadLetter: QUEUES.bulkDead,
  })
  await boss.createQueue(QUEUES.trashPurge, { retryLimit: 3, retryDelay: 15 * 60 })
  await boss.createQueue(QUEUES.signInPurge, { retryLimit: 3, retryDelay: 15 * 60 })
  await boss.createQueue(QUEUES.idempotencyPurge, { retryLimit: 3, retryDelay: 15 * 60 })
  await boss.createQueue(QUEUES.fieldPurge, { retryLimit: 5, retryDelay: 60, retryBackoff: true })
  await boss.createQueue(QUEUES.fieldRetype, { retryLimit: 5, retryDelay: 60, retryBackoff: true })
  // Ошибку построения задача пишет полю сама (failed) и не повторяется.
  await boss.createQueue(QUEUES.fieldIndex, { retryLimit: 2, retryDelay: 60 })

  await boss.work<BulkJobMessage>(QUEUES.bulk, polling, async (batch) => {
    for (const job of batch) {
      await runBulkJob(options.db, options.bulkActions, job.data, {
        batchSize: options.bulkBatchSize ?? BULK_BATCH_SIZE,
        signal: job.signal,
      })
    }
  })
  await boss.work<BulkJobMessage>(QUEUES.bulkDead, polling, async (batch) => {
    for (const job of batch) {
      await withProject(options.db, job.data.projectId, (trx) =>
        failBulkJob(trx, job.data.bulkJobId, 'PROCESSING_FAILED'),
      )
    }
  })
  await boss.work(QUEUES.trashPurge, polling, async () => {
    await purgeTrash(options.db, options.trashPurgers)
  })
  await boss.work(QUEUES.signInPurge, polling, async () => {
    await purgeExpiredFailedSignIns(options.db)
  })
  await boss.work(QUEUES.idempotencyPurge, polling, async () => {
    await purgeIdempotencyRecords(options.db)
  })
  await boss.work<FieldPurgeMessage>(QUEUES.fieldPurge, polling, async (batch) => {
    for (const job of batch) {
      await purgeField(options.db, job.data, options.fieldPurgeBatchSize ?? FIELD_PURGE_BATCH_SIZE)
    }
  })
  await boss.work<FieldRetypeMessage>(QUEUES.fieldRetype, polling, async (batch) => {
    for (const job of batch) {
      await retypeField(
        options.db,
        job.data,
        options.fieldRetypeBatchSize ?? FIELD_RETYPE_BATCH_SIZE,
      )
    }
  })
  await boss.work<FieldIndexMessage>(QUEUES.fieldIndex, polling, async (batch) => {
    for (const job of batch) {
      await buildFieldIndex(
        options.db,
        job.data,
        options.fieldIndexBatchSize ?? FIELD_INDEX_BATCH_SIZE,
      )
    }
  })
  for (const message of await pendingFieldIndexes(options.db)) {
    await boss.send(QUEUES.fieldIndex, message, { singletonKey: message.fieldId })
  }
  if (schedule) {
    await boss.schedule(QUEUES.trashPurge, TRASH_PURGE_CRON, null, { tz: TIMEZONE })
    await boss.schedule(QUEUES.signInPurge, SIGN_IN_PURGE_CRON, null, { tz: TIMEZONE })
    await boss.schedule(QUEUES.idempotencyPurge, IDEMPOTENCY_PURGE_CRON, null, { tz: TIMEZONE })
  }

  return {
    boss,
    async enqueueBulk(trx, message) {
      await boss.send(QUEUES.bulk, message, {
        db: fromKysely(trx),
        singletonKey: message.bulkJobId,
      })
    },
    async enqueueFieldPurge(trx, message) {
      await boss.send(QUEUES.fieldPurge, message, {
        db: fromKysely(trx),
        singletonKey: message.fieldId,
      })
    },
    async enqueueFieldRetype(trx, message) {
      await boss.send(QUEUES.fieldRetype, message, {
        db: fromKysely(trx),
        singletonKey: message.fieldId,
      })
    },
    async enqueueFieldIndex(trx, message) {
      await boss.send(QUEUES.fieldIndex, message, {
        db: fromKysely(trx),
        singletonKey: message.fieldId,
      })
    },
    stop: () => boss.stop({ graceful: true, timeout: options.stopTimeoutMs ?? 30_000 }),
  }
}
