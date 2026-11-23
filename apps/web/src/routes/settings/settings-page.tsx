import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useProjectCode } from '../../components/project-switcher/current-project.tsx'
import './settings.css'

// Настройки проекта: роли, пользователи, команды, журнал действий, воронки, причины проигрыша и товары; остальные подразделы придут
// со своими тикетами.
export function SettingsPage() {
  const { t } = useTranslation('settings')
  const { t: tAudit } = useTranslation('audit')
  const { t: tLists } = useTranslation('lists')
  const code = useProjectCode()

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
            <Link to="/p/$code/settings/trash" params={{ code }}>
              {tLists('trash.title')}
            </Link>
          </li>
        </ul>
      </nav>
    </section>
  )
}
