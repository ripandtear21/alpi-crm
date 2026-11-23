import type { ProjectSummary } from '@alpi/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '../../i18n/index.ts'
import { createAppRouter } from '../../router.tsx'
import { fakeAuthApi } from '../../routes/auth/fake-auth-api.ts'
import { DealCardApiError } from '../../routes/deals/$dealId/deal-card-api.ts'
import {
  DEAL_ID,
  type FakeDealCardApi,
  fakeDealCardApi,
  sampleDeal,
} from '../../routes/deals/$dealId/fake-deal-card-api.ts'
import { fakeDealsApi } from '../../routes/deals/fake-deals-api.ts'
import { fakeListsApi } from '../../routes/deals/list/fake-lists-api.ts'
import { CONTACT_ID, fakeContactsApi, ORGANIZATION_ID } from '../contact-form/fake-contacts-api.ts'
import { fakeTimelineApi } from '../timeline/fake-timeline-api.ts'
import { PROJECT_STORAGE_KEY, projectQueryKey } from './current-project.tsx'
import { fakeProjectsApi, PROJECT_ALPI, PROJECT_FRANCH } from './fake-projects-api.ts'

// Ссылки с проектом (тикет crm-deals/15) в настоящем дереве маршрутов: вошедший пользователь
// user-1 — участник ALPI и «Франча», подставные API. Сделка ALPI видна только в ALPI, сделка
// «Франча» — только во «Франче»: API проверяет проект по X-Project-Id.

const FRANCH_DEAL_ID = '00000000-0000-4000-9200-0000000000b9'
const MISSING_DEAL_ID = '00000000-0000-4000-9200-0000000000ee'
const FOREIGN_DEAL_ID = '00000000-0000-4000-9200-0000000000ff'
const FORBIDDEN_DEAL_ID = '00000000-0000-4000-9200-0000000000fb'
const ALPI_TITLE = 'Ірина Мельник — курс ALPI'
const FRANCH_TITLE = 'Остап Вигаданий — франшиза'

/** Карточка сделки, которая знает проект запроса, как API. */
function projectDealCardApi(): FakeDealCardApi & { projectsAsked: string[] } {
  const api = fakeDealCardApi({
    deals: [
      sampleDeal({ title: ALPI_TITLE }),
      sampleDeal({ id: FRANCH_DEAL_ID, title: FRANCH_TITLE }),
    ],
  })
  const projectsAsked: string[] = []
  const owner: Record<string, string> = {
    [DEAL_ID]: PROJECT_ALPI.id,
    [FRANCH_DEAL_ID]: PROJECT_FRANCH.id,
  }
  const base = api.deal.bind(api)
  return Object.assign(api, {
    projectsAsked,
    async deal(projectId: string, id: string) {
      projectsAsked.push(projectId)
      // Участие сняли после загрузки списка проектов — API отвечает 403 PROJECT_FORBIDDEN.
      if (id === FORBIDDEN_DEAL_ID) throw new DealCardApiError(403, 'PROJECT_FORBIDDEN')
      // Сделка вне охвата роли — тот же 404, что и несуществующая.
      if (id === FOREIGN_DEAL_ID || owner[id] !== projectId) {
        throw new DealCardApiError(404, 'DEAL_NOT_FOUND')
      }
      return base(projectId, id)
    },
  })
}

function renderAt(
  path: string,
  {
    dealCard = projectDealCardApi(),
    queryClient = new QueryClient(),
    projects = [PROJECT_ALPI, PROJECT_FRANCH],
  }: {
    dealCard?: ReturnType<typeof projectDealCardApi>
    queryClient?: QueryClient
    projects?: ProjectSummary[]
  } = {},
) {
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    auth: fakeAuthApi(),
    projects: fakeProjectsApi(projects),
    deals: fakeDealsApi(),
    dealCard,
    contacts: fakeContactsApi(),
    lists: fakeListsApi(),
    timeline: fakeTimelineApi(),
    queryClient,
  })
  render(
    <I18nextProvider i18n={createI18n('uk')}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nextProvider>,
  )
  return { router, queryClient, dealCard }
}

const switcher = () => screen.getByRole('combobox', { name: 'Проєкт' }) as HTMLSelectElement

describe('ссылка с проектом', () => {
  it('ссылка на сделку проекта Б из проекта А открывает сделку и переключает проект; данные А из кэша не показываются', async () => {
    window.localStorage.setItem(PROJECT_STORAGE_KEY, PROJECT_ALPI.id)
    const { router, queryClient, dealCard } = renderAt(`/p/alpi/deals/${DEAL_ID}`)
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe(ALPI_TITLE)
    expect(switcher().value).toBe(PROJECT_ALPI.id)
    expect(queryClient.getQueryData(projectQueryKey(PROJECT_ALPI.id, 'deal', DEAL_ID))).toBeTruthy()

    // Пользователь открывает ссылку на сделку «Франча», работая в ALPI.
    await router.navigate({ href: `/p/franch/deals/${FRANCH_DEAL_ID}` })

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(FRANCH_TITLE),
    )
    expect(switcher().value).toBe(PROJECT_FRANCH.id)
    expect(screen.queryByText(ALPI_TITLE)).toBeNull()
    // Запрос ушёл в проект из ссылки; кэш ALPI удалён целиком, выбор запомнен.
    expect(dealCard.projectsAsked.at(-1)).toBe(PROJECT_FRANCH.id)
    await waitFor(() =>
      expect(
        queryClient.getQueryData(projectQueryKey(PROJECT_ALPI.id, 'deal', DEAL_ID)),
      ).toBeUndefined(),
    )
    expect(
      queryClient.getQueryData(projectQueryKey(PROJECT_FRANCH.id, 'deal', FRANCH_DEAL_ID)),
    ).toBeTruthy()
    expect(window.localStorage.getItem(PROJECT_STORAGE_KEY)).toBe(PROJECT_FRANCH.id)
  })

  it('не участник, несуществующий код, нет сделки, сделка вне охвата и 403 проекта — один и тот же экран «немає доступу»', async () => {
    const cases = [
      // «other» — проект, где пользователь не участник: в его списке проектов такого кода нет.
      `/p/other/deals/${FRANCH_DEAL_ID}`,
      `/p/no-such-project/deals/${DEAL_ID}`,
      `/p/alpi/deals/${MISSING_DEAL_ID}`,
      `/p/alpi/deals/${FOREIGN_DEAL_ID}`,
      `/p/alpi/deals/${FORBIDDEN_DEAL_ID}`,
      // Сделка есть, но в другом проекте: API проекта из адреса отвечает 404.
      `/p/alpi/deals/${FRANCH_DEAL_ID}`,
    ]
    const screens: string[] = []
    for (const path of cases) {
      renderAt(path)
      const heading = await screen.findByRole(
        'heading',
        { level: 1, name: 'Немає доступу' },
        { timeout: 3000 },
      )
      const main = screen.getByRole('main')
      expect(main.contains(heading)).toBe(true)
      for (const name of [PROJECT_ALPI.name, PROJECT_FRANCH.name, ALPI_TITLE, FRANCH_TITLE]) {
        expect(main.textContent).not.toContain(name)
      }
      screens.push(main.innerHTML)
      cleanup()
    }
    expect(new Set(screens).size).toBe(1)
    expect(screens[0]).toContain(
      'Сторінку не знайдено, її видалено або у вас немає до неї доступу.',
    )
  })

  it('неизвестный код проекта не отвечает мгновенно: сначала та же загрузка, что у карточки', async () => {
    renderAt(`/p/no-such-project/deals/${DEAL_ID}`)
    expect(await screen.findByRole('status')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Немає доступу' })).toBeNull()
    expect(
      await screen.findByRole('heading', { name: 'Немає доступу' }, { timeout: 3000 }),
    ).toBeTruthy()
    // Переключатель не называет проект из адреса и предлагает выбрать свой.
    expect(switcher().value).toBe('')
  })
})

describe('переключатель меняет адрес', () => {
  it('смена проекта — тот же раздел в другом проекте; обновление страницы остаётся в нём', async () => {
    const queryClient = new QueryClient()
    const { router } = renderAt('/p/alpi/deals/list?stage=x', { queryClient })
    await screen.findByRole('heading', { level: 1 })
    queryClient.setQueryData(projectQueryKey(PROJECT_ALPI.id, 'deals'), ['сделка ALPI'])
    queryClient.setQueryData(['health'], { status: 'ok' })

    fireEvent.change(switcher(), { target: { value: PROJECT_FRANCH.id } })

    await waitFor(() => expect(router.state.location.pathname).toBe('/p/franch/deals/list'))
    // Условия в адресе принадлежали воронкам ALPI — в другой проект не переносятся.
    expect(router.state.location.searchStr).toBe('')
    expect(switcher().value).toBe(PROJECT_FRANCH.id)
    await waitFor(() =>
      expect(queryClient.getQueryData(projectQueryKey(PROJECT_ALPI.id, 'deals'))).toBeUndefined(),
    )
    expect(queryClient.getQueryData(['health'])).toEqual({ status: 'ok' })
    expect(window.localStorage.getItem(PROJECT_STORAGE_KEY)).toBe(PROJECT_FRANCH.id)

    // «Обновление страницы»: новый роутер на том же адресе. Проект берётся из адреса, даже если
    // в другой вкладке тем временем выбрали ALPI.
    cleanup()
    window.localStorage.setItem(PROJECT_STORAGE_KEY, PROJECT_ALPI.id)
    const reloaded = renderAt('/p/franch/deals/list')
    await screen.findByRole('heading', { level: 1 })
    expect(switcher().value).toBe(PROJECT_FRANCH.id)
    expect(reloaded.router.state.location.pathname).toBe('/p/franch/deals/list')
  })

  it('на карточке записи смена проекта ведёт в её раздел другого проекта', async () => {
    const { router } = renderAt(`/p/alpi/deals/${DEAL_ID}`)
    await screen.findByRole('heading', { level: 1, name: ALPI_TITLE })

    fireEvent.change(switcher(), { target: { value: PROJECT_FRANCH.id } })

    await waitFor(() => expect(router.state.location.pathname).toBe('/p/franch/deals'))
  })

  it('меню ведёт в разделы текущего проекта', async () => {
    renderAt('/p/franch/deals/list')
    await screen.findByRole('heading', { level: 1 })
    const nav = screen.getByRole('navigation', { name: 'Головне меню' })
    expect(within(nav).getByRole('link', { name: 'Контакти' }).getAttribute('href')).toBe(
      '/p/franch/contacts',
    )
  })
})

describe('старые адреса без проекта', () => {
  it('ведут на тот же экран в проекте, выбранном в прошлый раз', async () => {
    window.localStorage.setItem(PROJECT_STORAGE_KEY, PROJECT_FRANCH.id)
    const { router } = renderAt(`/deals/${FRANCH_DEAL_ID}`)
    expect((await screen.findByRole('heading', { level: 1, name: FRANCH_TITLE })).textContent).toBe(
      FRANCH_TITLE,
    )
    expect(router.state.location.pathname).toBe(`/p/franch/deals/${FRANCH_DEAL_ID}`)
  })

  it('без выбранного проекта — в первый доступный; условия адреса сохраняются', async () => {
    const { router } = renderAt('/deals/list?stage=x')
    await screen.findByRole('heading', { level: 1 })
    expect(router.state.location.pathname).toBe('/p/alpi/deals/list')
    expect(router.state.location.search).toEqual({ stage: 'x' })
  })

  it('без проектов — пояснение вместо экрана', async () => {
    renderAt('/deals', { projects: [] })
    expect(
      (await screen.findByRole('heading', { level: 1, name: 'Немає доступних проєктів' }))
        .textContent,
    ).toBe('Немає доступних проєктів')
  })
})

describe('«Скопіювати посилання»', () => {
  const original = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard')
  afterEach(() => {
    if (original) Object.defineProperty(window.navigator, 'clipboard', original)
    else Reflect.deleteProperty(window.navigator, 'clipboard')
  })

  function stubClipboard(writeText: (text: string) => Promise<void>) {
    const spy = vi.fn(writeText)
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: spy },
      configurable: true,
    })
    return spy
  }

  it.each([
    ['сделки', `/p/franch/deals/${FRANCH_DEAL_ID}`],
    ['контакта', `/p/franch/contacts/${CONTACT_ID}`],
    ['организации', `/p/franch/organizations/${ORGANIZATION_ID}`],
  ])('в карточке %s копирует ссылку с проектом', async (_kind, path) => {
    const writeText = stubClipboard(async () => {})
    renderAt(path)
    fireEvent.click(await screen.findByRole('button', { name: 'Скопіювати посилання' }))
    expect(await screen.findByText('Посилання скопійовано.')).toBeTruthy()
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}${path}`)
  })

  it('буфер обмена недоступен — ссылка в уведомлении', async () => {
    stubClipboard(async () => {
      throw new Error('denied')
    })
    renderAt(`/p/franch/deals/${FRANCH_DEAL_ID}`)
    fireEvent.click(await screen.findByRole('button', { name: 'Скопіювати посилання' }))
    expect(
      await screen.findByText(
        `Не вдалося скопіювати. Посилання: ${window.location.origin}/p/franch/deals/${FRANCH_DEAL_ID}`,
      ),
    ).toBeTruthy()
  })
})
