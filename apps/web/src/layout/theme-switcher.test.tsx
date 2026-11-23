import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '../i18n/index.ts'
import { THEME_STORAGE_KEY } from './theme.ts'
import { ThemeSwitcher } from './theme-switcher.tsx'

afterEach(() => {
  delete document.documentElement.dataset.theme
  vi.restoreAllMocks()
})

describe('переключатель темы', () => {
  it('ставит тему на <html> и запоминает выбор', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
    render(
      <I18nextProvider i18n={createI18n('ru')}>
        <ThemeSwitcher />
      </I18nextProvider>,
    )

    const light = screen.getByRole('button', { name: 'Светлая тема' })
    const dark = screen.getByRole('button', { name: 'Тёмная тема' })
    expect(light.getAttribute('aria-pressed')).toBe('true')

    await user.click(dark)
    expect(dark.getAttribute('aria-pressed')).toBe('true')
    expect(light.getAttribute('aria-pressed')).toBe('false')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
  })

  it('без сохранённого выбора идёт за сменой темы системы без перезагрузки', () => {
    const system = fakeSystemTheme(false)
    renderSwitcher()
    expect(screen.getByRole('button', { name: 'Светлая тема' }).getAttribute('aria-pressed')).toBe(
      'true',
    )

    act(() => system.change(true))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(screen.getByRole('button', { name: 'Тёмная тема' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
  })

  it('сохранённый выбор сильнее смены темы системы', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
    const system = fakeSystemTheme(false)
    renderSwitcher()

    act(() => system.change(true))
    expect(document.documentElement.dataset.theme).toBeUndefined()
    expect(screen.getByRole('button', { name: 'Светлая тема' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
  })

  it('после ухода со страницы подписка на тему системы снята', () => {
    const system = fakeSystemTheme(false)
    const { unmount } = renderSwitcher()
    expect(system.listeners.size).toBe(1)
    unmount()
    expect(system.listeners.size).toBe(0)
  })
})

function renderSwitcher() {
  return render(
    <I18nextProvider i18n={createI18n('ru')}>
      <ThemeSwitcher />
    </I18nextProvider>,
  )
}

/** Подменяет window.matchMedia: тема системы, которую тест меняет сам. */
function fakeSystemTheme(dark: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const list = {
    matches: dark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.delete(listener),
  } as unknown as MediaQueryList
  vi.spyOn(window, 'matchMedia').mockReturnValue(list)
  return {
    listeners,
    change(next: boolean) {
      ;(list as { matches: boolean }).matches = next
      for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent)
    },
  }
}
