import { useTranslation } from 'react-i18next'
import { useCurrentProject } from './current-project.tsx'

// Переключатель проекта в шапке: список проектов, где пользователь участник. Без проектов —
// неактивный список с пояснением.
export function ProjectSwitcher() {
  const { t } = useTranslation('layout')
  const { projects, current, select } = useCurrentProject()

  return (
    <label className="app-header__project">
      <span className="app-header__project-label">{t('project.label')}</span>
      <select
        value={current?.id ?? ''}
        title={current?.name}
        disabled={!current}
        onChange={(event) => select(event.target.value)}
      >
        {current ? (
          projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))
        ) : (
          <option value="">{t('project.none')}</option>
        )}
      </select>
    </label>
  )
}
