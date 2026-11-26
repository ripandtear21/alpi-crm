import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import { fakeProjectsApi } from '../../components/project-switcher/fake-projects-api.ts'
import { createI18n, type Language } from '../../i18n/index.ts'
import { createAppRouter } from '../../router.tsx'
import { fakeAuthApi } from '../auth/fake-auth-api.ts'
import { type FakeAuditApi, fakeAuditApi } from './fake-audit-api.ts'

// Экран «Настройки → журнал» в настоящем дереве маршрутов (вошедший пользователь, подставные API).

async function renderAudit(language: Language = 'uk', audit: FakeAuditApi = fakeAuditApi()) {
  const queryClient = new QueryClient()
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: ['/settings/audit'] }),
    auth: fakeAuthApi(),
    projects: fakeProjectsApi(),
    audit,
    queryClient,
  })
  render(
    <I18nextProvider i18n={createI18n(language)}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nextProvider>,
  )
  await screen.findByRole('heading', { level: 1 })
  return audit
}

/** Строки таблицы без заголовка: текст ячеек «действие | что изменилось». */
async function rows(): Promise<string[]> {
  const table = await screen.findByRole('table')
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => {
      const cells = within(row).getAllByRole('cell')
      return `${cells[1]?.textContent} | ${cells[2]?.textContent} | ${cells[3]?.textContent}`
    })
}

describe('экран журнала', () => {
  it('запись с автором-ключом API: название ключа и пометка «ключ API»', async () => {
    await renderAudit(
      'uk',
      fakeAuditApi({
        first: [
          {
            id: '00000000-0000-4000-8000-000000000099',
            occurredAt: '2026-11-04T12:01:00.000Z',
            actor: null,
            apiKey: { id: 'k-1', name: 'Робот n8n' },
            ip: '203.0.113.9',
            action: 'api_key.request',
            entityType: 'api_key',
            entityId: 'k-1',
            entityName: null,
            details: { method: 'POST', path: '/v1/deals', status: 201 },
          },
        ],
      }),
    )
    expect((await rows())[0]).toMatch(/^Робот n8n \(ключ API\) \| Зміна через ключ API \| /)
  })

  it('«догнать события с даты» (тикет crm-api/09): адрес, дата и сколько поставлено', async () => {
    const caughtUp = {
      id: '00000000-0000-4000-8000-000000000098',
      occurredAt: '2026-11-26T12:01:00.000Z',
      actor: null,
      apiKey: null,
      ip: null,
      action: 'webhook_endpoint.caught_up' as const,
      entityType: 'webhook_endpoint',
      entityId: '00000000-0000-4000-8000-000000000097',
      entityName: null,
      details: {
        url: 'https://hooks.example.test/n8n',
        since: '2026-11-21T00:00:00.000Z',
        queued: 7,
      },
    }
    await renderAudit('uk', fakeAuditApi({ first: [caughtUp] }))
    expect((await rows())[0]).toMatch(
      /\| Наздогнано події вебхука \| https:\/\/hooks\.example\.test\/n8n: події з .+, у черзі: 7$/,
    )
  })

  it('записи новые сверху: кто, действие, «было → стало»', async () => {
    await renderAudit('uk')
    expect(await rows()).toEqual([
      'Олена | Змінено роль учасника | Іван: Менеджер → Керівник',
      'Петро | Створено роль | Стажер',
      'Олена | Змінено роль | Стажер → Практикант',
    ])
    expect(screen.getAllByText('203.0.113.7')).toHaveLength(3)
  })

  it('фильтр по действию и по пользователю уходит в API', async () => {
    const audit = await renderAudit('uk')
    await rows()
    fireEvent.change(screen.getByRole('combobox', { name: 'Дія' }), {
      target: { value: 'role.created' },
    })
    await waitFor(async () => expect(await rows()).toEqual(['Петро | Створено роль | Стажер']))
    expect(audit.calls.at(-1)).toEqual({ action: 'role.created' })

    fireEvent.change(screen.getByRole('combobox', { name: 'Дія' }), { target: { value: '' } })
    const actor = screen.getByRole('combobox', { name: 'Користувач' })
    await within(actor).findByRole('option', { name: 'Олена (olena@example.test)' })
    fireEvent.change(actor, { target: { value: 'u-admin' } })
    await waitFor(async () => expect(await rows()).toHaveLength(2))
    expect(audit.calls.at(-1)).toEqual({ actor: 'u-admin' })
  })

  it('следующая страница — кнопкой, по курсору', async () => {
    const audit = await renderAudit('uk', fakeAuditApi({ pageSize: 2 }))
    expect(await rows()).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Показати ще' }))
    await waitFor(async () => expect(await rows()).toHaveLength(3))
    expect(audit.calls.at(-1)).toEqual({ cursor: '2' })
    expect(screen.queryByRole('button', { name: 'Показати ще' })).toBeNull()
  })

  it('без права «настройки проекта» — сообщение, а не журнал (ru)', async () => {
    await renderAudit('ru', fakeAuditApi({ deny: true }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Нет права «Доступ к настройкам проекта» в этом проекте.',
    )
    expect(screen.queryByRole('table')).toBeNull()
  })
})
