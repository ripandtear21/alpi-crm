import { PROJECT_HEADER, type ProjectSummary } from '@alpi/shared'

// Запросы проектов к API (apps/api/src/projects). Снаружи API живёт по /api: префикс срезают
// прокси Vite и Caddy.

export interface ProjectsApi {
  /** Проекты, в которых состоит вошедший пользователь. */
  list(): Promise<ProjectSummary[]>
}

export function createProjectsApi(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): ProjectsApi {
  return {
    async list() {
      const res = await fetchImpl('/api/projects', { credentials: 'same-origin' })
      if (!res.ok) {
        throw new Error(`Проекты не загружены: API ответил ${res.status}`)
      }
      return (await res.json()) as ProjectSummary[]
    },
  }
}

/**
 * Заголовки запроса в контексте проекта: API выполняет его внутри проекта из X-Project-Id и
 * только для участника (apps/api/src/middleware/project-context.ts).
 */
export function projectHeaders(projectId: string, headers?: HeadersInit): Headers {
  const result = new Headers(headers)
  result.set(PROJECT_HEADER, projectId)
  return result
}
