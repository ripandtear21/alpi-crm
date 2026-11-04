import { useRouteContext } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { LanguageSwitcher } from '../../layout/language-switcher.tsx'
import { ThemeSwitcher } from '../../layout/theme-switcher.tsx'
import type { AuthApi, AuthError } from './auth-api.ts'
import './auth.css'

/** Рамка экранов входа: название системы, язык и тема сверху, панель с формой по центру. */
export function AuthScreen({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useTranslation()
  return (
    <div className="auth-screen">
      <div className="auth-screen__top">
        <span className="auth-screen__brand">
          <span className="ui-mark" aria-hidden="true" />
          {t('appName')}
        </span>
        <div className="auth-screen__prefs">
          <LanguageSwitcher />
          <ThemeSwitcher />
        </div>
      </div>
      <main className="auth-screen__main">
        <section className="auth-card" aria-labelledby="auth-title">
          <h1 id="auth-title">{title}</h1>
          {children}
        </section>
      </main>
    </div>
  )
}

/** Сообщение об ошибке формы; читалка экрана объявляет его сразу. */
export function FormError({ message }: { message: string | null }) {
  return message ? (
    <p className="ui-notice" role="alert">
      {message}
    </p>
  ) : null
}

/** Клиент входа из контекста маршрутизатора (createAppRouter). */
export function useAuthApi(): AuthApi {
  return useRouteContext({ from: '__root__' }).auth
}

type ErrorKey =
  | 'invalidCredentials'
  | 'invalidPassword'
  | 'invalidCode'
  | 'codeExpired'
  | 'rateLimited'
  | 'banned'
  | 'failed'

/** Ключ перевода для ошибки; `invalid` у каждой формы свой. */
export function errorKey(error: AuthError, invalid: ErrorKey): `errors.${ErrorKey}` {
  switch (error) {
    case 'invalid':
      return `errors.${invalid}`
    case 'rate-limited':
      return 'errors.rateLimited'
    case 'banned':
      return 'errors.banned'
    case 'failed':
      return 'errors.failed'
  }
}
