import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import {
  CONTACT_ID,
  type FakeContactsApi,
  fakeContactsApi,
  OTHER_CONTACT_ID,
  PIPELINE_ID,
  STAGE_DECISION,
  sampleContact,
  sampleDeal,
} from '../../../components/contact-form/fake-contacts-api.ts'
import { fakeProjectsApi } from '../../../components/project-switcher/fake-projects-api.ts'
import { fakeTimelineApi } from '../../../components/timeline/fake-timeline-api.ts'
import { createI18n } from '../../../i18n/index.ts'
import { createAppRouter } from '../../../router.tsx'
import { fakeAuthApi } from '../../auth/fake-auth-api.ts'
import { type FakeDealsApi, fakeDealsApi } from '../../deals/fake-deals-api.ts'

// Карточка контакта (тикет crm-deals/14) в настоящем дереве маршрутов: вошедший пользователь
// user-1, подставные API контактов, канбана и ленты. Имена и телефоны вымышленные.

async function renderCard({
  api = fakeContactsApi(),
  kanban = fakeDealsApi(),
  contactId = CONTACT_ID,
}: {
  api?: FakeContactsApi
  kanban?: FakeDealsApi
  contactId?: string
} = {}) {
  const queryClient = new QueryClient()
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [`/p/alpi/contacts/${contactId}`] }),
    auth: fakeAuthApi(),
    projects: fakeProjectsApi(),
    deals: kanban,
    contacts: api,
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
  await screen.findByRole('heading', { level: 1 })
  return { api, kanban, router }
}

async function openEdit() {
  fireEvent.click(screen.getByRole('button', { name: 'Змінити' }))
  return screen.findByRole('form', { name: 'Змінити контакт' })
}

describe('карточка контакта: телефоны', () => {
  it('телефон «067 123 45 67» сохраняется в E.164 и показывается как +380 67 123 4567', async () => {
    const { api } = await renderCard()
    const form = await openEdit()
    fireEvent.change(within(form).getByLabelText('Телефон (основний)'), {
      target: { value: '067 123 45 67' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }))

    const details = await screen.findByRole('complementary', { name: 'Дані контакту' })
    expect(await within(details).findByRole('link', { name: '+380 67 123 4567' })).toBeTruthy()
    expect(api.contacts[0]?.phones).toEqual(['+380671234567'])
    expect(screen.queryByRole('form', { name: 'Змінити контакт' })).toBeNull()
  })

  it('неразбираемый номер подсвечивается ошибкой у своего поля, запрос не уходит', async () => {
    const { api } = await renderCard()
    const form = await openEdit()
    fireEvent.change(within(form).getByLabelText('Телефон (основний)'), {
      target: { value: '12-34' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }))

    expect(await within(form).findByText('Не схоже на номер телефону.')).toBeTruthy()
    expect(within(form).getByLabelText('Телефон (основний)').getAttribute('aria-invalid')).toBe(
      'true',
    )
    expect(api.calls).toEqual([])
  })

  it('второй телефон можно сделать основным: он уходит первым', async () => {
    const api = fakeContactsApi({ contacts: [sampleContact({ phones: ['+380671234567'] })] })
    await renderCard({ api })
    const form = await openEdit()
    fireEvent.click(within(form).getByRole('button', { name: '+ Телефон' }))
    fireEvent.change(within(form).getByLabelText('Телефон'), { target: { value: '0501112233' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Зробити основним' }))
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }))

    await waitFor(() => expect(api.contacts[0]?.phones).toEqual(['+380501112233', '+380671234567']))
  })
})

describe('карточка контакта: организация', () => {
  it('не больше одной: прежнюю убрать, новую создать из формы; ссылка ведёт в её карточку', async () => {
    const { api } = await renderCard()
    const details = screen.getByRole('complementary', { name: 'Дані контакту' })
    expect(await within(details).findByRole('link', { name: 'ТОВ Вигадана' })).toBeTruthy()
    const form = await openEdit()
    expect(await within(form).findByText('ТОВ Вигадана')).toBeTruthy()
    expect(within(form).queryByRole('combobox', { name: 'Знайти організацію' })).toBeNull()
    fireEvent.click(within(form).getByRole('button', { name: 'Прибрати організацію' }))
    fireEvent.change(within(form).getByRole('combobox', { name: 'Знайти організацію' }), {
      target: { value: 'Нова Фірма' },
    })
    fireEvent.mouseDown(
      await within(form).findByRole('option', { name: 'Створити організацію «Нова Фірма»' }),
    )
    expect(await within(form).findByText('Нова Фірма')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }))

    const created = api.organizations.find((org) => org.name === 'Нова Фірма')
    await waitFor(() => expect(api.contacts[0]?.organizationId).toBe(created?.id))
    const link = await within(details).findByRole('link', { name: 'Нова Фірма' })
    expect(link.getAttribute('href')).toBe(`/p/alpi/organizations/${created?.id}`)
  })
})

describe('карточка контакта: совпадения', () => {
  it('«чужий клієнт»: имя менеджера и ничего о чужом контакте', async () => {
    const api = fakeContactsApi()
    api.foreignPhones['+380679990011'] = 'Олена Коваль'
    await renderCard({ api })
    const form = await openEdit()
    fireEvent.change(within(form).getByLabelText('Телефон (основний)'), {
      target: { value: '+380 67 999 00 11' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }))

    const alert = await within(form).findByText(/Клієнт уже в роботі у Олена Коваль/)
    expect(alert.textContent).toBe('Клієнт уже в роботі у Олена Коваль.')
    expect(within(form).queryByRole('link')).toBeNull()
    expect(api.calls).toEqual([])
  })

  it('«чужий клієнт» без открытой сделки — без имени менеджера', async () => {
    const api = fakeContactsApi()
    api.foreignPhones['+380679990011'] = null
    await renderCard({ api })
    const form = await openEdit()
    fireEvent.change(within(form).getByLabelText('Телефон (основний)'), {
      target: { value: '0679990011' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }))
    expect(await within(form).findByText('Клієнт уже в роботі в іншого менеджера.')).toBeTruthy()
  })

  it('телефон у видимого контакта — ссылка «відкрити існуючий»', async () => {
    const api = fakeContactsApi({
      contacts: [
        sampleContact(),
        sampleContact({ id: OTHER_CONTACT_ID, firstName: 'Петро', phones: ['+380671234567'] }),
      ],
    })
    await renderCard({ api })
    const form = await openEdit()
    fireEvent.change(within(form).getByLabelText('Телефон (основний)'), {
      target: { value: '(067) 123-45-67' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }))

    const link = await within(form).findByRole('link', { name: 'Відкрити існуючий' })
    expect(link.getAttribute('href')).toBe(`/p/alpi/contacts/${OTHER_CONTACT_ID}`)
  })

  it('пометка «можливий дубль» видна в шапке', async () => {
    await renderCard({
      api: fakeContactsApi({ contacts: [sampleContact({ possibleDuplicate: true })] }),
    })
    expect(screen.getByText('Можливий дубль')).toBeTruthy()
  })
})

describe('карточка контакта: сделки', () => {
  it('основной и участник, с воронкой, этапом и статусом; «+ Угода» предлагает этот контакт', async () => {
    const api = fakeContactsApi({
      deals: [
        sampleDeal({ title: 'Ірина — курс', status: 'won', stageId: STAGE_DECISION }),
        sampleDeal({ title: 'Петро — курс', primaryContactId: OTHER_CONTACT_ID }),
      ],
    })
    const participantDeal = api.deals[1]?.id ?? ''
    api.participants[participantDeal] = [CONTACT_ID]
    const { kanban } = await renderCard({ api })

    const list = await screen.findByRole('list', { name: 'Угоди' })
    const items = within(list).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      'Ірина — курсALPI · Рішення · основний контактВиграна',
      'Петро — курсALPI · Новий лід · учасникВідкрита',
    ])

    fireEvent.click(screen.getByRole('button', { name: '+ Угода' }))
    const dialog = await screen.findByRole('form', { name: 'Нова угода' })
    expect((within(dialog).getByLabelText('Назва') as HTMLInputElement).value).toBe(
      'Ірина Мельник — ',
    )
    fireEvent.change(within(dialog).getByLabelText('Назва'), {
      target: { value: 'Ірина Мельник — вебінар' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Створити угоду' }))
    await waitFor(() => expect(kanban.calls.map((c) => c.action)).toEqual(['create']))
    expect(kanban.calls[0]?.value).toMatchObject({ contactId: CONTACT_ID, pipelineId: PIPELINE_ID })
  })
})

describe('карточка контакта: удаление', () => {
  function withTwoDeals() {
    return fakeContactsApi({
      deals: [
        sampleDeal({ title: 'Ірина — курс' }),
        sampleDeal({ title: 'Ірина — допродаж', status: 'won' }),
      ],
    })
  }

  it('основной в двух сделках: обе в диалоге; без подтверждения ничего не удаляется', async () => {
    const api = withTwoDeals()
    await renderCard({ api })
    await screen.findByRole('list', { name: 'Угоди' })
    fireEvent.click(screen.getByRole('button', { name: 'Видалити' }))

    const dialog = await screen.findByRole('dialog', { name: 'Видалити контакт?' })
    const deps = within(dialog).getByRole('list')
    expect(
      within(deps)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Ірина — курс', 'Ірина — допродаж'])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Скасувати' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.calls).toEqual([])
    expect(api.contacts.map((c) => c.id)).toEqual([CONTACT_ID])
  })

  it('подтверждение удаляет контакт вместе с обеими сделками и уводит к контактам', async () => {
    const api = withTwoDeals()
    const ids = api.deals.map((deal) => deal.id).sort()
    const { router } = await renderCard({ api })
    await screen.findByRole('list', { name: 'Угоди' })
    fireEvent.click(screen.getByRole('button', { name: 'Видалити' }))
    const dialog = await screen.findByRole('dialog', { name: 'Видалити контакт?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Видалити разом з угодами' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/p/alpi/contacts'))
    expect(api.calls).toEqual([`removeContact:${CONTACT_ID}:${ids.join(',')}`])
  })

  it('список сменился между открытием и подтверждением — новый список и повторное подтверждение', async () => {
    const api = withTwoDeals()
    await renderCard({ api })
    await screen.findByRole('list', { name: 'Угоди' })
    api.deals.push(sampleDeal({ title: 'Ірина — нова' }))
    fireEvent.click(screen.getByRole('button', { name: 'Видалити' }))
    const dialog = await screen.findByRole('dialog', { name: 'Видалити контакт?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Видалити разом з угодами' }))

    expect(await within(dialog).findByText(/Список угод змінився/)).toBeTruthy()
    expect(within(dialog).getByText('Ірина — нова')).toBeTruthy()
    expect(api.calls).toEqual([])
  })
})

describe('карточка контакта: доступ', () => {
  it('контакт вне охвата — «Немає доступу» без его данных', async () => {
    await renderCard({ contactId: OTHER_CONTACT_ID })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Немає доступу')
    expect(screen.queryByText(/Мельник/)).toBeNull()
  })

  it('менеджер без права «видаляти» не видит кнопки удаления', async () => {
    const api = fakeContactsApi()
    api.me.permissions.actions.contacts = ['view', 'create', 'edit']
    await renderCard({ api })
    expect(screen.queryByRole('button', { name: 'Видалити' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Змінити' })).toBeTruthy()
  })
})
