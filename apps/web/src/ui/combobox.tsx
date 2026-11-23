import { type KeyboardEvent, useId, useState } from 'react'
import { cx } from './cx.ts'

export type ComboboxOption = { id: string; label: string; hint?: string }

type ComboboxProps = {
  label: string
  value: string
  onValueChange: (value: string) => void
  /** Подсказки к введённому тексту; фильтрует и загружает их вызывающий. */
  options: ComboboxOption[]
  onSelect: (option: ComboboxOption) => void
  placeholder?: string
  /** Текст, когда по введённому ничего нет. */
  emptyText?: string
  /** Подпись видна (по умолчанию) или только для читалки — например, поиск в шапке. */
  hideLabel?: boolean
  className?: string
}

/**
 * Поле поиска с подсказками (шаблон WAI-ARIA «combobox» со списком): фокус остаётся в поле,
 * стрелки двигают выделенную подсказку (aria-activedescendant), Enter выбирает, Esc закрывает.
 */
export function Combobox({
  label,
  value,
  onValueChange,
  options,
  onSelect,
  placeholder,
  emptyText,
  hideLabel = false,
  className,
}: ComboboxProps) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const baseId = useId()
  const listId = `${baseId}-list`
  const optionId = (index: number) => `${baseId}-option-${index}`

  const showList = open && value.trim() !== ''
  const activeOption = showList ? options[active] : undefined

  function choose(option: ComboboxOption) {
    setOpen(false)
    setActive(-1)
    onSelect(option)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (options.length === 0) return
      setOpen(true)
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((index) => (index + step + options.length) % options.length)
      return
    }
    if (event.key === 'Enter' && activeOption) {
      event.preventDefault()
      choose(activeOption)
      return
    }
    if (event.key === 'Escape' && showList) {
      event.preventDefault()
      setOpen(false)
      setActive(-1)
    }
  }

  return (
    <div className={cx('ui-combobox', className)}>
      <label className="ui-field__label">
        <span className={hideLabel ? 'vh' : undefined}>{label}</span>
        <input
          type="search"
          role="combobox"
          className="ui-input"
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={activeOption ? optionId(active) : undefined}
          onChange={(event) => {
            onValueChange(event.target.value)
            setOpen(true)
            setActive(-1)
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setOpen(false)}
        />
      </label>
      {showList && options.length > 0 && (
        <div id={listId} role="listbox" aria-label={label} className="ui-popup">
          {options.map((option, index) => (
            <div
              key={option.id}
              id={optionId(index)}
              role="option"
              tabIndex={-1}
              aria-selected={index === active}
              className="ui-popup__item"
              // mousedown, а не click: поле не теряет фокус до выбора.
              onMouseDown={(event) => {
                event.preventDefault()
                choose(option)
              }}
            >
              {option.label}
              {option.hint && <span className="ui-popup__hint">{option.hint}</span>}
            </div>
          ))}
        </div>
      )}
      {showList && options.length === 0 && emptyText && (
        <p className="ui-popup ui-popup__empty" role="status">
          {emptyText}
        </p>
      )}
    </div>
  )
}
