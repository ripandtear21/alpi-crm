import type { Database } from '@alpi/db'
import type { Kysely } from 'kysely'
import { fromKysely, type PgBoss } from 'pg-boss'

// Очередь `webhook-fanout` (тикет crm-api/05): задача «разослать событие по подпискам» ставится
// той же транзакцией, что строка webhook_event (emit.ts), через `fromKysely(trx)` — откат
// транзакции откатывает и задачу. Своего опрашивающего процесса нет. Обработчика очереди здесь
// тоже нет — его добавляет доставка (тикет 06); до него задачи лежат в очереди.
//
// Очередь одна на процесс, как и сам pg-boss: функцию записи события зовут из любого эпика с
// одной транзакцией проекта, не протаскивая очередь через контексты сделок, контактов и
// массовых операций. Подключает её startJobs (jobs/jobs.ts) — тем же pg-boss, что фоновые
// задачи; тесты API без фоновых задач — startEventQueue (testing/api-harness.ts). Не подключена —
// запись события падает и откатывает изменение: изменение без события хуже ошибки.

export const WEBHOOK_FANOUT_QUEUE = 'webhook-fanout'

/** Задача очереди webhook-fanout. */
export interface FanoutMessage {
  eventId: string
}

/** Подключённые pg-boss; задачи ставит последний. Отключение возвращает предыдущий. */
const attached: PgBoss[] = []

/** Создаёт очередь (повторно — ничего не меняет) и ставит задачи событий через `boss`. */
export async function attachEventQueue(boss: PgBoss): Promise<void> {
  await boss.createQueue(WEBHOOK_FANOUT_QUEUE)
  attached.push(boss)
}

/** Отключает `boss` перед его остановкой. */
export function detachEventQueue(boss: PgBoss): void {
  const index = attached.lastIndexOf(boss)
  if (index !== -1) attached.splice(index, 1)
}

/** Ставит задачу рассылки события транзакцией `trx` — той же, что записала событие. */
export async function enqueueFanout(trx: Kysely<Database>, message: FanoutMessage): Promise<void> {
  const boss = attached.at(-1)
  if (boss === undefined) {
    throw new Error('очередь событий не подключена: attachEventQueue (events/queue.ts)')
  }
  await boss.send(WEBHOOK_FANOUT_QUEUE, message, { db: fromKysely(trx) })
}
