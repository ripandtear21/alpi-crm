import type { ComponentPropsWithRef, ReactNode } from 'react'
import { cx } from './cx.ts'

/** Флажок с подписью: нажимается и по тексту, и пробелом. */
export function Checkbox({
  label,
  className,
  ...props
}: Omit<ComponentPropsWithRef<'input'>, 'type'> & { label: ReactNode }) {
  return (
    <label className={cx('ui-check', className)}>
      <input type="checkbox" {...props} />
      <span>{label}</span>
    </label>
  )
}

/** Переключатель «включено / выключено» (role="switch"): изменение применяется сразу. */
export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled,
  className,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label: ReactNode
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={cx('ui-switch', className)}
      onClick={() => onCheckedChange(!checked)}
    >
      <span className="ui-switch__track" aria-hidden="true">
        <span className="ui-switch__thumb" />
      </span>
      <span>{label}</span>
    </button>
  )
}
