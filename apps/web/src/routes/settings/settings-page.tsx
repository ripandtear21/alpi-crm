import type { ProjectAccess } from '@alpi/shared'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import {
  projectQueryKey,
  useCurrentProject,
  useProjectCode,
} from '../../components/project-switcher/current-project.tsx'
import { fieldsSettingsAllowed } from './fields/fields-data.ts'
import './settings.css'

// Настройки проекта: роли, пользователи, команды, журнал действий, воронки, причины проигрыша,
// товары и поля; остальные подразделы придут со своими тикетами. Пункт «Поля» — только с правом
// «поля» (тикет crm-fields/05): права пользователя — `GET /project/access`.
export function SettingsPage({
  access,
}: {
  access: (projectId: string) => Promise<ProjectAccess>
}) {
  const { t } = useTranslation('settings')
  const { t: tAudit } = useTranslation('audit')
  const { t: tLists } = useTranslation('lists')
  const { t: tFields } = useTranslation('fields-settings')
  const code = useProjectCode()
  const projectId = useCurrentProject().current?.id ?? ''
  const rights = useQuery({
    queryKey: projectQueryKey(projectId, 'access'),
    queryFn: () => access(projectId),
    retry: false,
    enabled: projectId !== '',
  })
  const fieldsAllowed = rights.data ? fieldsSettingsAllowed(rights.data.permissions) : false

  return (
    <section>
      <h1>{t('title')}</h1>
      <nav aria-label={t('sectionsLabel')}>
        <ul className="settings-index">
          <li>
            <Link to="/p/$code/settings/roles" params={{ code }}>
              {t('roles.title')}
            </Link>
          </li>
          <li>
            <Link to="/p/$code/settings/audit" params={{ code }}>
              {tAudit('title')}
            </Link>
          </li>
          <li>
            <Link to="/p/$code/settings/users" params={{ code }}>
              {t('members.title')}
            </Link>
          </li>
          <li>
            <Link to="/p/$code/settings/teams" params={{ code }}>
              {t('teams.title')}
            </Link>
          </li>
          <li>
            <Link to="/p/$code/settings/pipelines" params={{ code }}>
              {t('pipelines.title')}
            </Link>
          </li>
          <li>
            <Link to="/p/$code/settings/lost-reasons" params={{ code }}>
              {t('lostReasons.title')}
            </Link>
          </li>
          <li>
            <Link to="/p/$code/settings/products" params={{ code }}>
              {t('products.title')}
            </Link>
          </li>
          {fieldsAllowed && (
            <li>
              <Link to="/p/$code/settings/fields" params={{ code }}>
                {tFields('title')}
              </Link>
            </li>
          )}
          <li>
            <Link to="/p/$code/settings/trash" params={{ code }}>
              {tLists('trash.title')}
            </Link>
          </li>
        </ul>
      </nav>
    </section>
  )
}
