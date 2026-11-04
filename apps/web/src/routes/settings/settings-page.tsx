import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import './settings.css'

// Настройки проекта: роли, пользователи, команды, журнал действий, воронки, причины проигрыша и товары; остальные подразделы придут
// со своими тикетами.
export function SettingsPage() {
  const { t } = useTranslation('settings')
  const { t: tAudit } = useTranslation('audit')

  return (
    <section>
      <h1>{t('title')}</h1>
      <nav aria-label={t('sectionsLabel')}>
        <ul className="settings-index">
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
          <li>
            <Link to="/settings/pipelines">{t('pipelines.title')}</Link>
          </li>
          <li>
            <Link to="/settings/lost-reasons">{t('lostReasons.title')}</Link>
          </li>
          <li>
            <Link to="/settings/products">{t('products.title')}</Link>
          </li>
        </ul>
      </nav>
    </section>
  )
}
