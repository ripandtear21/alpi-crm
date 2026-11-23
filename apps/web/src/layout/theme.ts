// Тема интерфейса: светлая или тёмная (токены обеих — в styles/tokens.css, атрибут data-theme
// на <html>). Выбор живёт в localStorage браузера; без выбора — как в системе.

export const THEMES = ['light', 'dark'] as const
export type Theme = (typeof THEMES)[number]

export const THEME_STORAGE_KEY = 'alpi.theme'

function isTheme(value: unknown): value is Theme {
  return THEMES.some((theme) => theme === value)
}

const SYSTEM_DARK = '(prefers-color-scheme: dark)'

function readSavedTheme(): Theme | null {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (isTheme(stored)) return stored
  } catch {
    // localStorage недоступен (приватный режим) — берём тему системы.
  }
  return null
}

export function readStoredTheme(): Theme {
  return readSavedTheme() ?? (window.matchMedia?.(SYSTEM_DARK).matches ? 'dark' : 'light')
}

/**
 * Пока выбор не сохранён, тема идёт за системой и без перезагрузки: система сменила тему —
 * ставим её на <html> и сообщаем onChange. Возвращает отписку.
 */
export function followSystemTheme(onChange: (theme: Theme) => void): () => void {
  const query = window.matchMedia?.(SYSTEM_DARK)
  if (!query) return () => {}
  const listener = (event: MediaQueryListEvent) => {
    if (readSavedTheme()) return
    const theme: Theme = event.matches ? 'dark' : 'light'
    applyTheme(theme)
    onChange(theme)
  }
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
}

export function storeTheme(theme: Theme): void {
  applyTheme(theme)
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // Не запомнили — тема всё равно переключена до перезагрузки страницы.
  }
}
