import type { HealthResponse } from '@alpi/shared'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch('/api/health')
  if (!res.ok) {
    throw new Error(`API ответил ${res.status}`)
  }
  return res.json()
}

// Страница-заглушка: показывает, что клиент собран и видит API.
export function HomePage() {
  const { t } = useTranslation(['home', 'common'])
  const health = useQuery({ queryKey: ['health'], queryFn: fetchHealth })

  return (
    <section>
      <h1>{t('common:appName')}</h1>
      <p>
        {t('api.label')}:{' '}
        {health.isPending
          ? t('api.checking')
          : health.isError
            ? t('api.unavailable')
            : health.data.status}
      </p>
    </section>
  )
}
