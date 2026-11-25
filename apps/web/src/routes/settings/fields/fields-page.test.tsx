import { type FieldOptionSummary, fullPermissions, type PipelineSummary } from '@alpi/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import {
  fakeProjectsApi,
  PROJECT_ALPI,
} from '../../../components/project-switcher/fake-projects-api.ts'
import { createI18n, type Language } from '../../../i18n/index.ts'
import { resources } from '../../../i18n/resources.ts'
import { createAppRouter } from '../../../router.tsx'
import { fakeAuthApi } from '../../auth/fake-auth-api.ts'
import {
  type FakeFieldsApi,
  fakeField,
  fakeFieldsApi,
  fakeId,
  GROUP_MAIN,
  PIPELINE_ALPI,
} from './fake-fields-api.ts'
import { type FieldChange, type FieldInput, FieldsApiError } from './fields-api.ts'

// Экран «Налаштування → Поля» (тикет crm-fields/05) в настоящем дереве маршрутов: вошедший
// пользователь, подставной клиент полей.

const DAY_MS = 24 * 60 * 60 * 1000
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString()

async function renderAt(
  path: '/settings' | '/settings/fields',
  { language = 'uk', api = fakeFieldsApi() }: { language?: Language; api?: FakeFieldsApi } = {},
) {
  const queryClient = new QueryClient()
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    auth: fakeAuthApi(),
    projects: fakeProjectsApi(),
    fields: api,
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

function dialog() {
  return within(screen.getByRole('dialog'))
}

function type(label: string, value: string) {
  fireEvent.change(dialog().getByRole('textbox', { name: label }), { target: { value } })
}

/** Текст подсказки или ошибки под полем формы (aria-describedby). */
function noteOf(control: HTMLElement): string {
  const id = control.getAttribute('aria-describedby') ?? ''
  return document.getElementById(id)?.textContent ?? ''
}

const callsOf = (api: FakeFieldsApi, method: string) =>
  api.calls.filter((c) => c.method === method).map((c) => c.args)

const option = (
  n: number,
  nameUk: string,
  archivedAt: string | null = null,
): FieldOptionSummary => ({
  id: fakeId(n),
  nameUk,
  nameRu: null,
  position: n - 20,
  archivedAt,
})

const optionNames = (api: FakeFieldsApi, fieldId: string) =>
  api.fieldList.find((f) => f.id === fieldId)?.options.map((o) => o.nameUk)

/** Тело первого запроса создания поля. */
const createdInput = (api: FakeFieldsApi) =>
  callsOf(api, 'createField')[0]?.[1] as FieldInput | undefined

describe('экран полей', () => {
  it('создание поля «один вариант» с тремя вариантами, обязательного с этапа воронки ALPI', async () => {
    const api = await renderAt('/settings/fields')
    fireEvent.click(await screen.findByRole('button', { name: 'Додати поле в групу «Основні»' }))
    type('Назва українською', 'Джерело ліда')
    expect((dialog().getByRole('textbox', { name: 'Код' }) as HTMLInputElement).value).toBe(
      'dzherelo_lida',
    )
    fireEvent.change(dialog().getByRole('combobox', { name: 'Тип' }), {
      target: { value: 'single_option' },
    })
    for (const _ of [1, 2, 3]) {
      fireEvent.click(dialog().getByRole('button', { name: 'Додати варіант' }))
    }
    type('Варіант 1 українською', 'Реклама')
    type('Варіант 2 українською', 'Вебінар')
    type('Варіант 3 українською', 'Рекомендація')
    type('Варіант 2 російською', 'Вебинар')
    fireEvent.click(dialog().getByRole('radio', { name: 'З етапу' }))
    fireEvent.change(dialog().getByRole('combobox', { name: 'Етап у воронці «ALPI»' }), {
      target: { value: fakeId(902) },
    })
    fireEvent.click(dialog().getByRole('checkbox', { name: 'Часто фільтрують' }))
    fireEvent.click(dialog().getByRole('button', { name: 'Створити поле' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(callsOf(api, 'createField')).toEqual([
      [
        PROJECT_ALPI.id,
        {
          nameUk: 'Джерело ліда',
          nameRu: null,
          groupId: GROUP_MAIN.id,
          type: 'single_option',
          pipelines: 'all',
          required: {
            mode: 'stages',
            stages: [{ pipelineId: PIPELINE_ALPI.id, stageId: fakeId(902) }],
          },
          isImportant: false,
          isFrequentlyFiltered: true,
          options: [
            { nameUk: 'Реклама', nameRu: null },
            { nameUk: 'Вебінар', nameRu: 'Вебинар' },
            { nameUk: 'Рекомендація', nameRu: null },
          ],
        },
      ],
    ])
    const group = await screen.findByRole('list', { name: 'Поля групи «Основні»' })
    const row = within(group).getByText('Джерело ліда').closest('li') as HTMLElement
    expect(within(row).getByText('dzherelo_lida')).toBeTruthy()
    expect(within(row).getByText('Один варіант')).toBeTruthy()
    expect(within(row).getByText("обов'язкове")).toBeTruthy()
    expect(within(row).getByText('Індекс будується')).toBeTruthy()
  })

  it('«Виграно» в правиле «з етапу» отправляется как этап null', async () => {
    const api = await renderAt('/settings/fields')
    fireEvent.click(await screen.findByRole('button', { name: 'Додати поле в групу «Основні»' }))
    type('Назва українською', 'Номер договору')
    fireEvent.click(dialog().getByRole('radio', { name: 'З етапу' }))
    fireEvent.click(dialog().getByRole('button', { name: 'Створити поле' }))
    // Без этапа — ошибка у обязательности, запроса нет.
    expect(await dialog().findByText('Оберіть етап хоча б для однієї воронки.')).toBeTruthy()
    expect(callsOf(api, 'createField')).toEqual([])
    fireEvent.change(dialog().getByRole('combobox', { name: 'Етап у воронці «ALPI»' }), {
      target: { value: 'won' },
    })
    fireEvent.click(dialog().getByRole('button', { name: 'Створити поле' }))
    await waitFor(() => expect(callsOf(api, 'createField')).toHaveLength(1))
    expect(createdInput(api)?.required).toEqual({
      mode: 'stages',
      stages: [{ pipelineId: PIPELINE_ALPI.id, stageId: null }],
    })
  })

  it('у поля с данными код заблокирован, в списке типов — только безопасные смены', async () => {
    const api = fakeFieldsApi({
      fields: [
        fakeField({ id: fakeId(10), nameUk: 'Бюджет', type: 'number', firstValueAt: daysAgo(3) }),
      ],
    })
    await renderAt('/settings/fields', { api })
    fireEvent.click(await screen.findByRole('button', { name: 'Змінити поле «Бюджет»' }))
    const code = dialog().getByRole('textbox', { name: 'Код' }) as HTMLInputElement
    expect(code.disabled).toBe(true)
    expect(noteOf(code)).toBe('Код не змінюється: у поля вже є значення.')
    const typeSelect = dialog().getByRole('combobox', { name: 'Тип' })
    expect(
      within(typeSelect)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Текст', 'Число'])
    fireEvent.change(typeSelect, { target: { value: 'text' } })
    expect(noteOf(typeSelect)).toContain('йде у фоні')
    fireEvent.click(dialog().getByRole('button', { name: 'Зберегти' }))
    await waitFor(() =>
      expect(callsOf(api, 'updateField')).toEqual([
        [PROJECT_ALPI.id, fakeId(10), { type: 'text' }],
      ]),
    )
  })

  it('варианты существующего поля: переименование, архив, новый и порядок', async () => {
    const api = fakeFieldsApi({
      fields: [
        fakeField({
          id: fakeId(15),
          nameUk: 'Канал',
          type: 'single_option',
          options: [option(21, 'Сайт'), option(22, 'Факс', daysAgo(5)), option(23, 'Пошта')],
        }),
      ],
    })
    await renderAt('/settings/fields', { api })
    fireEvent.click(await screen.findByRole('button', { name: 'Змінити поле «Канал»' }))
    // Без изменений — ни одного запроса.
    fireEvent.click(dialog().getByRole('button', { name: 'Зберегти' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.calls).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: 'Змінити поле «Канал»' }))
    expect(dialog().getByText('Факс')).toBeTruthy()
    type('Варіант 1 українською', 'Сайт школи')
    fireEvent.click(dialog().getByRole('button', { name: 'Архівувати варіант «Пошта»' }))
    fireEvent.click(dialog().getByRole('button', { name: 'Додати варіант' }))
    type('Варіант 2 українською', 'Телеграм')
    fireEvent.click(dialog().getByRole('button', { name: 'Варіант «Телеграм» вище' }))
    fireEvent.click(dialog().getByRole('button', { name: 'Зберегти' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const created = api.fieldList[0]?.options.find((o) => o.nameUk === 'Телеграм')?.id
    expect(api.calls.map((c) => [c.method, ...c.args.slice(2)])).toEqual([
      ['createOption', { nameUk: 'Телеграм', nameRu: null }],
      ['updateOption', fakeId(21), { nameUk: 'Сайт школи' }],
      ['updateOption', fakeId(23), { archived: true }],
      ['reorderOptions', [created, fakeId(21), fakeId(22), fakeId(23)]],
    ])
  })

  describe('частичное сохранение вариантов', () => {
    const channel = () =>
      fakeFieldsApi({
        fields: [
          fakeField({
            id: fakeId(17),
            nameUk: 'Канал',
            type: 'single_option',
            options: [option(21, 'Сайт')],
          }),
        ],
      })

    async function addOptionsAndSave(api: FakeFieldsApi, rename: boolean) {
      await renderAt('/settings/fields', { api })
      fireEvent.click(await screen.findByRole('button', { name: 'Змінити поле «Канал»' }))
      if (rename) type('Назва українською', 'Канал продажу')
      fireEvent.click(dialog().getByRole('button', { name: 'Додати варіант' }))
      fireEvent.click(dialog().getByRole('button', { name: 'Додати варіант' }))
      type('Варіант 2 українською', 'A')
      type('Варіант 3 українською', 'B')
      fireEvent.click(dialog().getByRole('button', { name: 'Зберегти' }))
    }

    it('второй вариант не создан: сказано, что осталось; повтор досохраняет без дублей', async () => {
      const api = channel()
      api.failOn = [{ method: 'createOption', nth: 2, error: new FieldsApiError(500, '') }]
      await addOptionsAndSave(api, true)
      expect(
        await dialog().findByText(
          'Поле збережено частково: не збереглися варіанти «B». Натисніть «Зберегти», щоб зберегти решту.',
        ),
      ).toBeTruthy()
      // Экран за диалогом уже показывает сохранённое название.
      expect(await screen.findByText('Канал продажу')).toBeTruthy()

      fireEvent.click(dialog().getByRole('button', { name: 'Зберегти' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(callsOf(api, 'updateField')).toEqual([
        [PROJECT_ALPI.id, fakeId(17), { nameUk: 'Канал продажу' }],
      ])
      expect(callsOf(api, 'createOption').map((args) => args[2])).toEqual([
        { nameUk: 'A', nameRu: null },
        { nameUk: 'B', nameRu: null },
        { nameUk: 'B', nameRu: null },
      ])
      expect(optionNames(api, fakeId(17))).toEqual(['Сайт', 'A', 'B'])
    })

    it('ответ на создание варианта потерялся: повтор узнаёт его на сервере и не создаёт снова', async () => {
      const api = channel()
      api.failOn = [
        {
          method: 'createOption',
          nth: 1,
          error: new TypeError('Failed to fetch'),
          afterWrite: true,
        },
      ]
      await addOptionsAndSave(api, false)
      expect(await dialog().findByText('Не вдалося зберегти. Спробуйте ще раз.')).toBeTruthy()
      expect(optionNames(api, fakeId(17))).toEqual(['Сайт', 'A'])

      fireEvent.click(dialog().getByRole('button', { name: 'Зберегти' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(callsOf(api, 'createOption').map((args) => args[2])).toEqual([
        { nameUk: 'A', nameRu: null },
        { nameUk: 'B', nameRu: null },
      ])
      expect(optionNames(api, fakeId(17))).toEqual(['Сайт', 'A', 'B'])
    })

    it('поле не перечиталось — сказано, что сохранено частично и что делать', async () => {
      const api = channel()
      api.failOn = [{ method: 'createOption', nth: 1, error: new FieldsApiError(500, '') }]
      api.field = async () => {
        throw new TypeError('Failed to fetch')
      }
      await addOptionsAndSave(api, true)
      expect(
        await dialog().findByText(
          'Поле збережено частково, але перевірити, що саме збереглося, не вдалося. Закрийте вікно й відкрийте поле знову.',
        ),
      ).toBeTruthy()
    })

    it('не сохранился только порядок — так и сказано', async () => {
      const api = fakeFieldsApi({
        fields: [
          fakeField({
            id: fakeId(17),
            nameUk: 'Канал',
            type: 'single_option',
            options: [option(21, 'Сайт'), option(22, 'Пошта')],
          }),
        ],
      })
      api.failOn = [{ method: 'reorderOptions', nth: 1, error: new FieldsApiError(500, '') }]
      await renderAt('/settings/fields', { api })
      fireEvent.click(await screen.findByRole('button', { name: 'Змінити поле «Канал»' }))
      type('Варіант 1 українською', 'Сайт школи')
      fireEvent.click(dialog().getByRole('button', { name: 'Варіант «Пошта» вище' }))
      fireEvent.click(dialog().getByRole('button', { name: 'Зберегти' }))
      expect(
        await dialog().findByText(
          'Поле збережено частково: не збережено порядок варіантів. Натисніть «Зберегти», щоб зберегти його.',
        ),
      ).toBeTruthy()
      fireEvent.click(dialog().getByRole('button', { name: 'Зберегти' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(callsOf(api, 'updateOption')).toHaveLength(1)
      expect(optionNames(api, fakeId(17))).toEqual(['Пошта', 'Сайт школи'])
    })
  })

  it('повторная отправка формы, пока идёт сохранение, — без второго запроса', async () => {
    const api = fakeFieldsApi({ fields: [fakeField({ id: fakeId(20), nameUk: 'Регіон' })] })
    await renderAt('/settings/fields', { api })
    fireEvent.click(await screen.findByRole('button', { name: 'Змінити поле «Регіон»' }))
    type('Назва українською', 'Область')
    const form = screen.getByRole('dialog').querySelector('form') as HTMLFormElement
    fireEvent.submit(form)
    fireEvent.submit(form)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(callsOf(api, 'updateField')).toHaveLength(1)
  })

  it('отказ сервера на изменение поля — у своего поля формы, без «збережено частково»', async () => {
    const api = fakeFieldsApi({ fields: [fakeField({ id: fakeId(18), nameUk: 'Місто' })] })
    await renderAt('/settings/fields', { api })
    fireEvent.click(await screen.findByRole('button', { name: 'Змінити поле «Місто»' }))
    type('Код', 'city')
    api.failNext = new FieldsApiError(422, 'FIELD_CODE_TAKEN', { path: 'code' })
    fireEvent.click(dialog().getByRole('button', { name: 'Зберегти' }))
    const code = dialog().getByRole('textbox', { name: 'Код' })
    await waitFor(() =>
      expect(noteOf(code)).toBe('Код уже зайнятий іншим полем (зокрема архівним).'),
    )
    expect(dialog().queryByText(/Не вдалося зберегти|збережено частково/)).toBeNull()
  })

  it('правило «з етапу» архивной воронки не стирается правкой поля', async () => {
    const old: PipelineSummary = {
      id: fakeId(950),
      code: 'old',
      name: 'Стара',
      position: 2,
      isUpsell: false,
      archivedAt: daysAgo(30),
      stages: [{ id: fakeId(951), pipelineId: fakeId(950), name: 'Договір', position: 1 }],
    }
    const oldRule = { pipelineId: old.id, stageId: fakeId(951) }
    const api = fakeFieldsApi({
      pipelines: [PIPELINE_ALPI, old],
      fields: [
        fakeField({
          id: fakeId(19),
          nameUk: 'Договір',
          required: {
            mode: 'stages',
            stages: [oldRule, { pipelineId: PIPELINE_ALPI.id, stageId: fakeId(902) }],
          },
        }),
      ],
    })
    await renderAt('/settings/fields', { api })
    const lastChange = () => callsOf(api, 'updateField').at(-1)?.[2] as FieldChange | undefined
    const save = async () => {
      fireEvent.click(dialog().getByRole('button', { name: 'Зберегти' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    }

    // Переименование: требование не менялось — не отправляется.
    fireEvent.click(await screen.findByRole('button', { name: 'Змінити поле «Договір»' }))
    expect(dialog().queryByRole('combobox', { name: 'Етап у воронці «Стара»' })).toBeNull()
    type('Назва українською', 'Договір підписано')
    await save()
    expect(lastChange()).toEqual({ nameUk: 'Договір підписано' })

    // Другой этап в видимой воронке: правило архивной воронки уходит вместе с ним.
    fireEvent.click(await screen.findByRole('button', { name: 'Змінити поле «Договір підписано»' }))
    fireEvent.change(dialog().getByRole('combobox', { name: 'Етап у воронці «ALPI»' }), {
      target: { value: 'won' },
    })
    await save()
    expect(lastChange()).toEqual({
      required: {
        mode: 'stages',
        stages: [{ pipelineId: PIPELINE_ALPI.id, stageId: null }, oldRule],
      },
    })

    // Поле видно только в ALPI: правило архивной воронки снимается, иначе сервер откажет.
    fireEvent.click(await screen.findByRole('button', { name: 'Змінити поле «Договір підписано»' }))
    fireEvent.click(dialog().getByRole('radio', { name: 'У вибраних воронках' }))
    fireEvent.click(dialog().getByRole('checkbox', { name: 'ALPI' }))
    await save()
    expect(lastChange()).toEqual({
      pipelines: [PIPELINE_ALPI.id],
      required: { mode: 'stages', stages: [{ pipelineId: PIPELINE_ALPI.id, stageId: null }] },
    })
  })

  it('ответ сервера «код занят» показан у поля кода', async () => {
    const api = await renderAt('/settings/fields')
    fireEvent.click(await screen.findByRole('button', { name: 'Додати поле в групу «Основні»' }))
    type('Назва українською', 'Місто')
    type('Код', 'city')
    api.failNext = new FieldsApiError(422, 'FIELD_CODE_TAKEN', { path: 'code' })
    fireEvent.click(dialog().getByRole('button', { name: 'Створити поле' }))
    const code = dialog().getByRole('textbox', { name: 'Код' })
    await waitFor(() =>
      expect(noteOf(code)).toBe('Код уже зайнятий іншим полем (зокрема архівним).'),
    )
    expect(code.getAttribute('aria-invalid')).toBe('true')
    expect(createdInput(api)?.code).toBe('city')
  })

  it('«Видалити остаточно» недоступно раньше 30 дней и требует ввести код', async () => {
    const api = fakeFieldsApi({
      fields: [
        fakeField({
          id: fakeId(11),
          nameUk: 'Свіже',
          code: 'fresh',
          firstValueAt: daysAgo(60),
          archivedAt: daysAgo(10),
        }),
        fakeField({
          id: fakeId(12),
          nameUk: 'Старе',
          code: 'old_field',
          firstValueAt: daysAgo(90),
          archivedAt: daysAgo(40),
        }),
      ],
    })
    await renderAt('/settings/fields', { api })
    fireEvent.click(await screen.findByRole('tab', { name: 'Архів' }))
    const fresh = (await screen.findByRole('button', {
      name: 'Видалити поле «Свіже» остаточно',
    })) as HTMLButtonElement
    expect(fresh.disabled).toBe(true)
    expect(screen.getByText(/^Остаточне видалення — з /)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Видалити поле «Старе» остаточно' }))
    const confirm = dialog().getByRole('button', {
      name: 'Видалити остаточно',
    }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    type('Код поля', 'old')
    expect(confirm.disabled).toBe(true)
    type('Код поля', 'old_field')
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    await waitFor(() =>
      expect(callsOf(api, 'removeField')).toEqual([[PROJECT_ALPI.id, fakeId(12)]]),
    )
    expect(await screen.findByText('Видаляється…')).toBeTruthy()
  })

  it('удаление поля с данными — в архив, «Повернути» возвращает', async () => {
    const api = fakeFieldsApi({
      fields: [fakeField({ id: fakeId(13), nameUk: 'Сума договору', firstValueAt: daysAgo(1) })],
    })
    await renderAt('/settings/fields', { api })
    fireEvent.click(await screen.findByRole('button', { name: 'Видалити поле «Сума договору»' }))
    expect(
      dialog().getByText(
        'У поля є значення — його буде перенесено в архів. Звідти поле можна повернути.',
      ),
    ).toBeTruthy()
    expect(dialog().queryByText(/буде видалено одразу/)).toBeNull()
    fireEvent.click(dialog().getByRole('button', { name: 'Видалити' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(await screen.findByText('У групі ще немає полів.')).toBeTruthy()

    fireEvent.click(await screen.findByRole('tab', { name: 'Архів' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Повернути поле «Сума договору»' }))
    await waitFor(() =>
      expect(callsOf(api, 'restoreField')).toEqual([[PROJECT_ALPI.id, fakeId(13)]]),
    )
  })

  it('удаление поля без данных — сразу и насовсем: в архиве его нет', async () => {
    const api = fakeFieldsApi({
      fields: [fakeField({ id: fakeId(16), nameUk: 'Чернетка' })],
    })
    await renderAt('/settings/fields', { api })
    fireEvent.click(await screen.findByRole('button', { name: 'Видалити поле «Чернетка»' }))
    expect(dialog().getByText('У поля немає значень — його буде видалено одразу.')).toBeTruthy()
    expect(dialog().queryByText(/перенесено в архів/)).toBeNull()
    fireEvent.click(dialog().getByRole('button', { name: 'Видалити' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(callsOf(api, 'removeField')).toEqual([[PROJECT_ALPI.id, fakeId(16)]])
    expect(await screen.findByText('У групі ще немає полів.')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: 'Архів' }))
    expect(await screen.findByText('В архіві немає полів.')).toBeTruthy()
    expect(screen.queryByText('Чернетка')).toBeNull()
  })

  it('обязательное поле в группе, скрытой у роли, — предупреждение в диалоге', async () => {
    const api = fakeFieldsApi()
    const manager = api.roleList.find((r) => r.templateKey === 'manager')
    if (!manager) throw new Error('нет шаблона менеджера')
    manager.permissions.fieldGroups[GROUP_MAIN.id] = 'hidden'
    await renderAt('/settings/fields', { api })
    fireEvent.click(await screen.findByRole('button', { name: 'Додати поле в групу «Основні»' }))
    expect(dialog().queryByText(/не зможуть перевести угоду далі/)).toBeNull()
    fireEvent.click(dialog().getByRole('radio', { name: 'Завжди' }))
    expect(dialog().getByText(/не зможуть перевести угоду далі/).textContent).toContain(
      manager.name,
    )
  })

  it('доступ ролей к группе: выбор сохраняется в правах роли, у администратора выбора нет', async () => {
    const api = await renderAt('/settings/fields')
    fireEvent.click(await screen.findByRole('button', { name: 'Доступ ролей до групи «Основні»' }))
    const manager = api.roleList.find((r) => r.templateKey === 'manager')
    const admin = api.roleList.find((r) => r.isAdmin)
    if (!manager || !admin) throw new Error('нет ролей')
    const select = await dialog().findByRole('combobox', { name: `Доступ ролі «${manager.name}»` })
    expect(dialog().queryByRole('combobox', { name: `Доступ ролі «${admin.name}»` })).toBeNull()
    fireEvent.change(select, { target: { value: 'read' } })
    await waitFor(() => expect(callsOf(api, 'updateRole')).toHaveLength(1))
    const [, roleId, input] = callsOf(api, 'updateRole')[0] as [
      string,
      string,
      { permissions: { fieldGroups: Record<string, string> } },
    ]
    expect(roleId).toBe(manager.id)
    expect(input.permissions.fieldGroups[GROUP_MAIN.id]).toBe('read')
  })

  it('группа: создание с русским названием; пустую можно удалить', async () => {
    const api = await renderAt('/settings/fields')
    fireEvent.click(await screen.findByRole('button', { name: 'Нова група' }))
    type('Назва українською', 'Оплата')
    type('Назва російською', 'Оплата (ru)')
    fireEvent.click(dialog().getByRole('button', { name: 'Створити групу' }))
    await screen.findByRole('heading', { name: 'Оплата', level: 2 })
    expect(callsOf(api, 'createGroup')).toEqual([
      [PROJECT_ALPI.id, { entity: 'deal', nameUk: 'Оплата', nameRu: 'Оплата (ru)' }],
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Видалити групу «Оплата»' }))
    fireEvent.click(dialog().getByRole('button', { name: 'Видалити' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Оплата' })).toBeNull())
  })

  it('по-русски: вкладки, названия и типы на русском', async () => {
    const api = fakeFieldsApi({
      fields: [fakeField({ id: fakeId(14), nameUk: 'Місто', nameRu: 'Город', type: 'address' })],
    })
    await renderAt('/settings/fields', { language: 'ru', api })
    expect(await screen.findByRole('tab', { name: 'Сделки' })).toBeTruthy()
    expect(await screen.findByRole('heading', { name: 'Основные', level: 2 })).toBeTruthy()
    expect(screen.getByText('Город')).toBeTruthy()
    expect(screen.getByText('Адрес')).toBeTruthy()
  })
})

describe('право «поля»', () => {
  const withoutFields = () => {
    const permissions = fullPermissions()
    permissions.actions.fields = []
    return fakeFieldsApi({ permissions })
  }

  it('с правом пункт «Поля» есть в настройках', async () => {
    await renderAt('/settings')
    expect(await screen.findByRole('link', { name: 'Поля' })).toBeTruthy()
  })

  it('без права пункта «Поля» в настройках нет', async () => {
    await renderAt('/settings', { api: withoutFields() })
    await screen.findByRole('link', { name: 'Ролі та права' })
    // Даём правам прийти: с правом ссылка к этому времени уже есть (тест выше).
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByRole('link', { name: 'Поля' })).toBeNull()
  })

  it('без права прямая ссылка — «немає доступу»', async () => {
    await renderAt('/settings/fields', { api: withoutFields() })
    expect(await screen.findByRole('heading', { name: 'Немає доступу' })).toBeTruthy()
    expect(screen.queryByRole('tab', { name: 'Угоди' })).toBeNull()
  })
})

describe('переводы экрана полей', () => {
  function entries(value: unknown, prefix = ''): [string, unknown][] {
    if (typeof value !== 'object' || value === null) return [[prefix, value]]
    return Object.entries(value).flatMap(([key, nested]) =>
      entries(nested, prefix ? `${prefix}.${key}` : key),
    )
  }

  it('все строки экрана есть в uk и ru и не пустые', () => {
    const uk = entries(resources.uk['fields-settings'])
    const ru = entries(resources.ru['fields-settings'])
    expect(ru.map(([key]) => key).sort()).toEqual(uk.map(([key]) => key).sort())
    for (const [key, value] of [...uk, ...ru]) {
      expect(typeof value === 'string' && value.trim() !== '', key).toBe(true)
    }
  })
})
