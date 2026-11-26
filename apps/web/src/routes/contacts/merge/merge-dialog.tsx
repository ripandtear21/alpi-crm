import { formatPhone } from '@alpi/shared'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { contactName } from '../../../components/contact-form/contact-form.tsx'
import type { ContactRecord, ContactsApi } from '../../../components/contact-form/contacts-api.ts'
import { projectQueryKey } from '../../../components/project-switcher/current-project.tsx'
import { Button } from '../../../ui/button.tsx'
import { Combobox } from '../../../ui/combobox.tsx'
import { Dialog } from '../../../ui/dialog.tsx'
import { type MergePreview, MergesApiError, useMergesApi } from './merges-api.tsx'
import './merge.css'

// «Об'єднати з…» в карточке контакта (тикет crm-intake/01; ADR 0005): найти второй контакт,
// увидеть направление — какой остаётся, какой будет скрыт (по умолчанию остаётся тот, из
// которого начали; «Поміняти місцями» меняет), предпросмотр того, что перейдёт, и число сделок
// вне доступа пользователя (они тоже перейдут). Слияние откатывается 30 дней.

/** Подпись поля, которое заполнит слияние. */
function useFieldLabel() {
  const { t } = useTranslation('contact-card')
  return (field: string, value: unknown): string => {
    if (field === 'lastName') return `${t('form.lastName')}: ${String(value)}`
    if (field === 'language') {
      return `${t('side.language')}: ${t(`languages.${String(value)}`, { defaultValue: String(value) })}`
    }
    if (field === 'organizationId') return t('side.organization')
    const code = field.startsWith('custom.') ? field.slice('custom.'.length) : field
    return t('merge.customField', { code })
  }
}

export function MergeContactDialog({
  contacts,
  projectId,
  contact,
  onClose,
  onMerged,
}: {
  contacts: ContactsApi
  projectId: string
  /** Карточка, из которой начали: по умолчанию остаётся она. */
  contact: ContactRecord
  onClose: () => void
  /** Слияние прошло: id оставшегося контакта. */
  onMerged: (survivorId: string) => void
}) {
  const { t } = useTranslation('contact-card')
  const merges = useMergesApi()
  const [search, setSearch] = useState('')
  const [chosen, setChosen] = useState<ContactRecord | null>(null)
  const [swapped, setSwapped] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const text = search.trim()

  const suggestions = useQuery({
    queryKey: projectQueryKey(projectId, 'merge', 'contact-search', text),
    queryFn: () => contacts.searchContacts(projectId, text),
    enabled: chosen === null && text.length >= 2,
    retry: false,
  })
  const survivor = chosen && swapped ? chosen : contact
  const merged = chosen && swapped ? contact : chosen
  const preview = useQuery({
    queryKey: projectQueryKey(projectId, 'merge', 'preview', survivor.id, merged?.id ?? ''),
    queryFn: () => merges.preview(projectId, survivor.id, merged?.id ?? ''),
    enabled: merged !== null,
    retry: false,
  })
  const previewError =
    preview.error instanceof MergesApiError
      ? t(`merge.errors.${preview.error.code}`, { defaultValue: t('errors.unknown') })
      : preview.isError
        ? t('errors.unknown')
        : null

  async function confirm() {
    if (!merged) return
    setError(null)
    setSending(true)
    try {
      await merges.merge(projectId, survivor.id, merged.id)
      onMerged(survivor.id)
    } catch (failure) {
      const code = failure instanceof MergesApiError ? failure.code : ''
      setError(t(`merge.errors.${code}`, { defaultValue: t('errors.unknown') }))
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('merge.title')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            busy={sending}
            disabled={!merged || !preview.isSuccess}
            onClick={() => void confirm()}
          >
            {t('merge.submit')}
          </Button>
        </>
      }
    >
      {chosen === null ? (
        <Combobox
          label={t('merge.search')}
          placeholder={t('merge.searchPlaceholder')}
          value={search}
          onValueChange={setSearch}
          options={(suggestions.data ?? [])
            .filter((c) => c.id !== contact.id)
            .map((c) => ({
              id: c.id,
              label: contactName(c),
              ...(c.phones[0] ? { hint: formatPhone(c.phones[0]) } : {}),
            }))}
          onSelect={(option) => {
            setChosen(suggestions.data?.find((c) => c.id === option.id) ?? null)
            setSwapped(false)
          }}
          {...(suggestions.isSuccess ? { emptyText: t('merge.nothingFound') } : {})}
        />
      ) : (
        <>
          <dl className="merge-direction" aria-label={t('merge.direction')}>
            <div className="merge-direction__side">
              <dt>{t('merge.keeps')}</dt>
              <dd>{contactName(survivor)}</dd>
            </div>
            <div className="merge-direction__side">
              <dt>{t('merge.hides')}</dt>
              <dd>{merged ? contactName(merged) : ''}</dd>
            </div>
          </dl>
          <div className="merge-direction__actions">
            <Button size="sm" onClick={() => setSwapped((value) => !value)}>
              {t('merge.swap')}
            </Button>
            <Button
              size="sm"
              variant="quiet"
              onClick={() => {
                setChosen(null)
                setSwapped(false)
              }}
            >
              {t('merge.another')}
            </Button>
          </div>
          {preview.isPending && <p role="status">{t('merge.previewLoading')}</p>}
          {previewError && (
            <p className="ui-notice" role="alert">
              {previewError}
            </p>
          )}
          {preview.isSuccess && <PreviewDetails preview={preview.data} />}
          <p className="record-card__muted">{t('merge.undoHint')}</p>
        </>
      )}
      {error && (
        <p className="ui-notice" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  )
}

function PreviewDetails({ preview }: { preview: MergePreview }) {
  const { t } = useTranslation('contact-card')
  const label = useFieldLabel()
  const counts = [
    t('merge.deals', { count: preview.deals }),
    t('merge.participations', { count: preview.participations }),
    t('merge.notes', { count: preview.notes }),
    t('merge.files', { count: preview.files }),
  ]
  return (
    <section className="merge-preview" aria-label={t('merge.previewTitle')}>
      <h3 className="merge-preview__title">{t('merge.previewTitle')}</h3>
      <ul className="merge-preview__list">
        {preview.fields.map((item) => (
          <li key={item.field}>{t('merge.fills', { field: label(item.field, item.value) })}</li>
        ))}
        {preview.phones.map((phone) => (
          <li key={phone}>{t('merge.phone', { phone: formatPhone(phone) })}</li>
        ))}
        {preview.emails.map((email) => (
          <li key={email}>{t('merge.email', { email })}</li>
        ))}
        {counts.map((line) => (
          <li key={line}>{line}</li>
        ))}
        {preview.duplicateMarkCleared && <li>{t('merge.duplicateCleared')}</li>}
      </ul>
      {preview.dealsOutOfScope > 0 && (
        <p className="ui-notice" role="status">
          {t('merge.outOfScope', { count: preview.dealsOutOfScope })}
        </p>
      )}
      <p>{t('merge.keepsFields')}</p>
    </section>
  )
}
