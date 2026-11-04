import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

// Настройки проекта: роли, пользователи, команды и журнал действий; остальные подразделы придут
// со своими тикетами.
export function SettingsPage() {
  const { t } = useTranslation('settings')
  const { t: tAudit } = useTranslation('audit')

  return (
    <section>
      <h1>{t('title')}</h1>
      <nav aria-label={t('sectionsLabel')}>
        <ul>
          <li>
            <Link to="/settings/roles">{t('roles.title')}</Link>
          </li>
          <li>
            <Link to="/settings/audit">{tAudit('title')}</Link>
          </li>
          <li>
            <Link to="/settings/users">{t('members.title')}</Link>
          </li>
          <li>
            <Link to="/settings/teams">{t('teams.title')}</Link>
          </li>
        </ul>
      </nav>
    </section>
  )
}
