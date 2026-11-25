import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  projectQueryKey,
  useCurrentProject,
} from '../components/project-switcher/current-project.tsx'
import { Notice } from '../ui/feedback.tsx'
import type { WebhookAlertsApi } from './webhook-alerts-api.ts'

// Предупреждение под шапкой (тикет crm-api/06): адрес событий, который система отключила (410 или
// 5 суток без успеха), — пока в CRM нет уведомлений. Видят его только пользователи с правом
// «интеграции» (webhook-alerts-api.ts); пропадает, когда адрес включат или удалят.

/** Как часто перечитывать список, мс: адрес отключает фоновая задача, без действия пользователя. */
const REFRESH_MS = 5 * 60 * 1000

export function WebhookAlertBanner({ api }: { api: WebhookAlertsApi }) {
  const { t } = useTranslation('layout')
  const { current } = useCurrentProject()
  const projectId = current?.id ?? ''
  const alerts = useQuery({
    queryKey: projectQueryKey(projectId, 'webhook-alerts'),
    queryFn: () => api.alerts(projectId),
    enabled: projectId !== '',
    retry: false,
    staleTime: 60_000,
    refetchInterval: REFRESH_MS,
  })
  if (!alerts.data || alerts.data.length === 0) return null
  return (
    <div className="app-layout__alerts">
      {alerts.data.map((alert) => (
        <Notice key={alert.endpointId} kind="alert">
          {t('webhookAlert.text', {
            target: alert.description ?? alert.url,
            reason: t(`webhookAlert.reason.${alert.reason}`),
          })}
        </Notice>
      ))}
    </div>
  )
}
