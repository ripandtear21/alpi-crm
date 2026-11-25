import {
  type FieldDefinitionSummary,
  type FieldOptionSummary,
  type FieldType,
  fullPermissions,
  type MemberSummary,
  type RolePermissions,
} from '@alpi/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import { createI18n } from '../../i18n/index.ts'
import { CustomFieldGroups } from './custom-field-groups.tsx'
import {
  CustomFieldsApiError,
  CustomFieldsApiProvider,
  type CustomValues,
} from './custom-fields-api.tsx'
import { fakeCustomFieldsApi, fieldDef, fieldGroup } from './fake-custom-fields-api.ts'

// Общие редакторы пользовательских полей (тикет crm-fields/06) в блоке групп карточки: каждый
// из 15 типов показывает значение и сохраняет его в формате тикета 02; правка на месте при
// отказе возвращает прежнее значение; группа «только чтение» не открывает редактор.

const PROJECT_ID = '00000000-0000-4000-9400-0000000000aa'
const RECORD_ID = '00000000-0000-4000-9400-0000000000bb'
const ME: MemberSummary = {
  userId: 'user-1',
  email: 'owner@example.com',
  name: 'Власник',
  roleId: 'role-admin',
  teamId: null,
  acceptsNewDeals: true,
  disabled: false,
}
const ACTIVE: MemberSummary = { ...ME, userId: 'user-2', name: 'Олена Коваль' }
const GONE: MemberSummary = { ...ME, userId: 'user-3', name: 'Петро Бондар', disabled: true }

const GROUP = fieldGroup({ nameUk: 'Анкета' })

function option(id: string, nameUk: string, archived = false): FieldOptionSummary {
  return {
    id,
    nameUk,
    nameRu: null,
    position: 1,
    archivedAt: archived ? '2026-11-01T10:00:00.000Z' : null,
  }
}
const OPTIONS = [option('opt-a', 'Ранок'), option('opt-b', 'День', true), option('opt-c', 'Вечір')]

function field(type: FieldType, overrides: Partial<FieldDefinitionSummary> = {}) {
  return fieldDef({
    groupId: GROUP.id,
    code: `f_${type}`,
    nameUk: `Поле ${type}`,
    type,
    options: type === 'single_option' || type === 'multi_option' ? OPTIONS : [],
    ...overrides,
  })
}

/** Карточка в миниатюре: запись в состоянии, ответ правки заменяет её. */
function Harness({
  custom,
  permissions,
  canEdit,
}: {
  custom: CustomValues
  permissions: RolePermissions
  canEdit: boolean
}) {
  const [record, setRecord] = useState({ id: RECORD_ID, custom: structuredClone(custom) })
  return (
    <CustomFieldGroups<typeof record>
      entity="deal"
      projectId={PROJECT_ID}
      user={ME}
      record={record}
      permissions={permissions}
      canEdit={canEdit}
      onSaved={setRecord}
    />
  )
}

function renderGroups({
  fields,
  custom = {},
  permissions = fullPermissions(),
  canEdit = true,
}: {
  fields: FieldDefinitionSummary[]
  custom?: CustomValues
  permissions?: RolePermissions
  canEdit?: boolean
}) {
  const store = { id: RECORD_ID, custom: structuredClone(custom) }
  const api = fakeCustomFieldsApi({
    groups: [GROUP],
    fields,
    members: [ME, ACTIVE, GONE],
    record: (_entity, id) => (id === RECORD_ID ? store : undefined),
  })
  render(
    <I18nextProvider i18n={createI18n('uk')}>
      <QueryClientProvider client={new QueryClient()}>
        <CustomFieldsApiProvider api={api}>
          <Harness custom={custom} permissions={permissions} canEdit={canEdit} />
        </CustomFieldsApiProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  )
  return { api, store }
}

const rowOf = (code: string) => {
  const row = document.querySelector(`[data-field="${code}"]`)
  if (!(row instanceof HTMLElement)) throw new Error(`нет строки поля ${code}`)
  return row
}

async function openEditor(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: `Змінити «${name}»` }))
  return screen.findByRole('form', { name })
}

async function save(form: HTMLElement) {
  fireEvent.click(within(form).getByRole('button', { name: 'Зберегти' }))
  await waitFor(() => expect(screen.queryByRole('form')).toBeNull())
}

const change = (element: HTMLElement, value: string) =>
  fireEvent.change(element, { target: { value } })

describe('редакторы 15 типов: значение сохраняется в формате тикета 02 и показывается', () => {
  const cases: {
    type: FieldType
    fill: (form: HTMLElement, name: string) => void
    saved: unknown
    shown: string
  }[] = [
    {
      type: 'text',
      fill: (form, name) => change(within(form).getByLabelText(name), '  Перший курс  '),
      saved: 'Перший курс',
      shown: 'Перший курс',
    },
    {
      type: 'long_text',
      fill: (form, name) => change(within(form).getByLabelText(name), 'рядок 1\nрядок 2'),
      saved: 'рядок 1\nрядок 2',
      shown: 'рядок 1\nрядок 2',
    },
    {
      type: 'number',
      fill: (form, name) => change(within(form).getByLabelText(name), '1,5'),
      saved: 1.5,
      shown: '1,5',
    },
    {
      type: 'money',
      fill: (form, name) => {
        change(within(form).getByLabelText(name), '1200.5')
        change(within(form).getByLabelText(`${name}: Валюта`), 'UAH')
      },
      saved: { amount: 1200.5, currency: 'UAH' },
      shown: new Intl.NumberFormat('uk', { style: 'currency', currency: 'UAH' }).format(1200.5),
    },
    {
      type: 'date',
      fill: (form, name) => change(within(form).getByLabelText(name), '2026-11-25'),
      saved: '2026-11-25',
      shown: new Intl.DateTimeFormat('uk', { dateStyle: 'medium', timeZone: 'UTC' }).format(
        new Date('2026-11-25T00:00:00Z'),
      ),
    },
    {
      type: 'time',
      fill: (form, name) => change(within(form).getByLabelText(name), '09:30'),
      saved: '09:30',
      shown: '09:30',
    },
    {
      type: 'date_range',
      fill: (form, name) => {
        change(within(form).getByLabelText(`${name}: з`), '2026-11-01')
        change(within(form).getByLabelText(`${name}: по`), '2026-11-05')
      },
      saved: { from: '2026-11-01', to: '2026-11-05' },
      shown: (() => {
        const day = new Intl.DateTimeFormat('uk', { dateStyle: 'medium', timeZone: 'UTC' })
        return `${day.format(new Date('2026-11-01T00:00:00Z'))} – ${day.format(new Date('2026-11-05T00:00:00Z'))}`
      })(),
    },
    {
      type: 'single_option',
      fill: (form, name) => change(within(form).getByLabelText(name), 'opt-c'),
      saved: 'opt-c',
      shown: 'Вечір',
    },
    {
      type: 'multi_option',
      fill: (form) => {
        fireEvent.click(within(form).getByLabelText('Вечір'))
        fireEvent.click(within(form).getByLabelText('Ранок'))
      },
      saved: ['opt-a', 'opt-c'],
      shown: 'РанокВечір',
    },
    {
      type: 'boolean',
      fill: (form, name) => change(within(form).getByLabelText(name), 'false'),
      saved: false,
      shown: 'Ні',
    },
    {
      type: 'phone',
      fill: (form, name) => change(within(form).getByLabelText(name), '067 123 45 67'),
      saved: '+380671234567',
      shown: '+380 67 123 4567',
    },
    {
      type: 'email',
      fill: (form, name) => change(within(form).getByLabelText(name), ' Ira@Example.com '),
      saved: 'ira@example.com',
      shown: 'ira@example.com',
    },
    {
      type: 'url',
      fill: (form, name) => change(within(form).getByLabelText(name), 'https://alpi.ua/kurs'),
      saved: 'https://alpi.ua/kurs',
      shown: 'https://alpi.ua/kurs',
    },
    {
      type: 'address',
      fill: (form, name) => change(within(form).getByLabelText(name), 'Київ, Хрещатик, 1'),
      saved: 'Київ, Хрещатик, 1',
      shown: 'Київ, Хрещатик, 1',
    },
    {
      type: 'user',
      fill: (form, name) => change(within(form).getByLabelText(name), 'user-2'),
      saved: 'user-2',
      shown: 'Олена Коваль',
    },
  ]

  it('перечислены все 15 типов', () => {
    expect(new Set(cases.map((item) => item.type)).size).toBe(15)
  })

  it.each(cases)('$type', async ({ type, fill, saved, shown }) => {
    const target = field(type)
    const { api, store } = renderGroups({ fields: [target] })
    expect(
      within(await screen.findByRole('region', { name: 'Анкета' })).getByText('Не заповнено'),
    ).toBeTruthy()

    const form = await openEditor(target.nameUk)
    fill(form, target.nameUk)
    await save(form)

    expect(api.saves).toEqual([{ entity: 'deal', id: RECORD_ID, custom: { [target.code]: saved } }])
    expect(store.custom[target.code]).toEqual(saved)
    await waitFor(() =>
      expect(rowOf(target.code).querySelector('dd')?.textContent).toContain(shown),
    )
  })
})

describe('показ значений', () => {
  it('телефон — tel:, email — mailto:, ссылка — новая вкладка с rel="noopener noreferrer"', async () => {
    renderGroups({
      fields: [field('phone'), field('email'), field('url')],
      custom: {
        f_phone: '+380671234567',
        f_email: 'ira@example.com',
        f_url: 'https://alpi.ua/kurs',
      },
    })
    const phone = await screen.findByRole('link', { name: '+380 67 123 4567' })
    expect(phone.getAttribute('href')).toBe('tel:+380671234567')
    expect(screen.getByRole('link', { name: 'ira@example.com' }).getAttribute('href')).toBe(
      'mailto:ira@example.com',
    )
    const site = screen.getByRole('link', { name: 'https://alpi.ua/kurs' })
    expect(site.getAttribute('href')).toBe('https://alpi.ua/kurs')
    expect(site.getAttribute('target')).toBe('_blank')
    expect(site.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('ссылка `javascript:` не сохраняется, а уже лежащая в записи — не становится ссылкой', async () => {
    const target = field('url')
    const { api } = renderGroups({ fields: [target], custom: { f_url: 'javascript:alert(1)' } })
    expect(await screen.findByText('javascript:alert(1)')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()

    const form = await openEditor(target.nameUk)
    change(within(form).getByLabelText(target.nameUk), 'javascript:alert(2)')
    fireEvent.click(within(form).getByRole('button', { name: 'Зберегти' }))
    expect((await within(rowOf(target.code)).findByRole('alert')).textContent).toBe(
      'Посилання має починатися з http:// або https://.',
    )
    expect(api.saves).toEqual([])
  })

  it('архивный вариант не предлагается, уже выбранный показан с пометкой «архів» и остаётся', async () => {
    const single = field('single_option')
    const { api } = renderGroups({ fields: [single], custom: { f_single_option: 'opt-b' } })
    const row = await waitFor(() => rowOf(single.code))
    expect(within(row).getByText('архів')).toBeTruthy()

    const form = await openEditor(single.nameUk)
    const select = within(form).getByLabelText(single.nameUk) as HTMLSelectElement
    expect([...select.options].map((item) => item.textContent)).toEqual([
      '—',
      'Ранок',
      'День (архів)',
      'Вечір',
    ])
    fireEvent.click(within(form).getByRole('button', { name: 'Скасувати' }))
    expect(api.saves).toEqual([])
  })

  it('без выбранного архивного варианта в списке только действующие', async () => {
    const single = field('single_option')
    renderGroups({ fields: [single] })
    const form = await openEditor(single.nameUk)
    const select = within(form).getByLabelText(single.nameUk) as HTMLSelectElement
    expect([...select.options].map((item) => item.textContent)).toEqual(['—', 'Ранок', 'Вечір'])
  })

  it('отключённый участник не предлагается; уже выбранный показан с пометкой', async () => {
    const user = field('user')
    renderGroups({ fields: [user], custom: { f_user: 'user-3' } })
    const row = await waitFor(() => rowOf(user.code))
    await waitFor(() => expect(within(row).getByText('відключений')).toBeTruthy())
    expect(row.textContent).toContain('Петро Бондар')

    const form = await openEditor(user.nameUk)
    const select = within(form).getByLabelText(user.nameUk) as HTMLSelectElement
    expect([...select.options].map((item) => item.textContent)).toEqual([
      '—',
      'Власник',
      'Олена Коваль',
      'Петро Бондар (відключений)',
    ])
  })
})

describe('правка на месте', () => {
  it('ответ 422 возвращает прежнее значение и показывает ошибку у поля', async () => {
    const target = field('text', { nameUk: 'Місто' })
    const { api } = renderGroups({ fields: [target], custom: { f_text: 'Київ' } })
    api.failNext = new CustomFieldsApiError(422, 'CUSTOM_FIELD_INVALID', {
      field: target.code,
      reason: 'too_long',
    })
    const form = await openEditor('Місто')
    change(within(form).getByLabelText('Місто'), 'Львів')
    fireEvent.click(within(form).getByRole('button', { name: 'Зберегти' }))

    const row = rowOf(target.code)
    expect((await within(row).findByRole('alert')).textContent).toBe('Задовге значення.')
    expect(within(row).getByRole('button', { name: 'Змінити «Місто»' }).textContent).toBe('Київ')
    expect(api.saves).toHaveLength(1)
  })

  it('ошибка проверки в браузере — у поля, запрос не уходит', async () => {
    const target = field('number', { nameUk: 'Кількість' })
    const { api } = renderGroups({ fields: [target] })
    const form = await openEditor('Кількість')
    change(within(form).getByLabelText('Кількість'), 'багато')
    fireEvent.click(within(form).getByRole('button', { name: 'Зберегти' }))
    expect((await within(form.parentElement as HTMLElement).findByRole('alert')).textContent).toBe(
      'Введіть число.',
    )
    expect(api.saves).toEqual([])
  })

  it('пустое значение убирает поле: в запросе null', async () => {
    const target = field('text', { nameUk: 'Місто' })
    const { api, store } = renderGroups({ fields: [target], custom: { f_text: 'Київ' } })
    const form = await openEditor('Місто')
    change(within(form).getByLabelText('Місто'), '   ')
    await save(form)
    expect(api.saves[0]?.custom).toEqual({ f_text: null })
    expect(store.custom).toEqual({})
    expect(await within(rowOf(target.code)).findByText('Не заповнено')).toBeTruthy()
  })
})

describe('группы и права', () => {
  it('поле группы «только чтение» не открывает редактор', async () => {
    const permissions = fullPermissions()
    permissions.fieldGroups[GROUP.id] = 'read'
    const target = field('text', { nameUk: 'Місто' })
    renderGroups({ fields: [target], custom: { f_text: 'Київ' }, permissions })
    const group = await screen.findByRole('region', { name: 'Анкета' })
    expect(within(group).getByText('Київ')).toBeTruthy()
    expect(within(group).getByText('лише перегляд')).toBeTruthy()
    expect(within(group).queryByRole('button', { name: 'Змінити «Місто»' })).toBeNull()
  })

  it('без права менять запись редактора нет ни у одного поля', async () => {
    renderGroups({ fields: [field('text')], canEdit: false })
    await screen.findByRole('region', { name: 'Анкета' })
    expect(screen.queryByRole('button', { name: /^Змінити/ })).toBeNull()
  })

  it('пустое «важное» поле подсвечено; после заполнения подсветки нет', async () => {
    const target = field('text', { nameUk: 'Джерело', isImportant: true })
    renderGroups({ fields: [target] })
    await screen.findByRole('region', { name: 'Анкета' })
    const row = rowOf(target.code)
    expect(row.classList.contains('custom-field--attention')).toBe(true)
    expect(within(row).getByText('Важливе')).toBeTruthy()

    const form = await openEditor('Джерело')
    change(within(form).getByLabelText('Джерело'), 'Instagram')
    await save(form)
    await waitFor(() => expect(within(row).queryByText('Важливе')).toBeNull())
    expect(row.classList.contains('custom-field--attention')).toBe(false)
  })

  it('группа сворачивается, и это запоминается за пользователем', async () => {
    const target = field('text', { nameUk: 'Місто' })
    renderGroups({ fields: [target] })
    fireEvent.click(await screen.findByRole('button', { name: 'Згорнути групу «Анкета»' }))
    expect(screen.queryByText('Місто')).toBeNull()
    expect(window.localStorage.getItem('alpi.fieldGroups.collapsed.user-1')).toBe(
      JSON.stringify([GROUP.id]),
    )
  })

  it('свёрнутая раньше группа открывается свёрнутой', async () => {
    window.localStorage.setItem('alpi.fieldGroups.collapsed.user-1', JSON.stringify([GROUP.id]))
    renderGroups({ fields: [field('text', { nameUk: 'Місто' })] })
    expect(await screen.findByRole('button', { name: 'Розгорнути групу «Анкета»' })).toBeTruthy()
    expect(screen.queryByText('Місто')).toBeNull()
  })

  it('группы и поля — по порядку; пустая группа не показывается', async () => {
    const second = fieldGroup({ nameUk: 'Друга', position: 2 })
    const empty = fieldGroup({ nameUk: 'Порожня', position: 3 })
    const first = fieldGroup({ nameUk: 'Перша', position: 1 })
    const api = fakeCustomFieldsApi({
      groups: [second, empty, first],
      fields: [
        fieldDef({ groupId: second.id, code: 'b2', nameUk: 'Б2', position: 2 }),
        fieldDef({ groupId: second.id, code: 'b1', nameUk: 'Б1', position: 1 }),
        fieldDef({ groupId: first.id, code: 'a1', nameUk: 'А1', position: 1 }),
        fieldDef({
          groupId: empty.id,
          code: 'gone',
          nameUk: 'Архівне',
          archivedAt: '2026-11-01T10:00:00.000Z',
        }),
      ],
    })
    render(
      <I18nextProvider i18n={createI18n('uk')}>
        <QueryClientProvider client={new QueryClient()}>
          <CustomFieldsApiProvider api={api}>
            <CustomFieldGroups
              entity="deal"
              projectId={PROJECT_ID}
              user={ME}
              record={{ id: RECORD_ID, custom: {} }}
              permissions={fullPermissions()}
              canEdit
              onSaved={() => {}}
            />
          </CustomFieldsApiProvider>
        </QueryClientProvider>
      </I18nextProvider>,
    )
    await screen.findByRole('region', { name: 'Перша' })
    expect(
      screen.getAllByRole('region').map((region) => region.getAttribute('aria-label')),
    ).toEqual(['Перша', 'Друга'])
    const names = [...document.querySelectorAll('.custom-field__name')].map((n) => n.textContent)
    expect(names).toEqual(['А1', 'Б1', 'Б2'])
  })
})
