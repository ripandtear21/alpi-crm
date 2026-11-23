import { type MouseEvent, type ReactNode, useCallback, useEffect, useId, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from './button.tsx'
import { cx } from './cx.ts'
import { useToastLayer } from './toast.tsx'

type DialogProps = {
  open: boolean
  /** Esc, кнопка «Закрыть», щелчок по затемнению вне рамки. Закрывает родитель: open → false. */
  onClose: () => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  className?: string
}

/**
 * Модальный диалог на нативном <dialog>: браузер сам делает остальную страницу недоступной
 * и держит Tab внутри. Esc закрывает, фокус возвращается туда, откуда диалог открыли.
 */
export function Dialog(props: DialogProps) {
  return <DialogFrame {...props} side={false} />
}

/** Боковая панель: тот же диалог, прижатый к правому краю на всю высоту. */
export function SidePanel(props: DialogProps) {
  return <DialogFrame {...props} side />
}

/**
 * Сколько событий close ещё придёт на узел от закрытий самой очистки эффекта, а не браузера.
 * По узлу, а не в ref компонента: событие снятого со страницы узла до React не доходит, и счёт
 * уходит вместе с узлом, не задевая следующий открытый диалог.
 */
const ownCloses = new WeakMap<HTMLDialogElement, number>()

/** Событие пришло на сам <dialog> и точка за пределами его рамки — то есть на затемнение. */
function isOnBackdrop(event: MouseEvent<HTMLDialogElement>): boolean {
  if (event.target !== event.currentTarget) return false
  const box = event.currentTarget.getBoundingClientRect()
  return (
    event.clientX < box.left ||
    event.clientX > box.right ||
    event.clientY < box.top ||
    event.clientY > box.bottom
  )
}

function DialogFrame({
  open,
  onClose,
  title,
  children,
  footer,
  className,
  side,
}: DialogProps & { side: boolean }) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  // Нажатие началось на затемнении: только тогда щелчок закрывает.
  const pressedOnBackdrop = useRef(false)
  const addToastLayer = useToastLayer()
  const releaseToasts = useRef<(() => void) | undefined>(undefined)

  // Закрывая диалог, React убирает <dialog> со страницы раньше, чем запускает очистку useEffect,
  // и область уведомлений ушла бы вместе с ним. Очистка ref-колбэка идёт до удаления узла —
  // здесь область и отпускаем, чтобы она осталась на странице тем же узлом.
  //
  // Под <StrictMode> (main.tsx) React 19 у только что вставленного <dialog> отсоединяет ref и
  // присоединяет снова, а эффект ниже повторно не запускает: диалог открыт, а область уже
  // отпущена. Поэтому ref, присоединённый к уже открытому диалогу, забирает её обратно.
  const attach = useCallback(
    (node: HTMLDialogElement | null) => {
      ref.current = node
      if (node?.open) releaseToasts.current = addToastLayer?.(node)
      return () => {
        releaseToasts.current?.()
        releaseToasts.current = undefined
        ref.current = null
      }
    },
    [addToastLayer],
  )

  useEffect(() => {
    const dialog = ref.current
    if (!open || !dialog) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!dialog.open) dialog.showModal()
    // Браузер сам ставит фокус в диалог; это страховка для сред, где showModal его не двигает.
    if (!dialog.contains(document.activeElement)) {
      const first = dialog.querySelector<HTMLElement>(
        '[autofocus], button, input, select, textarea',
      )
      ;(first ?? dialog).focus()
    }
    // Остальная страница под модальным диалогом недоступна — уведомления переезжают в него.
    // После showModal: так область встаёт в верхнем слое над диалогом, а не под ним.
    releaseToasts.current = addToastLayer?.(dialog)
    return () => {
      releaseToasts.current?.()
      releaseToasts.current = undefined
      // Своё закрытие (под StrictMode после него диалог тут же открывается снова) — не повод
      // звать onClose: его событие close обработчик ниже пропускает.
      if (dialog.open) {
        ownCloses.set(dialog, (ownCloses.get(dialog) ?? 0) + 1)
        dialog.close()
      }
      opener?.focus()
    }
  }, [open, addToastLayer])

  if (!open) return null

  return (
    <dialog
      ref={attach}
      className={cx('ui-dialog', side && 'ui-dialog--side', className)}
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        // Esc, который уже обработал вложенный элемент (меню, подсказки поиска), закрывает
        // только его: они отменяют действие по умолчанию, и диалог остаётся открытым.
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }
      }}
      // Запрос закрытия от браузера (Esc, «назад» на Android): закрываем через родителя,
      // чтобы состояние open не разошлось с тем, что видно.
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      // Браузер закрыл диалог сам, без cancel (Esc, <form method="dialog">): родитель узнаёт,
      // иначе open останется true при закрытом диалоге. Событие своего закрытия из очистки
      // эффекта пропускаем — в happy-dom оно приходит сразу, в браузере позже, когда диалог
      // уже снова открыт.
      onClose={(event) => {
        const pending = ownCloses.get(event.currentTarget) ?? 0
        if (pending > 0) {
          ownCloses.set(event.currentTarget, pending - 1)
          return
        }
        onClose()
      }}
      // Затемнение — это тоже сам <dialog>, как и пустое место внутри него (у высокой боковой
      // панели), поэтому смотрим на координаты: щелчок вне рамки диалога. И нажатие, и отпускание
      // должны прийти на затемнение — выделение текста, отпущенное над ним, не закрывает.
      onPointerDown={(event) => {
        pressedOnBackdrop.current = isOnBackdrop(event)
      }}
      onClick={(event) => {
        const pressed = pressedOnBackdrop.current
        pressedOnBackdrop.current = false
        if (pressed && isOnBackdrop(event)) onClose()
      }}
    >
      <div className="ui-dialog__head">
        <h2 id={titleId} className="ui-dialog__title">
          {title}
        </h2>
        <Button
          variant="quiet"
          icon
          aria-label={t('ui.close')}
          title={t('ui.close')}
          onClick={onClose}
        >
          <span aria-hidden="true">✕</span>
        </Button>
      </div>
      <div className="ui-dialog__body">{children}</div>
      {footer && <div className="ui-dialog__foot">{footer}</div>}
    </dialog>
  )
}
