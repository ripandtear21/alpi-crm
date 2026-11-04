import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import { fakeProjectsApi } from '../../components/project-switcher/fake-projects-api.ts'
import { createI18n, type Language } from '../../i18n/index.ts'
import { createAppRouter } from '../../router.tsx'
import { fakeAuthApi } from '../auth/fake-auth-api.ts'
import { type FakeRolesApi, fakeRolesApi } from './fake-roles-api.ts'

// Экран «Настройки → роли» в настоящем дереве маршрутов (вошедший пользователь, подставные API).

async function renderRoles(language: Language = 'uk', roles: FakeRolesApi = fakeRolesApi()) {
  const queryClient = new QueryClient()
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: ['/settings/roles'] }),
    auth: fakeAuthApi(),
    projects: fakeProjectsApi(),
    roles,
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
  return roles
}

function roleButtons(): string[] {
  return within(screen.getByRole('list', { name: /Ролі проєкту|Роли проекта/ }))
    .getAllByRole('button')
    .map((b) => b.textContent ?? '')
}

function checkbox(name: string): HTMLInputElement {
  return screen.getByRole('checkbox', { name }) as HTMLInputElement
}

function nameInput(name: string): HTMLInputElement {
  return screen.getByRole('textbox', { name }) as HTMLInputElement
}

describe('экран ролей', () => {
  it('список ролей с переведёнными шаблонами; администратор — только чтение', async () => {
    await renderRoles('uk')
    await screen.findByRole('form', { name: 'Права ролі' })
    expect(roleButtons()).toEqual([
      'Адміністратор 1 учасник',
      'Керівник 0 учасників',
      'Тімлід 0 учасників',
      'Менеджер 0 учасників',
    ])
    expect(screen.getByText(/Роль «Адміністратор» має всі права/)).toBeTruthy()
    expect(checkbox('Угоди: Видаляти').checked).toBe(true)
    expect(checkbox('Угоди: Видаляти').disabled).toBe(true)
    expect(nameInput('Назва').readOnly).toBe(true)
    expect(screen.queryByRole('button', { name: 'Зберегти' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Видалити' })).toBeNull()
  })

  it('ru: изменить права менеджера и сохранить', async () => {
    const api = await renderRoles('ru')
    fireEvent.click(await screen.findByRole('button', { name: /^Менеджер/ }))
    expect(checkbox('Сделки: Удалять').checked).toBe(false)
    fireEvent.click(checkbox('Сделки: Удалять'))
    // «Создавать» без «смотреть» не бывает: галочка «смотреть» ставится сама.
    fireEvent.click(checkbox('Отчёты: Создавать'))
    expect(checkbox('Отчёты: Смотреть').checked).toBe(true)
    fireEvent.change(screen.getByRole('combobox', { name: 'Сделки: видит' }), {
      target: { value: 'all' },
    })
    fireEvent.click(checkbox('Выгрузка в файл'))
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await screen.findByText('Роль сохранена.')
    expect(api.calls).toHaveLength(1)
    const [call] = api.calls
    expect(call?.method).toBe('update')
    expect(call?.input?.name).toBe('Менеджер')
    expect(call?.input?.permissions.actions.deals).toEqual(['view', 'create', 'edit', 'delete'])
    expect(call?.input?.permissions.actions.reports).toEqual(['view', 'create'])
    expect(call?.input?.permissions.scopes.deals).toEqual({ read: 'all', write: 'own' })
    expect(call?.input?.permissions.standalone).toEqual(['export'])
  })

  it('ru: неизменённое название шаблона показано переводом, а в API уходит как в базе', async () => {
    const api = await renderRoles('ru')
    fireEvent.click(await screen.findByRole('button', { name: /^Руководитель/ }))
    expect(nameInput('Название').value).toBe('Руководитель')
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    await screen.findByText('Роль сохранена.')
    expect(api.calls[0]?.input?.name).toBe('Керівник')
  })

  it('снятая «смотреть» снимает остальные действия части системы', async () => {
    await renderRoles('uk')
    fireEvent.click(await screen.findByRole('button', { name: /^Керівник/ }))
    expect(checkbox('Угоди: Видаляти').checked).toBe(true)
    fireEvent.click(checkbox('Угоди: Бачити'))
    for (const action of ['Бачити', 'Створювати', 'Змінювати', 'Видаляти']) {
      expect(checkbox(`Угоди: ${action}`).checked).toBe(false)
    }
  })

  it('новая роль и копия создаются; отказ API показан текстом', async () => {
    const api = await renderRoles('uk')
    fireEvent.click(await screen.findByRole('button', { name: 'Нова роль' }))
    fireEvent.change(nameInput('Назва'), { target: { value: 'Стажер' } })
    fireEvent.click(checkbox('Угоди: Бачити'))
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }))
    await screen.findByText('Роль збережено.')
    expect(api.calls[0]).toMatchObject({ method: 'create', input: { name: 'Стажер' } })
    expect(api.calls[0]?.input?.permissions.actions.deals).toEqual(['view'])
    await waitFor(() => expect(roleButtons()).toContain('Стажер 0 учасників'))

    fireEvent.click(screen.getByRole('button', { name: /^Адміністратор/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Копіювати' }))
    expect(nameInput('Назва').value).toBe('Адміністратор (копія)')
    api.failNextWith = 'ROLE_NAME_TAKEN'
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }))
    await screen.findByText('Роль з такою назвою вже є.')
  })

  it('без права «пользователи и роли» — пояснение вместо редактора', async () => {
    await renderRoles('uk', fakeRolesApi({ deny: true }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Немає права «Користувачі та ролі» в цьому проєкті.')
    expect(screen.queryByRole('form')).toBeNull()
  })
})
