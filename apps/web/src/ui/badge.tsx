import type { ReactNode } from 'react'
import { cx } from './cx.ts'

export type BadgeTone = 'neutral' | 'accent' | 'win' | 'danger' | 'ask'

/** Короткая метка рядом с текстом: счётчик, «в архиве», «выиграна». */
export function Badge({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: BadgeTone
  className?: string
  children: ReactNode
}) {
  return (
    <span className={cx('ui-badge', tone !== 'neutral' && `ui-badge--${tone}`, className)}>
      {children}
    </span>
  )
}
