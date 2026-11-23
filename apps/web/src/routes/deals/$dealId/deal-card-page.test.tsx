import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import { fakeProjectsApi } from '../../../components/project-switcher/fake-projects-api.ts'
import {
  type FakeTimelineApi,
  fakeTimelineApi,
} from '../../../components/timeline/fake-timeline-api.ts'
import type { TimelineItem } from '../../../components/timeline/timeline-api.ts'
import { createI18n } from '../../../i18n/index.ts'
import { createAppRouter } from '../../../router.tsx'
import { fakeAuthApi } from '../../auth/fake-auth-api.ts'
import { type FakeDealsApi, fakeDeal, fakeDealsApi } from '../fake-deals-api.ts'
import {
  CONTACT_ID,
  DEAL_ID,
  type FakeDealCardApi,
  fakeDealCardApi,
  OTHER_USER_ID,
  STAGES,
  sampleDeal,
  UPSELL_PIPELINE_ID,
  USER_ID,
} from './fake-deal-card-api.ts'

// Карточка сделки в настоящем дереве маршрутов: вошедший пользователь user-1 «Власник»,
// подставные API сделки и ленты.

const TITLE = 'Ірина Мельник — курс'
const FOREIGN_DEAL_ID = '00000000-0000-4000-9200-0000000000ff'

function timelineItems(): TimelineItem[] {
  return [
    {
      kind: 'change',
      id: '00000000-0000-4000-9300-100000000001',
      occurredAt: '2026-11-02T10:00:00.000Z',
      actorId: USER_ID,
      actorName: 'Власник',
      change: { field: 'stageId', before: STAGES.lead, after: STAGES.contact },
    },
    {
      kind: 'note',
      id: '00000000-0000-4000-9300-100000000002',
      occurredAt: '2026-11-03T10:00:00.000Z',
      actorId: OTHER_USER_ID,
      actorName: 'Олена Коваль',
      note: { text: 'Чужа нотатка', updatedAt: '2026-11-03T10:00:00.000Z' },
    },
    {
      kind: 'file',
      id: '00000000-0000-4000-9300-100000000003',
      occurredAt: '2026-11-04T10:00:00.000Z',
      actorId: USER_ID,
      actorName: 'Власник',
      file: { name: 'договір.pdf', contentType: 'application/pdf', size: 2048 },
    },
    {
      kind: 'note',
      id: '00000000-0000-4000-9300-100000000004',
      occurredAt: '2026-11-05T10:00:00.000Z',
      actorId: USER_ID,
      actorName: 'Власник',
      note: { text: 'Своя нотатка', updatedAt: '2026-11-05T10:00:00.000Z' },
    },
  ]
}

async function renderCard({
  api = fakeDealCardApi(),
  timeline = fakeTimelineApi(timelineItems()),
  dealId = DEAL_ID,
  kanban = fakeDealsApi(),
  path = `/p/alpi/deals/${dealId}`,
}: {
  api?: FakeDealCardApi
  timeline?: FakeTimelineApi
  dealId?: string
  /** Канбан «/deals» (тикет crm-deals/11): туда ведёт удаление сделки. */
  kanban?: FakeDealsApi
  path?: string
} = {}) {
  const queryClient = new QueryClient()
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    auth: fakeAuthApi(),
    projects: fakeProjectsApi(),
    deals: kanban,
    dealCard: api,
    timeline,
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
  return { api, timeline, router }
}

const historyList = () => screen.findByRole('list', { name: 'Історія' })

describe('карточка сделки: статусы', () => {
  it('«Програно» без причины не отправляется; после проигрыша видны причина и «Відкрити знову»', async () => {
    const { api } = await renderCard()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(TITLE)

    fireEvent.click(screen.getByRole('button', { name: 'Програно' }))
    const dialog = await screen.findByRole('dialog', { name: 'Угода програна' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Позначити програною' }))
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Оберіть причину програшу.')
    expect(api.calls).not.toContain('lose')

    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Група причин' }), {
      target: { value: api.reasonGroups[0]?.id },
    })
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Причина' }), {
      target: { value: api.reasonGroups[0]?.reasons[0]?.id },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Позначити програною' }))

    await screen.findByText('Програно: Дорого')
    expect(api.calls).toEqual(['lose'])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Відкрити знову' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Програно' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Виграно' })).toBeNull()
  })

  it('после выигрыша — «Створити допродаж» и «Відкрити знову»', async () => {
    const { api } = await renderCard()
    expect(screen.queryByRole('button', { name: 'Створити допродаж' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Виграно' }))
    await screen.findByRole('button', { name: 'Створити допродаж' })
    expect(api.calls).toEqual(['win'])
    expect(screen.getByRole('button', { name: 'Відкрити знову' })).toBeTruthy()
  })

  it('нажатие на этап меняет этап сделки', async () => {
    const { api } = await renderCard()
    const path = screen.getByRole('list', { name: 'Етапи воронки' })
    const current = within(path).getByRole('button', { current: 'step' })
    expect(current.textContent).toBe('3 дні · Контакт')
    fireEvent.click(within(path).getByRole('button', { name: 'Рішення' }))
    await waitFor(() => expect(api.deals[0]?.stageId).toBe(STAGES.decision))
    expect(api.calls).toEqual(['stage'])
  })
})

describe('карточка сделки: товары', () => {
  it('«Підставити» видна при расхождении сумм; после нажатия сумма сделки равна сумме строк', async () => {
    const { api } = await renderCard()
    expect(screen.getByTestId('deal-amount').textContent).toMatch(/^100,00\s(€|EUR)$/)
    expect(screen.getByTestId('products-total').textContent).toMatch(/^200,00\s(€|EUR)$/)
    fireEvent.click(screen.getByRole('button', { name: 'Підставити' }))
    await waitFor(() =>
      expect(screen.getByTestId('deal-amount').textContent).toMatch(/^200,00\s(€|EUR)$/),
    )
    expect(api.deals[0]?.amount).toBe(200)
    expect(api.calls).toEqual(['applyProductsTotal'])
    expect(screen.queryByRole('button', { name: 'Підставити' })).toBeNull()
  })

  it('суммы совпадают — «Підставити» нет', async () => {
    await renderCard({ api: fakeDealCardApi({ deals: [sampleDeal({ amount: 200 })] }) })
    expect(screen.getByTestId('products-total')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Підставити' })).toBeNull()
  })
})

describe('карточка сделки: контакт и участники', () => {
  it('основной контакт с телефоном tel: и пометкой «можливий дубль»; участник — добавить, сменить роль, убрать', async () => {
    const api = fakeDealCardApi()
    const newcomer = '00000000-0000-4000-9200-0000000000c3'
    api.contacts.push({
      id: newcomer,
      firstName: 'Оксана',
      lastName: 'Бондар',
      organizationId: null,
      possibleDuplicate: false,
      phones: ['+380671112233'],
      emails: [],
    })
    await renderCard({ api })
    const phone = await screen.findByRole('link', { name: '+380501234567' })
    expect(phone.getAttribute('href')).toBe('tel:+380501234567')
    expect(screen.getByText('можливий дубль')).toBeTruthy()
    await screen.findByText('Петро Мельник')

    fireEvent.click(screen.getByRole('button', { name: '+ Учасник' }))
    const roles = screen.getAllByRole('textbox', { name: 'Роль' })
    fireEvent.change(roles[roles.length - 1] as HTMLElement, { target: { value: 'Батько' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Знайти контакт' }), {
      target: { value: 'Оксана' },
    })
    fireEvent.mouseDown(await screen.findByRole('option', { name: /Оксана Бондар/ }))
    await screen.findByText('Оксана Бондар')
    expect(api.deals[0]?.participants).toEqual([
      { contactId: '00000000-0000-4000-9200-0000000000c2', role: 'Платник' },
      { contactId: newcomer, role: 'Батько' },
    ])

    const petro = screen.getByRole('form', { name: 'Роль: Петро Мельник' })
    fireEvent.change(within(petro).getByRole('textbox', { name: 'Роль' }), {
      target: { value: 'Мама' },
    })
    fireEvent.click(within(petro).getByRole('button', { name: 'Зберегти роль' }))
    await waitFor(() => expect(api.deals[0]?.participants[0]?.role).toBe('Мама'))

    fireEvent.click(screen.getByRole('button', { name: 'Прибрати Оксана Бондар' }))
    await waitFor(() => expect(screen.queryByText('Оксана Бондар')).toBeNull())
    expect(api.calls).toEqual(['addParticipant', 'updateParticipant', 'removeParticipant'])
  })
})

describe('карточка сделки: лента', () => {
  it('фильтр «Нотатки» оставляет только заметки; новая заметка встаёт сверху без перезагрузки', async () => {
    const { timeline } = await renderCard()
    const all = await historyList()
    expect(within(all).getAllByRole('listitem')).toHaveLength(4)
    expect(within(all).getByText('Етап', { exact: false }).textContent).toBe(
      'Етап: Новий лід → Контакт',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Нотатки' }))
    await waitFor(async () =>
      expect(within(await historyList()).getAllByRole('listitem')).toHaveLength(2),
    )
    const notes = await historyList()
    expect(
      within(notes)
        .getAllByRole('article')
        .map((item) => item.getAttribute('aria-label')),
    ).toEqual(['Нотатка', 'Нотатка'])

    fireEvent.change(screen.getByRole('textbox', { name: 'Текст нотатки' }), {
      target: { value: 'Передзвонити в понеділок' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти нотатку' }))
    await waitFor(async () =>
      expect(within(await historyList()).getAllByRole('listitem')).toHaveLength(3),
    )
    const first = within(await historyList()).getAllByRole('listitem')[0]
    expect(first?.textContent).toContain('Передзвонити в понеділок')
    expect(timeline.items.filter((item) => item.kind === 'note')).toHaveLength(3)
  })

  it('файл больше 25 МБ отклоняется до отправки', async () => {
    const { timeline } = await renderCard()
    fireEvent.click(screen.getByRole('tab', { name: 'Файл' }))
    const input = screen.getByLabelText('Файл', { selector: 'input' }) as HTMLInputElement
    const big = new File(['x'], 'відео.mp4', { type: 'video/mp4' })
    Object.defineProperty(big, 'size', { value: 25 * 1024 * 1024 + 1 })
    fireEvent.change(input, { target: { files: [big] } })
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Файл «відео.mp4» більший за 25 МБ — його не надіслано.',
    )
    expect(timeline.uploads).toHaveLength(0)

    const small = new File(['%PDF-'], 'рахунок.pdf', { type: 'application/pdf' })
    fireEvent.change(input, { target: { files: [small] } })
    await screen.findByRole('button', { name: 'рахунок.pdf' })
    expect(timeline.uploads.map((file) => file.name)).toEqual(['рахунок.pdf'])
  })
})

describe('карточка сделки: права', () => {
  it('менеджер без «передачи сделок» и без права удалять не видит этих кнопок', async () => {
    await renderCard({ api: fakeDealCardApi({ role: 'manager' }) })
    expect(screen.queryByRole('combobox', { name: 'Змінити відповідального' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Інші дії з угодою' }))
    const menu = await screen.findByRole('menu')
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['В архів'])
    // Свою заметку менеджер удаляет, чужую — нет.
    const notes = within(await historyList()).getAllByRole('article', { name: 'Нотатка' })
    const own = notes.find((note) => note.textContent?.includes('Своя нотатка'))
    const foreign = notes.find((note) => note.textContent?.includes('Чужа нотатка'))
    expect(
      within(own as HTMLElement).queryByRole('button', { name: 'Видалити нотатку' }),
    ).toBeTruthy()
    expect(
      within(foreign as HTMLElement).queryByRole('button', { name: 'Видалити нотатку' }),
    ).toBeNull()
    expect(within(foreign as HTMLElement).queryByRole('button', { name: 'Змінити' })).toBeNull()
  })

  it('администратор меняет ответственного, удаляет сделку и чужие заметки', async () => {
    const api = fakeDealCardApi({ role: 'admin' })
    const { router } = await renderCard({ api })
    const owner = screen.getByRole('combobox', { name: 'Змінити відповідального' })
    fireEvent.change(owner, { target: { value: '' } })
    await waitFor(() => expect(api.deals[0]?.ownerId).toBeNull())
    expect(screen.getByText('Загальна черга', { selector: '.deal-card__owner-name' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Взяти в роботу' })).toBeTruthy()

    const foreign = within(await historyList())
      .getAllByRole('article', { name: 'Нотатка' })
      .find((note) => note.textContent?.includes('Чужа нотатка'))
    expect(
      within(foreign as HTMLElement).getByRole('button', { name: 'Видалити нотатку' }),
    ).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Інші дії з угодою' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Видалити угоду' }))
    const dialog = await screen.findByRole('dialog', { name: 'Видалити угоду?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Видалити' }))
    await waitFor(() => expect(api.calls).toContain('remove'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/p/alpi/deals'))
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Угоди')
  })

  it('чужая или удалённая сделка — «Немає доступу» без её данных', async () => {
    const api = fakeDealCardApi({
      deals: [
        sampleDeal(),
        sampleDeal({
          id: FOREIGN_DEAL_ID,
          title: 'Чужа угода',
          deletedAt: '2026-11-10T00:00:00.000Z',
        }),
      ],
    })
    await renderCard({ api, dealId: FOREIGN_DEAL_ID })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Немає доступу')
    expect(screen.queryByText('Чужа угода', { exact: false })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Виграно' })).toBeNull()
  })

  it('название сделки на канбане ведёт на её карточку', async () => {
    const kanban = fakeDealsApi([fakeDeal({ id: DEAL_ID, title: TITLE })])
    const { router } = await renderCard({ kanban, path: '/p/alpi/deals' })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Угоди')
    const link = await screen.findByRole('link', { name: TITLE })
    router.history.push(link.getAttribute('href') as string)
    await waitFor(() => expect(router.state.location.pathname).toBe(`/p/alpi/deals/${DEAL_ID}`))
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(TITLE))
    expect(screen.getByRole('button', { name: 'Виграно' })).toBeTruthy()
  })
})

describe('карточка сделки: допродажа', () => {
  it('у контакта уже есть открытая сделка в воронке допродаж — подсказка со ссылкой, сделка не создаётся', async () => {
    const existing = sampleDeal({
      id: '00000000-0000-4000-9200-000000000002',
      title: 'Ірина Мельник — допродаж',
      pipelineId: UPSELL_PIPELINE_ID,
      stageId: STAGES.upsellFirst,
      primaryContactId: CONTACT_ID,
    })
    const api = fakeDealCardApi({ deals: [sampleDeal({ status: 'won' }), existing] })
    await renderCard({ api })
    fireEvent.click(screen.getByRole('button', { name: 'Створити допродаж' }))
    const dialog = await screen.findByRole('dialog', { name: 'Нова угода-допродаж' })
    expect(
      (within(dialog).getByRole('combobox', { name: 'Воронка' }) as HTMLSelectElement).value,
    ).toBe(UPSELL_PIPELINE_ID)
    // Название — как по умолчанию в API: имя основного контакта и «допродаж».
    await waitFor(() =>
      expect(
        (within(dialog).getByRole('textbox', { name: 'Назва' }) as HTMLInputElement).value,
      ).toBe('Ірина Мельник — допродаж'),
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Створити' }))

    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toContain('У клієнта вже є відкрита угода в цій воронці.')
    expect(
      within(alert).getByRole('link', { name: 'Відкрити ту угоду' }).getAttribute('href'),
    ).toBe(`/p/alpi/deals/${existing.id}`)
    expect(api.deals).toHaveLength(2)
    expect(api.calls).not.toContain('upsell')
  })

  it('допродажа без конфликта создаётся и открывается', async () => {
    const api = fakeDealCardApi({ deals: [sampleDeal({ status: 'won' })] })
    const { router } = await renderCard({ api })
    fireEvent.click(screen.getByRole('button', { name: 'Створити допродаж' }))
    const dialog = await screen.findByRole('dialog', { name: 'Нова угода-допродаж' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Створити' }))
    await waitFor(() => expect(api.deals).toHaveLength(2))
    const created = api.deals[1]
    expect(created?.pipelineId).toBe(UPSELL_PIPELINE_ID)
    await waitFor(() => expect(router.state.location.pathname).toBe(`/p/alpi/deals/${created?.id}`))
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Ірина Мельник — допродаж' }),
    ).toBeTruthy()
  })
})
