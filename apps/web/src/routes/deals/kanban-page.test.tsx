import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import {
  fakeProjectsApi,
  PROJECT_ALPI,
} from '../../components/project-switcher/fake-projects-api.ts'
import { createI18n, type Language } from '../../i18n/index.ts'
import { createAppRouter } from '../../router.tsx'
import { setViewportWidth } from '../../test/viewport.ts'
import { fakeAuthApi } from '../auth/fake-auth-api.ts'
import { type BoardDeal, DealsApiError } from './deals-api.ts'
import {
  FAKE_ME,
  type FakeDealsApi,
  fakeDeal,
  fakeDealsApi,
  PIPELINE_ID,
  REASON_EXPENSIVE,
  STAGE_CONTACT,
  STAGE_NEW,
} from './fake-deals-api.ts'

// Канбан «Угоди» в настоящем дереве маршрутов (вошедший пользователь, подставные API).

async function renderKanban({
  deals = [],
  language = 'uk',
  api = fakeDealsApi(deals),
}: {
  deals?: BoardDeal[]
  language?: Language
  api?: FakeDealsApi
} = {}) {
  const queryClient = new QueryClient()
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: ['/deals'] }),
    auth: fakeAuthApi(),
    projects: fakeProjectsApi(),
    deals: api,
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

const column = (name: string) => screen.getByRole('region', { name: `Етап ${name}` })

async function cardIn(columnName: string, title: string) {
  const region = await screen.findByRole('region', { name: `Етап ${columnName}` })
  return within(region).findByRole('article', { name: title })
}

function drag(card: HTMLElement, target: HTMLElement) {
  fireEvent.dragStart(card)
  fireEvent.dragOver(target)
  fireEvent.drop(target)
  fireEvent.dragEnd(card)
}

describe('канбан воронки', () => {
  it('колонки этапов: число и суммы по валютам из агрегатов, карточка с контактом и суммой', async () => {
    await renderKanban({
      deals: [
        fakeDeal({ title: 'Ірина — вебінар', amount: 100, currency: 'EUR' }),
        fakeDeal({
          title: 'Марко — курс',
          amount: 250,
          currency: 'UAH',
          ownerId: null,
          ownerName: null,
        }),
        fakeDeal({ title: 'Оля — контакт', stageId: STAGE_CONTACT }),
      ],
    })
    const card = await cardIn('Новий лід', 'Ірина — вебінар')
    expect(
      within(card).getByRole('link', { name: 'Ірина — вебінар' }).getAttribute('href'),
    ).toMatch(/^\/deals\/[0-9a-f-]{36}$/)
    expect(within(card).getByText('Ірина Вигадана')).toBeTruthy()
    expect(within(card).getByText('Власник')).toBeTruthy()
    expect(within(card).getByText(/100/).textContent).toMatch(/€/)
    const head = column('Новий лід').querySelector('header') as HTMLElement
    await waitFor(() => expect(head.textContent).toMatch(/Новий лід\s*2/))
    expect(head.textContent).toMatch(/100[^0-9]*€/)
    expect(head.textContent).toMatch(/250[^0-9]*₴/)
    const queued = await cardIn('Новий лід', 'Марко — курс')
    expect(within(queued).getByText('без відповідального')).toBeTruthy()
    expect(within(column('Оплата')).getByText('Угод немає.')).toBeTruthy()
  })

  it('перетаскивание в другую колонку вызывает смену этапа', async () => {
    const deal = fakeDeal({ title: 'Ірина — вебінар' })
    const api = await renderKanban({ deals: [deal] })
    drag(await cardIn('Новий лід', 'Ірина — вебінар'), column('Контакт'))
    await cardIn('Контакт', 'Ірина — вебінар')
    expect(api.calls).toEqual([{ action: 'changeStage', dealId: deal.id, value: STAGE_CONTACT }])
    expect(
      await screen.findByText('Угоду «Ірина — вебінар» перенесено на етап «Контакт».'),
    ).toBeTruthy()
    expect(within(column('Новий лід')).queryByRole('article')).toBeNull()
  })

  it('отказ API (поля этапа) возвращает карточку на место с сообщением', async () => {
    const deal = fakeDeal({ title: 'Ірина — вебінар' })
    const api = fakeDealsApi([deal])
    api.failNext = new DealsApiError(422, 'STAGE_REQUIREMENTS_MISSING', {
      fields: ['expectedCloseDate', 'organizationId'],
    })
    await renderKanban({ api })
    drag(await cardIn('Новий лід', 'Ірина — вебінар'), column('Контакт'))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Етап вимагає заповнити: очікувана дата закриття, організація.',
    )
    await cardIn('Новий лід', 'Ірина — вебінар')
    expect(within(column('Контакт')).queryByRole('article')).toBeNull()
    expect(api.calls).toHaveLength(1)
    expect(api.deals[0]?.stageId).toBe(STAGE_NEW)
  })

  it('«Виграно» — выигрыш; «Програно» без причины не отправляется, с причиной — проигрыш', async () => {
    const won = fakeDeal({ title: 'Виграшна' })
    const lost = fakeDeal({ title: 'Програшна' })
    const api = await renderKanban({ deals: [won, lost] })

    fireEvent.dragStart(await cardIn('Новий лід', 'Виграшна'))
    fireEvent.drop(screen.getByText('Виграно'))
    await waitFor(() => expect(api.calls).toEqual([{ action: 'win', dealId: won.id }]))
    await waitFor(() =>
      expect(within(column('Новий лід')).queryByRole('article', { name: 'Виграшна' })).toBeNull(),
    )

    fireEvent.dragStart(await cardIn('Новий лід', 'Програшна'))
    fireEvent.drop(screen.getByText('Програно'))
    const dialog = await screen.findByRole('dialog', { name: 'Програти угоду «Програшна»' })
    const submit = within(dialog).getByRole('button', { name: 'Програти' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.click(submit)
    const group = (await within(dialog).findByRole('combobox', {
      name: 'Група причин',
    })) as HTMLSelectElement
    // Архивная группа и архивная причина не предлагаются.
    expect([...group.options].map((o) => o.textContent)).toEqual(['Виберіть…', 'Якість ліда'])
    fireEvent.change(group, { target: { value: group.options[1]?.value } })
    const reason = within(dialog).getByRole('combobox', { name: 'Причина' }) as HTMLSelectElement
    expect([...reason.options].map((o) => o.textContent)).toEqual(['Виберіть…', 'Дорого'])
    // Группа выбрана, причина — нет: всё ещё не отправляется.
    fireEvent.submit(dialog.querySelector('form') as HTMLFormElement)
    expect(api.calls.filter((c) => c.action === 'lose')).toEqual([])

    fireEvent.change(reason, { target: { value: REASON_EXPENSIVE } })
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    await waitFor(() =>
      expect(api.calls.at(-1)).toEqual({
        action: 'lose',
        dealId: lost.id,
        value: REASON_EXPENSIVE,
      }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('на 375 px: одна колонка, этапы вкладками с числом, без перетаскивания; этап — в меню карточки', async () => {
    setViewportWidth(375)
    const deal = fakeDeal({ title: 'Ірина — вебінар' })
    const api = await renderKanban({ deals: [deal, fakeDeal({ stageId: STAGE_CONTACT })] })
    const tablist = await screen.findByRole('tablist', { name: 'Етапи' })
    await waitFor(() =>
      expect(
        within(tablist)
          .getAllByRole('tab')
          .map((tab) => tab.textContent),
      ).toEqual(['Новий лід 1', 'Контакт 1', 'Оплата 0']),
    )
    const card = await cardIn('Новий лід', 'Ірина — вебінар')
    expect(screen.getAllByRole('region', { name: /^Етап / })).toHaveLength(1)
    expect(card.getAttribute('draggable')).toBeNull()

    fireEvent.click(within(card).getByRole('button', { name: 'Дії з угодою «Ірина — вебінар»' }))
    const menu = within(card).getByRole('menu')
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['На етап «Контакт»', 'На етап «Оплата»', 'Виграти', 'Програти'])
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'На етап «Контакт»' }))
    await waitFor(() =>
      expect(api.calls).toEqual([{ action: 'changeStage', dealId: deal.id, value: STAGE_CONTACT }]),
    )
    fireEvent.click(screen.getByRole('tab', { name: /^Контакт/ }))
    await cardIn('Контакт', 'Ірина — вебінар')
  })

  it('«Взяти в роботу» ставит ответственным текущего пользователя', async () => {
    const deal = fakeDeal({ title: 'З черги', ownerId: null, ownerName: null })
    const api = await renderKanban({ deals: [deal] })
    const card = await cardIn('Новий лід', 'З черги')
    fireEvent.click(within(card).getByRole('button', { name: 'Взяти в роботу' }))
    await waitFor(() => expect(api.calls).toEqual([{ action: 'take', dealId: deal.id }]))
    expect(api.deals[0]?.ownerId).toBe(FAKE_ME.id)
    await waitFor(async () =>
      expect(within(await cardIn('Новий лід', 'З черги')).getByText('Власник')).toBeTruthy(),
    )
    expect(
      within(await cardIn('Новий лід', 'З черги')).queryByRole('button', {
        name: 'Взяти в роботу',
      }),
    ).toBeNull()
  })

  it('«Взяти в роботу» на 409 — «угоду вже взяли»', async () => {
    const api = fakeDealsApi([fakeDeal({ title: 'З черги', ownerId: null, ownerName: null })])
    api.failNext = new DealsApiError(409, 'DEAL_ALREADY_TAKEN')
    await renderKanban({ api })
    const card = await cardIn('Новий лід', 'З черги')
    fireEvent.click(within(card).getByRole('button', { name: 'Взяти в роботу' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Угоду вже взяли.')
  })

  it('колонка грузит 50 карточек и подгружает следующую страницу', async () => {
    const deals = Array.from({ length: 60 }, (_, i) => fakeDeal({ title: `Угода №${i + 1}` }))
    await renderKanban({ deals })
    await cardIn('Новий лід', 'Угода №50')
    expect(within(column('Новий лід')).getAllByRole('article')).toHaveLength(50)
    fireEvent.click(within(column('Новий лід')).getByRole('button', { name: 'Завантажити ще' }))
    await cardIn('Новий лід', 'Угода №60')
    expect(within(column('Новий лід')).getAllByRole('article')).toHaveLength(60)
    expect(within(column('Новий лід')).queryByRole('button', { name: 'Завантажити ще' })).toBeNull()
  })

  it('фильтр «без відповідального» — общая очередь', async () => {
    await renderKanban({
      deals: [
        fakeDeal({ title: 'Моя' }),
        fakeDeal({ title: 'Нічия', ownerId: null, ownerName: null }),
      ],
    })
    await cardIn('Новий лід', 'Моя')
    fireEvent.change(screen.getByRole('combobox', { name: 'Відповідальний' }), {
      target: { value: 'none' },
    })
    await waitFor(() =>
      expect(
        within(column('Новий лід'))
          .getAllByRole('article')
          .map((a) => a.getAttribute('aria-label')),
      ).toEqual(['Нічия']),
    )
  })

  it('выбор воронки запоминается', async () => {
    await renderKanban()
    await screen.findByRole('region', { name: 'Етап Новий лід' })
    expect((screen.getByRole('combobox', { name: 'Воронка' }) as HTMLSelectElement).value).toBe(
      PIPELINE_ID,
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Воронка' }), {
      target: { value: PIPELINE_ID },
    })
    expect(window.localStorage.getItem(`alpi.kanban.pipeline.${PROJECT_ALPI.id}`)).toBe(PIPELINE_ID)
  })
})

describe('форма «+ Угода»', () => {
  async function openForm(api = fakeDealsApi()) {
    await renderKanban({ api })
    fireEvent.click(await screen.findByRole('button', { name: '+ Угода' }))
    return screen.findByRole('form', { name: 'Нова угода' })
  }

  it("новый контакт: название предзаполнено «Ім'я Прізвище — », ответственный по умолчанию я", async () => {
    const api = fakeDealsApi()
    const form = await openForm(api)
    fireEvent.click(within(form).getByRole('button', { name: 'Новий контакт' }))
    fireEvent.change(within(form).getByRole('textbox', { name: "Ім'я" }), {
      target: { value: 'Ірина' },
    })
    fireEvent.change(within(form).getByRole('textbox', { name: 'Прізвище' }), {
      target: { value: 'Вигадана' },
    })
    const title = within(form).getByRole('textbox', { name: 'Назва' }) as HTMLInputElement
    expect(title.value).toBe('Ірина Вигадана — ')
    fireEvent.change(title, { target: { value: 'Ірина Вигадана — вебінар' } })
    fireEvent.change(within(form).getByRole('textbox', { name: 'Сума' }), {
      target: { value: '120,5' },
    })
    fireEvent.change(within(form).getByRole('textbox', { name: 'Телефон' }), {
      target: { value: '067 123 45 67' },
    })
    expect(
      (within(form).getByRole('combobox', { name: 'Відповідальний' }) as HTMLSelectElement).value,
    ).toBe(FAKE_ME.id)
    fireEvent.click(screen.getByRole('button', { name: 'Створити угоду' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.calls).toEqual([
      {
        action: 'create',
        value: {
          title: 'Ірина Вигадана — вебінар',
          pipelineId: PIPELINE_ID,
          stageId: STAGE_NEW,
          amount: 120.5,
          currency: 'EUR',
          ownerId: FAKE_ME.id,
          contact: { firstName: 'Ірина', lastName: 'Вигадана', phones: ['067 123 45 67'] },
        },
      },
    ])
    await cardIn('Новий лід', 'Ірина Вигадана — вебінар')
  })

  it('существующий контакт из поиска; «одна открытая сделка» — подсказка со ссылкой', async () => {
    const api = fakeDealsApi()
    api.failNext = new DealsApiError(409, 'OPEN_DEAL_EXISTS', {
      dealId: '00000000-0000-4000-9300-0000000000ff',
    })
    const form = await openForm(api)
    fireEvent.change(within(form).getByRole('combobox', { name: 'Контакт' }), {
      target: { value: 'Мар' },
    })
    fireEvent.mouseDown(await within(form).findByRole('option', { name: /Марко Вигаданий/ }))
    expect((within(form).getByRole('textbox', { name: 'Назва' }) as HTMLInputElement).value).toBe(
      'Марко Вигаданий — ',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Створити угоду' }))
    const alert = await within(form).findByRole('alert')
    expect(alert.textContent).toContain('У цього клієнта вже є відкрита угода в цій воронці.')
    expect(within(alert).getByRole('link', { name: 'Відкрити угоду' }).getAttribute('href')).toBe(
      '/deals/00000000-0000-4000-9300-0000000000ff',
    )
    expect(api.calls[0]?.value).toMatchObject({ contactId: '00000000-0000-4000-9400-000000000002' })
  })

  it('«чужой клиент» — «клієнт уже в роботі у <менеджер>», без контакта — не отправляется', async () => {
    const api = fakeDealsApi()
    const form = await openForm(api)
    fireEvent.click(screen.getByRole('button', { name: 'Створити угоду' }))
    expect((await within(form).findByRole('alert')).textContent).toBe(
      "Виберіть контакт або введіть ім'я нового.",
    )
    expect(api.calls).toEqual([])

    api.failNext = new DealsApiError(409, 'CONTACT_OUT_OF_SCOPE', { managerName: 'Марія Бондар' })
    fireEvent.click(within(form).getByRole('button', { name: 'Новий контакт' }))
    fireEvent.change(within(form).getByRole('textbox', { name: "Ім'я" }), {
      target: { value: 'Петро' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Створити угоду' }))
    await waitFor(() =>
      expect(within(form).getByRole('alert').textContent).toBe(
        'Клієнт уже в роботі у Марія Бондар.',
      ),
    )
  })

  it('по-русски', async () => {
    await renderKanban({ language: 'ru', deals: [fakeDeal({ title: 'Сделка' })] })
    expect(screen.getByRole('heading', { level: 1, name: 'Сделки' })).toBeTruthy()
    expect(await screen.findByRole('region', { name: 'Этап Новий лід' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '+ Сделка' })).toBeTruthy()
  })
})
