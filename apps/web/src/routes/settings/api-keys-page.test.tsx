import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeProjectsApi } from '../../components/project-switcher/fake-projects-api.ts'
import { createI18n, type Language } from '../../i18n/index.ts'
import { createAppRouter } from '../../router.tsx'
import { fakeAuthApi } from '../auth/fake-auth-api.ts'
import { type FakeApiKeysApi, fakeApiKeysApi } from './fake-api-keys-api.ts'

// Экран «Налаштування → Ключі API» (тикет crm-api/01) в настоящем дереве маршрутов (вошедший
// пользователь, подставные API): секрет показывается один раз, перевыпуск и отзыв — с
// подтверждением, тексты uk и ru.

async function renderAt(
  path: '/settings' | '/settings/api-keys',
  { language = 'uk', api = fakeApiKeysApi() }: { language?: Language; api?: FakeApiKeysApi } = {},
) {
  const queryClient = new QueryClient()
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    auth: fakeAuthApi(),
    projects: fakeProjectsApi(),
    apiKeys: api,
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
  return api
}

const original = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard')
afterEach(() => {
  if (original) Object.defineProperty(window.navigator, 'clipboard', original)
  else Reflect.deleteProperty(window.navigator, 'clipboard')
})

function stubClipboard() {
  const spy = vi.fn(async (_text: string) => {})
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: spy },
    configurable: true,
  })
  return spy
}

describe('экран ключей API', () => {
  it('в настройках есть пункт «Ключі API»; список — роль, начало секрета, срок, последний запрос', async () => {
    await renderAt('/settings')
    expect(screen.getByRole('link', { name: 'Ключі API' })).toBeTruthy()

    await renderAt('/settings/api-keys')
    const card = await screen.findByRole('article', { name: 'n8n' })
    expect(card.textContent).toContain('Керівник')
    expect(card.textContent).toContain('alpi_n8n…')
    expect(card.textContent).toContain('безстроково')
    expect(card.textContent).toContain('запитів не було')
  })

  it('создание показывает секрет один раз: после «Готово» его нигде нет', async () => {
    const clipboard = stubClipboard()
    const api = await renderAt('/settings/api-keys')
    fireEvent.click(await screen.findByRole('button', { name: 'Створити ключ' }))
    const dialog = await screen.findByRole('dialog', { name: 'Новий ключ API' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Назва' }), {
      target: { value: 'Make' },
    })
    const role = within(dialog).getByRole('combobox', { name: /Роль/ })
    await waitFor(() => expect(within(role).getAllByRole('option').length).toBeGreaterThan(1))
    // Охват менеджера — «свои»: предупреждение, что ключ увидит только общую очередь.
    fireEvent.change(role, {
      target: {
        value: within(role).getByRole('option', { name: 'Менеджер' }).getAttribute('value'),
      },
    })
    expect(within(dialog).getByRole('status').textContent).toContain(
      'лише угоди без відповідального',
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Створити' }))

    const secretDialog = await screen.findByRole('dialog', { name: 'Секрет ключа «Make»' })
    const secret = (
      within(secretDialog).getByRole('textbox', { name: 'Секрет' }) as HTMLInputElement
    ).value
    expect(secret).toMatch(/^alpi_/)
    expect(secretDialog.textContent).toContain('більше не буде показано')
    fireEvent.click(within(secretDialog).getByRole('button', { name: 'Скопіювати' }))
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith(secret))
    expect(await within(secretDialog).findByText('Скопійовано.')).toBeTruthy()

    fireEvent.click(within(secretDialog).getByRole('button', { name: 'Готово' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await screen.findByRole('article', { name: 'Make' })
    expect(document.body.innerHTML).not.toContain(secret)
    expect(api.calls).toEqual([{ method: 'create' }])
  })

  it('без названия и роли ключ не создаётся', async () => {
    const api = await renderAt('/settings/api-keys')
    fireEvent.click(await screen.findByRole('button', { name: 'Створити ключ' }))
    const dialog = await screen.findByRole('dialog', { name: 'Новий ключ API' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Створити' }))
    expect(within(dialog).getAllByText('Обов’язкове поле.').length).toBe(2)
    expect(api.calls).toEqual([])
  })

  it('отзыв — только после подтверждения; отмена ничего не делает', async () => {
    const api = await renderAt('/settings/api-keys')
    const card = await screen.findByRole('article', { name: 'n8n' })
    fireEvent.click(within(card).getByRole('button', { name: 'Відкликати' }))
    const confirm = await screen.findByRole('dialog', { name: 'Відкликати ключ «n8n»?' })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Скасувати' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.calls).toEqual([])

    fireEvent.click(within(card).getByRole('button', { name: 'Відкликати' }))
    const again = await screen.findByRole('dialog', { name: 'Відкликати ключ «n8n»?' })
    fireEvent.click(within(again).getByRole('button', { name: 'Відкликати' }))
    expect(await screen.findByText('Ключ «n8n» відкликано.')).toBeTruthy()
    expect(api.calls).toEqual([{ method: 'revoke', keyId: api.keys[0]?.id }])
    await waitFor(() =>
      expect(screen.getByRole('article', { name: 'n8n' }).textContent).toContain('відкликано'),
    )
    expect(
      within(screen.getByRole('article', { name: 'n8n' })).queryByRole('button', {
        name: 'Перевипустити',
      }),
    ).toBeNull()
  })

  it('перевыпуск — после подтверждения, новый секрет показывается один раз', async () => {
    const api = await renderAt('/settings/api-keys')
    const card = await screen.findByRole('article', { name: 'n8n' })
    fireEvent.click(within(card).getByRole('button', { name: 'Перевипустити' }))
    const confirm = await screen.findByRole('dialog', { name: 'Перевипустити ключ «n8n»?' })
    expect(confirm.textContent).toContain('Старий перестане працювати одразу')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Перевипустити' }))
    const secretDialog = await screen.findByRole('dialog', { name: 'Секрет ключа «n8n»' })
    expect(
      (within(secretDialog).getByRole('textbox', { name: 'Секрет' }) as HTMLInputElement).value,
    ).toMatch(/^alpi_/)
    expect(api.calls).toEqual([{ method: 'reissue', keyId: api.keys[0]?.id }])
  })

  it('отказ API показывается текстом', async () => {
    const api = fakeApiKeysApi()
    api.failNextWith = 'API_KEY_REVOKED'
    await renderAt('/settings/api-keys', { api })
    const card = await screen.findByRole('article', { name: 'n8n' })
    fireEvent.click(within(card).getByRole('button', { name: 'Відкликати' }))
    const confirm = await screen.findByRole('dialog', { name: 'Відкликати ключ «n8n»?' })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Відкликати' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Ключ уже відкликано.')
  })

  it('без права «Інтеграції» — сообщение вместо списка', async () => {
    await renderAt('/settings/api-keys', { api: fakeApiKeysApi({ deny: true }) })
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Немає права «Інтеграції» в цьому проєкті.',
    )
  })

  it('тексты на русском', async () => {
    await renderAt('/settings/api-keys', { language: 'ru' })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Ключи API')
    const card = await screen.findByRole('article', { name: 'n8n' })
    expect(within(card).getByRole('button', { name: 'Отозвать' })).toBeTruthy()
    expect(within(card).getByRole('button', { name: 'Перевыпустить' })).toBeTruthy()
    expect(card.textContent).toContain('бессрочно')
  })
})
