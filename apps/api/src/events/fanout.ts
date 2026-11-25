import { type Database, withProject } from '@alpi/db'
import type { Kysely } from 'kysely'
import { enqueueDeliveries, type FanoutMessage } from './queue.ts'

// Рассылка события по подпискам (тикет crm-api/06): обработчик очереди `webhook-fanout`.
//
// - Работает внутри withProject проекта из задачи: row-level security показывает только его
//   событие и его адреса. Событие другого проекта (подделанная или ошибочная задача) не
//   находится — рассылки нет.
// - Доставка — каждому активному адресу проекта, подписанному на тип события и созданному не
//   позже события: адреса, добавленные позже, его не получают.
// - Строки webhook_delivery и задачи `webhook-deliver` ставятся одной транзакцией. Повтор
//   рассылки (сбой после записи) не создаёт вторую доставку той же пары «событие × адрес» —
//   задачи ставятся только для новых строк.

/** Создаёт доставки события и ставит их в очередь; возвращает число новых доставок. */
export async function fanoutEvent(db: Kysely<Database>, message: FanoutMessage): Promise<number> {
  if (typeof message.projectId !== 'string' || typeof message.eventId !== 'string') {
    throw new Error('задача webhook-fanout без projectId или eventId')
  }
  return withProject(db, message.projectId, async (trx) => {
    const event = await trx
      .selectFrom('webhook_event')
      .select(['id', 'type', 'created_at'])
      .where('id', '=', message.eventId)
      .executeTakeFirst()
    if (!event) return 0
    const created = await trx
      .insertInto('webhook_delivery')
      .columns(['project_id', 'event_id', 'endpoint_id', 'next_attempt_at'])
      .expression((eb) =>
        eb
          .selectFrom('webhook_endpoint')
          .select((s) => [
            'project_id',
            s.val(event.id).as('event_id'),
            'id',
            s.fn<Date>('now').as('next_attempt_at'),
          ])
          .where('state', '=', 'active')
          .where((w) => w(w.val(event.type), '=', w.fn.any('event_types')))
          .where('created_at', '<=', event.created_at),
      )
      .onConflict((oc) => oc.columns(['event_id', 'endpoint_id']).doNothing())
      .returning('id')
      .execute()
    await enqueueDeliveries(
      trx,
      created.map(({ id }) => ({ projectId: message.projectId, deliveryId: id })),
    )
    return created.length
  })
}
