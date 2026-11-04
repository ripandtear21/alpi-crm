import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { type ButtonSize, type ButtonVariant, buttonClass } from './button.tsx'
import { cx } from './cx.ts'

export type MenuItem = {
  id: string
  label: ReactNode
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
}

type MenuProps = {
  /** Текст кнопки; если кнопка — значок, это её доступное имя. */
  label: string
  items: MenuItem[]
  /** Содержимое кнопки вместо текста (например, значок «⋯»). */
  icon?: ReactNode
  variant?: ButtonVariant
  size?: ButtonSize
  /** К какому краю кнопки прижато меню. */
  align?: 'start' | 'end'
}

/**
 * Кнопка с всплывающим меню (шаблон WAI-ARIA «menu button»): Enter, пробел или стрелка
 * открывают меню, стрелки и Home/End двигают фокус по доступным пунктам, Enter выбирает,
 * Esc и Tab закрывают; после выбора и Esc фокус возвращается на кнопку.
 */
export function Menu({
  label,
  items,
  icon,
  variant = 'secondary',
  size = 'md',
  align = 'start',
}: MenuProps) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const menuId = useId()

  const enabled = items.flatMap((item, index) => (item.disabled ? [] : [index]))

  useEffect(() => {
    if (open) itemRefs.current[active]?.focus()
  }, [open, active])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  function openAt(index: number | undefined) {
    if (index === undefined) return
    setActive(index)
    setOpen(true)
  }

  function close() {
    setOpen(false)
    buttonRef.current?.focus()
  }

  function move(step: 1 | -1) {
    const position = enabled.indexOf(active)
    const next = enabled[(position + step + enabled.length) % enabled.length]
    if (next !== undefined) setActive(next)
  }

  function onButtonKeyDown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      openAt(enabled[0])
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      openAt(enabled.at(-1))
    }
  }

  function onMenuKeyDown(event: KeyboardEvent) {
    switch (event.key) {
      case 'ArrowDown':
        move(1)
        break
      case 'ArrowUp':
        move(-1)
        break
      case 'Home':
        setActive(enabled[0] ?? 0)
        break
      case 'End':
        setActive(enabled.at(-1) ?? 0)
        break
      case 'Escape':
        close()
        break
      case 'Tab':
        // Tab уводит фокус дальше по странице, меню просто закрывается.
        setOpen(false)
        return
      default:
        return
    }
    event.preventDefault()
  }

  return (
    <div className="ui-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={buttonClass({ variant, size, icon: Boolean(icon) })}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={icon ? label : undefined}
        title={icon ? label : undefined}
        onClick={() => (open ? setOpen(false) : openAt(enabled[0]))}
        onKeyDown={onButtonKeyDown}
      >
        {icon ?? label}
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          className={cx('ui-popup', align === 'end' && 'ui-popup--end')}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item, index) => (
            <button
              key={item.id}
              ref={(element) => {
                itemRefs.current[index] = element
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              aria-disabled={item.disabled || undefined}
              className={cx('ui-popup__item', item.danger && 'ui-popup__item--danger')}
              onClick={() => {
                if (item.disabled) return
                close()
                item.onSelect()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
