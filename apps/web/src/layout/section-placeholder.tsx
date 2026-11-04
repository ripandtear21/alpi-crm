import { useTranslation } from 'react-i18next'
import type { NAV_SECTIONS } from './app-nav.tsx'

type SectionPlaceholderProps = {
  title: (typeof NAV_SECTIONS)[number]['label']
}

// Временная страница раздела из меню: настоящие экраны придут со своими тикетами.
export function SectionPlaceholder({ title }: SectionPlaceholderProps) {
  const { t } = useTranslation('layout')

  return (
    <section>
      <h1>{t(title)}</h1>
      <p>{t('placeholder')}</p>
    </section>
  )
}
