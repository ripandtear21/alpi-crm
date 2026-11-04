import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

type Tone = 'info' | 'error'
type ToastItem = { id: number; text: string; tone: Tone }
type ShowToast = (text: string, options?: { tone?: Tone }) => void
/** Принять уведомления в открытый модальный диалог; вернёт функцию, которая отпускает их. */
type AddToastLayer = (layer: HTMLElement) => () => void

/** Сколько уведомление видно, если его не закрыли раньше и не держат под указателем или фокусом. */
export const TOAST_DURATION_MS = 5000

const ToastContext = createContext<ShowToast | null>(null)
const ToastLayerContext = createContext<AddToastLayer | null>(null)

/**
 * Область уведомлений внизу слева: одна на приложение, вежливая live-область.
 *
 * Модальный диалог делает недоступным всё, что не лежит внутри него, — и для мыши, и для
 * читалки, даже если поверх нарисовано. Поэтому, пока диалог открыт, область живёт внутри
 * самого верхнего из них (диалоги сообщают о себе через useToastLayer), а чтобы её не обрезала
 * прокрутка диалога, она выводится в верхний слой браузера как popover="manual".
 *
 * Узел области один на всё время жизни провайдера: React рисует уведомления в него порталом,
 * а между страницей и диалогами его переносим мы. Область, вставленная на страницу сразу
 * с текстом, читалкой не объявляется — объявляется то, что добавили в уже стоящую.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [region] = useState(createRegion)
  // Открытые модальные диалоги снизу вверх. Не состояние: область переносится сразу, в том же
  // коммите React, где закрывается диалог, а не после следующей отрисовки.
  const layers = useRef<HTMLElement[]>([])
  // Куда область возвращается без диалогов; null — провайдер снят, переносить некуда.
  const home = useRef<HTMLElement | null>(null)
  const nextId = useRef(0)

  const place = useCallback(() => {
    const host = layers.current.at(-1) ?? home.current
    if (!host) return
    if (region.parentNode !== host) host.appendChild(region)
    // Перенос закрывает popover; показанный заново, он встаёт над только что открытым диалогом.
    showInTopLayer(region)
  }, [region])

  useLayoutEffect(() => {
    home.current = document.body
    place()
    return () => {
      home.current = null
      region.remove()
    }
  }, [region, place])

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((toast) => toast.id !== id))
  }, [])

  const show = useCallback<ShowToast>((text, options) => {
    nextId.current += 1
    const id = nextId.current
    setToasts((list) => [...list, { id, text, tone: options?.tone ?? 'info' }])
  }, [])

  const addLayer = useCallback<AddToastLayer>(
    (layer) => {
      layers.current = [...layers.current, layer]
      place()
      // Повторный вызов ничего не меняет: диалог отпускает область и до удаления, и после.
      return () => {
        layers.current = layers.current.filter((item) => item !== layer)
        place()
      }
    },
    [place],
  )

  return (
    <ToastContext value={show}>
      <ToastLayerContext value={addLayer}>
        {children}
        {/* После children: в коммите, где диалог закрывается, область уходит из него раньше,
            чем в неё добавится уведомление. */}
        {createPortal(
          toasts.map((toast) => <Toast key={toast.id} toast={toast} onDismiss={dismiss} />),
          region,
        )}
      </ToastLayerContext>
    </ToastContext>
  )
}

function createRegion(): HTMLDivElement {
  const region = document.createElement('div')
  region.className = 'ui-toasts'
  region.setAttribute('popover', 'manual')
  region.setAttribute('aria-live', 'polite')
  region.setAttribute('aria-relevant', 'additions')
  return region
}

function showInTopLayer(element: HTMLDivElement) {
  if (typeof element.showPopover !== 'function') return
  try {
    if (!element.matches(':popover-open')) element.showPopover()
  } catch {
    // Браузер без popover: область остаётся обычным блоком с position: fixed.
  }
}

/**
 * Одно уведомление со своим таймером. Пока над ним указатель или внутри фокус, таймер стоит;
 * после — отсчёт начинается заново. Закрыли раньше — таймер снимается вместе с уведомлением.
 */
function Toast({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: number) => void }) {
  const { t } = useTranslation()
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const paused = hovered || focused

  useEffect(() => {
    if (paused) return
    const timer = window.setTimeout(() => onDismiss(toast.id), TOAST_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [paused, onDismiss, toast.id])

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: указатель и фокус только держат таймер, действия у уведомления нет — оно у кнопки «Закрыть»
    <div
      className="ui-toast"
      data-tone={toast.tone}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
      }}
    >
      <span className="ui-toast__text">{toast.text}</span>
      <button
        type="button"
        className="ui-button ui-button--quiet ui-button--sm"
        aria-label={t('ui.closeToast')}
        title={t('ui.closeToast')}
        onClick={() => onDismiss(toast.id)}
      >
        <span aria-hidden="true">✕</span>
      </button>
    </div>
  )
}

/** Показать уведомление: toast('Сохранено') или toast('Не сохранилось', { tone: 'error' }). */
export function useToast(): ShowToast {
  const show = use(ToastContext)
  if (!show) throw new Error('useToast вызван вне ToastProvider')
  return show
}

/** Для модальных диалогов: принять уведомления к себе, пока открыт. Вне ToastProvider — null. */
export function useToastLayer(): AddToastLayer | null {
  return use(ToastLayerContext)
}
