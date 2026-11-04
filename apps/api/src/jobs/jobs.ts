import { type Database, purgeExpiredFailedSignIns, withProject } from '@alpi/db'
import type { Kysely, Transaction } from 'kysely'
import { fromKysely, PgBoss } from 'pg-boss'
import type { BulkActionRegistry } from '../bulk/registry.ts'
import { BULK_BATCH_SIZE, type BulkJobMessage, failBulkJob, runBulkJob } from '../bulk/runner.ts'
import { purgeTrash, type TrashRegistry } from '../trash/purge.ts'

// Фоновые задачи на pg-boss (тикет crm-deals/04). Обработчик работает в процессе API (решено без
// владельца, подтвердить; отдельный процесс — эпик эксплуатации) и ходит в базу той же ролью
// приложения, что и API: схему pgboss и её права создаёт миграция 0009_jobs_bulk под служебной
// ролью, поэтому pg-boss запускается с migrate: false и только сверяет версию схемы.
//
// Задачи:
// - bulk-job — массовая операция проекта (bulk/runner.ts), каждая порция — в withProject;
// - trash-purge — ежедневно: окончательное удаление из корзины старше 30 дней (trash/purge.ts),
//   проекты по одному, каждый в своём withProject;
// - failed-sign-in-purge — ежедневно: записи о неудачных входах старше 90 дней (служебная
//   функция базы, packages/db/src/audit.ts).
// Задачи по расписанию трогают только корзину и журнал входов и никогда не меняют сделки
// (ADR 0003).

/** Схема таблиц pg-boss; та же константа — в packages/db/migrations/0009_jobs_bulk.ts. */
export const PGBOSS_SCHEMA = 'pgboss'

export const QUEUES = {
  bulk: 'bulk-job',
  trashPurge: 'trash-purge',
  signInPurge: 'failed-sign-in-purge',
} as const

/** Время расписания — киевское: ночью, когда в CRM никто не работает. */
const TIMEZONE = 'Europe/Kyiv'
const TRASH_PURGE_CRON = '0 3 * * *'
const SIGN_IN_PURGE_CRON = '30 3 * * *'

/** Повторов массовой операции после сбоя: каждая продолжает с первой необработанной записи. */
const BULK_RETRY_LIMIT = 5

export interface JobsOptions {
  /** Строка подключения ролью приложения (та же DATABASE_URL, что у API). */
  connectionString: string
  /** Подключение ролью приложения: задачи данных проекта идут через withProject. */
  db: Kysely<Database>
  bulkActions: BulkActionRegistry
  trashPurgers: TrashRegistry
  bulkBatchSize?: number
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
  await boss.createQueue(QUEUES.bulk, {
    retryLimit: BULK_RETRY_LIMIT,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 60 * 60,
  })
  await boss.createQueue(QUEUES.trashPurge, { retryLimit: 3, retryDelay: 15 * 60 })
  await boss.createQueue(QUEUES.signInPurge, { retryLimit: 3, retryDelay: 15 * 60 })

  await boss.work<BulkJobMessage>(QUEUES.bulk, polling, async (batch) => {
    for (const job of batch) {
      try {
        await runBulkJob(options.db, options.bulkActions, job.data, {
          batchSize: options.bulkBatchSize ?? BULK_BATCH_SIZE,
          signal: job.signal,
        })
      } catch (error) {
        // Последняя попытка: операция не должна навсегда остаться «идёт».
        if (job.retryCount >= BULK_RETRY_LIMIT) {
          await withProject(options.db, job.data.projectId, (trx) =>
            failBulkJob(trx, job.data.bulkJobId, 'сбой обработки после всех повторов'),
          ).catch((failError: unknown) => {
            console.error(`массовая операция ${job.data.bulkJobId} не помечена`, failError)
          })
        }
        throw error
      }
    }
  })
  await boss.work(QUEUES.trashPurge, polling, async () => {
    await purgeTrash(options.db, options.trashPurgers)
  })
  await boss.work(QUEUES.signInPurge, polling, async () => {
    await purgeExpiredFailedSignIns(options.db)
  })
  if (schedule) {
    await boss.schedule(QUEUES.trashPurge, TRASH_PURGE_CRON, null, { tz: TIMEZONE })
    await boss.schedule(QUEUES.signInPurge, SIGN_IN_PURGE_CRON, null, { tz: TIMEZONE })
  }

  return {
    boss,
    async enqueueBulk(trx, message) {
      await boss.send(QUEUES.bulk, message, {
        db: fromKysely(trx),
        singletonKey: message.bulkJobId,
      })
    },
    stop: () => boss.stop({ graceful: true, timeout: options.stopTimeoutMs ?? 30_000 }),
  }
}
