import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import {
  CONTACT_ID,
  type FakeContactsApi,
  fakeContactsApi,
  ORGANIZATION_ID,
  OTHER_CONTACT_ID,
  sampleContact,
  sampleDeal,
} from '../../../components/contact-form/fake-contacts-api.ts'
import { CustomFieldsApiProvider } from '../../../components/custom-fields/custom-fields-api.tsx'
import {
  type FakeCustomFieldsApi,
  fakeCustomFieldsApi,
  fieldDef,
  fieldGroup,
} from '../../../components/custom-fields/fake-custom-fields-api.ts'
import { fakeProjectsApi } from '../../../components/project-switcher/fake-projects-api.ts'
import { fakeTimelineApi } from '../../../components/timeline/fake-timeline-api.ts'
import { createI18n } from '../../../i18n/index.ts'
import { createAppRouter } from '../../../router.tsx'
import { fakeAuthApi } from '../../auth/fake-auth-api.ts'
import { accessOf } from '../../deals/$dealId/fake-deal-card-api.ts'
import { fakeDealsApi } from '../../deals/fake-deals-api.ts'

// Карточка организации (тикет crm-deals/14) в настоящем дереве маршрутов: вошедший
// пользователь user-1, подставные API контактов и ленты. Имена вымышленные.

async function renderCard({
  api = fakeContactsApi(),
  organizationId = ORGANIZATION_ID,
  fields = fakeCustomFieldsApi(),
}: {
  api?: FakeContactsApi
  organizationId?: string
  /** Пользовательские поля (тикет crm-fields/06); по умолчанию — ни одного. */
  fields?: FakeCustomFieldsApi
} = {}) {
  const queryClient = new QueryClient()
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [`/p/alpi/organizations/${organizationId}`] }),
    auth: fakeAuthApi(),
    projects: fakeProjectsApi(),
    deals: fakeDealsApi(),
    contacts: api,
    timeline: fakeTimelineApi(),
    queryClient,
  })
  render(
    <I18nextProvider i18n={createI18n('uk')}>
      <QueryClientProvider client={queryClient}>
        <CustomFieldsApiProvider api={fields}>
          <RouterProvider router={router} />
        </CustomFieldsApiProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  )
  await screen.findByRole('heading', { level: 1 })
  return { api, router }
}

const details = () => screen.getByRole('complementary', { name: 'Дані організації' })

describe('карточка организации: поля и права', () => {
  it('с правом «організації: змінювати» поля меняются и сохраняются', async () => {
    const { api } = await renderCard()
    const form = within(details()).getByRole('form', { name: 'Організація' })
    fireEvent.change(within(form).getByLabelText('Адреса'), {
      target: { value: 'Київ, вул. Вигадана, 1' },
    })
    fireEvent.click(within(form).getByRole('button', { name: 'Зберегти' }))
    await waitFor(() => expect(api.calls).toEqual([`updateOrganization:${ORGANIZATION_ID}`]))
    expect(api.organizations[0]?.address).toBe('Київ, вул. Вигадана, 1')
  })

  it('без права «організації: змінювати» поля только для чтения', async () => {
    const api = fakeContactsApi({ access: accessOf('manager') })
    api.me.permissions.actions.organizations = ['view']
    api.organizations[0] = {
      ...api.organizations[0],
      id: ORGANIZATION_ID,
      name: 'ТОВ Вигадана',
      address: 'Львів',
      website: null,
    }
    await renderCard({ api })
    expect(within(details()).queryByRole('form')).toBeNull()
    expect(within(details()).queryByRole('textbox')).toBeNull()
    expect(within(details()).getByText('Львів')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Видалити' })).toBeNull()
  })

  it('организация удалённая или несуществующая — «Немає доступу»', async () => {
    await renderCard({ organizationId: '00000000-0000-4000-9400-0000000000ff' })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Немає доступу')
  })
})

describe('карточка организации: контакты и сделки', () => {
  function withContacts() {
    return fakeContactsApi({
      contacts: [
        sampleContact({ phones: ['+380671234567'] }),
        sampleContact({
          id: OTHER_CONTACT_ID,
          firstName: 'Петро',
          lastName: 'Коваль',
          organizationId: null,
        }),
      ],
      deals: [sampleDeal({ title: 'Ірина — курс' })],
    })
  }

  it('контакты организации со ссылкой и телефоном; сделки организации', async () => {
    await renderCard({ api: withContacts() })
    const contacts = await screen.findByRole('list', { name: 'Контакти' })
    const link = within(contacts).getByRole('link', { name: 'Ірина Мельник' })
    expect(link.getAttribute('href')).toBe(`/p/alpi/contacts/${CONTACT_ID}`)
    expect(within(contacts).getByText('+380 67 123 4567')).toBeTruthy()
    const deals = await screen.findByRole('list', { name: 'Угоди' })
    expect(within(deals).getByRole('link', { name: 'Ірина — курс' })).toBeTruthy()
  })

  it('убрать контакт из организации и добавить существующий', async () => {
    const { api } = await renderCard({ api: withContacts() })
    await screen.findByRole('list', { name: 'Контакти' })
    fireEvent.click(screen.getByRole('button', { name: 'Прибрати Ірина Мельник з організації' }))
    await waitFor(() => expect(api.contacts[0]?.organizationId).toBeNull())
    expect(await screen.findByText('Контактів немає.')).toBeTruthy()

    const search = screen.getByRole('combobox', { name: 'Додати існуючий контакт' })
    fireEvent.change(search, { target: { value: 'Петро' } })
    fireEvent.mouseDown(await screen.findByRole('option', { name: /Петро Коваль/ }))
    await waitFor(() => expect(api.contacts[1]?.organizationId).toBe(ORGANIZATION_ID))
    expect(await screen.findByRole('link', { name: 'Петро Коваль' })).toBeTruthy()
  })

  it('новый контакт из карточки: «чужий клієнт» — только имя менеджера; иначе создаётся в организации', async () => {
    const { api } = await renderCard()
    api.foreignPhones['+380679990011'] = 'Олена Коваль'
    fireEvent.click(screen.getByRole('button', { name: '+ Новий контакт' }))
    const form = await screen.findByRole('form', { name: 'Новий контакт' })
    const dialog = screen.getByRole('dialog', { name: 'Новий контакт' })
    const save = () => fireEvent.click(within(dialog).getByRole('button', { name: 'Зберегти' }))
    fireEvent.change(within(form).getByLabelText("Ім'я"), { target: { value: 'Марта' } })
    fireEvent.change(within(form).getByLabelText('Телефон (основний)'), {
      target: { value: '067 999 00 11' },
    })
    save()
    expect(await within(form).findByText('Клієнт уже в роботі у Олена Коваль.')).toBeTruthy()
    expect(api.calls).toEqual([])

    fireEvent.change(within(form).getByLabelText('Телефон (основний)'), {
      target: { value: '067 555 44 33' },
    })
    save()
    await waitFor(() => expect(api.calls).toEqual(['createContact']))
    expect(api.contacts.at(-1)).toMatchObject({
      firstName: 'Марта',
      organizationId: ORGANIZATION_ID,
      phones: ['+380675554433'],
    })
    expect(await screen.findByRole('link', { name: 'Марта' })).toBeTruthy()
  })
})

describe('карточка организации: удаление', () => {
  it('предупреждение о числе контактов и сделок; отмена ничего не удаляет, подтверждение — в корзину', async () => {
    const api = fakeContactsApi({ deals: [sampleDeal(), sampleDeal({ status: 'lost' })] })
    const { router } = await renderCard({ api })
    await screen.findByRole('list', { name: 'Угоди' })
    fireEvent.click(screen.getByRole('button', { name: 'Видалити' }))
    const dialog = await screen.findByRole('dialog', { name: 'Видалити організацію?' })
    expect(within(dialog).getByText(/контактів — 1, угод — 2/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Скасувати' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.calls).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: 'Видалити' }))
    const again = await screen.findByRole('dialog', { name: 'Видалити організацію?' })
    fireEvent.click(within(again).getByRole('button', { name: 'Видалити' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/p/alpi/contacts'))
    expect(api.calls).toEqual([`removeOrganization:${ORGANIZATION_ID}`])
  })
})

describe('карточка организации: пользовательские поля (тикет crm-fields/06)', () => {
  it('без права «організації: змінювати» поля организации только для чтения', async () => {
    const access = accessOf('manager')
    access.permissions.actions.organizations = ['view']
    const group = fieldGroup({ entity: 'organization', nameUk: 'Реквізити' })
    const api = fakeContactsApi({ access })
    const fields = fakeCustomFieldsApi({
      groups: [group],
      fields: [
        fieldDef({ entity: 'organization', groupId: group.id, code: 'edrpou', nameUk: 'ЄДРПОУ' }),
      ],
    })
    await renderCard({ api, fields })
    const block = await screen.findByRole('region', { name: 'Реквізити' })
    expect(within(block).getByText('Не заповнено')).toBeTruthy()
    expect(within(block).queryByRole('button', { name: 'Змінити «ЄДРПОУ»' })).toBeNull()
  })
})
