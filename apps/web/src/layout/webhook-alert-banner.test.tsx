import { ROLE_TEMPLATES, type RoleTemplateKey, type WebhookAlert } from '@alpi/shared'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it, vi } from 'vitest'
import { fakeProjectsApi } from '../components/project-switcher/fake-projects-api.ts'
import { createI18n, type Language } from '../i18n/index.ts'
import { createAppRouter } from '../router.tsx'
import { fakeAuthApi } from '../routes/auth/fake-auth-api.ts'
import { createWebhookAlertsApi } from './webhook-alerts-api.ts'

// Предупреждение в шапке об адресе событий, который система отключила (тикет crm-api/06):
// пользователь с правом «интеграции» его видит, менеджер — нет (и список даже не запрашивается).
// Настоящее дерево маршрутов; запросы к API — подставной fetch.

const ALERT: WebhookAlert = {
  endpointId: '0b8f6f4e-0000-4000-8000-000000000001',
  url: 'https://hooks.example.test/crm',
  description: 'Тестовий приймач',
  reason: 'failing_5_days',
  disabledAt: '2026-11-20T10:00:00.000Z',
}

function permissionsOf(role: RoleTemplateKey) {
  const template = ROLE_TEMPLATES.find((t) => t.key === role)
  if (!template) throw new Error(role)
  return template.permissions
}

/** fetch, который отвечает правами роли `role` и списком предупреждений. */
function fakeFetch(role: RoleTemplateKey, alerts: WebhookAlert[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === '/api/project/access') {
      return Response.json({ userId: 'u1', permissions: permissionsOf(role) })
    }
    if (url === '/api/v1/webhook-endpoints/alerts') return Response.json(alerts)
    return new Response(null, { status: 404 })
  })
}

async function renderApp(fetchImpl: typeof fetch, language: Language = 'uk') {
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: ['/p/alpi/deals'] }),
    auth: fakeAuthApi(),
    projects: fakeProjectsApi(),
    webhookAlerts: createWebhookAlertsApi(fetchImpl),
  })
  render(
    <I18nextProvider i18n={createI18n(language)}>
      <RouterProvider router={router} />
    </I18nextProvider>,
  )
  await screen.findByRole('heading', { level: 1 })
}

describe('предупреждение об отключённом адресе событий', () => {
  it('администратор (право «интеграции») видит адрес и причину', async () => {
    const fetchImpl = fakeFetch('admin', [ALERT])
    await renderApp(fetchImpl as unknown as typeof fetch)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Події не надсилаються на вебхук «Тестовий приймач»')
    expect(alert.textContent).toContain('5 діб без жодної успішної доставки')
  })

  it('предупреждение ведёт на экран «Налаштування → Вебхуки» (тикет crm-api/07)', async () => {
    const fetchImpl = fakeFetch('admin', [ALERT])
    await renderApp(fetchImpl as unknown as typeof fetch)
    const link = await screen.findByRole('link', { name: /Події не надсилаються на вебхук/ })
    expect(link.getAttribute('href')).toBe('/p/alpi/settings/webhooks')
    expect(link.textContent).toContain('«Налаштування → Вебхуки»')
  })

  it('по-русски — тот же текст на русском, адрес без описания — по URL', async () => {
    const fetchImpl = fakeFetch('admin', [{ ...ALERT, description: null, reason: 'gone_410' }])
    await renderApp(fetchImpl as unknown as typeof fetch, 'ru')
    const alert = await screen.findByText(/События не отправляются на вебхук/)
    expect(alert.textContent).toContain('https://hooks.example.test/crm')
    expect(alert.textContent).toContain('приёмник ответил 410 Gone')
  })

  it('менеджер (без права «интеграции») предупреждения не видит, список не запрашивается', async () => {
    const fetchImpl = fakeFetch('manager', [ALERT])
    await renderApp(fetchImpl as unknown as typeof fetch)
    await vi.waitFor(() =>
      expect(fetchImpl).toHaveBeenCalledWith('/api/project/access', expect.anything()),
    )
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).not.toContain(
      '/api/v1/webhook-endpoints/alerts',
    )
    expect(screen.queryByText(/Події не надсилаються/)).toBeNull()
  })

  it('нет отключённых адресов — предупреждения нет', async () => {
    const fetchImpl = fakeFetch('admin', [])
    await renderApp(fetchImpl as unknown as typeof fetch)
    await vi.waitFor(() =>
      expect(fetchImpl.mock.calls.map(([url]) => String(url))).toContain(
        '/api/v1/webhook-endpoints/alerts',
      ),
    )
    expect(screen.queryByText(/Події не надсилаються/)).toBeNull()
  })
})
