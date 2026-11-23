import type { PipelineSummary } from '@alpi/shared'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Badge, type BadgeTone } from '../../ui/badge.tsx'
import { Skeleton } from '../../ui/feedback.tsx'
import { RECORD_LIST_LIMIT, type RecordDeals } from './contacts-api.ts'

// Сделки контакта или организации (тикет crm-deals/14): название со ссылкой на карточку,
// воронка и этап, статус; в карточке контакта — ещё его роль: основной или участник.

const STATUS_TONE: Record<string, BadgeTone> = { open: 'accent', won: 'win', lost: 'danger' }

export function RecordDealsList({
  deals,
  pipelines,
  contactId,
  failed,
}: {
  /** undefined — загружаются. */
  deals: RecordDeals | undefined
  pipelines: PipelineSummary[]
  /** Карточка контакта: показать, основной он в сделке или участник. */
  contactId?: string
  failed: boolean
}) {
  const { t } = useTranslation('contact-card')
  if (failed) return <p className="record-card__stub">{t('errors.unknown')}</p>
  if (!deals) return <Skeleton lines={2} />
  if (deals.items.length === 0) return <p className="record-card__stub">{t('deals.empty')}</p>
  return (
    <>
      <ul className="record-card__list" aria-label={t('deals.title')}>
        {deals.items.map((deal) => {
          const pipeline = pipelines.find((p) => p.id === deal.pipelineId)
          const stage = pipeline?.stages.find((s) => s.id === deal.stageId)
          const place = [pipeline?.name, stage?.name].filter(Boolean).join(' · ')
          return (
            <li key={deal.id} className="record-card__item">
              <span className="record-card__item-main">
                <Link to="/deals/$dealId" params={{ dealId: deal.id }}>
                  {deal.title}
                </Link>
                <span className="record-card__item-meta">
                  {place || t('deals.hiddenStage')}
                  {contactId !== undefined &&
                    ` · ${deal.primaryContactId === contactId ? t('deals.primary') : t('deals.participant')}`}
                </span>
              </span>
              <Badge tone={STATUS_TONE[deal.status] ?? 'neutral'}>
                {t(`deals.status.${deal.status}`)}
              </Badge>
            </li>
          )
        })}
      </ul>
      {deals.more && (
        <p className="record-card__stub">{t('deals.more', { count: RECORD_LIST_LIMIT })}</p>
      )}
    </>
  )
}
