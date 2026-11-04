import 'i18next'
import type { defaultNS, resources } from './resources.ts'

// Ключи переводов проверяются при компиляции: t('layout:nav.deals') — да, опечатка — ошибка.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: typeof defaultNS
    resources: (typeof resources)['uk']
  }
}
