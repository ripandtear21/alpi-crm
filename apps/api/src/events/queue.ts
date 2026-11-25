import type { Database } from '@alpi/db'
import type { Kysely } from 'kysely'
import { fromKysely, type PgBoss } from 'pg-boss'

// Очереди событий (тикеты crm-api/05 и 06):
// - `webhook-fanout` — «разослать событие по подпискам»: задачу ставит запись события той же
//   транзакцией, что строка webhook_event (emit.ts), через `fromKysely(trx)` — откат транзакции
//   откатывает и задачу. Обработчик — events/fanout.ts.
// - `webhook-deliver` — одна доставка события на один адрес (events/deliver.ts). Задачи ставит
//   рассылка и ручной повтор из журнала (webhook-endpoints/routes.ts) — тоже в своей транзакции.
//   Повторы — встроенные pg-boss (настройки ниже).
// - `webhook-deliver-dead` — копия задачи доставки, исчерпавшей повторы без ответа обработчика
//   (процесс убит, срок задачи истёк): обработчик помечает доставку failed.
//
// Очереди одни на процесс, как и сам pg-boss: функцию записи события зовут из любого эпика с
// одной транзакцией проекта, не протаскивая очередь через контексты сделок, контактов и
// массовых операций. Подключает их startJobs (jobs/jobs.ts) — тем же pg-boss, что фоновые
// задачи; тесты API без фоновых задач — startEventQueue (testing/api-harness.ts). Не подключена —
// запись события падает и откатывает изменение: изменение без события хуже ошибки.

export const WEBHOOK_FANOUT_QUEUE = 'webhook-fanout'
export const WEBHOOK_DELIVER_QUEUE = 'webhook-deliver'
export const WEBHOOK_DELIVER_DEAD_QUEUE = 'webhook-deliver-dead'

/** Задача очереди webhook-fanout: событие и его проект (обработчик работает в withProject). */
export interface FanoutMessage {
  projectId: string
  eventId: string
}

/** Задача очереди webhook-deliver: доставка и её проект. */
export interface DeliveryMessage {
  projectId: string
  deliveryId: string
}

/** Повторы и срок задачи доставки. */
export interface DeliverQueueOptions {
  retryLimit: number
  /** Пауза перед первым повтором, с. */
  retryDelay: number
  retryBackoff: boolean
  /** Потолок паузы, с. */
  retryDelayMax?: number
  /** Срок одной попытки для pg-boss, с: таймаут запроса и запас. */
  expireInSeconds: number
}

/**
 * Повторы доставки: 20 повторов, пауза от 10 с, растёт вдвое (со случайной добавкой) до потолка
 * 6 ч — около 2,5–3 суток (расчёт исследования docs/research/webhook-delivery.md, раздел 2.2,
 * прогоном не проверен; решено без владельца — подтвердить). Срок задачи — 60 с: таймаут
 * запроса 15 с и запас.
 */
export const WEBHOOK_DELIVER_QUEUE_OPTIONS: DeliverQueueOptions = {
  retryLimit: 20,
  retryDelay: 10,
  retryBackoff: true,
  retryDelayMax: 6 * 60 * 60,
  expireInSeconds: 60,
}

/**
 * Рассылка — запросы только в базу: несколько быстрых повторов на случай сбоя базы; срок —
 * 5 минут (тысячи адресов в проекте не ожидаются).
 */
const FANOUT_QUEUE_OPTIONS = {
  retryLimit: 5,
  retryDelay: 10,
  retryBackoff: true,
  retryDelayMax: 60 * 60,
  expireInSeconds: 5 * 60,
}

/** Создаёт очередь или, если она есть, приводит её настройки к `options`. */
async function ensureQueue(
  boss: PgBoss,
  name: string,
  options: Omit<DeliverQueueOptions, 'retryDelayMax'> & {
    retryDelayMax?: number
    deadLetter?: string
  },
): Promise<void> {
  await boss.createQueue(name, options)
  await boss.updateQueue(name, { ...options, retryDelayMax: options.retryDelayMax ?? null })
}

/** Подключённые pg-boss; задачи ставит последний. Отключение возвращает предыдущий. */
const attached: PgBoss[] = []

/**
 * Создаёт очереди событий (есть — приводит их настройки к нужным) и ставит задачи событий через
 * `boss`. `deliver` — повторы доставки; тесты укорачивают паузы.
 */
export async function attachEventQueue(
  boss: PgBoss,
  deliver: DeliverQueueOptions = WEBHOOK_DELIVER_QUEUE_OPTIONS,
): Promise<void> {
  await ensureQueue(boss, WEBHOOK_DELIVER_DEAD_QUEUE, {
    retryLimit: 5,
    retryDelay: 60,
    retryBackoff: false,
    expireInSeconds: 60,
  })
  await ensureQueue(boss, WEBHOOK_FANOUT_QUEUE, FANOUT_QUEUE_OPTIONS)
  await ensureQueue(boss, WEBHOOK_DELIVER_QUEUE, {
    ...deliver,
    deadLetter: WEBHOOK_DELIVER_DEAD_QUEUE,
  })
  attached.push(boss)
}

/**
 * Отключает `boss` после его остановки: штатная остановка pg-boss дожидается текущих
 * обработчиков, и их события ставятся ещё через него.
 */
export function detachEventQueue(boss: PgBoss): void {
  const index = attached.lastIndexOf(boss)
  if (index !== -1) attached.splice(index, 1)
}

function currentBoss(): PgBoss {
  const boss = attached.at(-1)
  if (boss === undefined) {
    throw new Error('очередь событий не подключена: attachEventQueue (events/queue.ts)')
  }
  return boss
}

/** Ставит задачу рассылки события транзакцией `trx` — той же, что записала событие. */
export async function enqueueFanout(trx: Kysely<Database>, message: FanoutMessage): Promise<void> {
  await currentBoss().send(WEBHOOK_FANOUT_QUEUE, message, { db: fromKysely(trx) })
}

/** Ставит доставки транзакцией `trx` — той же, что создала или вернула их в pending. */
export async function enqueueDeliveries(
  trx: Kysely<Database>,
  messages: readonly DeliveryMessage[],
): Promise<void> {
  if (messages.length === 0) return
  await currentBoss().insert(
    WEBHOOK_DELIVER_QUEUE,
    messages.map((data) => ({ data })),
    { db: fromKysely(trx) },
  )
}
