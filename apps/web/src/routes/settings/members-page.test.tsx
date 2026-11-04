import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeProjectsApi } from '../../components/project-switcher/fake-projects-api.ts'
import { createI18n, type Language } from '../../i18n/index.ts'
import { createAppRouter } from '../../router.tsx'
import { fakeAuthApi } from '../auth/fake-auth-api.ts'
import {
  type FakeMembersApi,
  fakeMembersApi,
  MANAGER_ROLE_ID,
  TEAMLEAD_ROLE_ID,
} from './fake-members-api.ts'
import { fakeRolesApi } from './fake-roles-api.ts'

// Экраны «Настройки → пользователи» и «Настройки → команды» в настоящем дереве маршрутов
// (вошедший пользователь, подставные API).

async function renderAt(
  path: '/settings/users' | '/settings/teams',
  language: Language = 'uk',
  members: FakeMembersApi = fakeMembersApi(),
) {
  const queryClient = new QueryClient()
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    auth: fakeAuthApi(),
    projects: fakeProjectsApi(),
    roles: fakeRolesApi(),
    members,
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
  return members
}

function select(name: string): HTMLSelectElement {
  return screen.getByRole('combobox', { name }) as HTMLSelectElement
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('экран пользователей', () => {
  it('участники с ролью и командой; смена роли уходит в API', async () => {
    const api = await renderAt('/settings/users')
    const table = await screen.findByRole('table', { name: 'Учасники проєкту' })
    expect(within(table).getByText('Олена')).toBeTruthy()
    expect(select('Роль: Олена').value).toBe(MANAGER_ROLE_ID)
    // Шаблоны ролей — переведённые названия.
    expect(within(select('Роль: Олена')).getByRole('option', { name: 'Тімлід' })).toBeTruthy()
    fireEvent.change(select('Роль: Олена'), { target: { value: TEAMLEAD_ROLE_ID } })
    await waitFor(() =>
      expect(api.calls).toContainEqual({
        method: 'setRole',
        args: ['user-2', { roleId: TEAMLEAD_ROLE_ID }],
      }),
    )
  })

  it('новый пользователь: временный пароль показан один раз, копируется', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const api = await renderAt('/settings/users')
    const form = await screen.findByRole('form', { name: 'Додати користувача' })
    fireEvent.click(within(form).getByRole('checkbox'))
    fireEvent.change(within(form).getByLabelText('Email'), {
      target: { value: 'new@example.test' },
    })
    fireEvent.change(within(form).getByLabelText('Ім’я'), { target: { value: 'Новенький' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Створити' }))

    const shown = await screen.findByRole('region', { name: 'Тимчасовий пароль' })
    expect(shown.textContent).toContain('Tmp-Pass-1234567')
    expect(api.calls[0]).toEqual({
      method: 'create',
      args: [
        { email: 'new@example.test', name: 'Новенький', roleId: MANAGER_ROLE_ID, teamId: null },
      ],
    })
    fireEvent.click(within(shown).getByRole('button', { name: 'Копіювати пароль' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Tmp-Pass-1234567'))
    fireEvent.click(within(shown).getByRole('button', { name: 'Готово, пароль передано' }))
    expect(screen.queryByText('Tmp-Pass-1234567')).toBeNull()
  })

  it('отключение с открытыми сделками — текст отказа API (ru)', async () => {
    const api = fakeMembersApi()
    api.failNextWith = 'HAS_OPEN_DEALS'
    await renderAt('/settings/users', 'ru', api)
    fireEvent.click(await screen.findByRole('button', { name: 'Отключить Олена' }))
    expect((await screen.findByRole('status')).textContent).toBe(
      'У пользователя есть открытые сделки. Сначала передайте их другим.',
    )
    expect(api.members.find((m) => m.userId === 'user-2')?.disabled).toBe(false)
    // Без открытых сделок — отключается, кнопка меняется на «включить».
    fireEvent.click(screen.getByRole('button', { name: 'Отключить Олена' }))
    expect(await screen.findByRole('button', { name: 'Включить Олена' })).toBeTruthy()
  })

  it('отключение с открытыми сделками — отказ с их числом (ru)', async () => {
    const api = fakeMembersApi()
    api.openDeals['user-2'] = 2
    await renderAt('/settings/users', 'ru', api)
    fireEvent.click(await screen.findByRole('button', { name: 'Отключить Олена' }))
    expect((await screen.findByRole('status')).textContent).toBe(
      'Открытых сделок у пользователя: 2. Сначала передайте их — кнопка «Передать сделки».',
    )
  })

  it('передача сделок менеджеру: прогресс, затем отключение (ru)', async () => {
    const api = fakeMembersApi()
    api.openDeals['user-2'] = 3
    await renderAt('/settings/users', 'ru', api)
    fireEvent.click(await screen.findByRole('button', { name: 'Передать сделки Олена' }))
    const dialog = await screen.findByRole('dialog', { name: 'Передать сделки: Олена' })
    // Получатели — действующие участники, кроме самого пользователя; первым — общая очередь.
    const to = within(dialog).getByRole('combobox', { name: 'Кому' }) as HTMLSelectElement
    expect([...to.options].map((o) => o.text)).toEqual([
      'В общую очередь (без ответственного)',
      'Власник',
    ])
    fireEvent.change(to, { target: { value: 'user-1' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Передать' }))
    expect(await within(dialog).findByText('Готово: передано 3 из 3.')).toBeTruthy()
    expect(api.calls.find((c) => c.method === 'transferDeals')?.args).toEqual([
      'user-2',
      { toUserId: 'user-1' },
    ])

    fireEvent.click(within(dialog).getByRole('button', { name: 'Отключить Олена' }))
    expect(await screen.findByRole('button', { name: 'Включить Олена' })).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('в общую очередь; новые сделки за время передачи — отказ отключения с числом (uk)', async () => {
    const api = fakeMembersApi()
    api.openDeals['user-2'] = 2
    await renderAt('/settings/users', 'uk', api)
    fireEvent.click(await screen.findByRole('button', { name: 'Передати угоди Олена' }))
    const dialog = await screen.findByRole('dialog', { name: 'Передати угоди: Олена' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Передати' }))
    expect(await within(dialog).findByText('Готово: передано 2 з 2.')).toBeTruthy()
    expect(api.calls.find((c) => c.method === 'transferDeals')?.args).toEqual([
      'user-2',
      { toUserId: null },
    ])

    // Поки йшла передача, користувачу дали ще одну угоду.
    api.openDeals['user-2'] = 1
    fireEvent.click(within(dialog).getByRole('button', { name: 'Вимкнути Олена' }))
    expect(
      await within(dialog).findByText(
        "Поки йшла передача, у користувача з'явилися нові відкриті угоди: 1. Передайте їх і вимкніть знову.",
      ),
    ).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Передати' })).toBeTruthy()
    expect(api.members.find((m) => m.userId === 'user-2')?.disabled).toBe(false)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Закрити' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('экран команд', () => {
  it('создать команду с тимлидом и добавить участника', async () => {
    const api = await renderAt('/settings/teams')
    expect(await screen.findByText('Команд ще немає.')).toBeTruthy()
    const form = screen.getByRole('form', { name: 'Нова команда' })
    fireEvent.change(within(form).getByLabelText('Назва'), { target: { value: 'Альфа' } })
    fireEvent.change(within(form).getByLabelText('Тімлід'), { target: { value: 'user-2' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Створити команду' }))
    const team = await screen.findByRole('article', { name: 'Альфа' })
    expect(api.calls[0]).toEqual({
      method: 'createTeam',
      args: [{ name: 'Альфа', leadUserId: 'user-2' }],
    })
    expect(
      within(screen.getByRole('list', { name: 'Учасники команди Альфа' })).getByText(/Олена/),
    ).toBeTruthy()

    fireEvent.change(
      within(team).getByRole('combobox', { name: 'Додати учасника до команди Альфа' }),
      {
        target: { value: 'user-1' },
      },
    )
    fireEvent.click(within(team).getByRole('button', { name: 'Додати' }))
    await waitFor(() =>
      expect(api.calls).toContainEqual({
        method: 'setTeam',
        args: ['user-1', { teamId: 'team-1' }],
      }),
    )
    // Тимлида не убрать из команды кнопкой — только других участников.
    expect(await screen.findByRole('button', { name: 'Прибрати Власник' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Прибрати Олена' })).toBeNull()
  })

  it('отключённый участник в составе команды помечен', async () => {
    const api = fakeMembersApi()
    api.teams = [
      { id: 'team-9', name: 'Бета', leadUserId: 'user-1', memberUserIds: ['user-1', 'user-2'] },
    ]
    for (const m of api.members) m.teamId = 'team-9'
    const olena = api.members.find((m) => m.userId === 'user-2')
    if (olena) olena.disabled = true
    await renderAt('/settings/teams', 'uk', api)
    const list = await screen.findByRole('list', { name: 'Учасники команди Бета' })
    const items = within(list)
      .getAllByRole('listitem')
      .map((li) => li.textContent ?? '')
    expect(items[0]).not.toContain('вимкнений')
    expect(items[1]).toContain('Олена — вимкнений')
  })

  it('заголовок по-русски', async () => {
    await renderAt('/settings/teams', 'ru')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Команды')
  })
})
