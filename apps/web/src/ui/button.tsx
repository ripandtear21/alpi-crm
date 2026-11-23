import type { ComponentPropsWithRef } from 'react'
import { cx } from './cx.ts'

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'quiet'
export type ButtonSize = 'md' | 'sm'

type ButtonLook = {
  variant?: ButtonVariant | undefined
  size?: ButtonSize | undefined
  /** Кнопка-значок: квадратная, текст для читалки — в aria-label. */
  icon?: boolean | undefined
  className?: string | undefined
}

/** Классы кнопки — и для <Button>, и для ссылки, которая выглядит как кнопка. */
export function buttonClass({
  variant = 'secondary',
  size = 'md',
  icon = false,
  className,
}: ButtonLook) {
  return cx(
    'ui-button',
    `ui-button--${variant}`,
    size === 'sm' && 'ui-button--sm',
    icon && 'ui-button--icon',
    className,
  )
}

type ButtonProps = ComponentPropsWithRef<'button'> &
  ButtonLook & {
    /** Действие выполняется: кнопка остаётся видимой, но повторно не нажимается. */
    busy?: boolean
  }

/** Кнопка: основная (primary), второстепенная (secondary, по умолчанию), опасная, тихая. */
export function Button({
  variant,
  size,
  icon,
  busy = false,
  className,
  type = 'button',
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClass({ variant, size, icon, className })}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      data-busy={busy || undefined}
      {...props}
    />
  )
}
