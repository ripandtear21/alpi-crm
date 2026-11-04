import { Link, useNavigate } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
        <p className="auth-hint">{t(useBackup ? 'twoFactor.backupHint' : 'twoFactor.totpHint')}</p>
        {useBackup ? (
          <label>
            {t('twoFactor.backupLabel')}
            <input name="code" autoComplete="off" spellCheck={false} required />
          </label>
        ) : (
          <label>
            {t('twoFactor.codeLabel')}
            <input
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
        <button type="submit" className="auth-primary" disabled={pending}>
          {t('twoFactor.submit')}
        </button>
      </form>
      <div className="auth-links">
        <button
          type="button"
          className="auth-link"
          onClick={() => {
            setUseBackup((value) => !value)
            setError(null)
          }}
        >
          {t(useBackup ? 'twoFactor.useTotp' : 'twoFactor.useBackup')}
        </button>
        <Link to="/sign-in" className="auth-link">
          {t('twoFactor.restart')}
        </Link>
      </div>
    </AuthScreen>
  )
}
