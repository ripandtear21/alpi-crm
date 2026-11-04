import { type ReactNode, useEffect, useId, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from './button.tsx'
import { cx } from './cx.ts'

type DialogProps = {
  open: boolean
  /** Esc, кнопка «Закрыть», щелчок по затемнению. Закрывает родитель: open → false. */
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
    return () => {
      if (dialog.open) dialog.close()
      opener?.focus()
    }
  }, [open])

  if (!open) return null

  return (
    <dialog
      ref={ref}
      className={cx('ui-dialog', side && 'ui-dialog--side', className)}
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
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
      onClick={(event) => {
        // Щелчок по затемнению приходит на сам <dialog>, а не на его содержимое.
        if (event.target === event.currentTarget) onClose()
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
