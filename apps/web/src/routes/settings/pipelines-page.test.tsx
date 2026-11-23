import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import { fakeProjectsApi } from '../../components/project-switcher/fake-projects-api.ts'
import { createI18n, type Language } from '../../i18n/index.ts'
import { createAppRouter } from '../../router.tsx'
import { fakeAuthApi } from '../auth/fake-auth-api.ts'
import { type FakePipelinesApi, fakePipelinesApi } from './fake-pipelines-api.ts'

// Экраны «Настройки → Воронки» и «Настройки → Причины проигрыша» в настоящем дереве маршрутов
// (вошедший пользователь, подставные API).

async function renderAt(
  path: '/settings' | '/settings/pipelines' | '/settings/lost-reasons',
  {
    language = 'uk',
    api = fakePipelinesApi(),
  }: { language?: Language; api?: FakePipelinesApi } = {},
) {
  const queryClient = new QueryClient()
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    auth: fakeAuthApi(),
    projects: fakeProjectsApi(),
    pipelines: api,
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

function stageNames(pipeline: string): string[] {
  const list = screen.getByRole('list', { name: `Етапи воронки ${pipeline}` })
  return within(list)
    .getAllByRole('textbox')
    .map((input) => (input as HTMLInputElement).value)
}

describe('экран воронок', () => {
  it('воронка с этапами по порядку; этап двигается кнопками', async () => {
    const api = await renderAt('/settings/pipelines')
    await screen.findByRole('list', { name: 'Етапи воронки ALPI' })
    expect(stageNames('ALPI')).toEqual(['Новий лід', 'Передано в роботу', 'Був на вебінарі'])

    fireEvent.click(screen.getByRole('button', { name: 'Нижче: Новий лід' }))
    await waitFor(() =>
      expect(stageNames('ALPI')).toEqual(['Передано в роботу', 'Новий лід', 'Був на вебінарі']),
    )
    expect(api.pipelines[0]?.stages.map((s) => s.name)).toEqual([
      'Передано в роботу',
      'Новий лід',
      'Був на вебінарі',
    ])
    expect(
      (screen.getByRole('button', { name: 'Вище: Передано в роботу' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  it('создание воронки и этапа, переименование этапа', async () => {
    const api = await renderAt('/settings/pipelines')
    const form = await screen.findByRole('form', { name: 'Нова воронка' })
    fireEvent.change(within(form).getByRole('textbox', { name: 'Назва' }), {
      target: { value: 'Автовебінари' },
    })
    fireEvent.change(within(form).getByRole('textbox', { name: 'Код (латиницею)' }), {
      target: { value: 'autowebinars' },
    })
    fireEvent.click(within(form).getByRole('button', { name: 'Створити воронку' }))
    await screen.findByRole('list', { name: 'Етапи воронки Автовебінари' })
    expect(api.pipelines.map((p) => p.code)).toEqual(['alpi', 'autowebinars'])

    const newStage = screen.getByRole('textbox', { name: 'Новий етап воронки Автовебінари' })
    fireEvent.change(newStage, { target: { value: 'Новий лід' } })
    fireEvent.click(
      within(newStage.closest('form') as HTMLElement).getByRole('button', { name: 'Додати' }),
    )
    await waitFor(() => expect(stageNames('Автовебінари')).toEqual(['Новий лід']))

    const stageInput = screen.getByRole('textbox', { name: 'Назва етапу «Передано в роботу»' })
    fireEvent.change(stageInput, { target: { value: 'В роботі' } })
    fireEvent.click(
      within(stageInput.closest('form') as HTMLElement).getByRole('button', {
        name: 'Перейменувати',
      }),
    )
    await waitFor(() => expect(api.pipelines[0]?.stages[1]?.name).toBe('В роботі'))
  })

  it('удаление этапа — после подтверждения; отказ «есть открытые сделки» показан', async () => {
    const api = await renderAt('/settings/pipelines')
    await screen.findByRole('list', { name: 'Етапи воронки ALPI' })

    api.failNextWith = 'STAGE_HAS_OPEN_DEALS'
    fireEvent.click(screen.getByRole('button', { name: 'Видалити етап «Був на вебінарі»' }))
    fireEvent.click(screen.getByRole('button', { name: 'Так, видалити «Був на вебінарі»' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/відкриті угоди/)
    expect(stageNames('ALPI')).toContain('Був на вебінарі')

    fireEvent.click(screen.getByRole('button', { name: 'Видалити етап «Був на вебінарі»' }))
    fireEvent.click(screen.getByRole('button', { name: 'Так, видалити «Був на вебінарі»' }))
    await waitFor(() => expect(stageNames('ALPI')).toEqual(['Новий лід', 'Передано в роботу']))
  })

  it('отказ 409 при создании воронки не стирает введённое; после успеха форма очищается', async () => {
    const api = await renderAt('/settings/pipelines')
    const form = await screen.findByRole('form', { name: 'Нова воронка' })
    const name = within(form).getByRole('textbox', { name: 'Назва' }) as HTMLInputElement
    const code = within(form).getByRole('textbox', { name: 'Код (латиницею)' }) as HTMLInputElement
    fireEvent.change(name, { target: { value: 'Дубль' } })
    fireEvent.change(code, { target: { value: 'alpi' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Створити воронку' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Воронка з таким кодом у проєкті вже є.',
    )
    expect([name.value, code.value]).toEqual(['Дубль', 'alpi'])

    fireEvent.change(code, { target: { value: 'dubl' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Створити воронку' }))
    await screen.findByRole('list', { name: 'Етапи воронки Дубль' })
    expect(api.pipelines.map((p) => p.code)).toEqual(['alpi', 'dubl'])
    expect([name.value, code.value]).toEqual(['', ''])
  })

  it('отказ при добавлении этапа не стирает введённое название', async () => {
    const api = await renderAt('/settings/pipelines')
    const input = (await screen.findByRole('textbox', {
      name: 'Новий етап воронки ALPI',
    })) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Сплатив бронювання' } })
    api.failNextWith = 'INVALID_ORDER'
    fireEvent.click(
      within(input.closest('form') as HTMLElement).getByRole('button', { name: 'Додати' }),
    )
    await screen.findByRole('alert')
    expect(input.value).toBe('Сплатив бронювання')
    fireEvent.click(
      within(input.closest('form') as HTMLElement).getByRole('button', { name: 'Додати' }),
    )
    await waitFor(() => expect(stageNames('ALPI')).toContain('Сплатив бронювання'))
    expect(input.value).toBe('')
  })

  it('архив воронки и отметка «воронка допродажу»', async () => {
    const api = await renderAt('/settings/pipelines')
    const settings = await screen.findByRole('form', { name: 'Налаштування воронки ALPI' })
    fireEvent.click(within(settings).getByRole('checkbox', { name: 'Воронка допродажу' }))
    fireEvent.click(within(settings).getByRole('button', { name: 'Зберегти' }))
    await waitFor(() => expect(api.pipelines[0]?.isUpsell).toBe(true))

    fireEvent.click(screen.getByRole('button', { name: 'В архів' }))
    await screen.findByRole('button', { name: 'Повернути з архіву' })
    expect(api.pipelines[0]?.archivedAt).not.toBeNull()
    expect(screen.getByText(/в архіві/)).toBeTruthy()
  })

  it('без права «сделки: смотреть» — сообщение; русский язык', async () => {
    await renderAt('/settings/pipelines', { language: 'ru', api: fakePipelinesApi({ deny: true }) })
    expect(await screen.findByText('Нет права «Сделки: смотреть» в этом проекте.')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Воронки')
  })
})

describe('экран причин проигрыша', () => {
  it('группа с причинами; новая причина; архив причины; порядок групп', async () => {
    const api = await renderAt('/settings/lost-reasons')
    const reasons = await screen.findByRole('list', { name: 'Причини групи Якість ліда' })
    expect(
      within(reasons)
        .getAllByRole('textbox')
        .map((input) => (input as HTMLInputElement).value),
    ).toEqual(['Не дозвон', 'Не актуально'])

    const newReason = screen.getByRole('textbox', { name: 'Нова причина групи Якість ліда' })
    fireEvent.change(newReason, { target: { value: 'Пенсіонер' } })
    fireEvent.click(
      within(newReason.closest('form') as HTMLElement).getByRole('button', { name: 'Додати' }),
    )
    await waitFor(() => expect(api.groups[0]?.reasons.map((r) => r.name)).toContain('Пенсіонер'))

    const row = (await screen.findByRole('textbox', { name: 'Назва причини «Не дозвон»' })).closest(
      'li',
    ) as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'В архів' }))
    await waitFor(() => expect(api.groups[0]?.reasons[0]?.archivedAt).not.toBeNull())
    await within(row).findByRole('button', { name: 'Повернути з архіву' })

    const groupForm = screen.getByRole('form', { name: 'Нова група' })
    fireEvent.change(within(groupForm).getByRole('textbox', { name: 'Назва групи' }), {
      target: { value: 'Інше' },
    })
    fireEvent.click(within(groupForm).getByRole('button', { name: 'Створити групу' }))
    await screen.findByRole('list', { name: 'Причини групи Інше' })
    fireEvent.click(screen.getByRole('button', { name: 'Вище: Інше' }))
    await waitFor(() => expect(api.groups.map((g) => g.name)).toEqual(['Інше', 'Якість ліда']))
  })

  it('отказ 409 при создании группы не стирает введённое название', async () => {
    const api = await renderAt('/settings/lost-reasons')
    const form = await screen.findByRole('form', { name: 'Нова група' })
    const input = within(form).getByRole('textbox', { name: 'Назва групи' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Якість ліда' } })
    api.failNextWith = 'LOST_REASON_GROUP_NAME_TAKEN'
    fireEvent.click(within(form).getByRole('button', { name: 'Створити групу' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Група з такою назвою вже є.')
    expect(input.value).toBe('Якість ліда')
  })

  it('разделы настроек ведут на оба экрана', async () => {
    await renderAt('/settings')
    const nav = await screen.findByRole('navigation', { name: 'Розділи налаштувань' })
    expect(within(nav).getByRole('link', { name: 'Воронки' }).getAttribute('href')).toBe(
      '/p/alpi/settings/pipelines',
    )
    expect(within(nav).getByRole('link', { name: 'Причини програшу' }).getAttribute('href')).toBe(
      '/p/alpi/settings/lost-reasons',
    )
  })
})
