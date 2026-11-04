import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import { fakeProjectsApi } from '../../components/project-switcher/fake-projects-api.ts'
import { createI18n, type Language } from '../../i18n/index.ts'
import { createAppRouter } from '../../router.tsx'
import { fakeAuthApi } from '../auth/fake-auth-api.ts'
import { type FakeProductsApi, fakeProductsApi } from './fake-products-api.ts'

// Экран «Настройки → Товари» в настоящем дереве маршрутов (вошедший пользователь, подставные API).

async function renderAt(
  path: '/settings' | '/settings/products',
  { language = 'uk', api = fakeProductsApi() }: { language?: Language; api?: FakeProductsApi } = {},
) {
  const queryClient = new QueryClient()
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    auth: fakeAuthApi(),
    projects: fakeProjectsApi(),
    products: api,
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

function priceOf(form: HTMLElement, currency: string): string {
  return (within(form).getByRole('spinbutton', { name: `Ціна, ${currency}` }) as HTMLInputElement)
    .value
}

describe('экран товаров', () => {
  it('каталог с тремя ценами; пустая цена — пустое поле', async () => {
    await renderAt('/settings/products')
    const course = await screen.findByRole('form', { name: 'Товар «Курс»' })
    expect(priceOf(course, 'EUR')).toBe('100')
    expect(priceOf(course, 'UAH')).toBe('4000')
    expect(priceOf(course, 'USD')).toBe('')
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Вебінар',
      'Курс',
      'Новий товар',
    ])
  })

  it('создание товара: введённые цены, пустые — без цены', async () => {
    const api = await renderAt('/settings/products')
    const form = await screen.findByRole('form', { name: 'Новий товар' })
    fireEvent.change(within(form).getByRole('textbox', { name: 'Назва' }), {
      target: { value: 'Марафон' },
    })
    fireEvent.change(within(form).getByRole('spinbutton', { name: 'Ціна, USD' }), {
      target: { value: '12.5' },
    })
    fireEvent.click(within(form).getByRole('button', { name: 'Створити товар' }))
    await screen.findByRole('form', { name: 'Товар «Марафон»' })
    expect(api.products.find((p) => p.name === 'Марафон')?.prices).toEqual({
      EUR: null,
      UAH: null,
      USD: 12.5,
    })
    expect(screen.getByRole('status').textContent).toBe('Збережено.')
  })

  it('изменение цены и архив с возвратом', async () => {
    const api = await renderAt('/settings/products')
    const form = await screen.findByRole('form', { name: 'Товар «Вебінар»' })
    fireEvent.change(within(form).getByRole('spinbutton', { name: 'Ціна, EUR' }), {
      target: { value: '' },
    })
    fireEvent.change(within(form).getByRole('spinbutton', { name: 'Ціна, UAH' }), {
      target: { value: '2100' },
    })
    fireEvent.click(within(form).getByRole('button', { name: 'Зберегти' }))
    await waitFor(() =>
      expect(api.products.find((p) => p.name === 'Вебінар')?.prices).toEqual({
        EUR: null,
        UAH: 2100,
        USD: null,
      }),
    )

    const card = screen.getByRole('article', { name: 'Вебінар' })
    fireEvent.click(within(card).getByRole('button', { name: 'В архів' }))
    await within(card).findByText(/в архіві/)
    expect(api.products.find((p) => p.name === 'Вебінар')?.archivedAt).not.toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: 'Повернути з архіву' }))
    await waitFor(() =>
      expect(api.products.find((p) => p.name === 'Вебінар')?.archivedAt).toBeNull(),
    )
  })

  it('без права менять — сообщение об отказе, введённое остаётся', async () => {
    const api = fakeProductsApi()
    await renderAt('/settings/products', { api })
    const form = await screen.findByRole('form', { name: 'Новий товар' })
    const name = within(form).getByRole('textbox', { name: 'Назва' }) as HTMLInputElement
    fireEvent.change(name, { target: { value: 'Мій товар' } })
    api.failNextWith = 'PERMISSION_DENIED'
    fireEvent.click(within(form).getByRole('button', { name: 'Створити товар' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Немає права змінювати товари в цьому проєкті.',
    )
    expect(name.value).toBe('Мій товар')
  })

  it('без права «Товари: бачити» — сообщение вместо каталога', async () => {
    await renderAt('/settings/products', { api: fakeProductsApi({ deny: true }) })
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Немає права «Товари: бачити» в цьому проєкті.',
    )
  })

  it('по-русски; ссылка из настроек', async () => {
    await renderAt('/settings', { language: 'ru' })
    fireEvent.click(screen.getByRole('link', { name: 'Товары' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Товары' })).toBeTruthy()
    expect(await screen.findByRole('form', { name: 'Новый товар' })).toBeTruthy()
  })
})
