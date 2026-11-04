import { createContext, type ReactNode, use, useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

type Tone = 'info' | 'error'
type ToastItem = { id: number; text: string; tone: Tone }
type ShowToast = (text: string, options?: { tone?: Tone }) => void

/** Сколько уведомление видно, если его не закрыли раньше. */
const TOAST_DURATION_MS = 5000

const ToastContext = createContext<ShowToast | null>(null)

/** Область уведомлений внизу слева: одна на приложение, вежливая live-область. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(0)

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((toast) => toast.id !== id))
  }, [])

  const show = useCallback<ShowToast>(
    (text, options) => {
      nextId.current += 1
      const id = nextId.current
      setToasts((list) => [...list, { id, text, tone: options?.tone ?? 'info' }])
      window.setTimeout(() => dismiss(id), TOAST_DURATION_MS)
    },
    [dismiss],
  )

  return (
    <ToastContext value={show}>
      {children}
      <div className="ui-toasts" aria-live="polite" aria-relevant="additions">
        {toasts.map((toast) => (
          <div key={toast.id} className="ui-toast" data-tone={toast.tone}>
            <span className="ui-toast__text">{toast.text}</span>
            <button
              type="button"
              className="ui-button ui-button--quiet ui-button--sm"
              aria-label={t('ui.closeToast')}
              title={t('ui.closeToast')}
              onClick={() => dismiss(toast.id)}
            >
              <span aria-hidden="true">✕</span>
            </button>
          </div>
        ))}
      </div>
    </ToastContext>
  )
}

/** Показать уведомление: toast('Сохранено') или toast('Не сохранилось', { tone: 'error' }). */
export function useToast(): ShowToast {
  const show = use(ToastContext)
  if (!show) throw new Error('useToast вызван вне ToastProvider')
  return show
}
