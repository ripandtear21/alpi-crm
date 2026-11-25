import type { FieldDefinitionSummary, FieldEntity, FieldType } from '@alpi/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeProjectsApi } from '../../../components/project-switcher/fake-projects-api.ts'
import { createI18n } from '../../../i18n/index.ts'
import { createAppRouter } from '../../../router.tsx'
import { fakeAuthApi } from '../../auth/fake-auth-api.ts'
import { fakeDeal, fakeDealsApi, PIPELINE_ID } from '../fake-deals-api.ts'
import { type FakeListsApi, fakeDealRow, fakeListsApi } from './fake-lists-api.ts'

// Пользовательские поля в списке сделок, фильтре, сохранённых фильтрах и на карточке канбана
// (тикет crm-fields/07) в настоящем дереве маршрутов; поиск по базе и права проверяет API
// (apps/api/src/filters/custom-fields.test.ts).

let counter = 0
function fakeField(
  code: string,
  type: FieldType,
  fields: Partial<FieldDefinitionSummary> = {},
  entity: FieldEntity = 'deal',
): FieldDefinitionSummary {
  counter += 1
  return {
    id: `00000000-0000-4000-9700-${String(counter).padStart(12, '0')}`,
    entity,
    groupId: '00000000-0000-4000-9700-000000009999',
    code,
    type,
    nameUk: `Поле ${code}`,
    nameRu: null,
    position: counter,
    pipelines: 'all',
    required: { mode: 'none' },
    isImportant: false,
    isFrequentlyFiltered: false,
    firstValueAt: null,
    convertingTo: null,
    archivedAt: null,
    purgeRequestedAt: null,
    options: [],
    indexState: null,
    indexError: null,
    ...fields,
  } as FieldDefinitionSummary
}

const option = (id: string, nameUk: string) => ({
  id,
  nameUk,
  nameRu: null,
  position: 1,
  archivedAt: null,
})

const SMALL = '00000000-0000-4000-9800-000000000001'
const BIG = '00000000-0000-4000-9800-000000000002'

async function renderAt(path: string, api: FakeListsApi, deals = fakeDealsApi()) {
  const queryClient = new QueryClient()
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    auth: fakeAuthApi(),
    projects: fakeProjectsApi(),
    lists: api,
    deals,
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
  return api
}

const table = () => screen.findByRole('table', { name: /за фільтром/ })

async function titles(): Promise<string[]> {
  const rows = within(await table())
    .getAllByRole('row')
    .slice(1)
  return rows.map((row) => within(row).getAllByRole('cell')[1]?.textContent ?? '')
}

function listWithFields() {
  const score = fakeField('score', 'number')
  const size = fakeField('size', 'single_option', {
    options: [option(SMALL, 'Мала'), option(BIG, 'Велика')],
  })
  const api = fakeListsApi({
    deals: [
      fakeDealRow({ title: 'Альфа', custom: { score: 5, size: BIG } }),
      fakeDealRow({ title: 'Бета', custom: { score: 12 } }),
      fakeDealRow({ title: 'Гама', custom: { score: 8, size: SMALL } }),
    ],
  })
  api.customFields = [score, size]
  return { api, score, size }
}

afterEach(() => {
  window.localStorage.clear()
})

describe('пользовательские поля в списке сделок', () => {
  it('поле — колонкой: значение варианта названием, сортировка по полю уходит в запрос', async () => {
    const { api, score, size } = listWithFields()
    await renderAt('/deals/list', api)
    await waitFor(async () => expect(await titles()).toHaveLength(3))
    fireEvent.click(screen.getByRole('button', { name: 'Колонки' }))
    const dialog = await screen.findByRole('dialog', { name: 'Колонки списку' })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Поле size' }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Поле score' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Готово' }))

    const header = await screen.findByRole('columnheader', { name: /Поле score/ })
    const row = within(await table())
      .getAllByRole('row')
      .find((r) => r.textContent?.includes('Альфа'))
    expect(row?.textContent).toContain('Велика')
    fireEvent.click(within(header).getByRole('button'))
    await waitFor(async () => expect(await titles()).toEqual(['Альфа', 'Гама', 'Бета']))
    expect(api.calls.at(-1)?.value).toMatchObject({ sort: `custom.${score.id}:asc` })
    // Колонки полей запоминаются вместе с системными.
    const stored = Object.keys(window.localStorage).find((k) => k.startsWith('alpi.list.columns.'))
    expect(JSON.parse(window.localStorage.getItem(stored ?? '') ?? '[]')).toEqual(
      expect.arrayContaining([`custom.${size.id}`, `custom.${score.id}`]),
    )
  })

  it('фильтр «між» по числовому полю уходит условием custom.<id> и сужает список', async () => {
    const { api, score } = listWithFields()
    await renderAt('/deals/list', api)
    await waitFor(async () => expect(await titles()).toHaveLength(3))
    fireEvent.click(screen.getByRole('button', { name: 'Фільтр' }))
    const panel = await screen.findByRole('dialog', { name: 'Фільтр' })
    fireEvent.click(
      within(panel).getAllByRole('button', { name: 'Додати умову' })[0] as HTMLElement,
    )
    fireEvent.change(within(panel).getByLabelText('Поле'), {
      target: { value: `custom.${score.id}` },
    })
    const ops = within(within(panel).getByLabelText('Умова'))
      .getAllByRole('option')
      .map((o) => o.textContent)
    expect(ops).toEqual([
      'дорівнює',
      'раніше / менше',
      'пізніше / більше',
      'між',
      'порожнє',
      'заповнене',
    ])
    fireEvent.change(within(panel).getByLabelText('Умова'), { target: { value: 'between' } })
    fireEvent.change(within(panel).getByLabelText('Від'), { target: { value: '5' } })
    fireEvent.change(within(panel).getByLabelText('До'), { target: { value: '10' } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Застосувати' }))

    await waitFor(async () => expect((await titles()).sort()).toEqual(['Альфа', 'Гама']))
    expect(api.calls.at(-1)?.value).toMatchObject({
      filter: { and: [{ field: `custom.${score.id}`, op: 'between', value: [5, 10] }] },
    })
  })

  it('незаповнена межа «між» не применяется: подсказка в панели', async () => {
    const { api, score } = listWithFields()
    await renderAt('/deals/list', api)
    fireEvent.click(await screen.findByRole('button', { name: 'Фільтр' }))
    const panel = await screen.findByRole('dialog', { name: 'Фільтр' })
    fireEvent.click(
      within(panel).getAllByRole('button', { name: 'Додати умову' })[0] as HTMLElement,
    )
    fireEvent.change(within(panel).getByLabelText('Поле'), {
      target: { value: `custom.${score.id}` },
    })
    fireEvent.change(within(panel).getByLabelText('Умова'), { target: { value: 'between' } })
    fireEvent.change(within(panel).getByLabelText('Від'), { target: { value: '5' } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Застосувати' }))
    expect(await within(panel).findByText('Заповніть значення в усіх умовах.')).toBeTruthy()
  })

  it('сохранённый фильтр с недоступным полем: пометка «умова недоступна» в меню и при применении', async () => {
    const { api, score } = listWithFields()
    api.saved.push({
      id: '00000000-0000-4000-9900-000000000001',
      entity: 'deals',
      name: 'Великі',
      visibility: 'project',
      filter: { and: [{ field: `custom.${score.id}`, op: 'gt', value: 6 }] },
      teamId: null,
      ownerId: 'user-2',
      canDelete: false,
      createdAt: '2026-11-01T10:00:00.000Z',
      unavailableConditions: 1,
    })
    await renderAt('/deals/list', api)
    fireEvent.click(await screen.findByRole('button', { name: 'Збережені фільтри' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Великі (умова недоступна)' }))
    expect(await screen.findByText(/Умова недоступна: поле в архіві або приховане/)).toBeTruthy()
    await waitFor(async () => expect((await titles()).sort()).toEqual(['Бета', 'Гама']))
  })
})

describe('поля на карточке канбана', () => {
  it('под карточкой — значения выбранных полей, пустое поле не показывается', async () => {
    const city = fakeField('city', 'text')
    const vip = fakeField('vip', 'boolean')
    const note = fakeField('note', 'text')
    const deals = fakeDealsApi([
      fakeDeal({ title: 'Ірина — вебінар', custom: { city: 'Київ', vip: true, note: 'x' } }),
      fakeDeal({ title: 'Марко — курс', custom: { vip: false } }),
    ])
    deals.customFields = [city, vip, note]
    deals.cardFieldIds = { [PIPELINE_ID]: [city.id, vip.id] }
    await renderAt('/deals', fakeListsApi(), deals)

    const first = await screen.findByRole('article', { name: 'Ірина — вебінар' })
    const card = first.parentElement as HTMLElement
    await waitFor(() => expect(within(card).getByText('Київ')).toBeTruthy())
    expect(within(card).getByText('Поле city')).toBeTruthy()
    expect(within(card).getByText('Так')).toBeTruthy()
    // Поле не с карточки не показывается, даже если значение есть.
    expect(within(card).queryByText('Поле note')).toBeNull()
    const second = (await screen.findByRole('article', { name: 'Марко — курс' }))
      .parentElement as HTMLElement
    expect(within(second).queryByText('Поле city')).toBeNull()
    expect(within(second).getByText('Ні')).toBeTruthy()
  })
})
