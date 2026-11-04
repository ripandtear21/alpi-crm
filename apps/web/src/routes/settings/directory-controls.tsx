import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RolesApiError } from './roles-api.ts'
import './directory.css'

// Общие части экранов «Воронки» и «Причины проигрыша» (тикет crm-deals/02): переименование,
// перестановка кнопками «выше / ниже», добавление по названию и текст ошибки API.

/** Наибольшая длина названия — как в API (MAX_DIRECTORY_NAME_LENGTH). */
const MAX_NAME_LENGTH = 80

/** Сообщение экрана: успех — role="status", отказ — role="alert". */
export type Notice = { kind: 'status' | 'alert'; text: string } | null

export function NoticeLine({ notice }: { notice: Notice }) {
  if (!notice) return null
  return <p role={notice.kind}>{notice.text}</p>
}

/** Текст отказа API по коду: свои коды справочников, иначе — общие тексты настроек. */
export function useDirectoryErrorText() {
  const { t } = useTranslation('settings')
  return (error: unknown) => {
    const code = error instanceof RolesApiError ? error.code : ''
    return t(`directory.errors.${code}`, { defaultValue: t('roles.errors.unknown') })
  }
}

/** Список id после переноса элемента `index` на `delta` позиций (−1 — выше, +1 — ниже). */
export function moved(ids: string[], index: number, delta: -1 | 1): string[] {
  const next = [...ids]
  const target = index + delta
  const [item] = next.splice(index, 1)
  if (item === undefined || target < 0 || target > ids.length - 1) return ids
  next.splice(target, 0, item)
  return next
}

export function OrderButtons({
  name,
  index,
  count,
  pending,
  onMove,
}: {
  name: string
  index: number
  count: number
  pending: boolean
  onMove: (delta: -1 | 1) => void
}) {
  const { t } = useTranslation('settings')
  return (
    <span className="directory__order">
      <button
        type="button"
        aria-label={t('directory.up', { name })}
        title={t('directory.up', { name })}
        disabled={pending || index === 0}
        onClick={() => onMove(-1)}
      >
        ↑
      </button>
      <button
        type="button"
        aria-label={t('directory.down', { name })}
        title={t('directory.down', { name })}
        disabled={pending || index === count - 1}
        onClick={() => onMove(1)}
      >
        ↓
      </button>
    </span>
  )
}

/** Поле с названием и кнопкой: отправляет новое название, если оно изменилось. */
export function RenameForm({
  label,
  value,
  submitLabel,
  pending,
  onSubmit,
}: {
  label: string
  value: string
  submitLabel: string
  pending: boolean
  onSubmit: (name: string) => void
}) {
  const [name, setName] = useState(value)
  return (
    <form
      className="directory__rename"
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        const trimmed = name.trim()
        if (trimmed !== '' && trimmed !== value) onSubmit(trimmed)
      }}
    >
      <input
        aria-label={label}
        value={name}
        maxLength={MAX_NAME_LENGTH}
        required
        onChange={(event) => setName(event.target.value)}
      />
      <button type="submit" disabled={pending}>
        {submitLabel}
      </button>
    </form>
  )
}

/** Новый элемент списка по названию. */
export function AddForm({
  label,
  pending,
  onAdd,
}: {
  label: string
  pending: boolean
  onAdd: (name: string) => void
}) {
  const { t } = useTranslation('settings')
  return (
    <form
      className="directory__rename"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        const input = new FormData(event.currentTarget).get('name')
        const name = String(input ?? '').trim()
        if (name !== '') {
          onAdd(name)
          event.currentTarget.reset()
        }
      }}
    >
      <input
        name="name"
        aria-label={label}
        placeholder={label}
        maxLength={MAX_NAME_LENGTH}
        required
      />
      <button type="submit" disabled={pending}>
        {t('directory.add')}
      </button>
    </form>
  )
}

/** Кнопка «В архив» / «Вернуть из архива». */
export function ArchiveButton({
  archived,
  pending,
  onChange,
}: {
  archived: boolean
  pending: boolean
  onChange: (archived: boolean) => void
}) {
  const { t } = useTranslation('settings')
  return (
    <button type="button" disabled={pending} onClick={() => onChange(!archived)}>
      {archived ? t('directory.restore') : t('directory.archive')}
    </button>
  )
}
