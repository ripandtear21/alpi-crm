import { randomUUID } from 'node:crypto'
import {
  EVENT_CATALOG,
  EVENT_ID_PREFIX,
  type EventActor,
  type EventBody,
  type EventFacts,
  type EventType,
  eventBodyProblem,
} from '@alpi/shared'
import type { ChangeAuthor } from '../change-log/record.ts'
import { enqueueFanout } from './queue.ts'

// Функция записи события (тикет crm-api/05; шаблон transactional outbox) — одна для всех эпиков.
//
// - Пишет строку webhook_event и ставит задачу `webhook-fanout` с `{ eventId }` той же
//   транзакцией проекта (`author.db`), что и само изменение: откатилось изменение — нет ни
//   события, ни задачи; зафиксировалось — есть ровно по одной.
// - Тело — тонкое событие из каталога (packages/shared/src/events): тип, время, id события и
//   проекта, факты изменения, автор (тип и id). Тело не прошло схему своего типа или больше
//   20 КБ — ошибка, и изменение откатывается вместе с ним.
// - Только сообщает (ADR 0003): ни одно событие внутри CRM ничего не меняет.
//
// Зовут функции изменения сразу после записи изменения — после проверок и отказов, чтобы
// отказ (4xx фиксирует транзакцию запроса, middleware/project-context.ts) не оставил события.

/**
 * Автор события из автора изменения: ключ API, иначе пользователь. Без автора событие не
 * пишется — у каждого изменения в CRM есть тот, кто его сделал (для фоновой задачи — её
 * инициатор).
 */
export function eventActor(author: ChangeAuthor): EventActor {
  if (author.actorApiKeyId) return { type: 'api_key', id: author.actorApiKeyId }
  if (author.actorId) return { type: 'user', id: author.actorId }
  throw new Error('событие без автора: нет ни пользователя, ни ключа API')
}

/**
 * Пишет событие `type` с фактами `facts` транзакцией `author.db` проекта `author.projectId` и
 * ставит его рассылку в очередь. Возвращает id события.
 */
export async function emitEvent<T extends EventType>(
  author: ChangeAuthor,
  type: T,
  facts: EventFacts<T>,
): Promise<string> {
  const id = `${EVENT_ID_PREFIX}${randomUUID()}`
  const occurredAt = new Date()
  const actor = eventActor(author)
  const body = {
    type,
    timestamp: occurredAt.toISOString(),
    data: { event_id: id, project_id: author.projectId, ...facts, actor },
  } as EventBody<T>
  const problem = eventBodyProblem(body)
  if (problem !== null) throw new Error(`событие ${type}: ${problem}`)
  const entity = EVENT_CATALOG[type].entity
  const entityId = (facts as Record<string, unknown>)[`${entity}_id`]
  if (typeof entityId !== 'string') throw new Error(`событие ${type}: нет ${entity}_id`)
  await author.db
    .insertInto('webhook_event')
    .values({
      id,
      project_id: author.projectId,
      type,
      occurred_at: occurredAt,
      entity_type: entity,
      entity_id: entityId,
      body: JSON.stringify(body),
      actor_type: actor.type,
      actor_id: actor.id,
    })
    .execute()
  await enqueueFanout(author.db, { eventId: id })
  return id
}
