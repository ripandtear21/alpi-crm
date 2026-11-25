import { type QueryKey, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { type ChangeEvent, type FormEvent, type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/button.tsx'
import { cx } from '../../ui/cx.ts'
import { Progress } from '../../ui/feedback.tsx'
import { Field, Input, Textarea } from '../../ui/field.tsx'
import { Tabs } from '../../ui/tabs.tsx'
import { projectQueryKey } from '../project-switcher/current-project.tsx'
import {
  MAX_FILE_BYTES,
  type TimelineApi,
  TimelineApiError,
  type TimelineEntity,
  type TimelineItem,
  type TimelineKind,
} from './timeline-api.ts'
import './timeline.css'

// Лента записи (тикеты crm-deals/07 и 13): панель ввода (заметка, файл; задача — заглушка до
// эпика задач) и «Історія» — изменения полей, заметки и файлы по времени, новые сверху, с
// фильтром по виду. Запись — вид и id в пропсах: та же лента у сделки, контакта, организации.
//
// Права приходят пропсами — их считает экран записи: менять запись (добавлять, менять и удалять
// свои заметки и файлы) и «удалять» эту часть системы (чужие). Сервер проверяет каждый запрос
// сам; кнопки без права просто не показываются.

/** Корень ключей кэша ленты записи: экран сбрасывает его после своих изменений записи. */
export function timelineQueryKey(projectId: string, entity: TimelineEntity, id: string): QueryKey {
  return projectQueryKey(projectId, 'timeline', entity, id)
}

/** Фильтр «Історії»: все виды или один. */
const FILTERS = ['all', 'note', 'file', 'change'] as const
type Filter = (typeof FILTERS)[number]

export interface TimelineProps {
  api: TimelineApi
  projectId: string
  entity: TimelineEntity
  id: string
  currentUserId: string
  /** Можно менять запись: добавлять заметки и файлы, менять и удалять свои. */
  canWrite: boolean
  /** Право «удалять» эту часть системы: чужие заметки и файлы. */
  canDeleteOthers: boolean
  /**
   * Текст изменения поля записи; без него или если он вернул null — «поле: было → стало» как
   * есть.
   */
  describeChange?: (change: NonNullable<TimelineItem['change']>) => ReactNode
  /** Блок между панелью ввода и историей («Фокус» карточки). */
  focus?: ReactNode
}

export function Timeline(props: TimelineProps) {
  const { t } = useTranslation('timeline')
  const [filter, setFilter] = useState<Filter>('all')
  const queryClient = useQueryClient()
  const root = timelineQueryKey(props.projectId, props.entity, props.id)
  const refresh = () => queryClient.invalidateQueries({ queryKey: root })

  return (
    <div className="timeline">
      {props.canWrite && <Composer {...props} onAdded={refresh} />}
      {props.focus}
      <section className="timeline__history" aria-labelledby="timeline-history">
        <h2 id="timeline-history" className="timeline__title">
          {t('history')}
        </h2>
        <fieldset className="timeline__chips">
          <legend className="visually-hidden">{t('filter.label')}</legend>
          {FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              className={cx('timeline__chip', filter === value && 'timeline__chip--on')}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {t(`filter.${value}`)}
            </button>
          ))}
        </fieldset>
        <History {...props} filter={filter} root={root} onChanged={refresh} />
      </section>
    </div>
  )
}

function useErrorText() {
  const { t } = useTranslation('timeline')
  return (error: unknown) => {
    const code = error instanceof TimelineApiError ? error.code : ''
    return t(`errors.${code}`, { defaultValue: t('errors.unknown') })
  }
}

// ---- Панель ввода -------------------------------------------------------------------------

function Composer(props: TimelineProps & { onAdded: () => void }) {
  const { t } = useTranslation('timeline')
  return (
    <section className="timeline__composer" aria-label={t('composer.label')}>
      <Tabs
        label={t('composer.label')}
        tabs={[
          { id: 'note', label: t('composer.note'), content: <NoteForm {...props} /> },
          {
            id: 'task',
            label: t('composer.task'),
            content: <p className="timeline__stub">{t('composer.taskStub')}</p>,
          },
          { id: 'file', label: t('composer.file'), content: <FileForm {...props} /> },
        ]}
      />
    </section>
  )
}

function NoteForm({
  api,
  projectId,
  entity,
  id,
  onAdded,
}: TimelineProps & { onAdded: () => void }) {
  const { t } = useTranslation('timeline')
  const errorText = useErrorText()
  const [text, setText] = useState('')
  const add = useMutation({
    mutationFn: (value: string) => api.addNote(projectId, entity, id, value),
    onSuccess: () => {
      setText('')
      onAdded()
    },
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (text.trim() === '') return
    add.mutate(text.trim())
  }
  return (
    <form className="timeline__form" onSubmit={submit} aria-label={t('composer.note')}>
      <Field
        label={t('note.text')}
        error={add.isError ? errorText(add.error) : undefined}
        className="timeline__field"
      >
        <Textarea
          value={text}
          rows={3}
          maxLength={20_000}
          placeholder={t('note.placeholder')}
          onChange={(event) => setText(event.target.value)}
        />
      </Field>
      <div className="timeline__actions">
        <Button type="submit" variant="primary" size="sm" busy={add.isPending}>
          {t('note.save')}
        </Button>
      </div>
    </form>
  )
}

function FileForm({
  api,
  projectId,
  entity,
  id,
  onAdded,
}: TimelineProps & { onAdded: () => void }) {
  const { t } = useTranslation('timeline')
  const errorText = useErrorText()
  const [tooLarge, setTooLarge] = useState<string | null>(null)
  const upload = useMutation({
    mutationFn: (file: File) => api.uploadFile(projectId, entity, id, file),
    onSuccess: onAdded,
  })
  const pick = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // Тот же файл можно выбрать снова после отказа.
    event.target.value = ''
    if (!file) return
    upload.reset()
    // Больше предела — отказ до отправки: 25 МБ не уходят в сеть ради ответа 413.
    if (file.size > MAX_FILE_BYTES) {
      setTooLarge(t('file.tooLarge', { name: file.name }))
      return
    }
    setTooLarge(null)
    upload.mutate(file)
  }
  const error = tooLarge ?? (upload.isError ? errorText(upload.error) : null)
  return (
    <div className="timeline__form">
      <Field label={t('file.pick')} hint={t('file.hint')} error={error ?? undefined}>
        <Input
          type="file"
          className="timeline__file-input"
          onChange={pick}
          disabled={upload.isPending}
        />
      </Field>
      {upload.isPending && <Progress label={t('file.uploading')} />}
    </div>
  )
}

// ---- История ------------------------------------------------------------------------------

function History(props: TimelineProps & { filter: Filter; root: QueryKey; onChanged: () => void }) {
  const { t } = useTranslation('timeline')
  const { api, projectId, entity, id, filter, root } = props
  const kinds: TimelineKind[] | undefined = filter === 'all' ? undefined : [filter]
  const pages = useInfiniteQuery({
    queryKey: [...root, filter],
    queryFn: ({ pageParam }) => api.page(projectId, entity, id, { kinds, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    retry: false,
  })

  if (pages.isPending) return <p className="timeline__empty">{t('loading')}</p>
  if (pages.isError) {
    return (
      <p className="ui-notice" role="alert">
        {t('errors.unknown')}
      </p>
    )
  }
  const items = pages.data.pages.flatMap((page) => page.items)
  if (items.length === 0) return <p className="timeline__empty">{t(`empty.${filter}`)}</p>
  return (
    <>
      <ol className="timeline__list" aria-label={t('history')}>
        {items.map((item) => (
          <TimelineRow key={`${item.kind}-${item.id}`} item={item} {...props} />
        ))}
      </ol>
      {pages.hasNextPage && (
        <Button
          size="sm"
          variant="quiet"
          busy={pages.isFetchingNextPage}
          onClick={() => pages.fetchNextPage()}
        >
          {t('more')}
        </Button>
      )}
    </>
  )
}

const ICONS: Record<TimelineKind, string> = { note: '✎', file: '⎙', change: '↻' }

function TimelineRow(props: TimelineProps & { item: TimelineItem; onChanged: () => void }) {
  const { t, i18n } = useTranslation('timeline')
  const { item, currentUserId, canWrite, canDeleteOthers } = props
  const when = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(item.occurredAt))
  const own = item.actorId !== null && item.actorId === currentUserId
  // Своё меняет и удаляет тот, кто может менять запись; чужое удаляет право «удалять».
  const canDelete = own ? canWrite : canDeleteOthers
  return (
    <li className={cx('timeline__item', `timeline__item--${item.kind}`)}>
      <span className="timeline__icon" aria-hidden="true">
        {ICONS[item.kind]}
      </span>
      <article className="timeline__card" aria-label={t(`kind.${item.kind}`)}>
        {item.kind === 'note' && item.note && (
          <NoteBody {...props} note={item.note} canEdit={own && canWrite} canDelete={canDelete} />
        )}
        {item.kind === 'file' && item.file && (
          <FileBody {...props} file={item.file} canDelete={canDelete} />
        )}
        {item.kind === 'change' && item.change && (
          <p className="timeline__change">
            {props.describeChange?.(item.change) ?? <RawChange {...item.change} />}
          </p>
        )}
        <p className="timeline__meta">
          <time dateTime={item.occurredAt}>{when}</time>
          <span>{item.actorName ?? t('system')}</span>
        </p>
      </article>
    </li>
  )
}

function RawChange({ field, before, after }: NonNullable<TimelineItem['change']>) {
  const shown = (value: unknown) => (value === null || value === undefined ? '—' : String(value))
  return (
    <>
      {field}: <b>{shown(before)}</b> → <b>{shown(after)}</b>
    </>
  )
}

/** Кнопка удаления с подтверждением на месте: первое нажатие спрашивает, второе удаляет. */
function DeleteButton({
  label,
  onConfirm,
  busy,
}: {
  label: string
  onConfirm: () => void
  busy: boolean
}) {
  const { t } = useTranslation('timeline')
  const [asking, setAsking] = useState(false)
  if (!asking) {
    return (
      <Button size="sm" variant="quiet" onClick={() => setAsking(true)}>
        {label}
      </Button>
    )
  }
  return (
    <span className="timeline__confirm">
      <Button size="sm" variant="danger" busy={busy} onClick={onConfirm}>
        {t('confirmDelete')}
      </Button>
      <Button size="sm" variant="quiet" onClick={() => setAsking(false)}>
        {t('cancel')}
      </Button>
    </span>
  )
}

function NoteBody({
  api,
  projectId,
  entity,
  id,
  item,
  note,
  canEdit,
  canDelete,
  onChanged,
}: TimelineProps & {
  item: TimelineItem
  note: NonNullable<TimelineItem['note']>
  canEdit: boolean
  canDelete: boolean
  onChanged: () => void
}) {
  const { t } = useTranslation('timeline')
  const errorText = useErrorText()
  const [draft, setDraft] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: (text: string) => api.updateNote(projectId, entity, id, item.id, text),
    onSuccess: () => {
      setDraft(null)
      onChanged()
    },
  })
  const remove = useMutation({
    mutationFn: () => api.deleteNote(projectId, entity, id, item.id),
    onSuccess: onChanged,
  })
  const error = save.error ?? remove.error

  if (draft !== null) {
    return (
      <form
        className="timeline__form"
        aria-label={t('note.edit')}
        onSubmit={(event) => {
          event.preventDefault()
          if (draft.trim() !== '') save.mutate(draft.trim())
        }}
      >
        <Field label={t('note.text')} error={save.isError ? errorText(save.error) : undefined}>
          <Textarea value={draft} rows={3} onChange={(event) => setDraft(event.target.value)} />
        </Field>
        <div className="timeline__actions">
          <Button type="submit" size="sm" variant="primary" busy={save.isPending}>
            {t('note.save')}
          </Button>
          <Button size="sm" variant="quiet" onClick={() => setDraft(null)}>
            {t('cancel')}
          </Button>
        </div>
      </form>
    )
  }
  return (
    <>
      <p className="timeline__note">{note.text}</p>
      {(canEdit || canDelete) && (
        <div className="timeline__actions">
          {canEdit && (
            <Button size="sm" variant="quiet" onClick={() => setDraft(note.text)}>
              {t('note.edit')}
            </Button>
          )}
          {canDelete && (
            <DeleteButton
              label={t('note.delete')}
              busy={remove.isPending}
              onConfirm={() => remove.mutate()}
            />
          )}
        </div>
      )}
      {error && (
        <p className="ui-notice" role="alert">
          {errorText(error)}
        </p>
      )}
    </>
  )
}

function formatSize(bytes: number, language: string): string {
  const format = (value: number) =>
    new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(value)
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${format(bytes / 1024)} KB`
  return `${format(bytes / 1024 / 1024)} MB`
}

function FileBody({
  api,
  projectId,
  entity,
  id,
  item,
  file,
  canDelete,
  onChanged,
}: TimelineProps & {
  item: TimelineItem
  file: NonNullable<TimelineItem['file']>
  canDelete: boolean
  onChanged: () => void
}) {
  const { t, i18n } = useTranslation('timeline')
  const errorText = useErrorText()
  const download = useMutation({
    mutationFn: () => api.downloadFile(projectId, entity, id, item.id),
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = file.name
      link.click()
      URL.revokeObjectURL(url)
    },
  })
  const remove = useMutation({
    mutationFn: () => api.deleteFile(projectId, entity, id, item.id),
    onSuccess: onChanged,
  })
  const error = download.error ?? remove.error
  return (
    <>
      <p className="timeline__file">
        <Button
          size="sm"
          variant="quiet"
          busy={download.isPending}
          onClick={() => download.mutate()}
        >
          {file.name}
        </Button>
        <span className="timeline__file-size">{formatSize(file.size, i18n.language)}</span>
      </p>
      {canDelete && (
        <div className="timeline__actions">
          <DeleteButton
            label={t('file.delete')}
            busy={remove.isPending}
            onConfirm={() => remove.mutate()}
          />
        </div>
      )}
      {error && (
        <p className="ui-notice" role="alert">
          {errorText(error)}
        </p>
      )}
    </>
  )
}
