import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

export const NAV_ID = 'app-nav'

export const NAV_SECTIONS = [
  { to: '/deals', label: 'nav.deals' },
  { to: '/contacts', label: 'nav.contacts' },
  { to: '/organizations', label: 'nav.organizations' },
  { to: '/tasks', label: 'nav.tasks' },
  { to: '/reports', label: 'nav.reports' },
  { to: '/settings', label: 'nav.settings' },
] as const

type AppNavProps = {
  hidden: boolean
  onNavigate: () => void
}

export function AppNav({ hidden, onNavigate }: AppNavProps) {
  const { t } = useTranslation('layout')

  return (
    <nav id={NAV_ID} className="app-nav" aria-label={t('nav.label')} hidden={hidden}>
      {NAV_SECTIONS.map((section) => (
        <Link
          key={section.to}
          to={section.to}
          className="app-nav__link"
          activeProps={{ className: 'is-active' }}
          onClick={onNavigate}
        >
          {t(section.label)}
        </Link>
      ))}
    </nav>
  )
}
