import { type ReactNode, useState } from 'react'
import { AppHeader } from './app-header.tsx'
import { AppNav } from './app-nav.tsx'
import { MOBILE_MEDIA_QUERY, useMediaQuery } from './use-media-query.ts'
import './app-layout.css'

// Каркас всех экранов: шапка сверху, левое меню, справа — содержимое раздела.
// На телефоне меню свёрнуто и открывается кнопкой в шапке поверх содержимого.
export function AppLayout({ children }: { children: ReactNode }) {
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
      <AppHeader
        menuToggle={
          isMobile ? { open: menuOpen, onToggle: () => setMenuOpen((open) => !open) } : null
        }
      />
      <div className="app-layout__body">
        <AppNav hidden={!navOpen} onNavigate={() => setMenuOpen(false)} />
        <main className="app-layout__main">{children}</main>
      </div>
    </div>
  )
}
