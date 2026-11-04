import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'
import { createI18n } from '../i18n/index.ts'
import { THEME_STORAGE_KEY } from './theme.ts'
import { ThemeSwitcher } from './theme-switcher.tsx'

afterEach(() => {
  delete document.documentElement.dataset.theme
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
})
