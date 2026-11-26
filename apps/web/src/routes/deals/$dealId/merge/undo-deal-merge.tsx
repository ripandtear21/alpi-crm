import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  projectQueryKey,
  useProjectCode,
} from '../../../../components/project-switcher/current-project.tsx'
import { Button } from '../../../../ui/button.tsx'
import { Dialog } from '../../../../ui/dialog.tsx'
import type { DealCardApi } from '../deal-card-api.ts'
import {
  DealMergesApiError,
  type DealUndoResult,
  type DealUndoSkip,
  useDealMergesApi,
} from './deal-merges-api.tsx'
import './deal-merge.css'

// Откат слияния сделок (тикет crm-intake/02; ADR 0005): «Скасувати об'єднання» в карточке
// оставшейся (список слияний за 30 дней), на странице слитой сделки и в журнале проекта.
// Подтверждение, затем итог: что не вернулось — удалено окончательно или изменено после
// слияния (такое поле откат не трогает).

/** Ключ запроса слияний в сделку `dealId`. */
export const dealMergesQueryKey = (projectId: string, dealId: string) =>
  projectQueryKey(projectId, 'deal-merges', dealId)

/** Подпись пропуска в итоге отката. */
function useSkipText() {
  const { t } = useTranslation('deal-card')
  return (skip: DealUndoSkip): string => {
    if (skip.kind === 'field') {
      const field = skip.field ?? ''
      const name = field.startsWith('custom.')
        ? t('merge.customField', { code: field.slice('custom.'.length) })
        : t(`fields.${field}`, { defaultValue: field })
      return t('merge.undo.fieldChanged', { field: name })
    }
    const what = t(`merge.undo.kinds.${skip.kind}`, { defaultValue: skip.kind })
    return skip.reason === 'gone'
      ? t('merge.undo.gone', { what })
      : t('merge.undo.changed', { what })
  }
}

/** Текст отказа слияния или отката по коду ответа. */
export function useMergeErrorText() {
  const { t } = useTranslation('deal-card')
  return (failure: unknown): string =>
    t(`merge.errors.${failure instanceof DealMergesApiError ? failure.code : ''}`, {
      defaultValue: t('errors.unknown'),
    })
}

/** Подтверждение отката и его итог. */
export function UndoDealMergeDialog({
  projectId,
  mergeId,
  mergedTitle,
  onClose,
  onUndone,
}: {
  projectId: string
  mergeId: string
  /** Название слитой сделки для текста подтверждения; null — неизвестно (журнал). */
  mergedTitle: string | null
  onClose: () => void
  /** Откат прошёл: вызывается сразу, итог остаётся на экране до «Закрити». */
  onUndone: (result: DealUndoResult) => void
}) {
  const { t } = useTranslation('deal-card')
  const merges = useDealMergesApi()
  const skipText = useSkipText()
  const errorText = useMergeErrorText()
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<DealUndoResult | null>(null)

  async function confirm() {
    setError(null)
    setSending(true)
    try {
      const done = await merges.undo(projectId, mergeId)
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
        <p role="status">{t('merge.undo.done', { title: result.mergedDeal.title })}</p>
        {result.skipped.length > 0 && (
          <>
            <p>{t('merge.undo.skippedTitle')}</p>
            <ul className="deal-merge-preview__list" aria-label={t('merge.undo.skippedTitle')}>
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
        {mergedTitle === null
          ? t('merge.undo.textUnknown')
          : t('merge.undo.text', { title: mergedTitle })}
      </p>
      {error && (
        <p className="ui-notice" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  )
}

/** Слияния в эту сделку за 30 дней с «Скасувати об'єднання». Пусто — блока нет. */
export function DealMerges({
  projectId,
  dealId,
  canUndo,
  onUndone,
}: {
  projectId: string
  dealId: string
  canUndo: boolean
  onUndone: () => void
}) {
  const { t, i18n } = useTranslation('deal-card')
  const merges = useDealMergesApi()
  const [undoing, setUndoing] = useState<{ id: string; title: string } | null>(null)
  const list = useQuery({
    queryKey: dealMergesQueryKey(projectId, dealId),
    queryFn: () => merges.dealMerges(projectId, dealId),
    retry: false,
  })
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short' })
  const items = list.data ?? []
  if (items.length === 0 && undoing === null) return null
  return (
    <section className="deal-card__block" aria-labelledby="deal-merges">
      <h2 id="deal-merges" className="deal-card__block-head">
        {t('merge.listTitle')}
      </h2>
      <ul className="deal-card__block-body deal-merge-list">
        {items.map((item) => (
          <li key={item.id} className="deal-merge-list__item">
            <span>
              {t('merge.listItem', {
                title: item.mergedDeal.title,
                date: date.format(new Date(item.mergedAt)),
                until: date.format(new Date(item.undoUntil)),
              })}
            </span>
            {canUndo && (
              <Button
                size="sm"
                onClick={() => setUndoing({ id: item.id, title: item.mergedDeal.title })}
              >
                {t('merge.undo.action')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {undoing && (
        <UndoDealMergeDialog
          projectId={projectId}
          mergeId={undoing.id}
          mergedTitle={undoing.title}
          onClose={() => setUndoing(null)}
          onUndone={() => {
            void list.refetch()
            onUndone()
          }}
        />
      )}
    </section>
  )
}

/**
 * Прямая ссылка на слитую сделку: «Угоду об'єднано з Y» со ссылкой на оставшуюся и кнопкой
 * отката, пока он доступен (30 дней, право «угоди: змінювати»).
 */
export function MergedDealNotice({
  api,
  projectId,
  details,
  canUndo,
  onUndone,
}: {
  api: DealCardApi
  projectId: string
  /** Подробности ответа 404 DEAL_MERGED (apps/api/src/deals/store.ts, mergedDealRefusal). */
  details: Record<string, unknown>
  canUndo: boolean
  onUndone: () => void
}) {
  const { t } = useTranslation('deal-card')
  const code = useProjectCode()
  const [undoing, setUndoing] = useState(false)
  const survivorId = typeof details.merged_into_id === 'string' ? details.merged_into_id : null
  const mergeId = typeof details.merge_id === 'string' ? details.merge_id : null
  const undoUntil = typeof details.undo_until === 'string' ? Date.parse(details.undo_until) : NaN
  const survivor = useQuery({
    queryKey: projectQueryKey(projectId, 'deal', survivorId),
    queryFn: () => api.deal(projectId, survivorId ?? ''),
    enabled: survivorId !== null,
    retry: false,
  })
  const undoAvailable = canUndo && mergeId !== null && undoUntil > Date.now()
  return (
    <section className="deal-merge-notice" aria-labelledby="deal-merged-title">
      <h1 id="deal-merged-title">{t('merge.mergedTitle')}</h1>
      <p>
        {t('merge.mergedInto')}{' '}
        {survivorId && (
          <Link to="/p/$code/deals/$dealId" params={{ code, dealId: survivorId }}>
            {survivor.data ? survivor.data.title : t('merge.survivorLink')}
          </Link>
        )}
      </p>
      {undoAvailable && <Button onClick={() => setUndoing(true)}>{t('merge.undo.action')}</Button>}
      {undoing && mergeId && (
        <UndoDealMergeDialog
          projectId={projectId}
          mergeId={mergeId}
          mergedTitle={null}
          onClose={() => {
            setUndoing(false)
            onUndone()
          }}
          onUndone={() => {}}
        />
      )}
    </section>
  )
}
