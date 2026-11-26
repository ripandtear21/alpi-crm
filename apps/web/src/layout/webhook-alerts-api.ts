import { can, type ProjectAccess, type WebhookAlert } from '@alpi/shared'
import { projectHeaders } from '../components/project-switcher/projects-api.ts'

// Предупреждение в шапке об отключённых адресах событий (тикет crm-api/06): пока в CRM нет
// уведомлений, администратор узнаёт об адресе, который система отключила (ответ 410 или 5 суток
// без успешной доставки), из шапки. Права — `GET /api/project/access`; без права «интеграции:
// смотреть» список не запрашивается (API ответил бы 403). Список — `GET
// /api/v1/webhook-endpoints/alerts` (apps/api/src/webhook-endpoints/routes.ts).

export interface WebhookAlertsApi {
  /** Отключённые системой адреса текущего проекта; без права «интеграции» — пусто. */
  alerts(projectId: string): Promise<WebhookAlert[]>
}

export class WebhookAlertsApiError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`Предупреждения об адресах событий: API ответил ${status}`)
    this.name = 'WebhookAlertsApiError'
    this.status = status
  }
}

export function createWebhookAlertsApi(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): WebhookAlertsApi {
  async function get<T>(projectId: string, path: string): Promise<T> {
    const res = await fetchImpl(path, {
      headers: projectHeaders(projectId),
      credentials: 'same-origin',
    })
    if (!res.ok) throw new WebhookAlertsApiError(res.status)
    return (await res.json()) as T
  }
  return {
    async alerts(projectId) {
      const access = await get<ProjectAccess>(projectId, '/api/project/access')
      if (!can(access.permissions, 'integrations', 'view')) return []
      return get<WebhookAlert[]>(projectId, '/api/v1/webhook-endpoints/alerts')
    },
  }
}
