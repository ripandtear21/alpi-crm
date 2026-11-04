import { useNavigate } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/button.tsx'
import { AuthScreen, errorKey, FormError, useAuthApi } from './auth-screen.tsx'

/** Минимальная длина пароля — как на сервере (apps/api/src/auth/auth.ts). */
const MIN_PASSWORD_LENGTH = 12

// Первый вход с временным паролем (учётную запись создал администратор проекта): сначала
// новый пароль, затем настройка 2FA. Пока пароль не сменён, API пускает только сюда и к выходу.
export function ChangePasswordPage() {
  const { t } = useTranslation('auth')
  const auth = useAuthApi()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const current = String(form.get('current'))
    const next = String(form.get('next'))
    if (next.length < MIN_PASSWORD_LENGTH) {
      setError(t('changePassword.tooShort', { min: MIN_PASSWORD_LENGTH }))
      return
    }
    if (next === current) {
      setError(t('changePassword.unchanged'))
      return
    }
    if (next !== String(form.get('confirm'))) {
      setError(t('changePassword.mismatch'))
      return
    }
    setPending(true)
    setError(null)
    try {
      const result = await auth.changePassword(current, next)
      if (!result.ok) {
        setError(t(errorKey(result.error, 'invalidPassword')))
        return
      }
      await navigate({ to: '/two-factor-setup' })
    } catch {
      setError(t('errors.failed'))
    } finally {
      setPending(false)
    }
  }

  return (
    <AuthScreen title={t('changePassword.title')}>
      <p>{t('changePassword.intro')}</p>
      <form className="auth-form" onSubmit={onSubmit}>
        <label className="ui-field__label">
          {t('changePassword.current')}
          <input
            className="ui-input"
            name="current"
            type="password"
            autoComplete="current-password"
            required
          />
        </label>
        <label className="ui-field__label">
          {t('changePassword.next')}
          <input
            className="ui-input"
            name="next"
            type="password"
            autoComplete="new-password"
            required
          />
        </label>
        <label className="ui-field__label">
          {t('changePassword.confirm')}
          <input
            className="ui-input"
            name="confirm"
            type="password"
            autoComplete="new-password"
            required
          />
        </label>
        <FormError message={error} />
        <Button type="submit" variant="primary" busy={pending}>
          {t('changePassword.submit')}
        </Button>
      </form>
    </AuthScreen>
  )
}
