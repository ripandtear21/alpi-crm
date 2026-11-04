import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import { createI18n, LANGUAGE_STORAGE_KEY, type Language } from '../i18n/index.ts'
import { createAppRouter } from '../router.tsx'
import { setViewportWidth } from '../test/viewport.ts'

// Настоящее дерево маршрутов в памяти; стартуем с раздела, а не с главной,
// чтобы не ходить в API за /health.
async function renderApp(language: Language = 'uk') {
  const router = createAppRouter(createMemoryHistory({ initialEntries: ['/deals'] }))
  render(
    <I18nextProvider i18n={createI18n(language)}>
      <RouterProvider router={router} />
    </I18nextProvider>,
  )
  await screen.findByRole('heading', { level: 1 })
}

describe('каркас интерфейса', () => {
  it('рендерит шапку с местами под проект, поиск, уведомления, профиль и левое меню', async () => {
    await renderApp()

    const header = screen.getByRole('banner')
    expect(within(header).getByText('Alpi CRM')).toBeTruthy()
    expect(within(header).getByRole('combobox', { name: 'Проєкт' })).toBeTruthy()
    expect(within(header).getByRole('searchbox', { name: 'Швидкий пошук' })).toBeTruthy()
    expect(within(header).getByRole('button', { name: 'Сповіщення' })).toBeTruthy()
    expect(within(header).getByRole('button', { name: 'Профіль' })).toBeTruthy()

    const nav = screen.getByRole('navigation', { name: 'Головне меню' })
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Угоди', 'Контакти', 'Задачі', 'Звіти', 'Налаштування'])
    expect(screen.getByRole('main').textContent).toContain('Угоди')
  })

  it('переключение языка меняет тексты шапки, меню и страницы', async () => {
    await renderApp('uk')

    fireEvent.click(screen.getByRole('button', { name: 'Російська' }))

    const nav = await screen.findByRole('navigation', { name: 'Главное меню' })
    expect(within(nav).getByRole('link', { name: 'Сделки' })).toBeTruthy()
    expect(screen.getByRole('searchbox', { name: 'Быстрый поиск' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Сделки')
    expect(screen.getByRole('button', { name: 'Русский' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('ru')
  })

  it('на ширине 375 px меню свёрнуто и открывается кнопкой', async () => {
    setViewportWidth(375)
    await renderApp()

    const toggle = screen.getByRole('button', { name: 'Відкрити меню' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('navigation')).toBeNull()

    fireEvent.click(toggle)
    const nav = screen.getByRole('navigation', { name: 'Головне меню' })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.getAttribute('aria-label')).toBe('Закрити меню')

    // Переход в раздел закрывает меню, чтобы оно не загораживало открытый экран.
    fireEvent.click(within(nav).getByRole('link', { name: 'Контакти' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Контакти' })).toBeTruthy()
    expect(screen.queryByRole('navigation')).toBeNull()
  })

  it('на широком экране меню видно всегда, кнопки меню нет', async () => {
    setViewportWidth(1280)
    await renderApp()

    expect(screen.getByRole('navigation', { name: 'Головне меню' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Відкрити меню' })).toBeNull()
  })

  it('после расширения окна и нового сужения меню снова свёрнуто', async () => {
    // Начинаем с широкого окна: happy-dom 21 не шлёт первое событие change, если подписка
    // сделана, когда запрос уже совпадал (внутренний флаг стартует с false).
    setViewportWidth(1280)
    await renderApp()
    act(() => setViewportWidth(375))
    fireEvent.click(screen.getByRole('button', { name: 'Відкрити меню' }))
    expect(screen.getByRole('navigation')).toBeTruthy()

    act(() => setViewportWidth(1280))
    expect(screen.getByRole('navigation')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Закрити меню' })).toBeNull()

    act(() => setViewportWidth(375))
    expect(screen.queryByRole('navigation')).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Відкрити меню' }).getAttribute('aria-expanded'),
    ).toBe('false')
  })
})
