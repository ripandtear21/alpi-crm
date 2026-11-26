import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SearchApi } from '../components/search-bar/search-api.ts'
import { AppHeader } from './app-header.tsx'
import { AppNav } from './app-nav.tsx'
import { MOBILE_MEDIA_QUERY, useMediaQuery } from './use-media-query.ts'
import { WebhookAlertBanner } from './webhook-alert-banner.tsx'
import type { WebhookAlertsApi } from './webhook-alerts-api.ts'
import './app-layout.css'

// Каркас всех экранов: шапка сверху, левое меню, справа — содержимое раздела.
// На телефоне меню свёрнуто и открывается кнопкой в шапке поверх содержимого. Под шапкой —
// предупреждение об отключённых адресах событий (тикет crm-api/06), если передан его клиент.
export function AppLayout({
  children,
  search,
  webhookAlerts,
}: {
  children: ReactNode
  search: SearchApi
  webhookAlerts?: WebhookAlertsApi | undefined
}) {
  const { t } = useTranslation('layout')
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY)
  const [menuOpen, setMenuOpen] = useState(false)
  // При смене «телефон ↔ широкий экран» меню снова свёрнуто, а не открыто с прошлого раза
  // (сброс состояния во время рендера — приём из документации React вместо useEffect).
  const [prevIsMobile, setPrevIsMobile] = useState(isMobile)
  if (prevIsMobile !== isMobile) {
    setPrevIsMobile(isMobile)
    setMenuOpen(false)
  }

  const navOpen = !isMobile || menuOpen

  return (
    <div className="app-layout" data-mobile={isMobile}>
      <a className="skip" href="#main">
        {t('skip')}
      </a>
      <AppHeader
        search={search}
        menuToggle={
          isMobile ? { open: menuOpen, onToggle: () => setMenuOpen((open) => !open) } : null
        }
      />
      {webhookAlerts && <WebhookAlertBanner api={webhookAlerts} />}
      <div className="app-layout__body">
        <AppNav hidden={!navOpen} onNavigate={() => setMenuOpen(false)} />
        <main id="main" className="app-layout__main" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  )
}
