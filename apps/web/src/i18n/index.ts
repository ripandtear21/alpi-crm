import i18next, { type i18n } from 'i18next'
import { initReactI18next } from 'react-i18next'
import { defaultNS, namespaces, resources } from './resources.ts'

export const LANGUAGES = ['uk', 'ru'] as const
export type Language = (typeof LANGUAGES)[number]
export const DEFAULT_LANGUAGE: Language = 'uk'

// Пока у пользователя нет настроек на сервере, выбранный язык живёт в localStorage браузера.
export const LANGUAGE_STORAGE_KEY = 'alpi.language'

export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.some((language) => language === value)
}

export function readStoredLanguage(): Language {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY)
    return isLanguage(stored) ? stored : DEFAULT_LANGUAGE
  } catch {
    // localStorage бывает недоступен (приватный режим, запрет cookie) — тогда язык по умолчанию.
    return DEFAULT_LANGUAGE
  }
}

function storeLanguage(language: Language): void {
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language)
  } catch {
    // Не смогли запомнить — язык всё равно переключён до перезагрузки страницы.
  }
}

// Отдельный экземпляр на каждый вызов: приложение создаёт один, тесты — свой на каждый тест.
export function createI18n(language: Language = readStoredLanguage()): i18n {
  const instance = i18next.createInstance()
  instance.use(initReactI18next)
  instance.on('languageChanged', (changed) => {
    if (isLanguage(changed)) {
      storeLanguage(changed)
      document.documentElement.lang = changed
    }
  })
  // Ресурсы встроены в сборку, поэтому инициализация синхронная: первый рендер уже с текстами.
  void instance.init({
    lng: language,
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: LANGUAGES,
    resources,
    ns: namespaces,
    defaultNS,
    interpolation: { escapeValue: false },
    initAsync: false,
  })
  return instance
}
