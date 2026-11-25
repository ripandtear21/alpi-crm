import { EVENT_ACTOR_SCHEMA, EVENT_TYPES, type EventType, eventBodySchema } from '@alpi/shared'

// Раздел `webhooks` описания API (OpenAPI 3.1; тикет crm-api/05): тело каждого типа события из
// каталога packages/shared/src/events — тот же каталог, по которому сервер проверяет тело перед
// записью (events/emit.ts), поэтому описание не расходится с тем, что уходит на адрес.

const ACTOR_REF = { $ref: '#/components/schemas/EventActor' }

/** Имя схемы тела в components: deal.stage_changed → EventDealStageChanged. */
export function eventSchemaName(type: EventType): string {
  return `Event${type
    .split(/[._]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')}`
}

const DELIVERY = `Тело запроса POST на адрес автоматизации. Подпись и заголовки webhook-id, webhook-timestamp, webhook-signature — по Standard Webhooks. Тело «тонкое»: id и неизменяемые факты изменения, без имён, телефонов, email и значений пользовательских полей; актуальное состояние читайте через API ключом. Тело меняется только добавлением полей.`

/** Схемы тел событий для components.schemas и раздел webhooks со ссылками на них. */
export function eventWebhooks() {
  const schemas: Record<string, unknown> = { EventActor: EVENT_ACTOR_SCHEMA }
  const webhooks: Record<string, unknown> = {}
  for (const type of EVENT_TYPES) {
    const name = eventSchemaName(type)
    const schema = eventBodySchema(type, ACTOR_REF)
    schemas[name] = schema
    webhooks[type] = {
      post: {
        summary: schema.description,
        description: DELIVERY,
        operationId: `event_${type.replace('.', '_')}`,
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } },
        },
        responses: {
          '2XX': { description: 'Событие принято' },
        },
      },
    }
  }
  return { schemas, webhooks }
}
