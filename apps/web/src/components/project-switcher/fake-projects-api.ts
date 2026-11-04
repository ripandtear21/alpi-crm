import type { ProjectSummary } from '@alpi/shared'
import type { ProjectsApi } from './projects-api.ts'

// Подставной клиент проектов для тестов: список задаёт тест.

export const PROJECT_ALPI: ProjectSummary = {
  id: '00000000-0000-4000-8000-00000000000a',
  code: 'alpi',
  name: 'AI-школа ALPI',
}

export const PROJECT_FRANCH: ProjectSummary = {
  id: '00000000-0000-4000-8000-00000000000b',
  code: 'franch',
  name: 'Франч',
}

export function fakeProjectsApi(
  projects: ProjectSummary[] = [PROJECT_ALPI, PROJECT_FRANCH],
): ProjectsApi {
  return { list: async () => projects }
}
