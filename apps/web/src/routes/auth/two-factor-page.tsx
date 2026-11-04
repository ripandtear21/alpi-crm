import { Link, useNavigate } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/button.tsx'
import { AuthScreen, errorKey, FormError, useAuthApi } from './auth-screen.tsx'

// Второй шаг входа: код из приложения аутентификации или резервный код.
export function TwoFactorPage() {
  const { t } = useTranslation('auth')
  const auth = useAuthApi()
  const navigate = useNavigate()
  const [useBackup, setUseBackup] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const code = String(new FormData(event.currentTarget).get('code'))
    setPending(true)
    setError(null)
    try {
      const result = useBackup ? await auth.verifyBackupCode(code) : await auth.verifyTotp(code)
      if (!result.ok) {
        // Неверный код и истёкший шаг входа API различает только текстом — показываем общее.
        setError(t(errorKey(result.error, 'codeExpired')))
        return
      }
      await navigate({ to: '/' })
    } catch {
      setError(t('errors.failed'))
    } finally {
      setPending(false)
    }
  }

  return (
    <AuthScreen title={t('twoFactor.title')}>
      <form className="auth-form" onSubmit={onSubmit} key={useBackup ? 'backup' : 'totp'}>
        <p className="auth-lead">{t(useBackup ? 'twoFactor.backupHint' : 'twoFactor.totpHint')}</p>
        {useBackup ? (
          <label className="ui-field__label">
            {t('twoFactor.backupLabel')}
            <input
              className="ui-input"
              name="code"
              autoComplete="off"
              spellCheck={false}
              required
            />
          </label>
        ) : (
          <label className="ui-field__label">
            {t('twoFactor.codeLabel')}
            <input
              className="ui-input ui-input--code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
            />
          </label>
        )}
        <FormError message={error} />
        <Button type="submit" variant="primary" busy={pending}>
          {t('twoFactor.submit')}
        </Button>
      </form>
      <div className="auth-links">
        <Button
          variant="quiet"
          className="auth-link"
          onClick={() => {
            setUseBackup((value) => !value)
            setError(null)
          }}
        >
          {t(useBackup ? 'twoFactor.useTotp' : 'twoFactor.useBackup')}
        </Button>
        <Link to="/sign-in" className="auth-link">
          {t('twoFactor.restart')}
        </Link>
      </div>
    </AuthScreen>
  )
}
