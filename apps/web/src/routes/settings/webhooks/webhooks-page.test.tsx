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
import { type FakeWebhooksApi, fakeWebhooksApi } from './fake-webhooks-api.ts'

// Экран «Налаштування → Вебхуки» (тикет crm-api/07) в настоящем дереве маршрутов (вошедший
// пользователь, подставные API): право «інтеграції», ошибка адреса у поля, секрет один раз,
// смена секрета с предупреждением про 24 часа, журнал доставок с повтором, отключённый вебхук
// с причиной, тексты uk и ru.

async function renderAt(
  path: '/settings' | '/settings/webhooks',
  {
    language = 'uk',
    permissions = fullPermissions(),
    api = fakeWebhooksApi({ permissions }),
  }: { language?: Language; permissions?: RolePermissions; api?: FakeWebhooksApi } = {},
) {
  const queryClient = new QueryClient()
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    auth: fakeAuthApi(),
    projects: fakeProjectsApi(),
    fields: fakeFieldsApi({ permissions }),
    webhooks: api,
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

/** Дата `YYYY-MM-DD` по местному времени — значение поля type="date". */
function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

async function openCreate() {
  fireEvent.click(await screen.findByRole('button', { name: 'Створити вебхук' }))
  return screen.findByRole('dialog', { name: 'Новий вебхук' })
}

function fillUrl(dialog: HTMLElement, url: string) {
  fireEvent.change(within(dialog).getByRole('textbox', { name: /Адреса \(URL\)/ }), {
    target: { value: url },
  })
}

describe('экран вебхуков: права', () => {
  it('с правом «інтеграції» в настройках есть пункт «Вебхуки»', async () => {
    await renderAt('/settings')
    expect(await screen.findByRole('link', { name: 'Вебхуки' })).toBeTruthy()
  })

  it('без права «інтеграції» пункта «Вебхуки» нет', async () => {
    await renderAt('/settings', { permissions: integrations() })
    await screen.findByRole('link', { name: 'Ролі та права' })
    // Даём правам прийти: с правом ссылка к этому времени уже есть (тест выше).
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByRole('link', { name: 'Вебхуки' })).toBeNull()
  })

  it('без права прямая ссылка — «немає доступу», список не запрашивается', async () => {
    const api = fakeWebhooksApi({ permissions: integrations() })
    const list = vi.spyOn(api, 'list')
    await renderAt('/settings/webhooks', { permissions: integrations(), api })
    expect(await screen.findByRole('heading', { name: 'Немає доступу' })).toBeTruthy()
    expect(list).not.toHaveBeenCalled()
  })

  it('только «смотреть» — список без кнопок создания, изменения и удаления', async () => {
    await renderAt('/settings/webhooks', { permissions: integrations('view') })
    const card = await screen.findByRole('article', { name: 'n8n: нові угоди' })
    expect(screen.queryByRole('button', { name: 'Створити вебхук' })).toBeNull()
    for (const name of ['Змінити', 'Змінити секрет', 'Вимкнути', 'Видалити']) {
      expect(within(card).queryByRole('button', { name })).toBeNull()
    }
    expect(within(card).getByRole('button', { name: 'Журнал доставок' })).toBeTruthy()
  })
})

describe('экран вебхуков: список', () => {
  it('вебхук — адрес, описание, типы, состояние, последняя доставка, доля неудач за 24 часа', async () => {
    await renderAt('/settings/webhooks')
    const card = await screen.findByRole('article', { name: 'n8n: нові угоди' })
    expect(card.textContent).toContain('https://hooks.example.test/n8n/new-deals')
    expect(card.textContent).toContain('увімкнений')
    expect(card.textContent).toContain('2 з 10')
    expect(card.textContent).toContain('20 %')
  })

  it('отключённый вебхук показан с причиной; повторы у него недоступны', async () => {
    await renderAt('/settings/webhooks')
    const card = await screen.findByRole('article', { name: 'Make: контакти' })
    expect(card.textContent).toContain('вимкнений')
    expect(card.textContent).toContain('5 днів без успішної доставки')
    expect(within(card).getByRole('button', { name: 'Увімкнути' })).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: 'Журнал доставок' }))
    const log = await within(card).findByRole('region', { name: 'Журнал доставок' })
    expect(log.textContent).toContain('увімкніть його')
    const retryAll = within(log).getByRole('button', { name: 'Надіслати всі невдалі з дати' })
    expect((retryAll as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(within(log).getByLabelText('Події з дати'), {
      target: { value: localDay(new Date()) },
    })
    const catchUp = within(log).getByRole('button', { name: 'Наздогнати події з дати' })
    expect((catchUp as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(await within(log).findByRole('button', { name: 'Деталі' }))
    const retry = await within(log).findByRole('button', { name: 'Надіслати ще раз' })
    expect((retry as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('экран вебхуков: создание и секрет', () => {
  it('http:// и частный адрес — ошибка у поля; верный — окно с секретом; после закрытия секрета нигде нет', async () => {
    const clipboard = stubClipboard()
    const api = await renderAt('/settings/webhooks')
    let dialog = await openCreate()
    fillUrl(dialog, 'http://hooks.example.test/crm')
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Опис/ }), {
      target: { value: 'Make: угоди' },
    })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Вибрати все' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Створити' }))
    const urlField = within(dialog).getByRole('textbox', { name: /Адреса \(URL\)/ })
    await waitFor(() => expect(urlField.getAttribute('aria-invalid')).toBe('true'))
    expect(within(dialog).getByRole('alert').textContent).toContain('Потрібна адреса https://')

    fillUrl(dialog, 'https://192.168.1.10/hook')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Створити' }))
    await waitFor(() =>
      expect(within(dialog).getByRole('alert').textContent).toContain('локальну чи службову'),
    )

    fillUrl(dialog, 'https://hook.eu1.make.example.test/abc')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Створити' }))
    dialog = await screen.findByRole('dialog', { name: 'Секрет вебхука «Make: угоди»' })
    const secret = (
      within(dialog).getByRole('textbox', { name: 'Секрет підпису' }) as HTMLInputElement
    ).value
    expect(secret).toMatch(/^whsec_/)
    expect(dialog.textContent).toContain('більше не буде показано')
    expect(dialog.textContent).toContain('webhook-id')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Скопіювати' }))
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith(secret))

    fireEvent.click(within(dialog).getByRole('button', { name: 'Готово' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const card = await screen.findByRole('article', { name: 'Make: угоди' })
    expect(card.textContent).toContain('доставок не було')
    expect(document.body.innerHTML).not.toContain(secret)
    expect(api.calls.map((c) => c.method)).toEqual(['create', 'create', 'create'])
    expect(api.calls.at(-1)?.input).toMatchObject({
      url: 'https://hook.eu1.make.example.test/abc',
      description: 'Make: угоди',
    })
  })

  it('без адреса и без типов событий вебхук не создаётся', async () => {
    const api = await renderAt('/settings/webhooks')
    const dialog = await openCreate()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Створити' }))
    expect(within(dialog).getByText('Обов’язкове поле.')).toBeTruthy()
    expect(within(dialog).getByText('Оберіть хоча б один тип подій.')).toBeTruthy()
    expect(api.calls).toEqual([])
  })

  it('типы событий сгруппированы по сущности, с описаниями; «вибрати все» отмечает все', async () => {
    await renderAt('/settings/webhooks')
    const dialog = await openCreate()
    const deals = within(dialog).getByRole('group', { name: 'Угоди' })
    const contacts = within(dialog).getByRole('group', { name: 'Контакти' })
    expect(within(deals).getByRole('checkbox', { name: /Угоду виграно/ })).toBeTruthy()
    expect(within(contacts).getByRole('checkbox', { name: /Контакт створено/ })).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Вибрати все' }))
    const boxes = within(dialog).getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes.every((box) => box.checked)).toBe(true)
  })

  it('смена секрета — после подтверждения новый секрет и предупреждение про 24 часа', async () => {
    const api = await renderAt('/settings/webhooks')
    const card = await screen.findByRole('article', { name: 'n8n: нові угоди' })
    fireEvent.click(within(card).getByRole('button', { name: 'Змінити секрет' }))
    const confirm = await screen.findByRole('dialog', {
      name: 'Змінити секрет вебхука «n8n: нові угоди»?',
    })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Змінити секрет' }))
    const dialog = await screen.findByRole('dialog', { name: 'Секрет вебхука «n8n: нові угоди»' })
    expect(
      (within(dialog).getByRole('textbox', { name: 'Секрет підпису' }) as HTMLInputElement).value,
    ).toMatch(/^whsec_/)
    expect(dialog.textContent).toContain('Старий секрет діятиме ще 24 години')
    expect(api.calls).toEqual([{ method: 'rotateSecret', endpointId: api.endpoints[0]?.id }])
  })

  it('изменение: сохраняются только изменённые поля', async () => {
    const api = await renderAt('/settings/webhooks')
    const card = await screen.findByRole('article', { name: 'n8n: нові угоди' })
    fireEvent.click(within(card).getByRole('button', { name: 'Змінити' }))
    const dialog = await screen.findByRole('dialog', { name: 'Змінити вебхук «n8n: нові угоди»' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Опис/ }), {
      target: { value: 'n8n: угоди' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Зберегти' }))
    expect(await screen.findByText('Вебхук «n8n: угоди» збережено.')).toBeTruthy()
    expect(api.calls).toEqual([
      { method: 'update', endpointId: api.endpoints[0]?.id, input: { description: 'n8n: угоди' } },
    ])
  })
})

describe('экран вебхуков: включение, отключение, удаление', () => {
  it('отключение и удаление — после подтверждения; удаление предупреждает про журнал', async () => {
    const api = await renderAt('/settings/webhooks')
    const card = await screen.findByRole('article', { name: 'n8n: нові угоди' })
    fireEvent.click(within(card).getByRole('button', { name: 'Вимкнути' }))
    const confirm = await screen.findByRole('dialog', {
      name: 'Вимкнути вебхук «n8n: нові угоди»?',
    })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Вимкнути' }))
    expect(await screen.findByText('Вебхук «n8n: нові угоди» вимкнено.')).toBeTruthy()
    await waitFor(() =>
      expect(screen.getByRole('article', { name: 'n8n: нові угоди' }).textContent).toContain(
        'вимкнено вручну',
      ),
    )

    fireEvent.click(
      within(screen.getByRole('article', { name: 'n8n: нові угоди' })).getByRole('button', {
        name: 'Видалити',
      }),
    )
    const remove = await screen.findByRole('dialog', { name: 'Видалити вебхук «n8n: нові угоди»?' })
    expect(remove.textContent).toContain('зникне його журнал доставок')
    fireEvent.click(within(remove).getByRole('button', { name: 'Скасувати' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.calls.map((c) => c.method)).toEqual(['disable'])

    fireEvent.click(
      within(screen.getByRole('article', { name: 'n8n: нові угоди' })).getByRole('button', {
        name: 'Видалити',
      }),
    )
    const again = await screen.findByRole('dialog', { name: 'Видалити вебхук «n8n: нові угоди»?' })
    fireEvent.click(within(again).getByRole('button', { name: 'Видалити' }))
    await waitFor(() =>
      expect(screen.queryByRole('article', { name: 'n8n: нові угоди' })).toBeNull(),
    )
    expect(api.calls.map((c) => c.method)).toEqual(['disable', 'remove'])
  })

  it('включение отключённого вебхука — после подтверждения', async () => {
    const api = await renderAt('/settings/webhooks')
    const card = await screen.findByRole('article', { name: 'Make: контакти' })
    fireEvent.click(within(card).getByRole('button', { name: 'Увімкнути' }))
    const confirm = await screen.findByRole('dialog', {
      name: 'Увімкнути вебхук «Make: контакти»?',
    })
    expect(confirm.textContent).toContain('самі не прийдуть')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Увімкнути' }))
    expect(await screen.findByText('Вебхук «Make: контакти» увімкнено.')).toBeTruthy()
    expect(api.calls).toEqual([{ method: 'enable', endpointId: api.endpoints[1]?.id }])
  })
})

describe('экран вебхуков: журнал доставок', () => {
  it('неудачная доставка раскрывается с попытками и телом события; «надіслати ще раз» добавляет попытку', async () => {
    const api = await renderAt('/settings/webhooks')
    const card = await screen.findByRole('article', { name: 'n8n: нові угоди' })
    fireEvent.click(within(card).getByRole('button', { name: 'Журнал доставок' }))
    const log = await within(card).findByRole('region', { name: 'Журнал доставок' })
    const failed = await within(log).findByRole('listitem', { name: /Угоду створено/ })
    expect(failed.textContent).toContain('не доставлено')
    expect(failed.textContent).toContain('Спроб: 2')
    expect(failed.textContent).toContain('немає відповіді за 15 с')

    fireEvent.click(within(failed).getByRole('button', { name: 'Деталі' }))
    const attempts = await within(failed).findByRole('list', { name: 'Спроби' })
    expect(within(attempts).getAllByRole('listitem')).toHaveLength(2)
    expect(attempts.textContent).toContain('500')
    expect(attempts.textContent).toContain('Workflow could not be started')
    const deliveryId = api.deliveryLog.get(api.endpoints[0]?.id ?? '')?.[0]?.id
    const eventId = api.deliveryLog.get(api.endpoints[0]?.id ?? '')?.[0]?.eventId ?? ''
    expect(within(failed).getByLabelText('Тіло події').textContent).toContain(eventId)

    fireEvent.click(within(failed).getByRole('button', { name: 'Надіслати ще раз' }))
    await waitFor(() =>
      expect(
        within(within(log).getByRole('list', { name: 'Спроби' })).getAllByRole('listitem'),
      ).toHaveLength(3),
    )
    expect(api.calls).toEqual([
      { method: 'retryDelivery', endpointId: api.endpoints[0]?.id, deliveryId },
    ])
  })

  it('фильтр по состоянию и «надіслати всі невдалі з дати»', async () => {
    const api = await renderAt('/settings/webhooks')
    const card = await screen.findByRole('article', { name: 'n8n: нові угоди' })
    fireEvent.click(within(card).getByRole('button', { name: 'Журнал доставок' }))
    const log = await within(card).findByRole('region', { name: 'Журнал доставок' })
    await within(log).findByRole('listitem', { name: /Угоду виграно/ })
    fireEvent.change(within(log).getByRole('combobox', { name: 'Стан' }), {
      target: { value: 'failed' },
    })
    expect(await within(log).findByRole('listitem', { name: /Угоду створено/ })).toBeTruthy()
    expect(within(log).queryByRole('listitem', { name: /Угоду виграно/ })).toBeNull()

    fireEvent.change(within(log).getByLabelText('Невдалі з дати'), {
      target: { value: '2026-11-20' },
    })
    fireEvent.click(within(log).getByRole('button', { name: 'Надіслати всі невдалі з дати' }))
    expect(await within(log).findByText('У чергу поставлено доставок: 1.')).toBeTruthy()
    const call = api.calls.at(-1)
    expect(call?.method).toBe('retryFailed')
    const since = (call?.input as { since: string } | undefined)?.since ?? ''
    expect(new Date(since).getDate()).toBe(20)
  })

  it('журнал подгружается курсором: «показати ще»', async () => {
    const api = fakeWebhooksApi({ pageSize: 1 })
    await renderAt('/settings/webhooks', { api })
    const card = await screen.findByRole('article', { name: 'n8n: нові угоди' })
    fireEvent.click(within(card).getByRole('button', { name: 'Журнал доставок' }))
    const log = await within(card).findByRole('region', { name: 'Журнал доставок' })
    await within(log).findByRole('listitem', { name: /Угоду створено/ })
    expect(within(log).queryByRole('listitem', { name: /Угоду виграно/ })).toBeNull()
    fireEvent.click(within(log).getByRole('button', { name: 'Показати ще' }))
    expect(await within(log).findByRole('listitem', { name: /Угоду виграно/ })).toBeTruthy()
    expect(within(log).queryByRole('button', { name: 'Показати ще' })).toBeNull()
  })
})

describe('экран вебхуков: «наздогнати події з дати» (тикет crm-api/09)', () => {
  async function openLog() {
    const card = await screen.findByRole('article', { name: 'n8n: нові угоди' })
    fireEvent.click(within(card).getByRole('button', { name: 'Журнал доставок' }))
    const log = await within(card).findByRole('region', { name: 'Журнал доставок' })
    await within(log).findByRole('listitem', { name: /Угоду виграно/ })
    return log
  }

  function pick(log: HTMLElement, day: string) {
    fireEvent.change(within(log).getByLabelText('Події з дати'), { target: { value: day } })
    fireEvent.click(within(log).getByRole('button', { name: 'Наздогнати події з дати' }))
  }

  it('дата, подтверждение, число поставленных событий; отмена ничего не отправляет', async () => {
    const api = await renderAt('/settings/webhooks')
    const log = await openLog()
    const catchUp = within(log).getByRole('button', { name: 'Наздогнати події з дати' })
    // Без даты кнопка недоступна.
    expect((catchUp as HTMLButtonElement).disabled).toBe(true)

    const today = localDay(new Date())
    pick(log, today)
    const cancelled = await screen.findByRole('dialog', {
      name: 'Наздогнати події вебхука «n8n: нові угоди»?',
    })
    fireEvent.click(within(cancelled).getByRole('button', { name: 'Скасувати' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.calls.some((call) => call.method === 'catchUp')).toBe(false)

    pick(log, today)
    const dialog = await screen.findByRole('dialog', {
      name: 'Наздогнати події вебхука «n8n: нові угоди»?',
    })
    expect(dialog.textContent).toContain('лише тих типів, на які він підписаний зараз')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Наздогнати' }))
    expect(await within(log).findByText('У чергу поставлено подій: 3.')).toBeTruthy()
    const call = api.calls.at(-1)
    expect(call?.method).toBe('catchUp')
    expect(call?.endpointId).toBe(api.endpoints[0]?.id)
    // Дата без времени — с начала этого дня по местному времени.
    const since = (call?.input as { since: string } | undefined)?.since ?? ''
    expect(since).toBe(new Date(`${today}T00:00:00`).toISOString())
  })

  it('в первый доступный день — с самой границы: не раньше создания вебхука и не старше 30 дней', async () => {
    const api = await renderAt('/settings/webhooks')
    const log = await openLog()
    const input = within(log).getByLabelText('Події з дати') as HTMLInputElement
    expect(input.max).toBe(localDay(new Date()))
    pick(log, input.min)
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Наздогнати' }))
    // Подставной API, как и настоящий, отвечает 422 на дату раньше создания или старше 30 дней.
    expect(await within(log).findByText(/^У чергу поставлено подій: \d+\.$/)).toBeTruthy()
    const since = Date.parse(
      (api.calls.at(-1)?.input as { since?: string } | undefined)?.since ?? '',
    )
    expect(since).toBeGreaterThanOrEqual(Date.parse(api.endpoints[0]?.createdAt ?? ''))
    expect(since).toBeGreaterThan(Date.now() - 30 * 24 * 60 * 60 * 1000)
  })

  it('отказ API — понятная причина', async () => {
    const api = await renderAt('/settings/webhooks')
    const log = await openLog()
    api.failNextWith = 'WEBHOOK_CATCH_UP_TOO_OLD'
    pick(log, localDay(new Date()))
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Наздогнати' }),
    )
    expect(
      await within(log).findByText(
        'Події, старші за 30 днів, уже видалено — оберіть пізнішу дату.',
      ),
    ).toBeTruthy()
  })
})

describe('экран вебхуков: языки', () => {
  it('тексты на русском', async () => {
    await renderAt('/settings/webhooks', { language: 'ru' })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Вебхуки')
    const card = await screen.findByRole('article', { name: 'Make: контакти' })
    expect(card.textContent).toContain('отключён')
    expect(card.textContent).toContain('5 дней без успешной доставки')
    expect(within(card).getByRole('button', { name: 'Включить' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Создать вебхук' })).toBeTruthy()
  })

  it('все строки экрана есть в uk и ru и не пустые', () => {
    function entries(value: unknown, prefix = ''): [string, unknown][] {
      if (typeof value !== 'object' || value === null) return [[prefix, value]]
      return Object.entries(value).flatMap(([key, nested]) =>
        entries(nested, prefix ? `${prefix}.${key}` : key),
      )
    }
    const uk = entries(resources.uk.webhooks)
    const ru = entries(resources.ru.webhooks)
    expect(ru.map(([key]) => key).sort()).toEqual(uk.map(([key]) => key).sort())
    for (const [key, value] of [...uk, ...ru]) {
      expect(typeof value === 'string' && value.trim() !== '', key).toBe(true)
    }
  })
})
