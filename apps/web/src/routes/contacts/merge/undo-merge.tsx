import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { contactName } from '../../../components/contact-form/contact-form.tsx'
import type { ContactsApi } from '../../../components/contact-form/contacts-api.ts'
import {
  projectQueryKey,
  useProjectCode,
} from '../../../components/project-switcher/current-project.tsx'
import { Button } from '../../../ui/button.tsx'
import { Dialog } from '../../../ui/dialog.tsx'
import { MergesApiError, type UndoResult, type UndoSkip, useMergesApi } from './merges-api.tsx'
import './merge.css'

// Откат слияния контактов (тикет crm-intake/01; ADR 0005): «Скасувати об'єднання» в карточке
// оставшегося (список слияний за 30 дней), на странице слитого контакта и в журнале проекта.
// Подтверждение, затем итог: что не вернулось — удалено окончательно или изменено после
// слияния (такое поле откат не трогает).

/** Подпись поля в итоге отката. */
function useSkipText() {
  const { t } = useTranslation('contact-card')
  return (skip: UndoSkip): string => {
    if (skip.kind === 'field') {
      const field = skip.field ?? ''
      const name =
        field === 'lastName'
          ? t('form.lastName')
          : field === 'language'
            ? t('side.language')
            : field === 'organizationId'
              ? t('side.organization')
              : t('merge.customField', { code: field.replace(/^custom\./, '') })
      return t('merge.undo.fieldChanged', { field: name })
    }
    const what = t(`merge.undo.kinds.${skip.kind}`, { defaultValue: skip.kind })
    return skip.reason === 'gone'
      ? t('merge.undo.gone', { what })
      : t('merge.undo.changed', { what })
  }
}

/** Подтверждение отката и его итог. */
export function UndoMergeDialog({
  projectId,
  mergeId,
  mergedName,
  onClose,
  onUndone,
}: {
  projectId: string
  mergeId: string
  /** Имя слитого контакта для текста подтверждения; null — неизвестно (журнал). */
  mergedName: string | null
  onClose: () => void
  /** Откат прошёл: вызывается сразу, итог остаётся на экране до «Закрити». */
  onUndone: (result: UndoResult) => void
}) {
  const { t } = useTranslation('contact-card')
  const merges = useMergesApi()
  const skipText = useSkipText()
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<UndoResult | null>(null)

  async function confirm() {
    setError(null)
    setSending(true)
    try {
      const done = await merges.undo(projectId, mergeId)
      setResult(done)
      onUndone(done)
    } catch (failure) {
      const code = failure instanceof MergesApiError ? failure.code : ''
      setError(t(`merge.errors.${code}`, { defaultValue: t('errors.unknown') }))
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
        <p role="status">{t('merge.undo.done', { name: contactName(result.mergedContact) })}</p>
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
          : t('merge.undo.text', { name: mergedName })}
      </p>
      {error && (
        <p className="ui-notice" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  )
}

/** Слияния в этот контакт за 30 дней с «Скасувати об'єднання». Пусто — блока нет. */
export function ContactMerges({
  projectId,
  contactId,
  canUndo,
  onUndone,
}: {
  projectId: string
  contactId: string
  canUndo: boolean
  onUndone: () => void
}) {
  const { t, i18n } = useTranslation('contact-card')
  const merges = useMergesApi()
  const [undoing, setUndoing] = useState<{ id: string; name: string } | null>(null)
  const list = useQuery({
    queryKey: projectQueryKey(projectId, 'contact-merges', contactId),
    queryFn: () => merges.contactMerges(projectId, contactId),
    retry: false,
  })
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short' })
  const items = list.data ?? []
  if (items.length === 0 && undoing === null) return null
  return (
    <section className="record-card__block" aria-labelledby="contact-merges">
      <h2 id="contact-merges" className="record-card__block-head">
        {t('merge.listTitle')}
      </h2>
      <ul className="merge-list">
        {items.map((item) => {
          const name = contactName(item.mergedContact)
          return (
            <li key={item.id} className="merge-list__item">
              <span>
                {t('merge.listItem', {
                  name,
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
      {undoing && (
        <UndoMergeDialog
          projectId={projectId}
          mergeId={undoing.id}
          mergedName={undoing.name}
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
 * Прямая ссылка на слитый контакт: «Контакт об'єднано з X» со ссылкой на оставшийся и кнопкой
 * отката, пока он доступен (30 дней, право «контакти: змінювати»).
 */
export function MergedContactNotice({
  contacts,
  projectId,
  details,
  canUndo,
  onUndone,
}: {
  contacts: ContactsApi
  projectId: string
  /** Подробности ответа 404 CONTACT_MERGED (apps/api/src/contacts/merged.ts). */
  details: Record<string, unknown>
  canUndo: boolean
  onUndone: () => void
}) {
  const { t } = useTranslation('contact-card')
  const code = useProjectCode()
  const [undoing, setUndoing] = useState(false)
  const survivorId = typeof details.merged_into_id === 'string' ? details.merged_into_id : null
  const mergeId = typeof details.merge_id === 'string' ? details.merge_id : null
  const undoUntil = typeof details.undo_until === 'string' ? Date.parse(details.undo_until) : NaN
  const survivor = useQuery({
    queryKey: projectQueryKey(projectId, 'contact', survivorId),
    queryFn: () => contacts.contact(projectId, survivorId ?? ''),
    enabled: survivorId !== null,
    retry: false,
  })
  const undoAvailable = canUndo && mergeId !== null && undoUntil > Date.now()
  return (
    <section className="merge-notice" aria-labelledby="merged-title">
      <h1 id="merged-title">{t('merge.mergedTitle')}</h1>
      <p>
        {t('merge.mergedInto')}{' '}
        {survivorId && (
          <Link to="/p/$code/contacts/$contactId" params={{ code, contactId: survivorId }}>
            {survivor.data ? contactName(survivor.data) : t('merge.survivorLink')}
          </Link>
        )}
      </p>
      {undoAvailable && <Button onClick={() => setUndoing(true)}>{t('merge.undo.action')}</Button>}
      {undoing && mergeId && (
        <UndoMergeDialog
          projectId={projectId}
          mergeId={mergeId}
          mergedName={null}
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
