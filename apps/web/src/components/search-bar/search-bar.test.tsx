import { PROJECT_HEADER } from '@alpi/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import { createI18n } from '../../i18n/index.ts'
import { createAppRouter } from '../../router.tsx'
import { fakeAuthApi } from '../../routes/auth/fake-auth-api.ts'
import { fakeDealsApi } from '../../routes/deals/fake-deals-api.ts'
import { setViewportWidth } from '../../test/viewport.ts'
import {
  fakeProjectsApi,
  PROJECT_ALPI,
  PROJECT_FRANCH,
} from '../project-switcher/fake-projects-api.ts'
import {
  type FakeSearchApi,
  type FakeSearchContact,
  type FakeSearchDeal,
  fakeSearchApi,
} from './fake-search-api.ts'
import { createSearchApi, SearchApiError } from './search-api.ts'

// Строка поиска в шапке (тикет crm-deals/15) в настоящем дереве маршрутов: вошедший
// пользователь user-1, подставной API поиска. Имена вымышленные.

const CONTACT: FakeSearchContact = {
  id: '00000000-0000-4000-9500-0000000000c1',
  firstName: 'Ірина',
  lastName: 'Мельник',
  phones: ['+380671234567'],
}
const OWN_DEAL: FakeSearchDeal = {
  id: '00000000-0000-4000-9500-0000000000a1',
  title: 'Ірина Мельник — курс',
  status: 'open',
  archivedAt: null,
  ownerId: 'user-1',
}
const ARCHIVED_DEAL: FakeSearchDeal = {
  id: '00000000-0000-4000-9500-0000000000a2',
  title: 'Ірина Мельник — вебінар',
  status: 'lost',
  archivedAt: '2026-10-01T10:00:00.000Z',
  ownerId: 'user-1',
}
const FOREIGN_DEAL: FakeSearchDeal = {
  id: '00000000-0000-4000-9500-0000000000a3',
  title: 'Ірина Мельник — чужа угода',
  status: 'open',
  archivedAt: null,
  ownerId: 'user-2',
}
const ORGANIZATION = { id: '00000000-0000-4000-9500-0000000000d1', name: 'Мельник і партнери' }

function renderApp(search: FakeSearchApi, path = '/p/alpi/deals') {
  const queryClient = new QueryClient()
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    auth: fakeAuthApi(),
    projects: fakeProjectsApi(),
    deals: fakeDealsApi(),
    search,
    queryClient,
  })
  render(
    <I18nextProvider i18n={createI18n('uk')}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nextProvider>,
  )
  return router
}

async function searchField() {
  return (await screen.findByRole('combobox', { name: 'Швидкий пошук' })) as HTMLInputElement
}

function type(field: HTMLInputElement, value: string) {
  fireEvent.focus(field)
  fireEvent.change(field, { target: { value } })
}

const results = () => screen.findByRole('listbox', { name: 'Результати пошуку' })

/** Подписи вариантов списка по порядку. */
function optionLabels(listbox: HTMLElement) {
  return within(listbox)
    .getAllByRole('option')
    .map((option) => option.querySelector('.search-bar__label')?.textContent)
}

describe('строка поиска в шапке', () => {
  it('телефон в другом формате — контакт с этим номером, запрос один, в проекте из адреса', async () => {
    const api = fakeSearchApi({ contacts: [CONTACT], deals: [OWN_DEAL] })
    renderApp(api, '/p/franch/deals')
    const field = await searchField()

    type(field, '067 123 45 67')

    const listbox = await results()
    expect(within(listbox).getByRole('group', { name: 'Контакти' })).toBeTruthy()
    expect(optionLabels(listbox)).toEqual(['Ірина Мельник'])
    expect(within(listbox).queryByRole('group', { name: 'Угоди' })).toBeNull()
    expect(api.calls).toEqual([{ projectId: PROJECT_FRANCH.id, query: '067 123 45 67' }])
    expect(field.getAttribute('aria-expanded')).toBe('true')
  })

  it('группы «Угоди», «Контакти», «Організації»; архивная сделка с пометкой', async () => {
    renderApp(
      fakeSearchApi({
        deals: [OWN_DEAL, ARCHIVED_DEAL],
        contacts: [CONTACT],
        organizations: [ORGANIZATION],
      }),
    )
    type(await searchField(), 'Мельник')

    const listbox = await results()
    expect(
      within(listbox)
        .getAllByRole('group')
        .map((group) => group.firstChild?.textContent),
    ).toEqual(['Угоди', 'Контакти', 'Організації'])
    const archived = within(listbox).getByRole('option', { name: /вебінар/ })
    expect(within(archived).getByText('Архів')).toBeTruthy()
    expect(within(archived).getByText('Програно')).toBeTruthy()
    const open = within(listbox).getByRole('option', { name: /курс/ })
    expect(within(open).queryByText('Архів')).toBeNull()
  })

  it('стрелки выделяют результат, Enter открывает его по ссылке с проектом', async () => {
    const router = renderApp(
      fakeSearchApi({ deals: [OWN_DEAL], contacts: [CONTACT], organizations: [ORGANIZATION] }),
    )
    const field = await searchField()
    type(field, 'Мельник')
    const listbox = await results()
    const options = within(listbox).getAllByRole('option')

    fireEvent.keyDown(field, { key: 'ArrowDown' })
    expect(field.getAttribute('aria-activedescendant')).toBe(options[0]?.id)
    expect(options[0]?.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    expect(field.getAttribute('aria-activedescendant')).toBe(options[1]?.id)
    // Вверх с первого — последний, вниз с последнего — первый.
    fireEvent.keyDown(field, { key: 'ArrowUp' })
    fireEvent.keyDown(field, { key: 'ArrowUp' })
    expect(field.getAttribute('aria-activedescendant')).toBe(options[2]?.id)
    fireEvent.keyDown(field, { key: 'ArrowUp' })

    fireEvent.keyDown(field, { key: 'Enter' })

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/p/alpi/contacts/${CONTACT.id}`),
    )
    expect(field.value).toBe('')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('щелчок по результату открывает сделку в проекте из адреса', async () => {
    const router = renderApp(fakeSearchApi({ deals: [OWN_DEAL] }), '/p/franch/deals')
    type(await searchField(), 'курс')
    fireEvent.mouseDown(within(await results()).getByRole('option', { name: OWN_DEAL.title }))
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/p/franch/deals/${OWN_DEAL.id}`),
    )
  })

  it('Escape закрывает список, текст остаётся', async () => {
    renderApp(fakeSearchApi({ contacts: [CONTACT] }))
    const field = await searchField()
    type(field, 'Ірина')
    await results()

    fireEvent.keyDown(field, { key: 'Escape' })

    expect(screen.queryByRole('listbox')).toBeNull()
    expect(field.getAttribute('aria-expanded')).toBe('false')
    expect(field.value).toBe('Ірина')
  })

  it('менеджер «свої»: в списке только то, что вернул API, — чужих сделок нет', async () => {
    renderApp(
      fakeSearchApi({
        deals: [OWN_DEAL, FOREIGN_DEAL],
        visibleDeals: (deal) => deal.ownerId === 'user-1',
      }),
    )
    type(await searchField(), 'Мельник')
    const listbox = await results()
    expect(optionLabels(listbox)).toEqual([OWN_DEAL.title])
    expect(screen.queryByText(FOREIGN_DEAL.title)).toBeNull()
  })

  it('пока ввод идёт, запрос не уходит; один символ — без запроса', async () => {
    const api = fakeSearchApi({ contacts: [CONTACT] })
    renderApp(api)
    const field = await searchField()
    type(field, 'І')
    type(field, 'Ір')
    type(field, 'Іри')
    await results()
    expect(api.calls.map((call) => call.query)).toEqual(['Іри'])

    type(field, 'І')
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)))
    expect(api.calls).toHaveLength(1)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('ничего не найдено и отказ API — пояснение вместо списка', async () => {
    renderApp(fakeSearchApi())
    type(await searchField(), 'Нікого')
    expect((await screen.findByText('Нічого не знайдено.')).getAttribute('role')).toBe('status')
  })

  it.each([
    [404, null, 'Пошук зараз недоступний. Спробуйте пізніше.'],
    [403, 'PERMISSION_DENIED', 'У вас немає права на пошук у цьому проєкті.'],
  ])('API ответил %i — «%s»', async (status, code, text) => {
    renderApp(fakeSearchApi({ failWith: { status, code } }))
    type(await searchField(), 'Мельник')
    expect(await screen.findByText(text)).toBeTruthy()
  })

  it('на телефоне поиск открывается во весь экран и закрывается выбором результата', async () => {
    setViewportWidth(375)
    const router = renderApp(fakeSearchApi({ contacts: [CONTACT] }))
    fireEvent.click(await screen.findByRole('button', { name: 'Відкрити пошук' }))
    const dialog = await screen.findByRole('dialog', { name: 'Швидкий пошук' })
    const field = within(dialog).getByRole('combobox', {
      name: 'Швидкий пошук',
    }) as HTMLInputElement
    expect(document.activeElement).toBe(field)

    type(field, '+380 67 123 45 67')
    await within(dialog).findByRole('listbox', { name: 'Результати пошуку' })
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    fireEvent.keyDown(field, { key: 'Enter' })

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/p/alpi/contacts/${CONTACT.id}`),
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('запросы поиска', () => {
  it('GET /api/v1/search?q=… в контексте проекта; группы без права — пустые', async () => {
    const calls: { url: string; project: string | null }[] = []
    const api = createSearchApi(async (input, init) => {
      calls.push({ url: String(input), project: new Headers(init?.headers).get(PROJECT_HEADER) })
      return Response.json({
        deals: { items: [], hasMore: false },
        contacts: {
          items: [{ id: CONTACT.id, firstName: 'Ірина', lastName: null }],
          hasMore: true,
        },
      })
    })
    const result = await api.search(PROJECT_ALPI.id, '067 123')
    expect(calls).toEqual([{ url: '/api/v1/search?q=067+123', project: PROJECT_ALPI.id }])
    expect(result.contacts.hasMore).toBe(true)
    expect(result.organizations).toEqual({ items: [], hasMore: false })
  })

  it('отказ — SearchApiError со статусом и кодом', async () => {
    const api = createSearchApi(async () =>
      Response.json({ code: 'INVALID_SEARCH', details: { path: 'q' } }, { status: 400 }),
    )
    const failure = await api.search(PROJECT_ALPI.id, 'x').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SearchApiError)
    expect(failure).toMatchObject({ status: 400, code: 'INVALID_SEARCH' })
  })
})
