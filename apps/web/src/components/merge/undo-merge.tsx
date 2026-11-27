import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/button.tsx'
import { Dialog } from '../../ui/dialog.tsx'
import { type MergeRecord, mergeErrorCode, type UndoSkip } from './merge-api.tsx'
import './merge.css'

// Откат слияния контактов (тикет crm-intake/01) и сделок (тикет crm-intake/02; ADR 0005) — одно
// окно, список и страница слитой записи с параметром вида записи (тикет crm-intake/12):
// «Скасувати об'єднання» в карточке оставшейся (список слияний за 30 дней), на странице слитой и в
// журнале проекта. Подтверждение, затем итог: что не вернулось — удалено окончательно или
// изменено после слияния (такое поле откат не трогает).
//
// Тексты — в пространстве карточки записи (`contact-card` или `deal-card`), ключи `merge.*` у
// обеих одни; имя слитой записи в тексте — `{{name}}` у контакта, `{{title}}` у сделки.

/** Пространство текстов карточки записи. */
export type MergeTexts = 'contact-card' | 'deal-card'

/**
 * Текст отказа слияния или отката по коду ответа: `merge.errors.<код>` пространства `ns`, иначе
 * «неизвестная ошибка».
 */
export function useMergeErrorText(ns: MergeTexts) {
  const { t } = useTranslation(ns)
  return (failure: unknown): string => {
    const code = mergeErrorCode(failure)
    return code === ''
      ? t('errors.unknown')
      : t(`merge.errors.${code}`, { defaultValue: t('errors.unknown') })
  }
}

/** Подпись пропуска в итоге отката; `fieldName` — название заполнявшегося поля записи. */
function useSkipText(ns: MergeTexts, fieldName: (field: string) => string) {
  const { t } = useTranslation(ns)
  return (skip: UndoSkip): string => {
    if (skip.kind === 'field') {
      const field = skip.field ?? ''
      const name = field.startsWith('custom.')
        ? t('merge.customField', { code: field.slice('custom.'.length) })
        : fieldName(field)
      return t('merge.undo.fieldChanged', { field: name })
    }
    const what = t(`merge.undo.kinds.${skip.kind}`, { defaultValue: skip.kind })
    return skip.reason === 'gone'
      ? t('merge.undo.gone', { what })
      : t('merge.undo.changed', { what })
  }
}

/** Имя слитой записи в текстах: контакт — `{{name}}`, сделка — `{{title}}`. */
const named = (name: string) => ({ name, title: name })

/** Итог отката: что не вернулось. */
interface UndoOutcome {
  skipped: UndoSkip[]
}

/** Подтверждение отката и его итог. */
export function UndoDialog<Result extends UndoOutcome>({
  ns,
  undo,
  mergedName,
  doneName,
  fieldName,
  onClose,
  onUndone,
}: {
  ns: MergeTexts
  /** Откат на сервере. */
  undo: () => Promise<Result>
  /** Имя слитой записи для текста подтверждения; null — неизвестно (журнал). */
  mergedName: string | null
  /** Имя вернувшейся записи в итоге. */
  doneName: (result: Result) => string
  /** Название заполнявшегося поля записи (не пользовательского). */
  fieldName: (field: string) => string
  onClose: () => void
  /** Откат прошёл: вызывается сразу, итог остаётся на экране до «Закрити». */
  onUndone: (result: Result) => void
}) {
  const { t } = useTranslation(ns)
  const skipText = useSkipText(ns, fieldName)
  const errorText = useMergeErrorText(ns)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)

  async function confirm() {
    setError(null)
    setSending(true)
    try {
      const done = await undo()
      setResult(done)
      onUndone(done)
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setSending(false)
    }
  }

  if (result) {
    return (
      <Dialog
        open
        onClose={onClose}
        title={t('merge.undo.doneTitle')}
        footer={
          <Button variant="primary" onClick={onClose}>
            {t('merge.undo.close')}
          </Button>
        }
      >
        <p role="status">{t('merge.undo.done', named(doneName(result)))}</p>
        {result.skipped.length > 0 && (
          <>
            <p>{t('merge.undo.skippedTitle')}</p>
            <ul className="merge-preview__list" aria-label={t('merge.undo.skippedTitle')}>
              {result.skipped.map((skip, index) => (
                // Пропуски не имеют своего id: порядок итога не меняется.
                // biome-ignore lint/suspicious/noArrayIndexKey: список не переставляется
                <li key={index}>{skipText(skip)}</li>
              ))}
            </ul>
          </>
        )}
      </Dialog>
    )
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('merge.undo.title')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="danger" busy={sending} onClick={() => void confirm()}>
            {t('merge.undo.submit')}
          </Button>
        </>
      }
    >
      <p>
        {mergedName === null
          ? t('merge.undo.textUnknown')
          : t('merge.undo.text', named(mergedName))}
      </p>
      {error && (
        <p className="ui-notice" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  )
}

/** Слияние, которое откатывают из списка: id и имя слитой записи. */
export interface UndoTarget {
  id: string
  name: string
}

/**
 * Слияния в запись за 30 дней с «Скасувати об'єднання». Пусто — блока нет. Оформление блока —
 * карточки записи (`block`: классы секции, заголовка и списка).
 */
export function MergeList<Item extends MergeRecord>({
  ns,
  headingId,
  block,
  items,
  mergedName,
  canUndo,
  renderUndo,
}: {
  ns: MergeTexts
  headingId: string
  block: { section: string; head: string; list?: string }
  items: readonly Item[]
  /** Имя слитой записи. */
  mergedName: (item: Item) => string
  canUndo: boolean
  /** Окно отката слияния `target`; `close` — закрыть его. */
  renderUndo: (target: UndoTarget, close: () => void) => ReactNode
}) {
  const { t, i18n } = useTranslation(ns)
  const [undoing, setUndoing] = useState<UndoTarget | null>(null)
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short' })
  if (items.length === 0 && undoing === null) return null
  return (
    <section className={block.section} aria-labelledby={headingId}>
      <h2 id={headingId} className={block.head}>
        {t('merge.listTitle')}
      </h2>
      <ul className={block.list ? `${block.list} merge-list` : 'merge-list'}>
        {items.map((item) => {
          const name = mergedName(item)
          return (
            <li key={item.id} className="merge-list__item">
              <span>
                {t('merge.listItem', {
                  ...named(name),
                  date: date.format(new Date(item.mergedAt)),
                  until: date.format(new Date(item.undoUntil)),
                })}
              </span>
              {canUndo && (
                <Button size="sm" onClick={() => setUndoing({ id: item.id, name })}>
                  {t('merge.undo.action')}
                </Button>
              )}
            </li>
          )
        })}
      </ul>
      {undoing && renderUndo(undoing, () => setUndoing(null))}
    </section>
  )
}

/**
 * Прямая ссылка на слитую запись: «… об'єднано з X» со ссылкой на оставшуюся (`survivorLink` —
 * по её id) и кнопкой отката, пока он доступен (30 дней, право «змінювати»).
 */
export function MergedNotice({
  ns,
  headingId,
  details,
  canUndo,
  survivorLink,
  renderUndo,
}: {
  ns: MergeTexts
  headingId: string
  /** Подробности ответа 404 CONTACT_MERGED или DEAL_MERGED (apps/api/src/merge/merged.ts). */
  details: Record<string, unknown>
  canUndo: boolean
  survivorLink: (survivorId: string) => ReactNode
  /** Окно отката слияния `mergeId`; `close` — закрыть его. */
  renderUndo: (mergeId: string, close: () => void) => ReactNode
}) {
  const { t } = useTranslation(ns)
  const [undoing, setUndoing] = useState(false)
  const survivorId = mergedIntoId(details)
  const mergeId = typeof details.merge_id === 'string' ? details.merge_id : null
  const undoUntil = typeof details.undo_until === 'string' ? Date.parse(details.undo_until) : NaN
  const undoAvailable = canUndo && mergeId !== null && undoUntil > Date.now()
  return (
    <section className="merge-notice" aria-labelledby={headingId}>
      <h1 id={headingId}>{t('merge.mergedTitle')}</h1>
      <p>
        {t('merge.mergedInto')} {survivorId && survivorLink(survivorId)}
      </p>
      {undoAvailable && <Button onClick={() => setUndoing(true)}>{t('merge.undo.action')}</Button>}
      {undoing && mergeId && renderUndo(mergeId, () => setUndoing(false))}
    </section>
  )
}

/** Оставшаяся запись из подробностей ответа 404 CONTACT_MERGED или DEAL_MERGED. */
export const mergedIntoId = (details: Record<string, unknown>): string | null =>
  typeof details.merged_into_id === 'string' ? details.merged_into_id : null
