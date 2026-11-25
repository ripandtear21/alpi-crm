import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import { fieldDef } from '../../components/custom-fields/fake-custom-fields-api.ts'
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
  path = '/p/alpi/deals',
  onRouter,
}: {
  deals?: BoardDeal[]
  language?: Language
  api?: FakeDealsApi
  path?: string
  onRouter?: (router: ReturnType<typeof createAppRouter>) => void
} = {}) {
  const queryClient = new QueryClient()
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
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
  onRouter?.(router)
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
    ).toMatch(/^\/p\/alpi\/deals\/[0-9a-f-]{36}$/)
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

  // Обязательные поля этапа (тикет crm-fields/04): отказ 422 открывает форму заполнения.
  describe('обязательные поля этапа', () => {
    const budget = fieldDef({
      groupId: 'group-1',
      code: 'budget',
      nameUk: 'Бюджет',
      required: { mode: 'stages', stages: [{ pipelineId: PIPELINE_ID, stageId: STAGE_CONTACT }] },
    })
    const refusal = () =>
      new DealsApiError(422, 'STAGE_REQUIREMENTS_MISSING', {
        fields: ['budget'],
        names: [{ code: 'budget', nameUk: 'Бюджет', nameRu: null }],
        hiddenCount: 0,
      })

    it('перенос на этап X открывает форму; отмена возвращает карточку; «Зберегти» с значением переводит сделку', async () => {
      const deal = fakeDeal({ title: 'Ірина — вебінар' })
      const api = fakeDealsApi([deal])
      api.customFields = [budget]
      api.failNext = refusal()
      await renderKanban({ api })

      drag(await cardIn('Новий лід', 'Ірина — вебінар'), column('Контакт'))
      const dialog = await screen.findByRole('dialog', {
        name: 'Заповніть поля для етапу «Контакт»',
      })
      await cardIn('Новий лід', 'Ірина — вебінар')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Скасувати' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      await cardIn('Новий лід', 'Ірина — вебінар')
      expect(within(column('Контакт')).queryByRole('article')).toBeNull()
      expect(api.calls).toEqual([{ action: 'changeStage', dealId: deal.id, value: STAGE_CONTACT }])
      expect(api.deals[0]?.stageId).toBe(STAGE_NEW)

      api.failNext = refusal()
      drag(await cardIn('Новий лід', 'Ірина — вебінар'), column('Контакт'))
      const again = await screen.findByRole('dialog', {
        name: 'Заповніть поля для етапу «Контакт»',
      })
      // Пустое поле не отправляется.
      fireEvent.click(within(again).getByRole('button', { name: 'Зберегти' }))
      expect(await within(again).findByText('Заповніть поле.')).toBeTruthy()
      expect(api.calls).toHaveLength(2)

      fireEvent.change(within(again).getByRole('textbox', { name: 'Бюджет' }), {
        target: { value: '1000 €' },
      })
      fireEvent.click(within(again).getByRole('button', { name: 'Зберегти' }))
      await cardIn('Контакт', 'Ірина — вебінар')
      expect(api.calls[2]).toEqual({
        action: 'changeStage',
        dealId: deal.id,
        value: STAGE_CONTACT,
        custom: { budget: '1000 €' },
      })
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('выигрыш с незаполненным полем открывает форму; поле скрытой группы — только числом', async () => {
      const deal = fakeDeal({ title: 'Виграшна' })
      const api = fakeDealsApi([deal])
      api.customFields = [budget]
      api.failNext = new DealsApiError(422, 'STAGE_REQUIREMENTS_MISSING', {
        fields: ['budget'],
        names: [{ code: 'budget', nameUk: 'Бюджет', nameRu: null }],
        hiddenCount: 2,
      })
      await renderKanban({ api })
      fireEvent.dragStart(await cardIn('Новий лід', 'Виграшна'))
      fireEvent.drop(screen.getByText('Виграно'))
      const dialog = await screen.findByRole('dialog', {
        name: 'Заповніть поля, щоб виграти угоду',
      })
      expect(within(dialog).getByText('Ще 2 поля, недоступні вашій ролі.')).toBeTruthy()
      await cardIn('Новий лід', 'Виграшна')
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'Бюджет' }), {
        target: { value: '5' },
      })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Зберегти' }))
      await waitFor(() =>
        expect(api.calls[1]).toEqual({ action: 'win', dealId: deal.id, custom: { budget: '5' } }),
      )
    })

    it('поле группы «только чтение» — без правки, с пояснением; его значение не отправляется', async () => {
      const deal = fakeDeal({ title: 'Лише перегляд' })
      const api = fakeDealsApi([deal])
      api.customFields = [
        budget,
        fieldDef({ groupId: 'group-ro', code: 'contract', nameUk: 'Договір', position: 2 }),
      ]
      api.me.permissions.fieldGroups['group-ro'] = 'read'
      api.failNext = new DealsApiError(422, 'STAGE_REQUIREMENTS_MISSING', {
        fields: ['budget', 'contract'],
        names: [
          { code: 'budget', nameUk: 'Бюджет', nameRu: null },
          { code: 'contract', nameUk: 'Договір', nameRu: null },
        ],
        hiddenCount: 0,
      })
      await renderKanban({ api })
      drag(await cardIn('Новий лід', 'Лише перегляд'), column('Контакт'))
      const dialog = await screen.findByRole('dialog', {
        name: 'Заповніть поля для етапу «Контакт»',
      })
      expect(
        within(dialog).getByText(
          'Ваша роль може лише переглядати: Договір. Попросіть заповнити того, хто має право їх змінювати.',
        ),
      ).toBeTruthy()
      expect(within(dialog).queryByRole('textbox', { name: 'Договір' })).toBeNull()
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'Бюджет' }), {
        target: { value: '7' },
      })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Зберегти' }))
      await waitFor(() =>
        expect(api.calls[1]).toEqual({
          action: 'changeStage',
          dealId: deal.id,
          value: STAGE_CONTACT,
          custom: { budget: '7' },
        }),
      )
    })
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

  it('воронка — в адресе: без неё или с чужой адрес получает показанную воронку', async () => {
    for (const path of ['/p/alpi/deals', '/p/alpi/deals?pipeline=unknown']) {
      let router: ReturnType<typeof createAppRouter> | undefined
      await renderKanban({ path, onRouter: (r) => (router = r) })
      await screen.findByRole('region', { name: 'Етап Новий лід' })
      await waitFor(() => expect(router?.state.location.search).toEqual({ pipeline: PIPELINE_ID }))
      cleanup()
    }
  })

  it('ссылка на канбан с воронкой открывает эту воронку; смена воронки меняет адрес', async () => {
    const second = '00000000-0000-4000-9200-0000000000f2'
    const api = fakeDealsApi()
    const [first] = await api.pipelines(PROJECT_ALPI.id)
    if (!first) throw new Error('у подставного API нет воронки')
    api.pipelines = async () => [first, { ...first, id: second, name: 'Друга воронка' }]
    // В прошлый раз смотрели первую — ссылка всё равно открывает свою.
    window.localStorage.setItem(`alpi.kanban.pipeline.${PROJECT_ALPI.id}`, first.id)
    let router: ReturnType<typeof createAppRouter> | undefined
    await renderKanban({
      api,
      path: `/p/alpi/deals?pipeline=${second}`,
      onRouter: (r) => (router = r),
    })
    const select = (await screen.findByRole('combobox', { name: 'Воронка' })) as HTMLSelectElement
    expect(select.value).toBe(second)

    fireEvent.change(select, { target: { value: first.id } })

    await waitFor(() => expect(router?.state.location.search).toEqual({ pipeline: first.id }))
    expect(select.value).toBe(first.id)
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

  // Обязательные поля (тикет crm-fields/04): «всегда» и с выбранного этапа — сразу в форме.
  it('поля «всегда» и обязательные на выбранном этапе — в форме; без значений запрос не уходит', async () => {
    const api = fakeDealsApi()
    api.customFields = [
      fieldDef({ groupId: 'g', code: 'source', nameUk: 'Джерело', required: { mode: 'always' } }),
      fieldDef({
        groupId: 'g',
        code: 'budget',
        nameUk: 'Бюджет',
        position: 2,
        required: {
          mode: 'stages',
          stages: [{ pipelineId: PIPELINE_ID, stageId: STAGE_CONTACT }],
        },
      }),
      fieldDef({ groupId: 'g', code: 'note', nameUk: 'Нотатка', position: 3 }),
    ]
    const form = await openForm(api)
    expect(await within(form).findByRole('textbox', { name: 'Джерело' })).toBeTruthy()
    expect(within(form).queryByRole('textbox', { name: 'Бюджет' })).toBeNull()
    fireEvent.change(within(form).getByRole('combobox', { name: 'Етап' }), {
      target: { value: STAGE_CONTACT },
    })
    expect(within(form).getByRole('textbox', { name: 'Бюджет' })).toBeTruthy()
    expect(within(form).queryByRole('textbox', { name: 'Нотатка' })).toBeNull()

    fireEvent.click(within(form).getByRole('button', { name: 'Новий контакт' }))
    fireEvent.change(within(form).getByRole('textbox', { name: "Ім'я" }), {
      target: { value: 'Ірина' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Створити угоду' }))
    expect((await within(form).findAllByText('Заповніть поле.')).length).toBe(2)
    expect(api.calls).toEqual([])

    fireEvent.change(within(form).getByRole('textbox', { name: 'Джерело' }), {
      target: { value: 'Instagram' },
    })
    fireEvent.change(within(form).getByRole('textbox', { name: 'Бюджет' }), {
      target: { value: '900' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Створити угоду' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.calls[0]?.value).toMatchObject({
      stageId: STAGE_CONTACT,
      custom: { source: 'Instagram', budget: '900' },
    })
  })

  it('новый контакт: его поля «всегда» — в форме; без значения не уходит, значение уходит с контактом', async () => {
    const api = fakeDealsApi()
    api.contactCustomFields = [
      fieldDef({
        groupId: 'contact-group',
        entity: 'contact',
        code: 'city',
        nameUk: 'Місто',
        required: { mode: 'always' },
      }),
      fieldDef({ groupId: 'contact-group', entity: 'contact', code: 'hobby', nameUk: 'Хобі' }),
    ]
    const form = await openForm(api)
    // Существующему контакту поля нового не нужны.
    expect(within(form).queryByRole('textbox', { name: 'Місто' })).toBeNull()
    fireEvent.click(within(form).getByRole('button', { name: 'Новий контакт' }))
    const city = await within(form).findByRole('textbox', { name: 'Місто' })
    expect(within(form).queryByRole('textbox', { name: 'Хобі' })).toBeNull()
    fireEvent.change(within(form).getByRole('textbox', { name: "Ім'я" }), {
      target: { value: 'Ірина' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Створити угоду' }))
    expect(await within(form).findByText('Заповніть поле.')).toBeTruthy()
    expect(api.calls).toEqual([])

    fireEvent.change(city, { target: { value: 'Львів' } })
    fireEvent.click(screen.getByRole('button', { name: 'Створити угоду' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.calls[0]?.value).toMatchObject({
      contact: { firstName: 'Ірина', lastName: null, phones: [], custom: { city: 'Львів' } },
    })
    expect(api.calls[0]?.value).not.toHaveProperty('custom')
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
      '/p/alpi/deals/00000000-0000-4000-9300-0000000000ff',
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
