import { formatPhone } from '@alpi/shared'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { contactName } from '../../../components/contact-form/contact-form.tsx'
import type { ContactRecord, ContactsApi } from '../../../components/contact-form/contacts-api.ts'
import { formatMoney } from '../../../components/deal-card/deal-card.tsx'
import { projectQueryKey } from '../../../components/project-switcher/current-project.tsx'
import { Button } from '../../../ui/button.tsx'
import { Combobox } from '../../../ui/combobox.tsx'
import { Dialog } from '../../../ui/dialog.tsx'
import {
  type DealPairPreview,
  type MergePairDeal,
  type MergePreview,
  MergesApiError,
  useMergesApi,
} from './merges-api.tsx'
import './merge.css'

// «Об'єднати з…» в карточке контакта (тикет crm-intake/01; ADR 0005): найти второй контакт,
// увидеть направление — какой остаётся, какой будет скрыт (по умолчанию остаётся тот, из
// которого начали; «Поміняти місцями» меняет), предпросмотр того, что перейдёт, и число сделок
// вне доступа пользователя (они тоже перейдут). Слияние откатывается 30 дней.
//
// Тикет crm-intake/04: открытые сделки обоих в одной воронке объединяются в том же действии —
// блок «Угоди, які теж буде об'єднано»: воронка, две сделки, какая остаётся (по умолчанию —
// сделка контакта, который остаётся), «Поміняти». На пару без права на сделки — объяснение, и
// «Об'єднати» недоступна: API ответил бы 403 MERGE_DEAL_FORBIDDEN.

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
  /** Сделки пар, которые остаются вместо сделки контакта, который остаётся. */
  const [keep, setKeep] = useState<string[]>([])
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
    queryKey: projectQueryKey(projectId, 'merge', 'preview', survivor.id, merged?.id ?? '', keep),
    queryFn: () => merges.preview(projectId, survivor.id, merged?.id ?? '', keep),
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
      await merges.merge(projectId, survivor.id, merged.id, keep)
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
            disabled={
              !merged || !preview.isSuccess || preview.data.dealPairs.some((p) => p.forbidden)
            }
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
            setKeep([])
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
            <Button
              size="sm"
              onClick={() => {
                setSwapped((value) => !value)
                setKeep([])
              }}
            >
              {t('merge.swap')}
            </Button>
            <Button
              size="sm"
              variant="quiet"
              onClick={() => {
                setChosen(null)
                setSwapped(false)
                setKeep([])
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
          {preview.isSuccess && (
            <>
              <DealPairs
                pairs={preview.data.dealPairs}
                onSwap={(pair) => setKeep((value) => swapDealPair(value, pair))}
              />
              <PreviewDetails preview={preview.data} />
            </>
          )}
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

/**
 * `keep_deal_ids` после «Поміняти» на паре `pair`: остаётся другая сделка пары. Общий с экраном
 * «Дублі» (тикет crm-intake/05).
 */
export function swapDealPair(keep: readonly string[], pair: DealPairPreview): string[] {
  const ids = [pair.survivorDeal?.id, pair.mergedDeal?.id]
  const other = pair.keepDealId === pair.survivorDeal?.id ? pair.mergedDeal : null
  return [...keep.filter((id) => !ids.includes(id)), ...(other ? [other.id] : [])]
}

/**
 * Открытые сделки обоих в одной воронке: объединятся вместе с контактами. Общий с экраном
 * «Дублі» (тикет crm-intake/05).
 */
export function DealPairs({
  pairs,
  onSwap,
}: {
  pairs: DealPairPreview[]
  onSwap: (pair: DealPairPreview) => void
}) {
  const { t, i18n } = useTranslation('contact-card')
  if (pairs.length === 0) return null
  const deal = (item: MergePairDeal | null, kept: boolean) =>
    item && (
      <div className="merge-pair__deal">
        <dt>{t(kept ? 'merge.dealPairs.keeps' : 'merge.dealPairs.hides')}</dt>
        <dd>
          {item.title}
          <span className="merge-pair__amount">
            {formatMoney(item.amount, item.currency, i18n.language)}
          </span>
        </dd>
      </div>
    )
  return (
    <section className="merge-pairs" aria-label={t('merge.dealPairs.title')}>
      <h3 className="merge-preview__title">{t('merge.dealPairs.title')}</h3>
      <p>{t('merge.dealPairs.hint')}</p>
      <ul className="merge-pairs__list">
        {pairs.map((pair) => {
          const survivorKept = pair.keepDealId === pair.survivorDeal?.id
          return (
            <li key={pair.pipeline.id} className="merge-pair">
              <p className="merge-pair__pipeline">
                {t('merge.dealPairs.pipeline', { name: pair.pipeline.name })}
              </p>
              {pair.forbidden ? (
                <p className="ui-notice" role="status">
                  {t('merge.dealPairs.forbidden')}
                </p>
              ) : (
                <>
                  <dl className="merge-pair__deals">
                    {deal(survivorKept ? pair.survivorDeal : pair.mergedDeal, true)}
                    {deal(survivorKept ? pair.mergedDeal : pair.survivorDeal, false)}
                  </dl>
                  <Button
                    size="sm"
                    aria-label={t('merge.dealPairs.swapLabel', { name: pair.pipeline.name })}
                    onClick={() => onSwap(pair)}
                  >
                    {t('merge.dealPairs.swap')}
                  </Button>
                </>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
