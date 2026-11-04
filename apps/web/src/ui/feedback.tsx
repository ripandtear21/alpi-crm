import type { CSSProperties, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cx } from './cx.ts'

// Состояния экрана без данных: пусто, загрузка, долгое действие.

/** Пустое состояние: что здесь будет и как это получить. */
export function EmptyState({
  title,
  children,
  actions,
}: {
  title: ReactNode
  children?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="ui-empty">
      <p className="ui-empty__title">{title}</p>
      {children && <p className="ui-empty__text">{children}</p>}
      {actions && <div className="ui-empty__actions">{actions}</div>}
    </div>
  )
}

const SKELETON_WIDTHS = ['100%', '82%', '64%', '90%', '72%']

/** Скелет загрузки: полосы на месте будущего текста; читалка слышит «Загрузка…». */
export function Skeleton({ lines = 3, label }: { lines?: number; label?: string }) {
  const { t } = useTranslation()
  return (
    <div className="ui-skeleton" role="status" aria-label={label ?? t('ui.loading')}>
      {SKELETON_WIDTHS.slice(0, lines).map((width) => (
        <span key={width} className="ui-skeleton__bar" style={{ '--w': width } as CSSProperties} />
      ))}
    </div>
  )
}

/** Индикатор прогресса; без value — «идёт, сколько осталось, неизвестно». */
export function Progress({
  label,
  value,
  max = 100,
}: {
  label: string
  value?: number
  max?: number
}) {
  const known = value !== undefined
  const percent = known ? Math.min(100, Math.max(0, (value / max) * 100)) : 0
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={known ? value : undefined}
      className={cx('ui-progress', !known && 'ui-progress--indeterminate')}
    >
      <span
        className="ui-progress__bar"
        style={known ? ({ '--p': `${percent}%` } as CSSProperties) : undefined}
      />
    </div>
  )
}

/** Строка-сообщение под действием: успех — role="status", отказ — role="alert". */
export function Notice({ kind, children }: { kind: 'status' | 'alert'; children: ReactNode }) {
  return (
    <p className="ui-notice" role={kind}>
      {children}
    </p>
  )
}
