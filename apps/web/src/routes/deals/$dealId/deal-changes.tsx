import type { LostReasonGroupSummary, PipelineSummary } from '@alpi/shared'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { TimelineItem } from '../../../components/timeline/timeline-api.ts'

// Строка «було → стало» в ленте сделки: поле — подписью карточки, id этапа, воронки, причины и
// ответственного — названиями, даты и суммы — по языку интерфейса. Поле, которого карточка не
// знает, показывается как есть.

type Change = NonNullable<TimelineItem['change']>

const KNOWN_FIELDS = [
  'title',
  'pipelineId',
  'stageId',
  'status',
  'lostReasonId',
  'amount',
  'currency',
  'ownerId',
  'primaryContactId',
  'organizationId',
  'wonAt',
  'lostAt',
  'expectedCloseDate',
  'archivedAt',
  'deletedAt',
  'participants',
] as const
type KnownField = (typeof KNOWN_FIELDS)[number]

const isKnown = (field: string): field is KnownField =>
  KNOWN_FIELDS.some((known) => known === field)

export function useDescribeChange({
  pipelines,
  reasons,
  ownerName,
}: {
  pipelines: PipelineSummary[]
  reasons: LostReasonGroupSummary[]
  ownerName: (ownerId: string | null) => string
}): (change: Change) => ReactNode {
  const { t, i18n } = useTranslation('deal-card')
  const stages = new Map(
    pipelines.flatMap((pipeline) => pipeline.stages.map((stage) => [stage.id, stage.name])),
  )
  const pipelineNames = new Map(pipelines.map((pipeline) => [pipeline.id, pipeline.name]))
  const reasonNames = new Map(
    reasons.flatMap((group) => group.reasons.map((reason) => [reason.id, reason.name])),
  )
  const dateTime = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'short',
    timeStyle: 'short',
  })
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short', timeZone: 'UTC' })

  function value(field: KnownField, raw: unknown): string {
    if (raw === null || raw === undefined || raw === '') return '—'
    const text = String(raw)
    switch (field) {
      case 'pipelineId':
        return pipelineNames.get(text) ?? t('changes.unknown')
      case 'stageId':
        return stages.get(text) ?? t('changes.unknown')
      case 'lostReasonId':
        return reasonNames.get(text) ?? t('changes.unknown')
      case 'ownerId':
        return ownerName(text)
      case 'status':
        return text === 'open' || text === 'won' || text === 'lost' ? t(`status.${text}`) : text
      case 'amount':
        return new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 2 }).format(
          Number(text),
        )
      case 'expectedCloseDate':
        return date.format(new Date(`${text}T00:00:00Z`))
      case 'wonAt':
      case 'lostAt':
      case 'archivedAt':
      case 'deletedAt':
        return dateTime.format(new Date(text))
      case 'participants':
        return String(Array.isArray(raw) ? raw.length : text)
      case 'primaryContactId':
      case 'organizationId':
        return t('changes.record')
      default:
        return text
    }
  }

  return (change) => {
    if (!isKnown(change.field)) {
      return (
        <>
          {change.field}: <b>{String(change.before ?? '—')}</b> →{' '}
          <b>{String(change.after ?? '—')}</b>
        </>
      )
    }
    return (
      <>
        {t(`fields.${change.field}`)}: <b>{value(change.field, change.before)}</b> →{' '}
        <b>{value(change.field, change.after)}</b>
      </>
    )
  }
}
