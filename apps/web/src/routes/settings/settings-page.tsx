import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

// Настройки проекта: пока один подраздел — роли; остальные придут со своими тикетами.
export function SettingsPage() {
  const { t } = useTranslation('settings')

  return (
    <section>
      <h1>{t('title')}</h1>
      <nav aria-label={t('sectionsLabel')}>
        <ul>
          <li>
            <Link to="/settings/roles">{t('roles.title')}</Link>
          </li>
        </ul>
      </nav>
    </section>
  )
}
