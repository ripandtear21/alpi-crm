import { type ComponentPropsWithRef, createContext, type ReactNode, use, useId } from 'react'
import { cx } from './cx.ts'

type FieldState = {
  controlId: string | undefined
  describedBy: string | undefined
  invalid: boolean
}

const FieldContext = createContext<FieldState>({
  controlId: undefined,
  describedBy: undefined,
  invalid: false,
})

/**
 * Подпись над полем и под ним подсказка или ошибка. Поле внутри (Input, Select, Textarea)
 * само получает id для подписи, aria-describedby и aria-invalid.
 */
export function Field({
  label,
  hint,
  error,
  className,
  children,
}: {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  className?: string
  children: ReactNode
}) {
  const id = useId()
  const noteId = hint || error ? `${id}-note` : undefined
  return (
    <div className={cx('ui-field', className)}>
      <label htmlFor={id} className="ui-field__label">
        {label}
      </label>
      <FieldContext value={{ controlId: id, describedBy: noteId, invalid: Boolean(error) }}>
        {children}
      </FieldContext>
      {error ? (
        <span id={noteId} className="ui-field__error" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span id={noteId} className="ui-field__hint">
          {hint}
        </span>
      ) : null}
    </div>
  )
}

/** Связь поля с подписью, подсказкой и ошибкой из окружающего <Field>; свои значения важнее. */
function useFieldAria(
  id: string | undefined,
  describedBy: string | undefined,
  invalid: ComponentPropsWithRef<'input'>['aria-invalid'],
) {
  const field = use(FieldContext)
  return {
    id: id ?? field.controlId,
    'aria-describedby': cx(describedBy, field.describedBy) || undefined,
    'aria-invalid': invalid ?? (field.invalid || undefined),
  }
}

type Size = { size?: 'md' | 'sm' }

export function Input({
  className,
  id,
  size = 'md',
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
  ...props
}: Omit<ComponentPropsWithRef<'input'>, 'size'> & Size) {
  const aria = useFieldAria(id, describedBy, invalid)
  return (
    <input
      className={cx('ui-input', size === 'sm' && 'ui-input--sm', className)}
      {...aria}
      {...props}
    />
  )
}

export function Select({
  className,
  id,
  size = 'md',
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
  ...props
}: Omit<ComponentPropsWithRef<'select'>, 'size'> & Size) {
  const aria = useFieldAria(id, describedBy, invalid)
  return (
    <select
      className={cx('ui-select', size === 'sm' && 'ui-select--sm', className)}
      {...aria}
      {...props}
    />
  )
}

export function Textarea({
  className,
  id,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
  ...props
}: ComponentPropsWithRef<'textarea'>) {
  const aria = useFieldAria(id, describedBy, invalid)
  return <textarea className={cx('ui-textarea', className)} {...aria} {...props} />
}
