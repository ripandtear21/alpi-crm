import { useNavigate } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TwoFactorSetup } from './auth-api.ts'
import { AuthScreen, errorKey, FormError, useAuthApi } from './auth-screen.tsx'
import { QrCode } from './qr-code.tsx'

// Настройка 2FA после первого входа. Пока она не завершена, API отвечает 403 на всё остальное,
// поэтому каркас интерфейса сюда и отправляет. Шаги: пароль → QR и резервные коды → код.
export function TwoFactorSetupPage() {
  const { t } = useTranslation('auth')
  const auth = useAuthApi()
  const navigate = useNavigate()
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function run(action: () => Promise<void>) {
    setPending(true)
    setError(null)
    try {
      await action()
    } catch {
      setError(t('errors.failed'))
    } finally {
      setPending(false)
    }
  }

  function onStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const password = String(new FormData(event.currentTarget).get('password'))
    return run(async () => {
      const result = await auth.enableTwoFactor(password)
      if (result.ok) setSetup(result)
      else setError(t(errorKey(result.error, 'invalidPassword')))
    })
  }

  function onVerify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const code = String(new FormData(event.currentTarget).get('code'))
    return run(async () => {
      const result = await auth.verifyTotp(code)
      if (result.ok) await navigate({ to: '/' })
      else setError(t(errorKey(result.error, 'invalidCode')))
    })
  }

  function onSignOut() {
    return run(async () => {
      await auth.signOut()
      await navigate({ to: '/sign-in' })
    })
  }

  return (
    <AuthScreen title={t('setup.title')}>
      {setup === null ? (
        <form className="auth-form" onSubmit={onStart}>
          <p className="auth-hint">{t('setup.intro')}</p>
          <label>
            {t('password')}
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          <FormError message={error} />
          <button type="submit" className="auth-primary" disabled={pending}>
            {t('setup.start')}
          </button>
        </form>
      ) : (
        <form className="auth-form" onSubmit={onVerify}>
          <p className="auth-hint">{t('setup.scan')}</p>
          <QrCode value={setup.totpURI} label={t('setup.qrLabel')} />
          <p className="auth-hint">
            {t('setup.manual')} <code className="auth-secret">{setup.secret}</code>
          </p>
          <h2>{t('setup.backupTitle')}</h2>
          <p className="auth-hint">{t('setup.backupHint')}</p>
          <ul className="auth-backup-codes" aria-label={t('setup.backupTitle')}>
            {setup.backupCodes.map((code) => (
              <li key={code}>
                <code>{code}</code>
              </li>
            ))}
          </ul>
          <p className="auth-hint">{t('setup.verifyHint')}</p>
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
          <FormError message={error} />
          <button type="submit" className="auth-primary" disabled={pending}>
            {t('setup.submit')}
          </button>
        </form>
      )}
      <div className="auth-links">
        <button type="button" className="auth-link" onClick={onSignOut} disabled={pending}>
          {t('setup.signOut')}
        </button>
      </div>
    </AuthScreen>
  )
}
