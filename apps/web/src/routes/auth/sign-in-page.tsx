import { useNavigate } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AuthScreen, errorKey, FormError, useAuthApi } from './auth-screen.tsx'

// Первый шаг входа: email и пароль. Дальше — код 2FA или, если 2FA ещё нет, её настройка
// (туда отправит проверка доступа на главной).
export function SignInPage() {
  const { t } = useTranslation('auth')
  const auth = useAuthApi()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    setError(null)
    try {
      const result = await auth.signIn(String(form.get('email')), String(form.get('password')))
      if (!result.ok) {
        setError(t(errorKey(result.error, 'invalidCredentials')))
        return
      }
      await navigate({ to: result.twoFactor ? '/sign-in/two-factor' : '/' })
    } catch {
      setError(t('errors.failed'))
    } finally {
      setPending(false)
    }
  }

  return (
    <AuthScreen title={t('signIn.title')}>
      <form className="auth-form" onSubmit={onSubmit}>
        <label>
          {t('email')}
          <input name="email" type="email" autoComplete="username" required />
        </label>
        <label>
          {t('password')}
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <FormError message={error} />
        <button type="submit" className="auth-primary" disabled={pending}>
          {t('signIn.submit')}
        </button>
      </form>
    </AuthScreen>
  )
}
