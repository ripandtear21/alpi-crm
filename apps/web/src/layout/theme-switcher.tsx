import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { followSystemTheme, readStoredTheme, storeTheme, THEMES, type Theme } from './theme.ts'

/** Переключатель «светлая / тёмная» в шапке: значки, название — в подсказке и для читалки. */
export function ThemeSwitcher() {
  const { t } = useTranslation('layout')
  const [theme, setTheme] = useState(readStoredTheme)

  useEffect(() => followSystemTheme(setTheme), [])

  return (
    <fieldset className="ui-segmented theme-switcher">
      <legend className="visually-hidden">{t('theme.label')}</legend>
      {THEMES.map((option) => (
        <button
          key={option}
          type="button"
          aria-label={t(`theme.${option}`)}
          title={t(`theme.${option}`)}
          aria-pressed={theme === option}
          onClick={() => {
            storeTheme(option)
            setTheme(option)
          }}
        >
          <ThemeIcon theme={option} />
        </button>
      ))}
    </fieldset>
  )
}

function ThemeIcon({ theme }: { theme: Theme }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      {theme === 'light' ? (
        <>
          <circle cx="8" cy="8" r="3" />
          <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
        </>
      ) : (
        <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z" strokeLinejoin="round" />
      )}
    </svg>
  )
}
