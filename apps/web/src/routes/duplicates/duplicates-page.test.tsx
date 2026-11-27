import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeProjectsApi } from '../../components/project-switcher/fake-projects-api.ts'
import { createI18n, type Language } from '../../i18n/index.ts'
import { createAppRouter } from '../../router.tsx'
import { setViewportWidth } from '../../test/viewport.ts'
import { fakeAuthApi } from '../auth/fake-auth-api.ts'
import type { DuplicateCounts, DuplicateGroup } from './duplicates-api.ts'
import { createFakeDuplicatesApi, type FakeDuplicatesApi } from './fake-duplicates-api.ts'

// Экран «Дублі» и счётчик в шапке (тикет crm-intake/05) в настоящем дереве маршрутов (вошедший
// пользователь, подставные API): группы с причинами и предпросмотром, «Об'єднати» —
// последовательные слияния в выбранную запись с откатом каждого, «Не дубль», тексты uk и ru,
// 375 px.

const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`

const contact = (n: number, firstName: string, createdAt: string, phones = ['+380671234567']) => ({
  id: ID(n),
  firstName,
  lastName: 'Коваленко',
  phones,
  emails: [],
  createdAt,
})

/** Три контакта: 1–2 по телефону, 2–3 по отметке «можливий дубль». */
const THREE: DuplicateGroup = {
  id: ID(1),
  type: 'contact',
  recordIds: [ID(1), ID(2), ID(3)],
  reasons: ['mark', 'phone'],
  pairs: [
    { aId: ID(1), bId: ID(2), reasons: ['phone'] },
    { aId: ID(2), bId: ID(3), reasons: ['mark'] },
  ],
  foundAt: '2026-11-20T10:00:00.000Z',
  records: [
    contact(1, 'Олена', '2026-01-01T00:00:00.000Z'),
    contact(2, 'Олена', '2025-06-01T00:00:00.000Z'),
    contact(3, 'Олена К.', '2026-03-01T00:00:00.000Z', []),
  ],
}

const DEALS: DuplicateGroup = {
  id: ID(7),
  type: 'deal',
  recordIds: [ID(7), ID(8)],
  reasons: ['open_deals'],
  pairs: [{ aId: ID(7), bId: ID(8), reasons: ['open_deals'] }],
  foundAt: '2026-11-21T10:00:00.000Z',
  records: [
    {
      id: ID(7),
      title: 'Курс AI',
      pipelineName: 'Продажі',
      stageName: 'Новий лід',
      archived: true,
      amount: '0.00',
      currency: 'UAH',
      ownerName: null,
      contactName: 'Олена Коваленко',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: ID(8),
      title: 'Курс AI повторно',
      pipelineName: 'Продажі',
      stageName: 'Новий лід',
      archived: false,
      amount: '100.00',
      currency: 'UAH',
      ownerName: 'Марія',
      contactName: 'Олена Коваленко',
      createdAt: '2026-02-01T00:00:00.000Z',
    },
  ],
}

async function renderAt(
  path: string,
  {
    language = 'uk',
    api = createFakeDuplicatesApi([THREE, DEALS]),
  }: { language?: Language; api?: FakeDuplicatesApi } = {},
) {
  const queryClient = new QueryClient()
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    auth: fakeAuthApi(),
    projects: fakeProjectsApi(),
    duplicates: api,
    duplicatesCounter: api,
    queryClient,
  })
  render(
    <I18nextProvider i18n={createI18n(language)}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nextProvider>,
  )
  return api
}

afterEach(() => {
  setViewportWidth(1280)
})

describe('экран «Дублі»', () => {
  it('группы с причинами, записями и парами; счётчик в шапке и пункт меню ведут на экран', async () => {
    await renderAt('/duplicates')
    const counter = await screen.findByRole('link', { name: 'Дублів: 2' })
    expect(counter.getAttribute('href')).toBe('/p/alpi/duplicates')
    expect(screen.getByRole('link', { name: 'Дублі' }).getAttribute('href')).toBe(
      '/p/alpi/duplicates',
    )

    expect(await screen.findByRole('heading', { level: 1, name: 'Дублі' })).toBeTruthy()
    const group = await screen.findByRole('article', { name: 'Група схожих записів: 3' })
    // Причина — меткой группы и у своей пары.
    expect(within(group).getAllByText('Однаковий телефон')).toHaveLength(2)
    expect(within(group).getAllByText('Позначка «можливий дубль»')).toHaveLength(2)
    expect(within(group).getAllByRole('link', { name: /Олена/ })).toHaveLength(3)
    expect(within(group).getAllByRole('button', { name: /^Не дубль/ })).toHaveLength(2)

    fireEvent.click(screen.getByRole('tab', { name: 'Угоди: 1' }))
    const deals = await screen.findByRole('article', { name: 'Група схожих записів: 2' })
    expect(within(deals).getAllByText('Кілька відкритих угод у воронці')).toHaveLength(2)
    expect(within(deals).getByText('Архів')).toBeTruthy()
  })

  it('контакт сделки вне охвата — без имени, как на доске', async () => {
    const hidden: DuplicateGroup = {
      ...DEALS,
      records: DEALS.records.map((record) => ({ ...record, contactName: null })),
    }
    await renderAt('/duplicates', {
      api: createFakeDuplicatesApi([hidden], { contact: null, deal: 1 }),
    })
    const group = await screen.findByRole('article', { name: 'Група схожих записів: 2' })
    expect(within(group).getAllByText(/контакт поза вашим охопленням/)).toHaveLength(2)
    expect(within(group).queryByText(/Олена Коваленко/)).toBeNull()
  })

  it("«Об'єднати» группу из трёх: предпросмотр, два слияния в выбранную, откат каждого", async () => {
    const api = await renderAt('/duplicates')
    const group = await screen.findByRole('article', { name: 'Група схожих записів: 3' })
    fireEvent.click(within(group).getByRole('button', { name: "Об'єднати" }))
    const dialog = await screen.findByRole('dialog', { name: "Об'єднати записи" })
    // По умолчанию остаётся самая старая запись (2); выбираем первую.
    const keep = within(dialog).getAllByRole('radio') as HTMLInputElement[]
    expect(keep.map((radio) => radio.checked)).toEqual([false, true, false])
    fireEvent.click(keep[0] as HTMLInputElement)
    await within(dialog).findAllByText('угоди: 2')
    expect(api.calls).toContain(`preview contact ${ID(1)} ${ID(2)}`)
    expect(api.calls).toContain(`preview contact ${ID(1)} ${ID(3)}`)

    fireEvent.click(within(dialog).getByRole('button', { name: "Об'єднати (2)" }))
    await within(dialog).findByText("«Олена К. Коваленко» об'єднано в «Олена Коваленко».")
    expect(api.calls.filter((call) => call.startsWith('merge'))).toEqual([
      `merge contact ${ID(1)} ${ID(2)}`,
      `merge contact ${ID(1)} ${ID(3)}`,
    ])
    const undo = within(dialog).getAllByRole('button', { name: "Скасувати об'єднання" })
    expect(undo).toHaveLength(2)
    // Кнопки отката доступны, когда слияния закончились и группы перечитаны.
    await waitFor(() => expect((undo[1] as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(undo[1] as HTMLElement)
    await waitFor(() => expect(api.calls).toContain('undo merge-2'))
    expect(api.calls).not.toContain('undo merge-1')
    await waitFor(() =>
      expect(within(dialog).getAllByRole('button', { name: "Скасувати об'єднання" })).toHaveLength(
        1,
      ),
    )
  })

  it('конфликтующие сделки: блок пар, «Поміняти» — keep_deal_ids в предпросмотре и слиянии', async () => {
    const dealOf = (id: string, title: string) => ({ id, title, amount: 100, currency: 'UAH' })
    // Остаётся контакт 2 (самый старый); у контактов 1 и 2 открытые сделки в одной воронке.
    const api = createFakeDuplicatesApi([THREE], undefined, {
      [ID(1)]: [
        {
          pipeline: { id: 'pipeline-1', name: 'Продажі' },
          forbidden: false,
          survivorDeal: dealOf('deal-of-2', 'Угода Олени'),
          mergedDeal: dealOf('deal-of-1', 'Угода Олени (дубль)'),
          keepDealId: 'deal-of-2',
        },
      ],
    })
    await renderAt('/duplicates', { api })
    const group = await screen.findByRole('article', { name: 'Група схожих записів: 3' })
    fireEvent.click(within(group).getByRole('button', { name: "Об'єднати" }))
    const dialog = await screen.findByRole('dialog', { name: "Об'єднати записи" })
    const pairs = await within(dialog).findByRole('region', {
      name: "Угоди, які теж буде об'єднано",
    })
    expect(within(pairs).getByText('Воронка «Продажі»')).toBeTruthy()
    fireEvent.click(
      within(pairs).getByRole('button', { name: 'Поміняти угоди у воронці «Продажі»' }),
    )
    await waitFor(() =>
      expect(api.calls).toContain(`preview contact ${ID(2)} ${ID(1)} keep deal-of-1`),
    )

    fireEvent.click(within(dialog).getByRole('button', { name: "Об'єднати (2)" }))
    await waitFor(() =>
      expect(api.calls.filter((call) => call.startsWith('merge'))).toEqual([
        `merge contact ${ID(2)} ${ID(1)} keep deal-of-1`,
        `merge contact ${ID(2)} ${ID(3)}`,
      ]),
    )
  })

  it("пара сделок без права на них — объяснение, «Об'єднати» недоступна", async () => {
    const api = createFakeDuplicatesApi([THREE], undefined, {
      [ID(3)]: [
        {
          pipeline: { id: 'pipeline-1', name: 'Продажі' },
          forbidden: true,
          survivorDeal: null,
          mergedDeal: null,
          keepDealId: null,
        },
      ],
    })
    await renderAt('/duplicates', { api })
    const group = await screen.findByRole('article', { name: 'Група схожих записів: 3' })
    fireEvent.click(within(group).getByRole('button', { name: "Об'єднати" }))
    const dialog = await screen.findByRole('dialog', { name: "Об'єднати записи" })
    expect(
      await within(dialog).findByText(/Немає права змінювати обидві угоди в цій воронці/),
    ).toBeTruthy()
    const confirm = within(dialog).getByRole('button', {
      name: "Об'єднати (2)",
    }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
  })

  it('отказ сервера в предпросмотре и слиянии показывается как пришёл', async () => {
    const api = createFakeDuplicatesApi([THREE])
    api.failNext('MERGE_DEAL_FORBIDDEN', 403)
    await renderAt('/duplicates', { api })
    const group = await screen.findByRole('article', { name: 'Група схожих записів: 3' })
    fireEvent.click(within(group).getByRole('button', { name: "Об'єднати" }))
    const dialog = await screen.findByRole('dialog')
    expect(
      await within(dialog).findByText(
        "Серед конфліктних угод є недоступні вам — об'єднати контакти не можна.",
      ),
    ).toBeTruthy()
  })

  it('«Не дубль» на паре: пара пропадает, с ней группа из двух записей', async () => {
    const api = await renderAt('/duplicates', {
      api: createFakeDuplicatesApi([{ ...THREE, pairs: [THREE.pairs[0] as never] }]),
    })
    const group = await screen.findByRole('article')
    fireEvent.click(
      within(group).getByRole('button', { name: 'Не дубль: Олена Коваленко і Олена Коваленко' }),
    )
    await waitFor(() => expect(screen.queryByRole('article')).toBeNull())
    expect(api.calls).toEqual([`not-duplicate contact ${ID(1)} ${ID(2)}`])
    expect(await screen.findByText('Схожих контактів немає.')).toBeTruthy()
  })

  it('без права «изменять» ни на один раздел — нет счётчика, пункта меню и экрана', async () => {
    const none: DuplicateCounts = { contact: null, deal: null }
    await renderAt('/duplicates', { api: createFakeDuplicatesApi([THREE], none) })
    expect(await screen.findByRole('heading', { name: 'Немає доступу' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: /Дублів/ })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Дублі' })).toBeNull()
  })

  it('только сделки: вкладки контактов нет, счётчик считает только сделки', async () => {
    await renderAt('/duplicates', {
      api: createFakeDuplicatesApi([THREE, DEALS], { contact: null, deal: 1 }),
    })
    expect(await screen.findByRole('link', { name: 'Дублів: 1' })).toBeTruthy()
    expect(await screen.findByText('Курс AI повторно')).toBeTruthy()
    expect(screen.queryByRole('tab')).toBeNull()
  })

  it('тексты на русском', async () => {
    await renderAt('/duplicates', { language: 'ru' })
    expect(await screen.findByRole('heading', { level: 1, name: 'Дубли' })).toBeTruthy()
    expect(await screen.findByRole('link', { name: 'Дублей: 2' })).toBeTruthy()
    const group = await screen.findByRole('article', { name: 'Группа похожих записей: 3' })
    expect(within(group).getByRole('button', { name: 'Объединить' })).toBeTruthy()
    expect(within(group).getAllByText('Одинаковый телефон')).toHaveLength(2)
    expect(screen.getByRole('tab', { name: 'Сделки: 1' })).toBeTruthy()
  })

  it('на 375 px: счётчик в шапке, экран и окно объединения работают', async () => {
    setViewportWidth(375)
    await renderAt('/duplicates')
    expect(await screen.findByRole('link', { name: 'Дублів: 2' })).toBeTruthy()
    const group = await screen.findByRole('article', { name: 'Група схожих записів: 3' })
    fireEvent.click(within(group).getByRole('button', { name: "Об'єднати" }))
    expect(await screen.findByRole('dialog', { name: "Об'єднати записи" })).toBeTruthy()
  })
})
