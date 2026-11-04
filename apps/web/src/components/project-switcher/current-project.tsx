import type { ProjectSummary } from '@alpi/shared'
import type { QueryClient, QueryKey } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react'

// Текущий проект клиента (docs/adr/0001-izolyatsiya-proektov.md): интерфейс показывает данные
// одного проекта за раз. Выбор живёт в localStorage браузера; если сохранённого проекта нет
// среди доступных (участие сняли, другой пользователь), берётся первый доступный.

export const PROJECT_STORAGE_KEY = 'alpi.project'

/** Корень ключей TanStack Query для данных проекта: при смене проекта они удаляются. */
const PROJECT_QUERY_ROOT = 'project'

/**
 * Ключ запроса с данными проекта: `projectQueryKey(id, 'deals')`. id проекта в ключе — данные
 * двух проектов не попадут в одну запись кэша даже до его очистки.
 */
export function projectQueryKey(projectId: string, ...rest: unknown[]): QueryKey {
  return [PROJECT_QUERY_ROOT, projectId, ...rest]
}

export function pickProject(
  projects: ProjectSummary[],
  storedId: string | null,
): ProjectSummary | null {
  return projects.find((project) => project.id === storedId) ?? projects[0] ?? null
}

function readStoredProjectId(): string | null {
  try {
    return window.localStorage.getItem(PROJECT_STORAGE_KEY)
  } catch {
    // localStorage недоступен (приватный режим) — первый доступный проект.
    return null
  }
}

function storeProjectId(projectId: string): void {
  try {
    window.localStorage.setItem(PROJECT_STORAGE_KEY, projectId)
  } catch {
    // Не смогли запомнить — проект всё равно выбран до перезагрузки страницы.
  }
}

export interface CurrentProject {
  /** Проекты, где пользователь участник. */
  projects: ProjectSummary[]
  /** Выбранный проект; null — доступных проектов нет. */
  current: ProjectSummary | null
  select(projectId: string): void
}

const CurrentProjectContext = createContext<CurrentProject | null>(null)

export function CurrentProjectProvider({
  projects,
  queryClient,
  children,
}: {
  projects: ProjectSummary[]
  queryClient: QueryClient
  children: ReactNode
}) {
  const router = useRouter()
  const [selectedId, setSelectedId] = useState(readStoredProjectId)
  const current = pickProject(projects, selectedId)

  const select = useCallback(
    (projectId: string) => {
      if (projectId === current?.id || !projects.some((p) => p.id === projectId)) return
      // Данные прежнего проекта не должны мелькнуть в новом: кэш проекта удаляется целиком,
      // данные маршрутов загружаются заново.
      queryClient.removeQueries({ queryKey: [PROJECT_QUERY_ROOT] })
      storeProjectId(projectId)
      setSelectedId(projectId)
      void router.invalidate()
    },
    [current?.id, projects, queryClient, router],
  )

  const value = useMemo(() => ({ projects, current, select }), [projects, current, select])
  return <CurrentProjectContext.Provider value={value}>{children}</CurrentProjectContext.Provider>
}

export function useCurrentProject(): CurrentProject {
  const value = useContext(CurrentProjectContext)
  if (!value) {
    throw new Error('useCurrentProject — только внутри CurrentProjectProvider')
  }
  return value
}
