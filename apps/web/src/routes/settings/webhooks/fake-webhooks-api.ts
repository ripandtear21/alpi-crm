import {
  EVENT_CATALOG,
  EVENT_TYPE_TITLES,
  EVENT_TYPES,
  type EventType,
  fullPermissions,
  type RolePermissions,
  type WebhookDeliveryView,
  type WebhookEndpointListItem,
  type WebhookEndpointSummary,
  type WebhookEndpointWithSecret,
} from '@alpi/shared'
import { RolesApiError } from '../roles-api.ts'
import type { WebhookDeliveriesPage, WebhooksApi } from './webhooks-api.ts'

// Подставной клиент экрана «Вебхуки» для тестов и снимков экрана: вебхуки, доставки и попытки в
// памяти, секреты и адреса выдуманные. Проверка адреса повторяет коды API (422, поле `url`):
// не https, частная сеть, имя не разрешается. «Надіслати ще раз» сразу добавляет успешную
// попытку — как будто фоновая задача уже отправила событие. `permissions` — права пользователя;
// `calls` — что вызывали; `failNextWith` — следующее изменение отклоняется с этим кодом (409).

export interface FakeWebhooksApi extends WebhooksApi {
  endpoints: WebhookEndpointListItem[]
  deliveryLog: Map<string, WebhookDeliveryView[]>
  calls: { method: string; endpointId?: string; deliveryId?: string; input?: unknown }[]
  failNextWith: string | null
  /** Сколько событий «догнать» поставит сверх неудачных доставок журнала (тикет 09). */
  missedEvents: number
}

const PROJECT_ID = '00000000-0000-4000-8000-00000000000a'
const AUTHOR = { id: 'user-1', name: 'Ірина Тестова' }

let counter = 0
function fakeUuid(prefix = '9300'): string {
  counter += 1
  return `00000000-0000-4000-${prefix}-${String(counter).padStart(12, '0')}`
}

/** Выдуманный секрет нужной формы: `whsec_` и base64 от 32 байт. */
function fakeSecret(): string {
  counter += 1
  return `whsec_${`test${counter}`.padEnd(43, 'x')}=`
}

/** Тело события, как его получает приёмник. */
function eventBody(type: EventType, eventId: string, occurredAt: string) {
  return {
    type,
    timestamp: occurredAt,
    data: {
      event_id: eventId,
      project_id: PROJECT_ID,
      deal_id: '00000000-0000-4000-9400-000000000001',
      actor: { type: 'user' as const, id: AUTHOR.id },
    },
  } as unknown as WebhookDeliveryView['event']
}

function delivery(
  type: EventType,
  occurredAt: string,
  state: WebhookDeliveryView['state'],
  attemptLog: WebhookDeliveryView['attemptLog'],
): WebhookDeliveryView {
  const eventId = `evt_${fakeUuid('9500')}`
  return {
    id: fakeUuid('9600'),
    eventId,
    eventType: type,
    occurredAt,
    state,
    attempts: attemptLog.length,
    nextAttemptAt: null,
    succeededAt: state === 'succeeded' ? (attemptLog.at(-1)?.attemptedAt ?? null) : null,
    attemptLog,
    event: eventBody(type, eventId, occurredAt),
  }
}

/** Как API проверяет адрес при сохранении (apps/api/src/events/ssrf.ts), упрощённо. */
function urlProblem(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'WEBHOOK_URL_INVALID'
  }
  if (url.protocol !== 'https:') return 'WEBHOOK_URL_NOT_HTTPS'
  const host = url.hostname
  if (
    host === 'localhost' ||
    /^(127|10)\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host)
  ) {
    return 'WEBHOOK_URL_FORBIDDEN_ADDRESS'
  }
  if (host.endsWith('.invalid')) return 'WEBHOOK_URL_UNRESOLVABLE'
  return null
}

/**
 * Два вебхука: включённый «n8n: нові угоди» с журналом (неудачная доставка с двумя попытками и
 * успешная) и отключённый системой «Make: контакти» (5 днів без успішної доставки).
 */
export function fakeWebhooksApi({
  permissions = fullPermissions(),
  pageSize = 20,
}: {
  permissions?: RolePermissions
  pageSize?: number
} = {}): FakeWebhooksApi {
  const active: WebhookEndpointListItem = {
    id: fakeUuid(),
    url: 'https://hooks.example.test/n8n/new-deals',
    description: 'n8n: нові угоди',
    eventTypes: ['deal.created', 'deal.won'],
    state: 'active',
    disabledReason: null,
    disabledAt: null,
    lastSuccessAt: '2026-11-25T09:15:00.000Z',
    previousSecretExpiresAt: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    createdBy: AUTHOR,
    deliveries24h: { finished: 10, failed: 2 },
  }
  const disabled: WebhookEndpointListItem = {
    id: fakeUuid(),
    url: 'https://make.example.test/hook/contacts',
    description: 'Make: контакти',
    eventTypes: ['contact.created'],
    state: 'disabled',
    disabledReason: 'failing_5_days',
    disabledAt: '2026-11-24T06:00:00.000Z',
    lastSuccessAt: '2026-11-18T12:00:00.000Z',
    previousSecretExpiresAt: null,
    createdAt: '2026-10-20T10:00:00.000Z',
    createdBy: AUTHOR,
    deliveries24h: { finished: 0, failed: 0 },
  }

  function failIfAsked() {
    const code = api.failNextWith
    if (code) {
      api.failNextWith = null
      throw new RolesApiError(409, code)
    }
  }

  function endpoint(id: string): WebhookEndpointListItem {
    const found = api.endpoints.find((e) => e.id === id)
    if (!found) throw new RolesApiError(404, 'WEBHOOK_ENDPOINT_NOT_FOUND')
    return found
  }

  const summary = (found: WebhookEndpointListItem): WebhookEndpointSummary => {
    const { deliveries24h: _, ...rest } = structuredClone(found)
    return rest
  }

  function checkUrl(value: string) {
    const problem = urlProblem(value)
    if (problem) throw new RolesApiError(422, problem)
  }

  function requireActive(found: WebhookEndpointListItem) {
    if (found.state !== 'active') throw new RolesApiError(409, 'WEBHOOK_ENDPOINT_DISABLED')
  }

  const api: FakeWebhooksApi = {
    endpoints: [active, disabled],
    deliveryLog: new Map([
      [
        active.id,
        [
          delivery('deal.created', '2026-11-25T10:00:00.000Z', 'failed', [
            {
              attemptedAt: '2026-11-25T10:00:01.000Z',
              statusCode: 500,
              error: null,
              durationMs: 340,
              responseBody: '{"error":"Workflow could not be started"}',
            },
            {
              attemptedAt: '2026-11-25T10:00:31.000Z',
              statusCode: null,
              error: 'timeout',
              durationMs: 15000,
              responseBody: null,
            },
          ]),
          delivery('deal.won', '2026-11-25T09:15:00.000Z', 'succeeded', [
            {
              attemptedAt: '2026-11-25T09:15:00.500Z',
              statusCode: 200,
              error: null,
              durationMs: 120,
              responseBody: '{"ok":true}',
            },
          ]),
        ],
      ],
      [
        disabled.id,
        [
          delivery('contact.created', '2026-11-23T18:00:00.000Z', 'cancelled', [
            {
              attemptedAt: '2026-11-23T18:00:01.000Z',
              statusCode: 503,
              error: null,
              durationMs: 210,
              responseBody: 'Service Unavailable',
            },
          ]),
        ],
      ],
    ]),
    calls: [],
    failNextWith: null,
    missedEvents: 3,
    async access() {
      return { userId: AUTHOR.id, permissions: structuredClone(permissions) }
    },
    async list() {
      return structuredClone(api.endpoints)
    },
    async eventTypes() {
      return EVENT_TYPES.map((type) => ({
        type,
        entity: EVENT_CATALOG[type].entity,
        title: EVENT_TYPE_TITLES[type],
      }))
    },
    async create(_projectId, input) {
      api.calls.push({ method: 'create', input: structuredClone(input) })
      failIfAsked()
      checkUrl(input.url)
      const created: WebhookEndpointListItem = {
        id: fakeUuid(),
        url: input.url,
        description: input.description ?? null,
        eventTypes: EVENT_TYPES.filter((type) => input.eventTypes.includes(type)),
        state: 'active',
        disabledReason: null,
        disabledAt: null,
        lastSuccessAt: null,
        previousSecretExpiresAt: null,
        createdAt: new Date().toISOString(),
        createdBy: AUTHOR,
        deliveries24h: { finished: 0, failed: 0 },
      }
      api.endpoints.unshift(created)
      api.deliveryLog.set(created.id, [])
      return {
        endpoint: summary(created),
        secret: fakeSecret(),
      } satisfies WebhookEndpointWithSecret
    },
    async update(_projectId, endpointId, input) {
      api.calls.push({ method: 'update', endpointId, input: structuredClone(input) })
      failIfAsked()
      const found = endpoint(endpointId)
      if (input.url !== undefined) {
        checkUrl(input.url)
        found.url = input.url
      }
      if (input.description !== undefined) found.description = input.description
      if (input.eventTypes !== undefined) {
        found.eventTypes = EVENT_TYPES.filter((type) => input.eventTypes?.includes(type))
      }
      return summary(found)
    },
    async enable(_projectId, endpointId) {
      api.calls.push({ method: 'enable', endpointId })
      failIfAsked()
      const found = endpoint(endpointId)
      Object.assign(found, { state: 'active', disabledReason: null, disabledAt: null })
      return summary(found)
    },
    async disable(_projectId, endpointId) {
      api.calls.push({ method: 'disable', endpointId })
      failIfAsked()
      const found = endpoint(endpointId)
      Object.assign(found, {
        state: 'disabled',
        disabledReason: 'manual',
        disabledAt: new Date().toISOString(),
      })
      return summary(found)
    },
    async remove(_projectId, endpointId) {
      api.calls.push({ method: 'remove', endpointId })
      failIfAsked()
      endpoint(endpointId)
      api.endpoints = api.endpoints.filter((e) => e.id !== endpointId)
      api.deliveryLog.delete(endpointId)
    },
    async rotateSecret(_projectId, endpointId) {
      api.calls.push({ method: 'rotateSecret', endpointId })
      failIfAsked()
      const found = endpoint(endpointId)
      found.previousSecretExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      return { endpoint: summary(found), secret: fakeSecret() }
    },
    async deliveries(_projectId, endpointId, query): Promise<WebhookDeliveriesPage> {
      endpoint(endpointId)
      const all = (api.deliveryLog.get(endpointId) ?? []).filter(
        (d) =>
          (query.state === undefined || d.state === query.state) &&
          (query.type === undefined || d.eventType === query.type),
      )
      const start = query.cursor ? Number(query.cursor) : 0
      const end = start + pageSize
      return {
        data: structuredClone(all.slice(start, end)),
        next_cursor: end < all.length ? String(end) : null,
      }
    },
    async retryDelivery(_projectId, endpointId, deliveryId) {
      api.calls.push({ method: 'retryDelivery', endpointId, deliveryId })
      failIfAsked()
      requireActive(endpoint(endpointId))
      const found = api.deliveryLog.get(endpointId)?.find((d) => d.id === deliveryId)
      if (!found) throw new RolesApiError(404, 'WEBHOOK_DELIVERY_NOT_FOUND')
      if (found.state === 'pending') throw new RolesApiError(409, 'WEBHOOK_DELIVERY_PENDING')
      const attemptedAt = new Date().toISOString()
      found.attemptLog.push({
        attemptedAt,
        statusCode: 200,
        error: null,
        durationMs: 95,
        responseBody: '{"ok":true}',
      })
      Object.assign(found, {
        state: 'succeeded',
        attempts: found.attemptLog.length,
        succeededAt: attemptedAt,
      })
      return { queued: 1 }
    },
    async retryFailed(_projectId, endpointId, since) {
      api.calls.push({ method: 'retryFailed', endpointId, input: { since } })
      failIfAsked()
      requireActive(endpoint(endpointId))
      const queued = (api.deliveryLog.get(endpointId) ?? []).filter(
        (d) => (d.state === 'failed' || d.state === 'cancelled') && d.occurredAt >= since,
      ).length
      return { queued }
    },
    async catchUp(_projectId, endpointId, since) {
      api.calls.push({ method: 'catchUp', endpointId, input: { since } })
      failIfAsked()
      const found = endpoint(endpointId)
      requireActive(found)
      if (since < found.createdAt) throw new RolesApiError(422, 'WEBHOOK_CATCH_UP_BEFORE_CREATED')
      if (Date.parse(since) < Date.now() - 30 * 24 * 60 * 60 * 1000) {
        throw new RolesApiError(422, 'WEBHOOK_CATCH_UP_TOO_OLD')
      }
      // Неудачные и отменённые с даты и `missedEvents` событий, которых в журнале ещё нет.
      const queued = (api.deliveryLog.get(endpointId) ?? []).filter(
        (d) => (d.state === 'failed' || d.state === 'cancelled') && d.occurredAt >= since,
      ).length
      return { queued: queued + api.missedEvents }
    },
  }
  return api
}
