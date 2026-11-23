import { PROJECT_HEADER, type ProjectSummary } from '@alpi/shared'
import { QueryClient } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render, screen, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import { createI18n, type Language } from '../../i18n/index.ts'
import { createAppRouter } from '../../router.tsx'
import { fakeAuthApi } from '../../routes/auth/fake-auth-api.ts'
import { PROJECT_STORAGE_KEY } from './current-project.tsx'
import { fakeProjectsApi, PROJECT_ALPI, PROJECT_FRANCH } from './fake-projects-api.ts'
import { createProjectsApi, projectHeaders } from './projects-api.ts'

// Переключатель проекта в настоящем дереве маршрутов (вошедший пользователь, подставные API).

async function renderApp(
  projects: ProjectSummary[] = [PROJECT_ALPI, PROJECT_FRANCH],
  language: Language = 'uk',
) {
  const queryClient = new QueryClient()
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: ['/deals'] }),
    auth: fakeAuthApi(),
    projects: fakeProjectsApi(projects),
    queryClient,
  })
  render(
    <I18nextProvider i18n={createI18n(language)}>
      <RouterProvider router={router} />
    </I18nextProvider>,
  )
  await screen.findByRole('heading', { level: 1 })
  const switcher = within(screen.getByRole('banner')).getByRole('combobox', {
    name: language === 'uk' ? 'Проєкт' : 'Проект',
  }) as HTMLSelectElement
  return { queryClient, switcher }
}

describe('переключатель проекта', () => {
  it('показывает проекты пользователя и по умолчанию выбирает первый', async () => {
    const { switcher } = await renderApp()
    expect(
      within(switcher)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['AI-школа ALPI', 'Франч'])
    expect(switcher.value).toBe(PROJECT_ALPI.id)
    expect(switcher.disabled).toBe(false)
  })

  it('открывается на проекте, выбранном в прошлый раз', async () => {
    window.localStorage.setItem(PROJECT_STORAGE_KEY, PROJECT_FRANCH.id)
    const { switcher } = await renderApp()
    expect(switcher.value).toBe(PROJECT_FRANCH.id)
  })

  it('сохранённый проект больше не доступен — берёт первый доступный', async () => {
    window.localStorage.setItem(PROJECT_STORAGE_KEY, '00000000-0000-4000-8000-0000000000ff')
    const { switcher } = await renderApp([PROJECT_FRANCH])
    expect(switcher.value).toBe(PROJECT_FRANCH.id)
  })

  it('без доступных проектов — неактивный список с пояснением, uk и ru', async () => {
    const uk = await renderApp([])
    expect(uk.switcher.disabled).toBe(true)
    expect(uk.switcher.textContent).toBe('Немає доступних проєктів')
    expect(window.localStorage.getItem(PROJECT_STORAGE_KEY)).toBeNull()
  })

  it('по-русски — русские подпись и пояснение', async () => {
    const { switcher } = await renderApp([], 'ru')
    expect(switcher.textContent).toBe('Нет доступных проектов')
  })
})

describe('запросы проектов', () => {
  it('список проектов — GET /api/projects', async () => {
    const calls: string[] = []
    const api = createProjectsApi(async (input) => {
      calls.push(String(input))
      return Response.json([PROJECT_ALPI])
    })
    expect(await api.list()).toEqual([PROJECT_ALPI])
    expect(calls).toEqual(['/api/projects'])
  })

  it('запрос в контексте проекта несёт заголовок X-Project-Id', () => {
    const headers = projectHeaders(PROJECT_ALPI.id, { accept: 'application/json' })
    expect(headers.get(PROJECT_HEADER)).toBe(PROJECT_ALPI.id)
    expect(headers.get('accept')).toBe('application/json')
  })
})
