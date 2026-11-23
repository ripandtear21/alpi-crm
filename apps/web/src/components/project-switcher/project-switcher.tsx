import { useTranslation } from 'react-i18next'
import { useCurrentProject } from './current-project.tsx'

// Переключатель проекта в шапке: список проектов, где пользователь участник. Выбор меняет адрес
// (тот же раздел в другом проекте). Без проектов — неактивный список с пояснением; на адресе
// с чужим или несуществующим кодом — список без выбранного проекта.
export function ProjectSwitcher() {
  const { t } = useTranslation('layout')
  const { projects, current, select } = useCurrentProject()

  return (
    <label className="app-header__project">
      <span className="app-header__project-label">{t('project.label')}</span>
      <select
        className="ui-select ui-select--sm"
        value={current?.id ?? ''}
        title={current?.name}
        disabled={projects.length === 0}
        onChange={(event) => select(event.target.value)}
      >
        {projects.length === 0 && <option value="">{t('project.none')}</option>}
        {projects.length > 0 && !current && (
          <option value="" disabled>
            {t('project.choose')}
          </option>
        )}
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
    </label>
  )
}
