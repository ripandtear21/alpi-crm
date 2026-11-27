import { fullPermissions, type RolePermissions } from '@alpi/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeProjectsApi } from '../../../components/project-switcher/fake-projects-api.ts'
import { createI18n, type Language } from '../../../i18n/index.ts'
import { resources } from '../../../i18n/resources.ts'
import { createAppRouter } from '../../../router.tsx'
import { fakeAuthApi } from '../../auth/fake-auth-api.ts'
import { fakeFieldsApi } from '../fields/fake-fields-api.ts'
import { type FakeIntakeSourcesApi, fakeIntakeSourcesApi } from './fake-intake-sources-api.ts'

// Экран «Налаштування → Джерела» (тикет crm-intake/07) в настоящем дереве маршрутов (вошедший
// пользователь, подставные API): право «інтеграції», ключ один раз, смена ключа, отключение и
// включение, журнал входящих с фильтром и сырым телом, «провести заново» только администратору,
// тексты uk и ru.

async function renderAt(
  path: '/settings' | '/settings/intake-sources',
  {
    language = 'uk',
    permissions = fullPermissions(),
    api = fakeIntakeSourcesApi({ permissions }),
  }: { language?: Language; permissions?: RolePermissions; api?: FakeIntakeSourcesApi } = {},
) {
  const queryClient = new QueryClient()
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    auth: fakeAuthApi(),
    projects: fakeProjectsApi(),
    fields: fakeFieldsApi({ permissions }),
    intakeSources: api,
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

/** Права администратора без части действий «інтеграції». */
function integrations(...actions: ('view' | 'create' | 'edit' | 'delete')[]): RolePermissions {
  const permissions = fullPermissions()
  permissions.actions.integrations = actions
  return permissions
}

const original = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard')
afterEach(() => {
  if (original) Object.defineProperty(window.navigator, 'clipboard', original)
  else Reflect.deleteProperty(window.navigator, 'clipboard')
})

function stubClipboard() {
  const spy = vi.fn(async (_text: string) => {})
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: spy },
    configurable: true,
  })
  return spy
}

/** Значение поля type="datetime-local" по местному времени. */
function localMinute(time: number): string {
  const date = new Date(time)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

const DAY = 24 * 60 * 60 * 1000

async function openJournal(name = 'Лендинг вебінару') {
  const card = await screen.findByRole('article', { name })
  fireEvent.click(within(card).getByRole('button', { name: 'Журнал вхідних' }))
  return within(card).findByRole('region', { name: 'Журнал вхідних' })
}

describe('экран источников: права', () => {
  it('с правом «інтеграції» в настройках есть пункт «Джерела»', async () => {
    await renderAt('/settings')
    expect(await screen.findByRole('link', { name: 'Джерела' })).toBeTruthy()
  })

  it('без права «інтеграції» пункта «Джерела» нет', async () => {
    await renderAt('/settings', { permissions: integrations() })
    await screen.findByRole('link', { name: 'Ролі та права' })
    // Даём правам прийти: с правом ссылка к этому времени уже есть (тест выше).
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByRole('link', { name: 'Джерела' })).toBeNull()
  })

  it('без права прямая ссылка — «немає доступу», источники не запрашиваются', async () => {
    const api = fakeIntakeSourcesApi({ permissions: integrations() })
    const list = vi.spyOn(api, 'list')
    await renderAt('/settings/intake-sources', { permissions: integrations(), api })
    expect(await screen.findByRole('heading', { name: 'Немає доступу' })).toBeTruthy()
    expect(list).not.toHaveBeenCalled()
  })

  it('только «смотреть» — список и журнал без кнопок создания, смены ключа и отключения', async () => {
    await renderAt('/settings/intake-sources', { permissions: integrations('view') })
    const card = await screen.findByRole('article', { name: 'Лендинг вебінару' })
    expect(screen.queryByRole('button', { name: 'Створити джерело' })).toBeNull()
    for (const name of ['Змінити ключ', 'Вимкнути']) {
      expect(within(card).queryByRole('button', { name })).toBeNull()
    }
    expect(within(card).getByRole('button', { name: 'Журнал вхідних' })).toBeTruthy()
  })
})

describe('экран источников: список', () => {
  it('источник — название, воронка, начало ключа, кто и когда создал, последний запрос, отключён ли', async () => {
    const api = await renderAt('/settings/intake-sources')
    const [webinar, tilda] = api.sources
    const card = await screen.findByRole('article', { name: 'Лендинг вебінару' })
    expect(card.textContent).toContain('Продажі')
    expect(card.textContent).toContain(`${webinar?.keyPrefix}…`)
    expect(webinar?.keyPrefix).toHaveLength(12)
    expect(card.textContent).toContain('Ірина Тестова')
    expect(card.textContent).toContain('увімкнене')
    expect(card.textContent).not.toContain('запитів не було')
    const off = screen.getByRole('article', { name: tilda?.name ?? '' })
    expect(off.textContent).toContain('вимкнене')
    expect(off.textContent).toContain('запитів не було')
    expect(within(off).getByRole('button', { name: 'Увімкнути' })).toBeTruthy()
  })
})

describe('экран источников: ключ', () => {
  it('создание показывает ключ один раз, пример curl и ссылку на API; после закрытия ключа нигде нет', async () => {
    const clipboard = stubClipboard()
    const api = await renderAt('/settings/intake-sources')
    fireEvent.click(await screen.findByRole('button', { name: 'Створити джерело' }))
    let dialog = await screen.findByRole('dialog', { name: 'Нове джерело' })
    // Без названия и воронки не создаётся; архивной воронки в выборе нет.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Створити' }))
    await waitFor(() => expect(within(dialog).getAllByText('Заповніть поле')).toHaveLength(2))
    const select = within(dialog).getByRole('combobox', { name: 'Воронка' })
    await waitFor(() =>
      expect(within(select).getByRole('option', { name: 'Продажі' })).toBeTruthy(),
    )
    expect(within(select).queryByRole('option', { name: 'Стара воронка' })).toBeNull()
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Назва/ }), {
      target: { value: 'n8n: Tilda' },
    })
    fireEvent.change(select, {
      target: {
        value: (within(select).getByRole('option', { name: 'Продажі' }) as HTMLOptionElement).value,
      },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Створити' }))

    dialog = await screen.findByRole('dialog', { name: 'Ключ джерела «n8n: Tilda»' })
    const key = (within(dialog).getByRole('textbox', { name: 'Ключ джерела' }) as HTMLInputElement)
      .value
    expect(key).toBe(api.issuedKeys.at(-1))
    expect(key).toMatch(/^alpi_src_/)
    expect(dialog.textContent).toContain('більше не буде показано')
    expect(dialog.textContent).toContain('curl -X POST')
    expect(dialog.textContent).toContain('/api/intake/registrations')
    expect(dialog.textContent).toContain('$ALPI_SOURCE_KEY')
    const docs = within(dialog).getByRole('link', { name: /Опис API/ })
    expect(docs.getAttribute('href')).toBe('/api/v1/docs')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Скопіювати' }))
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith(key))

    fireEvent.click(within(dialog).getByRole('button', { name: 'Готово' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const card = await screen.findByRole('article', { name: 'n8n: Tilda' })
    expect(card.textContent).toContain(`${key.slice(0, 12)}…`)
    expect(document.body.innerHTML).not.toContain(key)
    expect(api.calls.filter((c) => c.method === 'create')).toHaveLength(1)
  })

  it('занятое название — причина в окне создания', async () => {
    await renderAt('/settings/intake-sources')
    fireEvent.click(await screen.findByRole('button', { name: 'Створити джерело' }))
    const dialog = await screen.findByRole('dialog', { name: 'Нове джерело' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Назва/ }), {
      target: { value: 'Лендинг вебінару' },
    })
    const select = within(dialog).getByRole('combobox', { name: 'Воронка' })
    const option = (await within(select).findByRole('option', {
      name: 'Продажі',
    })) as HTMLOptionElement
    fireEvent.change(select, { target: { value: option.value } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Створити' }))
    expect(await within(dialog).findByText('Джерело з такою назвою вже є.')).toBeTruthy()
  })

  it('смена ключа — подтверждение «старий ключ перестане працювати одразу», затем окно нового ключа', async () => {
    const api = await renderAt('/settings/intake-sources')
    const card = await screen.findByRole('article', { name: 'Лендинг вебінару' })
    const before = api.sources[0]?.keyPrefix ?? ''
    fireEvent.click(within(card).getByRole('button', { name: 'Змінити ключ' }))
    const confirm = await screen.findByRole('dialog', {
      name: 'Змінити ключ джерела «Лендинг вебінару»?',
    })
    expect(confirm.textContent).toContain('Старий ключ перестане працювати одразу')
    expect(api.calls.some((c) => c.method === 'reissueKey')).toBe(false)
    fireEvent.click(within(confirm).getByRole('button', { name: 'Змінити ключ' }))

    const dialog = await screen.findByRole('dialog', { name: 'Ключ джерела «Лендинг вебінару»' })
    const key = (within(dialog).getByRole('textbox', { name: 'Ключ джерела' }) as HTMLInputElement)
      .value
    expect(key).toBe(api.issuedKeys.at(-1))
    expect(dialog.textContent).toContain('Старий ключ уже не працює')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Готово' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(card.textContent).toContain(`${key.slice(0, 12)}…`))
    expect(key.slice(0, 12)).not.toBe(before)
    expect(document.body.innerHTML).not.toContain(key)
  })
})

describe('экран источников: отключение и включение', () => {
  it('«Вимкнути» и «Увімкнути» с подтверждением меняют состояние в списке', async () => {
    const api = await renderAt('/settings/intake-sources')
    const card = await screen.findByRole('article', { name: 'Лендинг вебінару' })
    fireEvent.click(within(card).getByRole('button', { name: 'Вимкнути' }))
    let confirm = await screen.findByRole('dialog', {
      name: 'Вимкнути джерело «Лендинг вебінару»?',
    })
    // Отмена ничего не меняет.
    fireEvent.click(within(confirm).getByRole('button', { name: 'Скасувати' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.calls.some((c) => c.method === 'disable')).toBe(false)
    expect(card.textContent).toContain('увімкнене')

    fireEvent.click(within(card).getByRole('button', { name: 'Вимкнути' }))
    confirm = await screen.findByRole('dialog', { name: 'Вимкнути джерело «Лендинг вебінару»?' })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Вимкнути' }))
    expect(await screen.findByText('Джерело «Лендинг вебінару» вимкнено.')).toBeTruthy()
    const disabled = await screen.findByRole('article', { name: 'Лендинг вебінару' })
    await waitFor(() => expect(disabled.textContent).toContain('вимкнене'))

    fireEvent.click(await within(disabled).findByRole('button', { name: 'Увімкнути' }))
    confirm = await screen.findByRole('dialog', { name: 'Увімкнути джерело «Лендинг вебінару»?' })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Увімкнути' }))
    expect(await screen.findByText('Джерело «Лендинг вебінару» увімкнено.')).toBeTruthy()
    const enabled = await screen.findByRole('article', { name: 'Лендинг вебінару' })
    await waitFor(() => expect(enabled.textContent).toContain('увімкнене'))
    expect(api.calls.filter((c) => c.method !== 'requests').map((c) => c.method)).toEqual([
      'disable',
      'enable',
    ])
  })
})

describe('экран источников: журнал входящих', () => {
  it('принятый запрос, повтор и ошибка — с итогом, кодом и event_id; ссылки на контакт и сделку', async () => {
    await renderAt('/settings/intake-sources')
    const log = await openJournal()
    const rows = await within(log).findAllByRole('listitem')
    expect(rows).toHaveLength(4)
    const [replayed, error, repeat, accepted] = rows as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ]
    expect(accepted.textContent).toContain('прийнято')
    expect(accepted.textContent).toContain('код 201')
    expect(accepted.textContent).toContain('form-0001')
    expect(accepted.textContent).toContain('OWNER_NOT_FOUND')
    expect(accepted.textContent).toContain('Реєстрація 00000000')
    expect(within(accepted).getByRole('link', { name: 'Контакт' }).getAttribute('href')).toMatch(
      /\/contacts\/00000000-0000-4000-9a00-000000000002$/,
    )
    expect(within(accepted).getByRole('link', { name: 'Угода' }).getAttribute('href')).toMatch(
      /\/deals\/00000000-0000-4000-9a00-000000000003$/,
    )
    expect(repeat.textContent).toContain('повтор')
    expect(repeat.textContent).toContain('код 200')
    expect(error.textContent).toContain('помилка')
    expect(error.textContent).toContain('код 400')
    expect(error.textContent).toContain('CONTACT_KEYS_REQUIRED')
    // Проведённая заново строка ссылается на исходную.
    expect(replayed.textContent).toContain('Проведено заново')
    const link = within(replayed).getByRole('link', { name: 'вихідний запит' })
    expect(link.getAttribute('href')).toBe(`#${accepted.id}`)
  })

  it('фильтр по итогу — только строки с этим итогом', async () => {
    const api = await renderAt('/settings/intake-sources')
    const log = await openJournal()
    await within(log).findAllByRole('listitem')
    fireEvent.change(within(log).getByRole('combobox', { name: 'Підсумок' }), {
      target: { value: 'error' },
    })
    await waitFor(() => expect(within(log).getAllByRole('listitem')).toHaveLength(1))
    expect(within(log).getByRole('listitem').textContent).toContain('CONTACT_KEYS_REQUIRED')
    expect(api.calls.at(-1)).toMatchObject({ method: 'requests', input: { outcome: 'error' } })
    fireEvent.change(within(log).getByRole('combobox', { name: 'Підсумок' }), {
      target: { value: 'repeat' },
    })
    await waitFor(() => expect(within(log).getAllByRole('listitem')).toHaveLength(2))
  })

  it('раскрытая строка показывает сырое тело как пришло', async () => {
    const api = await renderAt('/settings/intake-sources')
    const log = await openJournal()
    const rows = await within(log).findAllByRole('listitem')
    const error = rows[1] as HTMLElement
    const raw = api.journal.get(api.sources[0]?.id ?? '')?.[1]?.body ?? ''
    expect(error.textContent).not.toContain(raw)
    fireEvent.click(within(error).getByRole('button', { name: 'Тіло запиту' }))
    const body = (await within(error).findByRole('region', { name: 'Тіло запиту' })).querySelector(
      'pre',
    )
    expect(body?.textContent).toBe(raw)
  })

  it('пустой журнал — «Запитів немає»', async () => {
    await renderAt('/settings/intake-sources')
    const log = await openJournal('Tilda: старі форми')
    expect(await within(log).findByText('Запитів немає.')).toBeTruthy()
  })
})

describe('экран источников: провести заново', () => {
  const region = () => screen.findByRole('region', { name: 'Провести заново вхідні' })

  it('не администратору проекта раздела и кнопки нет', async () => {
    const api = fakeIntakeSourcesApi({ isAdmin: false })
    const status = vi.spyOn(api, 'replayStatus')
    await renderAt('/settings/intake-sources', { api })
    await screen.findByRole('article', { name: 'Лендинг вебінару' })
    await waitFor(() => expect(status).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByRole('region', { name: 'Провести заново вхідні' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Провести заново вхідні з моменту…' })).toBeNull()
  })

  it('дата старше 30 дней не принимается: запрос не уходит', async () => {
    const api = await renderAt('/settings/intake-sources')
    const section = await region()
    fireEvent.click(
      within(section).getByRole('button', { name: 'Провести заново вхідні з моменту…' }),
    )
    expect(await within(section).findByText('Вкажіть дату й час.')).toBeTruthy()
    fireEvent.change(within(section).getByLabelText('З моменту'), {
      target: { value: localMinute(Date.now() - 31 * DAY) },
    })
    fireEvent.click(
      within(section).getByRole('button', { name: 'Провести заново вхідні з моменту…' }),
    )
    expect(
      await within(section).findByText('Момент має бути не давніше ніж 30 днів тому.'),
    ).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.calls.some((c) => c.method === 'replay')).toBe(false)
  })

  it('подтверждение с пояснением, ход, затем итог', async () => {
    const api = fakeIntakeSourcesApi({ replayRunningPolls: 1 })
    await renderAt('/settings/intake-sources', { api })
    const section = await region()
    const since = localMinute(Date.now() - 2 * DAY)
    fireEvent.change(within(section).getByLabelText('З моменту'), { target: { value: since } })
    fireEvent.click(
      within(section).getByRole('button', { name: 'Провести заново вхідні з моменту…' }),
    )
    const confirm = await screen.findByRole('dialog', { name: /^Провести заново вхідні з / })
    expect(confirm.textContent).toContain(
      'Повтор безпечний: вже прийняті реєстрації не задвояться.',
    )
    fireEvent.click(within(confirm).getByRole('button', { name: 'Провести заново' }))
    expect(await within(section).findByText(/^Виконується: вхідні з /)).toBeTruthy()
    expect(api.calls.at(-1)).toEqual({
      method: 'replay',
      input: new Date(since).toISOString(),
    })
    // Ход перечитывается сам, пока не придёт итог.
    expect(
      await within(section).findByText(
        /^Готово: вхідні з .*прийнято: 1, повторів: 3, помилок: 1$/,
        undefined,
        { timeout: 5000 },
      ),
    ).toBeTruthy()
  })
})

describe('экран источников: языки', () => {
  it('тексты на русском', async () => {
    await renderAt('/settings/intake-sources', { language: 'ru' })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Источники')
    const card = await screen.findByRole('article', { name: 'Tilda: старі форми' })
    expect(card.textContent).toContain('отключён')
    expect(within(card).getByRole('button', { name: 'Включить' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Создать источник' })).toBeTruthy()
    expect(
      await screen.findByRole('button', { name: 'Провести заново входящие с момента…' }),
    ).toBeTruthy()
  })

  it('все строки экрана есть в uk и ru и не пустые', () => {
    function entries(value: unknown, prefix = ''): [string, unknown][] {
      if (typeof value !== 'object' || value === null) return [[prefix, value]]
      return Object.entries(value).flatMap(([key, nested]) =>
        entries(nested, prefix ? `${prefix}.${key}` : key),
      )
    }
    const uk = entries(resources.uk['intake-sources'])
    const ru = entries(resources.ru['intake-sources'])
    expect(ru.map(([key]) => key).sort()).toEqual(uk.map(([key]) => key).sort())
    for (const [key, value] of [...uk, ...ru]) {
      expect(typeof value === 'string' && value.trim() !== '', key).toBe(true)
    }
  })
})
