import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeProjectsApi } from '../../components/project-switcher/fake-projects-api.ts'
import { createI18n, type Language } from '../../i18n/index.ts'
import { createAppRouter } from '../../router.tsx'
import type { AuthApi, Session } from './auth-api.ts'
import { fakeAuthApi, SIGNED_IN } from './fake-auth-api.ts'

// Первый вход с временным паролем: сначала смена пароля, потом настройка 2FA.

const TEMPORARY: Session = {
  session: { twoFactorVerified: false },
  user: { ...SIGNED_IN.user, twoFactorEnabled: false, mustChangePassword: true },
}

function renderAt(path: string, auth: AuthApi, language: Language = 'uk') {
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    auth,
    projects: fakeProjectsApi(),
  })
  render(
    <I18nextProvider i18n={createI18n(language)}>
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nextProvider>,
  )
  return router
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

beforeEach(() => {
  vi.stubGlobal('fetch', async () => Response.json({ status: 'ok' }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('смена временного пароля', () => {
  it('любой раздел и настройка 2FA ведут на смену пароля', async () => {
    for (const path of ['/deals', '/two-factor-setup']) {
      const router = renderAt(path, fakeAuthApi({ getSession: async () => TEMPORARY }))
      expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe(
        'Зміна тимчасового пароля',
      )
      expect(router.state.location.pathname).toBe('/change-password')
      router.history.destroy()
      document.body.innerHTML = ''
    }
  })

  it('после смены пароля — настройка 2FA', async () => {
    let session = TEMPORARY
    const changePassword = vi.fn(async () => {
      session = { ...session, user: { ...session.user, mustChangePassword: false } }
      return { ok: true as const }
    })
    const router = renderAt(
      '/change-password',
      fakeAuthApi({ getSession: async () => session, changePassword }),
    )
    await screen.findByRole('heading', { name: 'Зміна тимчасового пароля' })
    fill('Тимчасовий пароль', 'Tmp-Pass-1234567')
    fill('Новий пароль', 'my-new-password-1')
    fill('Повторіть новий пароль', 'my-new-password-1')
    fireEvent.click(screen.getByRole('button', { name: 'Змінити пароль' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/two-factor-setup'))
    expect(changePassword).toHaveBeenCalledWith('Tmp-Pass-1234567', 'my-new-password-1')
  })

  it('короткий и неповторённый пароль не отправляются; неверный текущий — ошибка', async () => {
    const changePassword = vi.fn(async () => ({ ok: false as const, error: 'invalid' as const }))
    renderAt(
      '/change-password',
      fakeAuthApi({ getSession: async () => TEMPORARY, changePassword }),
      'ru',
    )
    await screen.findByRole('heading', { name: 'Смена временного пароля' })
    fill('Временный пароль', 'Tmp-Pass-1234567')
    fill('Новый пароль', 'short')
    fill('Повторите новый пароль', 'short')
    fireEvent.click(screen.getByRole('button', { name: 'Сменить пароль' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/не менее 12/)
    fill('Новый пароль', 'my-new-password-1')
    fill('Повторите новый пароль', 'my-new-password-2')
    fireEvent.click(screen.getByRole('button', { name: 'Сменить пароль' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Пароли не совпадают.')
    expect(changePassword).not.toHaveBeenCalled()

    fill('Повторите новый пароль', 'my-new-password-1')
    fireEvent.click(screen.getByRole('button', { name: 'Сменить пароль' }))
    await waitFor(() => expect(changePassword).toHaveBeenCalled())
    expect((await screen.findByRole('alert')).textContent).toMatch(/[Нн]еверный пароль/)
  })
})
