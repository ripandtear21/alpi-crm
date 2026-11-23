import { useTranslation } from 'react-i18next'
import { LANGUAGES } from '../i18n/index.ts'

export function LanguageSwitcher() {
  const { t, i18n } = useTranslation()

  return (
    <fieldset className="ui-segmented language-switcher">
      <legend className="visually-hidden">{t('language.label')}</legend>
      {LANGUAGES.map((language) => (
        <button
          key={language}
          type="button"
          lang={language}
          title={t(`language.${language}`)}
          aria-label={t(`language.${language}`)}
          aria-pressed={i18n.resolvedLanguage === language}
          onClick={() => void i18n.changeLanguage(language)}
        >
          {language.toUpperCase()}
        </button>
      ))}
    </fieldset>
  )
}
