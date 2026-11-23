import { fullPermissions, type RolePermissions } from '@alpi/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeProjectsApi } from '../../../components/project-switcher/fake-projects-api.ts'
import { createI18n } from '../../../i18n/index.ts'
import { createAppRouter } from '../../../router.tsx'
import { fakeAuthApi } from '../../auth/fake-auth-api.ts'
import { fakeDeal, fakeDealsApi } from '../fake-deals-api.ts'
import {
  type FakeListsApi,
  fakeContactRow,
  fakeDealRow,
  fakeListsApi,
  fakeOrganizationRow,
  LIST_PIPELINE,
  LIST_STAGE_CALL,
} from './fake-lists-api.ts'
import { ListsApiError } from './lists-api.ts'

// Списки сделок, контактов и организаций, фильтр, массовые действия и корзина (тикет
// crm-deals/12) в настоящем дереве маршрутов: вошедший пользователь, подставные API.

async function renderAt(path: string, api: FakeListsApi, deals = fakeDealsApi()) {
  const queryClient = new QueryClient()
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    auth: fakeAuthApi(),
    projects: fakeProjectsApi(),
    lists: api,
    deals,
    queryClient,
  })
  render(
    <I18nextProvider i18n={createI18n('uk')}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nextProvider>,
  )
  await screen.findByRole('heading', { level: 1 })
  return api
}

const table = () => screen.findByRole('table', { name: /за фільтром/ })

async function titles(): Promise<string[]> {
  const rows = within(await table())
    .getAllByRole('row')
    .slice(1)
  return rows.map((row) => within(row).getAllByRole('cell')[1]?.textContent ?? '')
}

function without(permissions: RolePermissions, standalone: string[]): RolePermissions {
  return {
    ...permissions,
    standalone: permissions.standalone.filter((p) => !standalone.includes(p)),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('список сделок', () => {
  it('строки, счётчик и сортировка по сумме с сервера', async () => {
    const api = await renderAt(
      '/deals/list',
      fakeListsApi({
        deals: [
          fakeDealRow({ title: 'Середня', amount: 200 }),
          fakeDealRow({ title: 'Мала', amount: 100 }),
          fakeDealRow({ title: 'Велика', amount: 300 }),
          fakeDealRow({ title: 'Архівна', amount: 50, archivedAt: '2026-11-02T10:00:00.000Z' }),
        ],
      }),
    )
    expect(await screen.findByText('Знайдено: 3')).toBeTruthy()
    expect(await titles()).toHaveLength(3)

    fireEvent.click(screen.getByRole('button', { name: /Сума/ }))
    await waitFor(async () => expect(await titles()).toEqual(['Мала', 'Середня', 'Велика']))
    expect(api.calls.at(-1)).toMatchObject({ method: 'page', value: { sort: 'amount:asc' } })
    expect(screen.getByRole('columnheader', { name: /Сума/ }).getAttribute('aria-sort')).toBe(
      'ascending',
    )

    fireEvent.click(screen.getByRole('button', { name: /Сума/ }))
    await waitFor(async () => expect(await titles()).toEqual(['Велика', 'Середня', 'Мала']))
  })

  it('«Показати ще» подгружает следующую страницу по курсору', async () => {
    const api = fakeListsApi({
      deals: Array.from({ length: 5 }, (_, i) => fakeDealRow({ title: `Угода ${i}`, amount: i })),
    })
    api.pageSize = 2
    await renderAt('/deals/list', api)
    await waitFor(async () => expect(await titles()).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: 'Показати ще' }))
    await waitFor(async () => expect(await titles()).toHaveLength(4))
    fireEvent.click(screen.getByRole('button', { name: 'Показати ще' }))
    await waitFor(async () => expect(await titles()).toHaveLength(5))
    expect(screen.queryByRole('button', { name: 'Показати ще' })).toBeNull()
  })

  it('ссылка из колонки канбана: фильтр воронки и этапа из адреса', async () => {
    const api = await renderAt(
      `/deals/list?pipeline=${LIST_PIPELINE}&stage=${LIST_STAGE_CALL}`,
      fakeListsApi({
        deals: [
          fakeDealRow({ title: 'На дзвінку', stageId: LIST_STAGE_CALL }),
          fakeDealRow({ title: 'Новий лід' }),
        ],
      }),
    )
    await waitFor(async () => expect(await titles()).toEqual(['На дзвінку']))
    expect(api.calls.find((c) => c.method === 'page')?.value).toMatchObject({
      filter: {
        and: [
          { field: 'pipeline', op: 'eq', value: LIST_PIPELINE },
          { field: 'stage', op: 'eq', value: LIST_STAGE_CALL },
        ],
      },
    })
    expect(screen.getByRole('button', { name: 'Фільтр (2)' })).toBeTruthy()
  })

  it('фильтр: условие «статус = виграна» уходит в запрос и сужает список', async () => {
    const api = await renderAt(
      '/deals/list',
      fakeListsApi({
        deals: [
          fakeDealRow({ title: 'Виграна', status: 'won' }),
          fakeDealRow({ title: 'Відкрита' }),
        ],
      }),
    )
    await waitFor(async () => expect(await titles()).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: 'Фільтр' }))
    const panel = await screen.findByRole('dialog', { name: 'Фільтр' })
    fireEvent.click(
      within(panel).getAllByRole('button', { name: 'Додати умову' })[0] as HTMLElement,
    )
    fireEvent.change(within(panel).getByLabelText('Поле'), { target: { value: 'status' } })
    fireEvent.change(within(panel).getByLabelText('Значення'), { target: { value: 'won' } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Застосувати' }))

    await waitFor(async () => expect(await titles()).toEqual(['Виграна']))
    expect(api.calls.at(-1)?.value).toMatchObject({
      filter: { and: [{ field: 'status', op: 'eq', value: 'won' }] },
    })
    expect(screen.getByText('Знайдено: 1')).toBeTruthy()
  })

  it('фильтр без значения не применяется: подсказка в панели', async () => {
    await renderAt('/deals/list', fakeListsApi({ deals: [fakeDealRow()] }))
    fireEvent.click(await screen.findByRole('button', { name: 'Фільтр' }))
    const panel = await screen.findByRole('dialog', { name: 'Фільтр' })
    fireEvent.click(
      within(panel).getAllByRole('button', { name: 'Додати умову' })[0] as HTMLElement,
    )
    fireEvent.change(within(panel).getByLabelText('Поле'), { target: { value: 'title' } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Застосувати' }))
    expect(await within(panel).findByText('Заповніть значення в усіх умовах.')).toBeTruthy()
  })

  it('массовое архивирование всех по фильтру: прогресс и итог, список обновился', async () => {
    const api = fakeListsApi({
      deals: Array.from({ length: 5 }, (_, i) => fakeDealRow({ title: `Угода ${i}` })),
    })
    api.pageSize = 2
    api.bulkStep = 2
    await renderAt('/deals/list', api)
    await waitFor(async () => expect(await titles()).toHaveLength(2))

    fireEvent.click(screen.getByRole('checkbox', { name: 'Вибрати всі на сторінці' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Вибрати всі 5 за фільтром' }))
    expect(screen.getByText('Вибрано всі за фільтром: 5')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Масова дія' }))
    const dialog = await screen.findByRole('dialog', { name: 'Масова дія' })
    expect(within(dialog).getByText('Усі записи за фільтром: 5')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Запустити' }))

    expect(await within(dialog).findByRole('progressbar')).toBeTruthy()
    expect(
      await within(dialog).findByText('Готово: оброблено 5, з помилкою 0.', {}, { timeout: 5000 }),
    ).toBeTruthy()
    expect(api.calls.find((c) => c.method === 'startBulk')?.value).toMatchObject({
      action: 'deals.archive',
      selection: { filter: { and: [] } },
    })
    expect(api.rows.deals.every((d) => d.archivedAt !== null)).toBe(true)
    fireEvent.click(
      within(dialog).getAllByRole('button', { name: 'Закрити' }).at(-1) as HTMLElement,
    )
    expect(await screen.findByText('Нічого не знайдено. Змініть фільтр.')).toBeTruthy()
  }, 15000)

  it('без права «масові операції» нет выбора строк действия, без «експорт» — выгрузки', async () => {
    await renderAt(
      '/deals/list',
      fakeListsApi(
        { deals: [fakeDealRow({ title: 'Одна' })] },
        without(fullPermissions(), ['bulk_operations', 'export']),
      ),
    )
    await waitFor(async () => expect(await titles()).toEqual(['Одна']))
    expect(screen.queryByRole('button', { name: 'Вивантажити CSV' })).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Вибрати «Одна»' }))
    expect(await screen.findByText('Вибрано: 1')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Масова дія' })).toBeNull()
  })

  it('«Передати» в массовом действии только с правом «передача угод»', async () => {
    await renderAt(
      '/deals/list',
      fakeListsApi(
        { deals: [fakeDealRow({ title: 'Одна' })] },
        without(fullPermissions(), ['transfer_deals']),
      ),
    )
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Вибрати «Одна»' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Масова дія' }))
    const dialog = await screen.findByRole('dialog', { name: 'Масова дія' })
    const actions = within(within(dialog).getByLabelText('Дія'))
      .getAllByRole('option')
      .map((o) => o.textContent)
    expect(actions).toContain('Архівувати')
    expect(actions).not.toContain('Передати')
  })

  it('выгрузка CSV: текущие фильтр, сортировка и колонки; файл скачивается', async () => {
    const createUrl = vi.fn(() => 'blob:test')
    Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const api = await renderAt('/deals/list', fakeListsApi({ deals: [fakeDealRow()] }))
    fireEvent.click(await screen.findByRole('button', { name: 'Вивантажити CSV' }))
    expect(await screen.findByText('Файл вивантажено.')).toBeTruthy()
    expect(api.calls.find((c) => c.method === 'exportCsv')?.value).toEqual({
      filter: { and: [] },
      sort: 'stageChangedAt:desc',
      columns: ['title', 'stage', 'status', 'amount', 'owner', 'contact', 'createdAt'],
      lang: 'uk',
    })
    expect(createUrl).toHaveBeenCalled()
    expect(click).toHaveBeenCalled()
  })

  it('выбор колонок запоминается для пользователя', async () => {
    await renderAt('/deals/list', fakeListsApi({ deals: [fakeDealRow()] }))
    fireEvent.click(await screen.findByRole('button', { name: 'Колонки' }))
    const dialog = await screen.findByRole('dialog', { name: 'Колонки списку' })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Воронка' }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Контакт' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Готово' }))
    expect(await screen.findByRole('columnheader', { name: 'Воронка' })).toBeTruthy()
    expect(screen.queryByRole('columnheader', { name: 'Контакт' })).toBeNull()
    const stored = Object.keys(window.localStorage).find((k) => k.startsWith('alpi.list.columns.'))
    expect(stored?.endsWith('.deals')).toBe(true)
    expect(JSON.parse(window.localStorage.getItem(stored ?? '') ?? '[]')).toContain('pipeline')
  })

  it('сохранённый фильтр: без права «спільні фільтри» — только «Лише я»', async () => {
    const api = await renderAt(
      '/deals/list',
      fakeListsApi({ deals: [fakeDealRow()] }, without(fullPermissions(), ['shared_filters'])),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Збережені фільтри' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Зберегти поточний фільтр…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Зберегти фільтр' })
    const options = within(within(dialog).getByLabelText('Хто бачить'))
      .getAllByRole('option')
      .map((o) => o.textContent)
    expect(options).toEqual(['Лише я'])
    fireEvent.change(within(dialog).getByLabelText('Назва'), { target: { value: 'Мої' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Зберегти' }))
    expect(await screen.findByText('Фільтр «Мої» збережено.')).toBeTruthy()
    expect(api.saved.map((f) => [f.name, f.visibility])).toEqual([['Мої', 'personal']])

    fireEvent.click(screen.getByRole('button', { name: 'Збережені фільтри' }))
    expect(await screen.findByRole('menuitem', { name: 'Мої' })).toBeTruthy()
  })

  it('с правом «спільні фільтри» и охватом «усі» — команда и проект', async () => {
    await renderAt('/deals/list', fakeListsApi({ deals: [fakeDealRow()] }))
    fireEvent.click(await screen.findByRole('button', { name: 'Збережені фільтри' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Зберегти поточний фільтр…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Зберегти фільтр' })
    const options = within(within(dialog).getByLabelText('Хто бачить'))
      .getAllByRole('option')
      .map((o) => o.textContent)
    expect(options).toEqual(['Лише я', 'Моя команда', 'Увесь проєкт'])
  })
})

describe('канбан и фильтр', () => {
  it('фильтр канбана уходит в выдачу колонок той же формы', async () => {
    const deals = fakeDealsApi([
      fakeDeal({ title: 'Ірина — вебінар', amount: 100 }),
      fakeDeal({ title: 'Марко — курс', amount: 900 }),
    ])
    await renderAt('/deals', fakeListsApi(), deals)
    await screen.findByRole('article', { name: 'Марко — курс' })
    fireEvent.click(screen.getByRole('button', { name: 'Фільтр' }))
    const panel = await screen.findByRole('dialog', { name: 'Фільтр' })
    fireEvent.click(
      within(panel).getAllByRole('button', { name: 'Додати умову' })[0] as HTMLElement,
    )
    fireEvent.change(within(panel).getByLabelText('Поле'), { target: { value: 'amount' } })
    fireEvent.change(within(panel).getByLabelText('Умова'), { target: { value: 'gt' } })
    fireEvent.change(within(panel).getByLabelText('Значення'), { target: { value: '500' } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Застосувати' }))

    await waitFor(() =>
      expect(screen.queryByRole('article', { name: 'Ірина — вебінар' })).toBeNull(),
    )
    expect(await screen.findByRole('article', { name: 'Марко — курс' })).toBeTruthy()
    expect(deals.calls.find((c) => c.action === 'stagePage')?.value).toEqual({
      and: [{ field: 'amount', op: 'gt', value: 500 }],
    })
    const link = screen.getByRole('link', { name: 'Список' })
    const href = new URL(link.getAttribute('href') ?? '', 'http://x')
    expect(href.pathname).toBe('/p/alpi/deals/list')
    expect(JSON.parse(href.searchParams.get('filter') ?? '{}')).toEqual({
      and: [{ field: 'amount', op: 'gt', value: 500 }],
    })
  })
})

describe('списки контактов и организаций', () => {
  it('контакты: строки со ссылкой на карточку, сортировка по имени', async () => {
    const api = await renderAt(
      '/contacts',
      fakeListsApi({
        contacts: [
          fakeContactRow({ firstName: 'Богдан', lastName: null }),
          fakeContactRow({ firstName: 'Анна', lastName: 'Коваль' }),
        ],
      }),
    )
    expect(await screen.findByRole('heading', { name: 'Контакти' })).toBeTruthy()
    expect(await screen.findByRole('link', { name: 'Анна Коваль' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Ім'я/ }))
    await waitFor(() =>
      expect(api.calls.at(-1)).toMatchObject({ entity: 'contacts', value: { sort: 'name:asc' } }),
    )
    expect(screen.queryByRole('checkbox', { name: /Вибрати/ })).toBeNull()
  })

  it('организации: отдельный пункт меню и список', async () => {
    await renderAt('/organizations', fakeListsApi({ organizations: [fakeOrganizationRow()] }))
    expect(await screen.findByRole('heading', { name: 'Організації' })).toBeTruthy()
    expect(await screen.findByRole('link', { name: 'ТОВ Вигадка' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Організації' })).toBeTruthy()
  })
})

describe('корзина', () => {
  const trashed = {
    type: 'deal' as const,
    id: '00000000-0000-4000-9b00-000000000001',
    title: 'Ірина — вебінар',
    deletedAt: '2026-11-20T10:00:00.000Z',
    deletedByName: 'Власник',
    purgeAt: '2026-12-20T10:00:00.000Z',
  }

  it('восстановление с конфликтом открытой сделки: понятная подсказка, запись на месте', async () => {
    const api = fakeListsApi()
    api.trashItems = [trashed]
    api.failNext = new ListsApiError(409, 'OPEN_DEAL_EXISTS', { dealId: 'x' })
    await renderAt('/settings/trash', api)
    fireEvent.click(await screen.findByRole('button', { name: 'Відновити' }))
    expect(await screen.findByText(/у контакта вже є відкрита угода в цій воронці/)).toBeTruthy()
    expect(screen.getByText('Ірина — вебінар')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Відновити' }))
    expect(await screen.findByText('«Ірина — вебінар» відновлено.')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('cell', { name: 'Ірина — вебінар' })).toBeNull())
  })

  it('без права «Кошик: видаляти» нет кнопки окончательного удаления', async () => {
    const permissions = fullPermissions()
    permissions.actions.trash = ['view', 'edit']
    const api = fakeListsApi({}, permissions)
    api.trashItems = [trashed]
    await renderAt('/settings/trash', api)
    expect(await screen.findByRole('button', { name: 'Відновити' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Видалити остаточно' })).toBeNull()
  })

  it('окончательное удаление — после подтверждения', async () => {
    const api = fakeListsApi()
    api.trashItems = [trashed]
    await renderAt('/settings/trash', api)
    fireEvent.click(await screen.findByRole('button', { name: 'Видалити остаточно' }))
    const dialog = await screen.findByRole('dialog', { name: 'Видалити остаточно' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Видалити остаточно' }))
    expect(await screen.findByText('«Ірина — вебінар» видалено остаточно.')).toBeTruthy()
    expect(api.calls.at(-1)).toMatchObject({ method: 'purge', entity: 'deal', value: trashed.id })
  })
})
