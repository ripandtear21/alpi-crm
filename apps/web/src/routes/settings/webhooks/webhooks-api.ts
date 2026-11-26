import type {
  ProjectAccess,
  WebhookDeliveryState,
  WebhookDeliveryView,
  WebhookEndpointInput,
  WebhookEndpointListItem,
  WebhookEndpointSummary,
  WebhookEndpointWithSecret,
  WebhookEventTypeInfo,
} from '@alpi/shared'
import { projectHeaders } from '../../../components/project-switcher/projects-api.ts'
import { RolesApiError } from '../roles-api.ts'

// Запросы экрана «Налаштування → Вебхуки» (тикет crm-api/07) к API вебхуков тикета 06
// (apps/api/src/webhook-endpoints/routes.ts): `/api/v1/webhook-endpoints`, в контексте проекта,
// по сессии. Права пользователя — `/api/project/access`. Отказ — RolesApiError с кодом ответа,
// как у остальных экранов настроек. Секрет приходит только в ответе на создание и смену секрета
// и нигде не сохраняется.

/** Страница журнала доставок: новые сверху, `next_cursor` — следующая страница. */
export interface WebhookDeliveriesPage {
  data: WebhookDeliveryView[]
  next_cursor: string | null
}

/** Фильтр журнала доставок: состояние, тип события, курсор страницы. */
export interface WebhookDeliveriesQuery {
  state?: WebhookDeliveryState
  type?: string
  cursor?: string
}

export interface WebhooksApi {
  access(projectId: string): Promise<ProjectAccess>
  list(projectId: string): Promise<WebhookEndpointListItem[]>
  eventTypes(projectId: string): Promise<WebhookEventTypeInfo[]>
  create(projectId: string, input: WebhookEndpointInput): Promise<WebhookEndpointWithSecret>
  update(
    projectId: string,
    endpointId: string,
    input: Partial<WebhookEndpointInput>,
  ): Promise<WebhookEndpointSummary>
  enable(projectId: string, endpointId: string): Promise<WebhookEndpointSummary>
  disable(projectId: string, endpointId: string): Promise<WebhookEndpointSummary>
  remove(projectId: string, endpointId: string): Promise<void>
  rotateSecret(projectId: string, endpointId: string): Promise<WebhookEndpointWithSecret>
  deliveries(
    projectId: string,
    endpointId: string,
    query: WebhookDeliveriesQuery,
  ): Promise<WebhookDeliveriesPage>
  retryDelivery(
    projectId: string,
    endpointId: string,
    deliveryId: string,
  ): Promise<{ queued: number }>
  /** Повтор всех неудачных и отменённых доставок вебхука, созданных начиная с `since` (ISO). */
  retryFailed(projectId: string, endpointId: string, since: string): Promise<{ queued: number }>
  /**
   * «Наздогнати події з дати» (тикет crm-api/09): события с `since` (ISO), ещё не доставленные
   * вебхуку успешно, — в отправку; `queued` — сколько поставлено.
   */
  catchUp(projectId: string, endpointId: string, since: string): Promise<{ queued: number }>
}

export function createWebhooksApi(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): WebhooksApi {
  async function send<T>(
    projectId: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers = projectHeaders(projectId)
    if (body !== undefined) headers.set('content-type', 'application/json')
    const res = await fetchImpl(`/api${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { code?: unknown } | null
      throw new RolesApiError(res.status, typeof payload?.code === 'string' ? payload.code : '')
    }
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  const base = '/v1/webhook-endpoints'
  return {
    access: (projectId) => send(projectId, 'GET', '/project/access'),
    list: (projectId) => send(projectId, 'GET', base),
    eventTypes: (projectId) => send(projectId, 'GET', `${base}/event-types`),
    create: (projectId, input) => send(projectId, 'POST', base, input),
    update: (projectId, id, input) => send(projectId, 'PATCH', `${base}/${id}`, input),
    enable: (projectId, id) => send(projectId, 'POST', `${base}/${id}/enable`),
    disable: (projectId, id) => send(projectId, 'POST', `${base}/${id}/disable`),
    remove: (projectId, id) => send(projectId, 'DELETE', `${base}/${id}`),
    rotateSecret: (projectId, id) => send(projectId, 'POST', `${base}/${id}/rotate-secret`),
    deliveries: (projectId, id, query) => {
      const params = new URLSearchParams()
      if (query.state) params.set('state', query.state)
      if (query.type) params.set('type', query.type)
      if (query.cursor) params.set('cursor', query.cursor)
      const search = params.toString()
      return send(projectId, 'GET', `${base}/${id}/deliveries${search ? `?${search}` : ''}`)
    },
    retryDelivery: (projectId, id, deliveryId) =>
      send(projectId, 'POST', `${base}/${id}/deliveries/${deliveryId}/retry`),
    retryFailed: (projectId, id, since) =>
      send(projectId, 'POST', `${base}/${id}/retry-failed`, { since }),
    catchUp: (projectId, id, since) => send(projectId, 'POST', `${base}/${id}/catch-up`, { since }),
  }
}
