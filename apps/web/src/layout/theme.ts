// Тема интерфейса: светлая или тёмная (токены обеих — в styles/tokens.css, атрибут data-theme
// на <html>). Выбор живёт в localStorage браузера; без выбора — как в системе.

export const THEMES = ['light', 'dark'] as const
export type Theme = (typeof THEMES)[number]

export const THEME_STORAGE_KEY = 'alpi.theme'

function isTheme(value: unknown): value is Theme {
  return THEMES.some((theme) => theme === value)
}

export function readStoredTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (isTheme(stored)) return stored
  } catch {
    // localStorage недоступен (приватный режим) — берём тему системы.
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
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
