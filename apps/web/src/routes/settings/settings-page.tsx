import { can, type ProjectAccess } from '@alpi/shared'
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
// товары, поля, ключи API, вебхуки и источники регистраций; остальные подразделы придут со
// своими тикетами. Пункт «Поля» — только с правом «поля» (тикет crm-fields/05), пункты «Вебхуки»
// (тикет crm-api/07) и «Джерела» (тикет crm-intake/07) — с правом «інтеграції: дивитися»: права
// пользователя — `GET /project/access`.
export function SettingsPage({
  access,
}: {
  access: (projectId: string) => Promise<ProjectAccess>
}) {
  const { t } = useTranslation('settings')
  const { t: tAudit } = useTranslation('audit')
  const { t: tLists } = useTranslation('lists')
  const { t: tFields } = useTranslation('fields-settings')
  const { t: tSources } = useTranslation('intake-sources')
  const code = useProjectCode()
  const projectId = useCurrentProject().current?.id ?? ''
  const rights = useQuery({
    queryKey: projectQueryKey(projectId, 'access'),
    queryFn: () => access(projectId),
    retry: false,
    enabled: projectId !== '',
  })
  const fieldsAllowed = rights.data ? fieldsSettingsAllowed(rights.data.permissions) : false
  const integrationsAllowed = rights.data
    ? can(rights.data.permissions, 'integrations', 'view')
    : false

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
          <li>
            <Link to="/p/$code/settings/api-keys" params={{ code }}>
              {t('apiKeys.title')}
            </Link>
          </li>
          {integrationsAllowed && (
            <li>
              <Link to="/p/$code/settings/webhooks" params={{ code }}>
                {t('webhooks.title')}
              </Link>
            </li>
          )}
          {integrationsAllowed && (
            <li>
              <Link to="/p/$code/settings/intake-sources" params={{ code }}>
                {tSources('title')}
              </Link>
            </li>
          )}
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
