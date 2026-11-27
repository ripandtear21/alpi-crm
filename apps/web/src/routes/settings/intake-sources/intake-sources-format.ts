import { useTranslation } from 'react-i18next'
import { RolesApiError } from '../roles-api.ts'

// Общее для частей экрана «Джерела» (тикет crm-intake/07): дата по языку интерфейса и текст
// отказа API по его коду.

export function useDateFormat(timeStyle: 'short' | 'medium' = 'short') {
  const { i18n } = useTranslation()
  const format = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short', timeStyle })
  return (value: string) => format.format(new Date(value))
}

export function useErrorText() {
  const { t } = useTranslation('intake-sources')
  return (error: unknown) => {
    const code = error instanceof RolesApiError ? error.code : ''
    return code ? t(`errors.${code}`, { defaultValue: t('errors.unknown') }) : t('errors.unknown')
  }
}
