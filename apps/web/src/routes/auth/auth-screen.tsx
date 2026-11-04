import { useRouteContext } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { LanguageSwitcher } from '../../layout/language-switcher.tsx'
import type { AuthApi, AuthError } from './auth-api.ts'
// Общие цвета и шрифт — из каркаса интерфейса.
import '../../layout/app-layout.css'
import './auth.css'

/** Рамка экранов входа: карточка по центру, название системы и переключатель языка. */
export function AuthScreen({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useTranslation()
  return (
    <div className="auth-screen">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-card__top">
          <span className="auth-card__brand">{t('appName')}</span>
          <LanguageSwitcher />
        </div>
        <h1 id="auth-title">{title}</h1>
        {children}
      </section>
    </div>
  )
}

/** Сообщение об ошибке формы; читалка экрана объявляет его сразу. */
export function FormError({ message }: { message: string | null }) {
  return message ? (
    <p className="auth-error" role="alert">
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
