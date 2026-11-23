import { useTranslation } from 'react-i18next'
import { ProjectSwitcher } from '../components/project-switcher/project-switcher.tsx'
import { NAV_ID } from './app-nav.tsx'
import { LanguageSwitcher } from './language-switcher.tsx'
import { ThemeSwitcher } from './theme-switcher.tsx'

type AppHeaderProps = {
  // Кнопка меню есть только на телефоне: на широком экране меню видно всегда.
  menuToggle: { open: boolean; onToggle: () => void } | null
}

// Шапка: переключатель проекта; поиск, уведомления и профиль пока только занимают свои места —
// их поведение добавят тикеты поиска, уведомлений и входа.
export function AppHeader({ menuToggle }: AppHeaderProps) {
  const { t } = useTranslation(['layout', 'common'])

  return (
    <header className="app-header">
      {menuToggle && (
        <button
          type="button"
          className="ui-button ui-button--secondary ui-button--icon app-header__menu"
          aria-controls={NAV_ID}
          aria-expanded={menuToggle.open}
          aria-label={t(menuToggle.open ? 'menu.close' : 'menu.open')}
          onClick={menuToggle.onToggle}
        >
          <MenuIcon open={menuToggle.open} />
        </button>
      )}
      <span className="app-header__brand">
        <span className="ui-mark" aria-hidden="true" />
        {t('common:appName')}
      </span>
      <ProjectSwitcher />
      <input
        type="search"
        className="ui-input app-header__search"
        aria-label={t('search.label')}
        placeholder={t('search.placeholder')}
        disabled
      />
      <div className="app-header__prefs">
        <LanguageSwitcher />
        <ThemeSwitcher />
      </div>
      <button
        type="button"
        className="ui-button ui-button--quiet ui-button--icon app-header__icon"
        aria-label={t('notifications')}
        title={t('notifications')}
        disabled
      >
        <BellIcon />
      </button>
      <button
        type="button"
        className="app-header__avatar"
        aria-label={t('profile')}
        title={t('profile')}
        disabled
      >
        <span aria-hidden="true">?</span>
      </button>
    </header>
  )
}

function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none">
      <path
        d={open ? 'M3.5 3.5l9 9M12.5 3.5l-9 9' : 'M2.5 4h11M2.5 8h11M2.5 12h11'}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

function BellIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path
        d="M6 9a6 6 0 1 1 12 0c0 4 1.5 6 2.5 7h-17C4.5 15 6 13 6 9Zm4 10a2 2 0 0 0 4 0"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
