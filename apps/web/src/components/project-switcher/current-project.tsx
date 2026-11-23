import type { ProjectSummary } from '@alpi/shared'
import type { QueryClient, QueryKey } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo } from 'react'

// Текущий проект клиента (docs/adr/0001-izolyatsiya-proektov.md): интерфейс показывает данные
// одного проекта за раз. Проект — в адресе экрана: `/p/<код проекта>/…` (тикет crm-deals/15),
// поэтому ссылка на запись открывает её в нужном проекте, а обновление страницы остаётся в нём.
// Последний открытый проект запоминается в localStorage: туда ведут старые адреса без проекта.

export const PROJECT_STORAGE_KEY = 'alpi.project'

/** Корень ключей TanStack Query для данных проекта: данные прежнего проекта удаляются при смене. */
const PROJECT_QUERY_ROOT = 'project'

/**
 * Ключ запроса с данными проекта: `projectQueryKey(id, 'deals')`. id проекта в ключе — данные
 * двух проектов не попадут в одну запись кэша даже до его очистки.
 */
export function projectQueryKey(projectId: string, ...rest: unknown[]): QueryKey {
  return [PROJECT_QUERY_ROOT, projectId, ...rest]
}

/** Адрес экрана проекта: `projectHref('alpi', '/deals/…')` → `/p/alpi/deals/…`. */
export function projectHref(code: string, path = ''): string {
  return `/p/${encodeURIComponent(code)}${path}`
}

/** Проект, куда ведёт адрес без проекта: выбранный в прошлый раз, если он ещё доступен, или первый. */
export function pickProject(
  projects: ProjectSummary[],
  storedId: string | null,
): ProjectSummary | null {
  return projects.find((project) => project.id === storedId) ?? projects[0] ?? null
}

export function readStoredProjectId(): string | null {
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
    // Не смогли запомнить — старые адреса поведут в первый проект.
  }
}

// Части адреса, которые принадлежат записи проекта: при смене проекта переключателем экран
// записи сменяется своим разделом — запись другого проекта всё равно «немає доступу».
const RECORD_PATH = /^\/(deals|contacts|organizations)\/(?!list(?:\/|$))[^/]+/

/**
 * Куда ведёт переключатель: тот же раздел в другом проекте. Экран записи — её раздел, условия
 * в адресе (воронка, фильтр) не переносятся: id воронок и этапов у каждого проекта свои.
 */
export function switchProjectHref(pathname: string, code: string): string {
  const rest = pathname.replace(/^\/p\/[^/]+/, '')
  const record = RECORD_PATH.exec(rest)
  return projectHref(code, record ? `/${record[1]}` : rest)
}

export interface CurrentProject {
  /** Проекты, где пользователь участник. */
  projects: ProjectSummary[]
  /** Проект из адреса; null — адрес без проекта или с кодом, которого у пользователя нет. */
  current: ProjectSummary | null
  /** Переключатель в шапке: тот же раздел в другом проекте (меняет адрес). */
  select(projectId: string): void
}

const CurrentProjectContext = createContext<CurrentProject | null>(null)

export function CurrentProjectProvider({
  projects,
  code,
  queryClient,
  children,
}: {
  projects: ProjectSummary[]
  /** Код проекта из адреса (`/p/<код>/…`); undefined — адрес без проекта. */
  code: string | undefined
  queryClient: QueryClient
  children: ReactNode
}) {
  const router = useRouter()
  const current = projects.find((project) => project.code === code) ?? null
  const currentId = current?.id

  // Вошли в проект — по ссылке или переключателем: данные других проектов удаляются из кэша
  // целиком. После отрисовки нового проекта: экраны прежнего уже сняты и не перечитают удалённое.
  useEffect(() => {
    if (currentId === undefined) return
    storeProjectId(currentId)
    queryClient.removeQueries({
      predicate: (query) =>
        query.queryKey[0] === PROJECT_QUERY_ROOT && query.queryKey[1] !== currentId,
    })
  }, [currentId, queryClient])

  const select = useCallback(
    (projectId: string) => {
      const next = projects.find((p) => p.id === projectId)
      if (!next || next.id === currentId) return
      void router.navigate({
        href: switchProjectHref(router.state.location.pathname, next.code),
      })
    },
    [currentId, projects, router],
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

/**
 * Код проекта из адреса — для ссылок экрана проекта: `<Link to="/p/$code/…" params={{ code }}>`.
 * Экраны проекта рисуются только для известного проекта (router.tsx, ProjectScreen).
 */
export function useProjectCode(): string {
  const { current } = useCurrentProject()
  if (!current) throw new Error('useProjectCode — только на экранах проекта /p/<код>/…')
  return current.code
}
