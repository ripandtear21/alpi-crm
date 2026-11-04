import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { fireEvent, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n, type Language } from '../../i18n/index.ts'
import { createAppRouter } from '../../router.tsx'
import { type AuthApi, createAuthApi, type Session } from './auth-api.ts'
import { fakeAuthApi, SIGNED_IN } from './fake-auth-api.ts'

const WITHOUT_2FA: Session = { user: { ...SIGNED_IN.user, twoFactorEnabled: false } }

function renderAt(path: string, auth: AuthApi, language: Language = 'uk') {
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }), auth })
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
  // Главная спрашивает /api/health — отвечаем без сети.
  vi.stubGlobal('fetch', async () => Response.json({ status: 'ok' }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('доступ к интерфейсу', () => {
  it('без входа любой раздел открывает экран входа', async () => {
    const router = renderAt('/deals', fakeAuthApi({ getSession: async () => null }))
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Вхід')
    expect(router.state.location.pathname).toBe('/sign-in')
  })

  it('вошедший без 2FA попадает на настройку 2FA', async () => {
    const router = renderAt('/deals', fakeAuthApi({ getSession: async () => WITHOUT_2FA }))
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe(
      'Налаштування двофакторної автентифікації',
    )
    expect(router.state.location.pathname).toBe('/two-factor-setup')
  })
})

describe('экран входа', () => {
  it('пароль принят — экран кода; верный код — в интерфейс', async () => {
    let session: Session | null = null
    const signIn = vi.fn(async () => ({ ok: true as const, twoFactor: true }))
    const verifyTotp = vi.fn(async () => {
      session = SIGNED_IN
      return { ok: true as const }
    })
    const router = renderAt(
      '/sign-in',
      fakeAuthApi({ getSession: async () => session, signIn, verifyTotp }),
    )

    await screen.findByRole('heading', { name: 'Вхід' })
    fill('Email', 'owner@example.test')
    fill('Пароль', 'correct horse battery')
    fireEvent.click(screen.getByRole('button', { name: 'Увійти' }))

    await screen.findByRole('heading', { name: 'Код підтвердження' })
    expect(signIn).toHaveBeenCalledWith('owner@example.test', 'correct horse battery')

    fill('Код', '123456')
    fireEvent.click(screen.getByRole('button', { name: 'Підтвердити' }))
    await screen.findByRole('navigation', { name: 'Головне меню' })
    expect(verifyTotp).toHaveBeenCalledWith('123456')
    expect(router.state.location.pathname).toBe('/')
  })

  it('неверный пароль и лимит попыток — понятные ошибки', async () => {
    const signIn = vi
      .fn<AuthApi['signIn']>()
      .mockResolvedValueOnce({ ok: false, error: 'invalid' })
      .mockResolvedValueOnce({ ok: false, error: 'rate-limited' })
    renderAt('/sign-in', fakeAuthApi({ getSession: async () => null, signIn }), 'ru')

    await screen.findByRole('heading', { name: 'Вход' })
    fill('Email', 'owner@example.test')
    fill('Пароль', 'wrong')
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Неверный email или пароль.')

    fireEvent.click(screen.getByRole('button', { name: 'Войти' }))
    expect((await screen.findByText(/Слишком много попыток/)).getAttribute('role')).toBe('alert')
  })
})

describe('экран кода 2FA', () => {
  it('неверный код — ошибка; резервный код — отдельной проверкой', async () => {
    let session: Session | null = null
    const verifyTotp = vi.fn(async () => ({ ok: false as const, error: 'invalid' as const }))
    const verifyBackupCode = vi.fn(async () => {
      session = SIGNED_IN
      return { ok: true as const }
    })
    renderAt(
      '/sign-in/two-factor',
      fakeAuthApi({ getSession: async () => session, verifyTotp, verifyBackupCode }),
    )

    await screen.findByRole('heading', { name: 'Код підтвердження' })
    fill('Код', '000000')
    fireEvent.click(screen.getByRole('button', { name: 'Підтвердити' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/код невірний/)

    fireEvent.click(screen.getByRole('button', { name: /резервним кодом/ }))
    fill('Резервний код', 'aaaaa-11111')
    fireEvent.click(screen.getByRole('button', { name: 'Підтвердити' }))
    await screen.findByRole('navigation', { name: 'Головне меню' })
    expect(verifyBackupCode).toHaveBeenCalledWith('aaaaa-11111')
  })
})

describe('экран настройки 2FA', () => {
  it('пароль → QR, ключ и резервные коды → код из приложения включает 2FA', async () => {
    let session: Session = WITHOUT_2FA
    const enableTwoFactor = vi.fn(fakeAuthApi().enableTwoFactor)
    const verifyTotp = vi.fn(async () => {
      session = SIGNED_IN
      return { ok: true as const }
    })
    const router = renderAt(
      '/two-factor-setup',
      fakeAuthApi({ getSession: async () => session, enableTwoFactor, verifyTotp }),
    )

    await screen.findByRole('heading', { name: 'Налаштування двофакторної автентифікації' })
    fill('Пароль', 'correct horse battery')
    fireEvent.click(screen.getByRole('button', { name: 'Продовжити' }))

    expect(
      await screen.findByRole('img', { name: 'QR-код для застосунку автентифікації' }),
    ).toBeTruthy()
    expect(enableTwoFactor).toHaveBeenCalledWith('correct horse battery')
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeTruthy()
    expect(screen.getByText('aaaaa-11111')).toBeTruthy()
    expect(screen.getByText('bbbbb-22222')).toBeTruthy()

    fill('Код', '654321')
    fireEvent.click(screen.getByRole('button', { name: 'Увімкнути' }))
    await screen.findByRole('navigation', { name: 'Головне меню' })
    expect(verifyTotp).toHaveBeenCalledWith('654321')
    expect(router.state.location.pathname).toBe('/')
  })

  it('неверный пароль — ошибка, QR не показан', async () => {
    renderAt(
      '/two-factor-setup',
      fakeAuthApi({
        getSession: async () => WITHOUT_2FA,
        enableTwoFactor: async () => ({ ok: false, error: 'invalid' }),
      }),
    )
    await screen.findByRole('heading', { name: 'Налаштування двофакторної автентифікації' })
    fill('Пароль', 'wrong')
    fireEvent.click(screen.getByRole('button', { name: 'Продовжити' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Невірний пароль.')
    expect(screen.queryByRole('img')).toBeNull()
  })
})

describe('createAuthApi', () => {
  function apiAnswering(status: number, body: unknown) {
    const calls: { url: string; init: RequestInit | undefined }[] = []
    const api = createAuthApi(async (input, init) => {
      calls.push({ url: String(input), init })
      return Response.json(body, { status })
    })
    return { api, calls }
  }

  it('вход: шлёт email и пароль на /api/auth/sign-in/email, узнаёт шаг 2FA', async () => {
    const { api, calls } = apiAnswering(200, { twoFactorRedirect: true })
    expect(await api.signIn('a@example.test', 'secret')).toEqual({ ok: true, twoFactor: true })
    expect(calls[0]?.url).toBe('/api/auth/sign-in/email')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      email: 'a@example.test',
      password: 'secret',
    })
  })

  it('разбирает отказы API', async () => {
    expect(await apiAnswering(401, {}).api.signIn('a', 'b')).toEqual({
      ok: false,
      error: 'invalid',
    })
    expect(await apiAnswering(429, {}).api.signIn('a', 'b')).toEqual({
      ok: false,
      error: 'rate-limited',
    })
    expect(await apiAnswering(403, { code: 'BANNED_USER' }).api.signIn('a', 'b')).toEqual({
      ok: false,
      error: 'banned',
    })
    expect(await apiAnswering(500, {}).api.verifyTotp('1')).toEqual({ ok: false, error: 'failed' })
  })

  it('включение 2FA достаёт секрет из totpURI', async () => {
    const { api } = apiAnswering(200, {
      totpURI: 'otpauth://totp/Alpi%20CRM:a%40example.test?secret=ABCDEF&issuer=Alpi%20CRM',
      backupCodes: ['x'],
    })
    expect(await api.enableTwoFactor('p')).toMatchObject({ ok: true, secret: 'ABCDEF' })
  })
})
