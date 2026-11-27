import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useCurrentProject } from '../components/project-switcher/current-project.tsx'
import type { DuplicatesApi } from '../routes/duplicates/duplicates-api.ts'
import { useDuplicateCounts } from './duplicates-counter.tsx'

export const NAV_ID = 'app-nav'

export const NAV_SECTIONS = [
  { to: '/p/$code/deals', section: 'deals', label: 'nav.deals' },
  { to: '/p/$code/contacts', section: 'contacts', label: 'nav.contacts' },
  { to: '/p/$code/organizations', section: 'organizations', label: 'nav.organizations' },
  { to: '/p/$code/tasks', section: 'tasks', label: 'nav.tasks' },
  { to: '/p/$code/reports', section: 'reports', label: 'nav.reports' },
  { to: '/p/$code/settings', section: 'settings', label: 'nav.settings' },
] as const

type AppNavProps = {
  hidden: boolean
  onNavigate: () => void
  /** Пункт «Дублі» (тикет crm-intake/05) — только с правом «изменять» контакты или сделки. */
  duplicates?: DuplicatesApi | undefined
}

export function AppNav({ hidden, onNavigate, duplicates }: AppNavProps) {
  const { t } = useTranslation('layout')
  const { current } = useCurrentProject()
  const duplicatesAllowed = Boolean(useDuplicateCounts(duplicates).data)

  return (
    <nav id={NAV_ID} className="app-nav" aria-label={t('nav.label')} hidden={hidden}>
      {NAV_SECTIONS.map((section) =>
        current ? (
          <Link
            key={section.to}
            to={section.to}
            params={{ code: current.code }}
            className="app-nav__link"
            activeProps={{ className: 'is-active' }}
            onClick={onNavigate}
          >
            {t(section.label)}
          </Link>
        ) : (
          // Адрес без проекта: раздел откроется в проекте, открытом в прошлый раз.
          <Link
            key={section.to}
            to="/$"
            params={{ _splat: section.section }}
            className="app-nav__link"
            onClick={onNavigate}
          >
            {t(section.label)}
          </Link>
        ),
      )}
      {current && duplicatesAllowed && (
        <Link
          to="/p/$code/duplicates"
          params={{ code: current.code }}
          className="app-nav__link"
          activeProps={{ className: 'is-active' }}
          onClick={onNavigate}
        >
          {t('nav.duplicates')}
        </Link>
      )}
    </nav>
  )
}
