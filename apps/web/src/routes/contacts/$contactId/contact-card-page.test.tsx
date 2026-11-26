import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import { ContactsApiError } from '../../../components/contact-form/contacts-api.ts'
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
import { type FakeDealsApi, fakeDealsApi } from '../../deals/fake-deals-api.ts'
import { type FakeMergesApi, fakeMergesApi, sampleMerge } from '../merge/fake-merges-api.ts'
import { MergesApiError, MergesApiProvider } from '../merge/merges-api.tsx'

// Карточка контакта (тикет crm-deals/14) в настоящем дереве маршрутов: вошедший пользователь
// user-1, подставные API контактов, канбана и ленты. Имена и телефоны вымышленные.

async function renderCard({
  api = fakeContactsApi(),
  kanban = fakeDealsApi(),
  contactId = CONTACT_ID,
  fields = fakeCustomFieldsApi(),
  merges = fakeMergesApi({ contacts: () => api.contacts }),
}: {
  api?: FakeContactsApi
  kanban?: FakeDealsApi
  contactId?: string
  /** Пользовательские поля (тикет crm-fields/06); по умолчанию — ни одного. */
  fields?: FakeCustomFieldsApi
  /** Слияние (тикет crm-intake/01): по умолчанию — подставной клиент без слияний. */
  merges?: FakeMergesApi
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
        <CustomFieldsApiProvider api={fields}>
          <MergesApiProvider api={merges}>
            <RouterProvider router={router} />
          </MergesApiProvider>
        </CustomFieldsApiProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  )
  await screen.findByRole('heading', { level: 1 })
  return { api, kanban, router, merges }
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

describe('карточка контакта: пользовательские поля (тикет crm-fields/06)', () => {
  it('группа полей контакта показана, значение правится на месте запросом контакта', async () => {
    const api = fakeContactsApi()
    const group = fieldGroup({ entity: 'contact', nameUk: 'Про клієнта' })
    const store = { custom: {} as Record<string, unknown> }
    const fields = fakeCustomFieldsApi({
      groups: [group],
      fields: [fieldDef({ entity: 'contact', groupId: group.id, code: 'hobby', nameUk: 'Хобі' })],
      record: (_entity, id) => {
        const found = api.contacts.find((contact) => contact.id === id)
        return found ? Object.assign(found, store) : undefined
      },
    })
    await renderCard({ api, fields })
    const block = await screen.findByRole('region', { name: 'Про клієнта' })
    fireEvent.click(within(block).getByRole('button', { name: 'Змінити «Хобі»' }))
    const form = await within(block).findByRole('form', { name: 'Хобі' })
    fireEvent.change(within(form).getByLabelText('Хобі'), { target: { value: 'Шахи' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Зберегти' }))
    await waitFor(() =>
      expect(within(block).getByRole('button', { name: 'Змінити «Хобі»' }).textContent).toBe(
        'Шахи',
      ),
    )
    expect(fields.saves).toEqual([{ entity: 'contact', id: CONTACT_ID, custom: { hobby: 'Шахи' } }])
  })
})

describe('карточка контакта: слияние (тикет crm-intake/01)', () => {
  const other = () =>
    sampleContact({ id: OTHER_CONTACT_ID, firstName: 'Олег', lastName: 'Коваль', emails: [] })

  async function chooseOther() {
    fireEvent.click(screen.getByRole('button', { name: "Об'єднати з…" }))
    const dialog = await screen.findByRole('dialog', { name: "Об'єднати контакти" })
    fireEvent.change(within(dialog).getByRole('combobox', { name: "З яким контактом об'єднати" }), {
      target: { value: 'Олег' },
    })
    fireEvent.mouseDown(await within(dialog).findByRole('option', { name: /Олег Коваль/ }))
    return dialog
  }

  it("«Об'єднати з…»: направление, «Поміняти місцями», предпросмотр со сделками вне доступа", async () => {
    const api = fakeContactsApi({ contacts: [sampleContact(), other()] })
    const merges = fakeMergesApi({
      contacts: () => api.contacts,
      preview: { deals: 2, notes: 1, dealsOutOfScope: 1, phones: ['+380671234567'] },
    })
    const { router } = await renderCard({ api, merges })
    const dialog = await chooseOther()
    const sides = () =>
      within(dialog)
        .getAllByRole('definition')
        .map((d) => d.textContent)
    expect(sides()).toEqual(['Ірина Мельник', 'Олег Коваль'])
    expect(
      await within(dialog).findByText('Угод поза вашим доступом: 1. Вони теж перейдуть.'),
    ).toBeTruthy()
    expect(within(dialog).getByText('Угоди, де контакт основний: 2')).toBeTruthy()
    expect(within(dialog).getByText('Телефон +380 67 123 4567 (не основний)')).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Поміняти місцями' }))
    await waitFor(() => expect(sides()).toEqual(['Олег Коваль', 'Ірина Мельник']))
    await waitFor(() => expect(merges.calls).toContain(`preview ${OTHER_CONTACT_ID} ${CONTACT_ID}`))
    const submit = within(dialog).getByRole('button', { name: "Об'єднати" }) as HTMLButtonElement
    await waitFor(() => expect(submit.disabled).toBe(false))
    fireEvent.click(submit)
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/p/alpi/contacts/${OTHER_CONTACT_ID}`),
    )
    expect(merges.calls).toContain(`merge ${OTHER_CONTACT_ID} ${CONTACT_ID}`)
  })

  it("конфликт открытых сделок — понятный отказ, «Об'єднати» недоступна", async () => {
    const api = fakeContactsApi({ contacts: [sampleContact(), other()] })
    const merges = fakeMergesApi({ contacts: () => api.contacts })
    merges.preview = async () => {
      throw new MergesApiError(409, 'MERGE_DEAL_CONFLICT', { pairs: [] })
    }
    await renderCard({ api, merges })
    const dialog = await chooseOther()
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'В обох контактів є відкриті угоди в одній воронці. Спершу закрийте або перенесіть одну з них.',
    )
    const submit = within(dialog).getByRole('button', { name: "Об'єднати" }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    expect(merges.calls.filter((call) => call.startsWith('merge '))).toEqual([])
  })

  it("слияния за 30 дней в карточке оставшегося: «Скасувати об'єднання», подтверждение и итог", async () => {
    const api = fakeContactsApi({ contacts: [sampleContact(), other()] })
    const merges = fakeMergesApi({ contacts: () => api.contacts })
    merges.merges.push(
      sampleMerge({
        survivorId: CONTACT_ID,
        mergedId: OTHER_CONTACT_ID,
        mergedContact: { id: OTHER_CONTACT_ID, firstName: 'Олег', lastName: 'Коваль' },
      }),
    )
    merges.skipped = [
      { kind: 'field', itemId: null, field: 'language', value: 'ru', reason: 'changed' },
      { kind: 'note', itemId: 'n-1', field: null, value: null, reason: 'gone' },
    ]
    await renderCard({ api, merges })
    const block = await screen.findByRole('region', { name: "Об'єднання" })
    expect(within(block).getByText(/^Олег Коваль — об'єднано/)).toBeTruthy()
    fireEvent.click(within(block).getByRole('button', { name: "Скасувати об'єднання" }))
    const confirm = await screen.findByRole('dialog', { name: "Скасувати об'єднання?" })
    expect(within(confirm).getByText(/Контакт «Олег Коваль» знову з'явиться/)).toBeTruthy()
    fireEvent.click(within(confirm).getByRole('button', { name: "Скасувати об'єднання" }))
    const done = await screen.findByRole('dialog', { name: "Об'єднання скасовано" })
    const skipped = within(done).getByRole('list', { name: 'Не повернуто:' })
    expect(
      within(skipped)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      "Мова спілкування: змінили після об'єднання — не чіпали",
      'Нотатка: видалено остаточно',
    ])
    expect(merges.calls).toContain(`undo ${merges.merges[0]?.id}`)
  })

  it("прямая ссылка на слитый контакт: «Контакт об'єднано» со ссылкой на оставшийся и откатом", async () => {
    const api = fakeContactsApi({ contacts: [sampleContact()] })
    const merges = fakeMergesApi({ contacts: () => api.contacts })
    const original = api.contact.bind(api)
    api.contact = async (projectId, id) => {
      if (id !== OTHER_CONTACT_ID) return original(projectId, id)
      throw new ContactsApiError(404, 'CONTACT_MERGED', {
        merged_into_id: CONTACT_ID,
        merge_id: 'm-1',
        undo_until: new Date(Date.now() + 86_400_000).toISOString(),
      })
    }
    await renderCard({ api, merges, contactId: OTHER_CONTACT_ID })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe("Контакт об'єднано")
    const link = await screen.findByRole('link', { name: 'Ірина Мельник' })
    expect(link.getAttribute('href')).toBe(`/p/alpi/contacts/${CONTACT_ID}`)
    expect(await screen.findByRole('button', { name: "Скасувати об'єднання" })).toBeTruthy()
  })

  it("без права «змінювати» нет ни «Об'єднати з…», ни отката", async () => {
    const api = fakeContactsApi({ contacts: [sampleContact(), other()] })
    api.me.permissions.actions.contacts = ['view']
    const merges = fakeMergesApi({ contacts: () => api.contacts })
    merges.merges.push(sampleMerge({ survivorId: CONTACT_ID, mergedId: OTHER_CONTACT_ID }))
    await renderCard({ api, merges })
    await screen.findByRole('region', { name: "Об'єднання" })
    expect(screen.queryByRole('button', { name: "Об'єднати з…" })).toBeNull()
    expect(screen.queryByRole('button', { name: "Скасувати об'єднання" })).toBeNull()
  })
})
