import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMergeErrorText } from '../../../../components/merge/undo-merge.tsx'
import { projectQueryKey } from '../../../../components/project-switcher/current-project.tsx'
import { Button } from '../../../../ui/button.tsx'
import { Combobox } from '../../../../ui/combobox.tsx'
import { Dialog } from '../../../../ui/dialog.tsx'
import type { DealCard } from '../deal-card-api.ts'
import { type DealHit, type DealMergePreview, useDealMergesApi } from './deal-merges-api.tsx'
import '../../../../components/merge/merge.css'

// «Об'єднати з…» в карточке сделки (тикет crm-intake/02; ADR 0005): найти вторую сделку,
// увидеть направление — какая остаётся, какая будет скрыта (по умолчанию остаётся та, из
// которой начали; «Поміняти місцями» меняет), и предпросмотр того, что перейдёт. Слияние
// откатывается 30 дней.

/** Одна сделка в выборе направления: из карточки — DealCard, из поиска — DealHit. */
type DealSide = Pick<DealCard, 'id' | 'title'>

/** Подпись поля, которое заполнит слияние. */
function useFieldLabel() {
  const { t, i18n } = useTranslation('deal-card')
  return (field: string, value: unknown): string => {
    if (field === 'amount') {
      const { amount, currency } = (value ?? {}) as { amount?: number; currency?: string }
      const sum = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 2 }).format(
        Number(amount ?? 0),
      )
      return `${t('fields.amount')}: ${sum} ${currency ?? ''}`.trim()
    }
    if (field === 'expectedCloseDate' && typeof value === 'string') {
      const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short', timeZone: 'UTC' })
      return `${t('fields.expectedCloseDate')}: ${date.format(new Date(`${value}T00:00:00Z`))}`
    }
    if (field === 'organizationId') return t('fields.organizationId')
    const code = field.startsWith('custom.') ? field.slice('custom.'.length) : field
    return t('merge.customField', { code })
  }
}

export function MergeDealDialog({
  projectId,
  deal,
  onClose,
  onMerged,
}: {
  projectId: string
  /** Карточка, из которой начали: по умолчанию остаётся она. */
  deal: DealCard
  onClose: () => void
  /** Слияние прошло: id оставшейся сделки. */
  onMerged: (survivorId: string) => void
}) {
  const { t } = useTranslation('deal-card')
  const merges = useDealMergesApi()
  const [search, setSearch] = useState('')
  const [chosen, setChosen] = useState<DealHit | null>(null)
  const [swapped, setSwapped] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const text = search.trim()

  const suggestions = useQuery({
    queryKey: projectQueryKey(projectId, 'deal-merge', 'deal-search', text),
    queryFn: () => merges.searchDeals(projectId, text),
    enabled: chosen === null && text.length >= 2,
    retry: false,
  })
  const current: DealSide = deal
  const survivor: DealSide = chosen && swapped ? chosen : current
  const merged: DealSide | null = chosen && swapped ? current : chosen
  const preview = useQuery({
    queryKey: projectQueryKey(projectId, 'deal-merge', 'preview', survivor.id, merged?.id ?? ''),
    queryFn: () => merges.preview(projectId, survivor.id, merged?.id ?? ''),
    enabled: merged !== null,
    retry: false,
  })
  const errorText = useMergeErrorText('deal-card')

  async function confirm() {
    if (!merged) return
    setError(null)
    setSending(true)
    try {
      await merges.merge(projectId, survivor.id, merged.id)
      onMerged(survivor.id)
    } catch (failure) {
      setError(errorText(failure))
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
            .filter((hit) => hit.id !== deal.id)
            .map((hit) => ({
              id: hit.id,
              label: hit.title,
              hint: hit.archivedAt === null ? t(`status.${hit.status}`) : t('status.archived'),
            }))}
          onSelect={(option) => {
            setChosen(suggestions.data?.find((hit) => hit.id === option.id) ?? null)
            setSwapped(false)
          }}
          {...(suggestions.isSuccess ? { emptyText: t('merge.nothingFound') } : {})}
        />
      ) : (
        <>
          <dl className="merge-direction" aria-label={t('merge.direction')}>
            <div className="merge-direction__side">
              <dt>{t('merge.keeps')}</dt>
              <dd>{survivor.title}</dd>
            </div>
            <div className="merge-direction__side">
              <dt>{t('merge.hides')}</dt>
              <dd>{merged?.title ?? ''}</dd>
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
          {preview.isError && (
            <p className="ui-notice" role="alert">
              {errorText(preview.error)}
            </p>
          )}
          {preview.isSuccess && <PreviewDetails preview={preview.data} />}
          <p className="deal-card__stub">{t('merge.undoHint')}</p>
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

function PreviewDetails({ preview }: { preview: DealMergePreview }) {
  const { t } = useTranslation('deal-card')
  const label = useFieldLabel()
  const counts = [
    t('merge.products', { count: preview.products }),
    t('merge.participants', { count: preview.participants }),
    t('merge.notes', { count: preview.notes }),
    t('merge.files', { count: preview.files }),
  ]
  // Валюта оставшейся после слияния: пустая сумма берёт сумму и валюту второй сделки.
  const amount = preview.fields.find((item) => item.field === 'amount')?.value as
    | { currency?: string }
    | undefined
  const currency = amount?.currency ?? preview.survivor.currency
  return (
    <section className="merge-preview" aria-label={t('merge.previewTitle')}>
      <h3 className="merge-preview__title">{t('merge.previewTitle')}</h3>
      <ul className="merge-preview__list">
        {preview.fields.map((item) => (
          <li key={item.field}>{t('merge.fills', { field: label(item.field, item.value) })}</li>
        ))}
        {counts.map((line) => (
          <li key={line}>{line}</li>
        ))}
        {preview.primaryContactId !== null && <li>{t('merge.primaryContact')}</li>}
      </ul>
      {preview.convertedProducts > 0 && (
        <p className="ui-notice" role="status">
          {t('merge.converted', { count: preview.convertedProducts, currency })}
        </p>
      )}
      <p>{t('merge.keepsFields')}</p>
    </section>
  )
}
