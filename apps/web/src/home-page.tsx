import type { HealthResponse } from '@alpi/shared'
import { useQuery } from '@tanstack/react-query'

async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch('/api/health')
  if (!res.ok) {
    throw new Error(`API ответил ${res.status}`)
  }
  return res.json()
}

// Страница-заглушка: показывает, что клиент собран и видит API.
export function HomePage() {
  const health = useQuery({ queryKey: ['health'], queryFn: fetchHealth })

  return (
    <main>
      <h1>Alpi CRM</h1>
      <p>
        API: {health.isPending ? 'проверяем…' : health.isError ? 'недоступен' : health.data.status}
      </p>
    </main>
  )
}
