import { type Database, purgeExpiredFailedSignIns, withProject } from '@alpi/db'
import type { Kysely, Transaction } from 'kysely'
import { fromKysely, PgBoss } from 'pg-boss'
import type { BulkActionRegistry } from '../bulk/registry.ts'
import { BULK_BATCH_SIZE, type BulkJobMessage, failBulkJob, runBulkJob } from '../bulk/runner.ts'
import { scanAllDuplicates, scanDuplicates } from '../duplicates/finder.ts'
import {
  attachDuplicateQueue,
  DUPLICATE_SCAN_QUEUE,
  type DuplicateScanMessage,
  detachDuplicateQueue,
} from '../duplicates/queue.ts'
import { deliverWebhook, failDeadDelivery, type WebhookDeliveryOptions } from '../events/deliver.ts'
import { fanoutEvent } from '../events/fanout.ts'
import {
  attachEventQueue,
  type DeliverQueueOptions,
  type DeliveryMessage,
  detachEventQueue,
  type FanoutMessage,
  WEBHOOK_DELIVER_DEAD_QUEUE,
  WEBHOOK_DELIVER_QUEUE,
  WEBHOOK_DELIVER_QUEUE_OPTIONS,
  WEBHOOK_FANOUT_QUEUE,
} from '../events/queue.ts'
import { FIELD_PURGE_BATCH_SIZE, type FieldPurgeMessage, purgeField } from '../fields/purge.ts'
import { FIELD_RETYPE_BATCH_SIZE, type FieldRetypeMessage, retypeField } from '../fields/retype.ts'
import { type InboundReplayMessage, replayInbound } from '../intake/replay.ts'
import { failInboundReplay } from '../intake/replay-status.ts'
import { purgeTrash, type TrashRegistry } from '../trash/purge.ts'
import {
  buildFieldIndex,
  FIELD_INDEX_BATCH_SIZE,
  type FieldIndexMessage,
  pendingFieldIndexes,
} from './field-index.ts'
import { purgeIdempotencyRecords } from './idempotency-purge.ts'
import { purgeInboundJournal } from './inbound-purge.ts'
import { purgeWebhookLog } from './webhook-purge.ts'

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
// - webhook-fanout — рассылка события по подпискам (events/fanout.ts, тикеты crm-api/05 и 06):
//   задачу ставит запись события той же транзакцией, что изменение; обработчик создаёт доставки
//   на подписанные адреса проекта;
// - webhook-deliver — одна доставка события на адрес (events/deliver.ts, тикет crm-api/06):
//   подпись, отправка, повторы pg-boss; webhook-deliver-dead помечает failed доставку, задача
//   которой исчерпала повторы, не дойдя до итога;
// - webhook-purge — ежедневно: события, доставки и попытки старше 30 дней (webhook-purge.ts).
// - inbound-purge — ежедневно: строки журнала входящих старше 30 дней (inbound-purge.ts, тикет
//   crm-intake/06);
// - inbound-replay — «провести заново входящие с момента T» по запросу администратора
//   (intake/replay.ts): каждая строка журнала проводится той же функцией, что запрос источника;
//   inbound-replay-dead пишет итог «не завершилось» задаче, исчерпавшей повторы (тикет
//   crm-intake/07, intake/replay-status.ts).
// - duplicate-scan — пары дублей одной записи (duplicates/finder.ts, тикет crm-intake/05):
//   задачу ставит изменение записи той же транзакцией (duplicates/queue.ts);
// - duplicate-nightly — ежедневно: все пары дублей каждого проекта заново (duplicates/finder.ts).
//   Надсмотрщик пишет только пары дублей.
// Обработчики событий и доставки работают в withProject проекта из задачи.
// Задачи по расписанию трогают только корзину, журнал входов, ответы Idempotency-Key, журнал
// доставки, журнал входящих и пары дублей и никогда не меняют сделки (ADR 0003).

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
  webhookPurge: 'webhook-purge',
  fieldPurge: 'field-purge',
  fieldRetype: 'field-retype',
  fieldIndex: 'field-index',
  inboundPurge: 'inbound-purge',
  inboundReplay: 'inbound-replay',
  /**
   * Очередь мёртвых задач inbound-replay (тикет crm-intake/07): копия задачи, провалившей все
   * попытки (сбой или истёк срок). Обработчик пишет итог с признаком сбоя, чтобы запуск не
   * выглядел идущим вечно.
   */
  inboundReplayDead: 'inbound-replay-dead',
  duplicateNightly: 'duplicate-nightly',
} as const

/** Время расписания — киевское: ночью, когда в CRM никто не работает. */
const TIMEZONE = 'Europe/Kyiv'
const TRASH_PURGE_CRON = '0 3 * * *'
const SIGN_IN_PURGE_CRON = '30 3 * * *'
const IDEMPOTENCY_PURGE_CRON = '45 3 * * *'
const WEBHOOK_PURGE_CRON = '0 4 * * *'
const INBOUND_PURGE_CRON = '15 4 * * *'
const DUPLICATE_NIGHTLY_CRON = '30 4 * * *'

/**
 * Доставок одновременно в процессе: медленный адрес (до 15 с на попытку) не задерживает
 * остальные.
 */
const WEBHOOK_DELIVER_CONCURRENCY = 5

/** Повторов «провести заново» после сбоя: повтор проводит строки снова, безопасно по event_id. */
const INBOUND_REPLAY_RETRY_LIMIT = 3

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
  /** Повторов «провести заново»; по умолчанию INBOUND_REPLAY_RETRY_LIMIT. Тесты ставят 0. */
  inboundReplayRetryLimit?: number
  /** Как часто опрашивать очередь, с; по умолчанию — как у pg-boss. Тесты ставят 0.5. */
  pollingIntervalSeconds?: number
  /** Ставить расписание и выполнять задачи по нему; по умолчанию да. */
  schedule?: boolean
  /** Сколько остановка ждёт текущих задач, мс. */
  stopTimeoutMs?: number
  /**
   * Доставка событий: ключ шифрования секретов, разрешение http/localhost (только тесты), часы.
   * Без неё доставки не отправляются (нет ключа) и повторяются.
   */
  webhooks?: WebhookDeliveryOptions
  /** Повторы доставки; по умолчанию WEBHOOK_DELIVER_QUEUE_OPTIONS. Тесты укорачивают паузы. */
  webhookQueue?: DeliverQueueOptions
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
  /** Ставит «провести заново входящие» той же транзакцией проекта, что пишет запуск в журнал. */
  enqueueInboundReplay(trx: Transaction<Database>, message: InboundReplayMessage): Promise<void>
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
  await boss.createQueue(QUEUES.webhookPurge, { retryLimit: 3, retryDelay: 15 * 60 })
  await boss.createQueue(QUEUES.inboundPurge, { retryLimit: 3, retryDelay: 15 * 60 })
  // Повтор после сбоя проводит строки снова: безопасно по event_id. Час на задачу — как у
  // массовой операции. Очередь уже есть у баз до тикета crm-intake/07 — createQueue её не
  // меняет, поэтому updateQueue приводит настройки (и очередь мёртвых задач) к нужным.
  await boss.createQueue(QUEUES.inboundReplayDead, { retryLimit: 5, retryDelay: 60 })
  const inboundReplayQueue = {
    retryLimit: options.inboundReplayRetryLimit ?? INBOUND_REPLAY_RETRY_LIMIT,
    retryDelay: 60,
    expireInSeconds: 60 * 60,
    deadLetter: QUEUES.inboundReplayDead,
  }
  await boss.createQueue(QUEUES.inboundReplay, inboundReplayQueue)
  await boss.updateQueue(QUEUES.inboundReplay, inboundReplayQueue)
  // Ночной проход по 100 тыс. контактов — секунды (duplicates/nightly.test.ts); час — с запасом.
  await boss.createQueue(QUEUES.duplicateNightly, {
    retryLimit: 3,
    retryDelay: 15 * 60,
    expireInSeconds: 60 * 60,
  })
  // Очереди событий: рассылку ставит запись события (events/emit.ts), доставки — рассылка и
  // ручной повтор. Очередь поиска дублей ставят изменения контактов, приём и слияние.
  await attachEventQueue(boss, options.webhookQueue ?? WEBHOOK_DELIVER_QUEUE_OPTIONS)
  await attachDuplicateQueue(boss)
  const webhooks: WebhookDeliveryOptions = options.webhooks ?? {
    secretKey: null,
    allowInsecureUrls: false,
  }

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
  await boss.work<FanoutMessage>(WEBHOOK_FANOUT_QUEUE, polling, async (batch) => {
    for (const job of batch) {
      await fanoutEvent(options.db, job.data)
    }
  })
  const deliverWork = {
    ...polling,
    includeMetadata: true as const,
    localConcurrency: WEBHOOK_DELIVER_CONCURRENCY,
  }
  await boss.work<DeliveryMessage, void, typeof deliverWork>(
    WEBHOOK_DELIVER_QUEUE,
    deliverWork,
    async ([job]) => {
      if (job) await deliverWebhook(options.db, webhooks, job)
    },
  )
  await boss.work<DeliveryMessage>(WEBHOOK_DELIVER_DEAD_QUEUE, polling, async (batch) => {
    for (const job of batch) {
      await failDeadDelivery(options.db, job.data)
    }
  })
  await boss.work(QUEUES.webhookPurge, polling, async () => {
    await purgeWebhookLog(options.db)
  })
  await boss.work(QUEUES.inboundPurge, polling, async () => {
    await purgeInboundJournal(options.db)
  })
  await boss.work<InboundReplayMessage>(QUEUES.inboundReplay, polling, async (batch) => {
    for (const job of batch) {
      await replayInbound(options.db, job.data)
    }
  })
  await boss.work<InboundReplayMessage>(QUEUES.inboundReplayDead, polling, async (batch) => {
    for (const job of batch) {
      await failInboundReplay(options.db, job.data)
    }
  })
  await boss.work<DuplicateScanMessage>(DUPLICATE_SCAN_QUEUE, polling, async (batch) => {
    for (const job of batch) {
      await scanDuplicates(options.db, job.data)
    }
  })
  await boss.work(QUEUES.duplicateNightly, polling, async () => {
    await scanAllDuplicates(options.db)
  })
  for (const message of await pendingFieldIndexes(options.db)) {
    await boss.send(QUEUES.fieldIndex, message, { singletonKey: message.fieldId })
  }
  if (schedule) {
    await boss.schedule(QUEUES.trashPurge, TRASH_PURGE_CRON, null, { tz: TIMEZONE })
    await boss.schedule(QUEUES.signInPurge, SIGN_IN_PURGE_CRON, null, { tz: TIMEZONE })
    await boss.schedule(QUEUES.idempotencyPurge, IDEMPOTENCY_PURGE_CRON, null, { tz: TIMEZONE })
    await boss.schedule(QUEUES.webhookPurge, WEBHOOK_PURGE_CRON, null, { tz: TIMEZONE })
    await boss.schedule(QUEUES.inboundPurge, INBOUND_PURGE_CRON, null, { tz: TIMEZONE })
    await boss.schedule(QUEUES.duplicateNightly, DUPLICATE_NIGHTLY_CRON, null, { tz: TIMEZONE })
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
    async enqueueInboundReplay(trx, message) {
      await boss.send(QUEUES.inboundReplay, message, { db: fromKysely(trx) })
    },
    async stop() {
      // Очередь событий отключается только после остановки: штатная остановка дожидается
      // текущих обработчиков, а они пишут события (массовая операция, передача сделок) и
      // ставят доставки (рассылка). Отключить раньше — их записи падали бы и навсегда уходили
      // в журнал ошибок операции. Текущие доставки остановка тоже дожидается (попытка — до
      // 15 с); не дождалась — сигнал задачи обрывает запрос, доставка повторится.
      try {
        await boss.stop({ graceful: true, timeout: options.stopTimeoutMs ?? 30_000 })
      } finally {
        detachEventQueue(boss)
        detachDuplicateQueue(boss)
      }
    },
  }
}

/**
 * pg-boss только для постановки задач событий и поиска дублей, без обработчиков и расписания:
 * для процессов без фоновых задач (тесты API, testing/api-harness.ts). Остановка отключает обе
 * очереди.
 */
export async function startEventQueue(
  connectionString: string,
): Promise<{ stop(): Promise<void> }> {
  const boss = new PgBoss({
    connectionString,
    schema: PGBOSS_SCHEMA,
    application_name: 'alpi-api-events',
    max: 2,
    migrate: false,
    createSchema: false,
    schedule: false,
    supervise: false,
  })
  boss.on('error', (error) => {
    console.error('pg-boss (события):', error)
  })
  await boss.start()
  await attachEventQueue(boss)
  await attachDuplicateQueue(boss)
  return {
    async stop() {
      try {
        await boss.stop({ graceful: false, timeout: 5_000 })
      } finally {
        detachEventQueue(boss)
        detachDuplicateQueue(boss)
      }
    },
  }
}
