import {
  INBOUND_OUTCOMES,
  type InboundOutcome,
  type InboundRequestView,
  type IntakeSourceSummary,
} from '@alpi/shared'
import { useInfiniteQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  projectQueryKey,
  useProjectCode,
} from '../../../components/project-switcher/current-project.tsx'
import { Badge, type BadgeTone } from '../../../ui/badge.tsx'
import { Button } from '../../../ui/button.tsx'
import { Skeleton } from '../../../ui/feedback.tsx'
import { Field, Select } from '../../../ui/field.tsx'
import type { IntakeSourcesApi } from './intake-sources-api.ts'
import { useDateFormat, useErrorText } from './intake-sources-format.ts'

// Журнал входящих источника (тикет crm-intake/07) внутри его карточки: запросы за 30 дней,
// новые сверху, фильтр по итогу, подгрузка курсором. Строка раскрывается с сырым телом — в нём
// персональные данные: журнал виден только с правом «інтеграції: дивитися», как и весь экран.
// Строка «проведено заново» ссылается на исходную строку журнала: та старше и может быть ещё не
// подгружена — тогда ссылка никуда не ведёт, пока её не подгрузить (решено без владельца —
// подтвердить).

const OUTCOME_TONES: Partial<Record<InboundOutcome, BadgeTone>> = {
  accepted: 'win',
  repeat: 'neutral',
  error: 'danger',
}

/** id элемента строки журнала: на него ведёт ссылка «вихідний запит». */
export const inboundAnchor = (id: string) => `inbound-${id}`

const idOf = (result: InboundRequestView['result'], key: string): string | null => {
  const value = result?.[key]
  return typeof value === 'string' ? value : null
}

export function InboundJournal({
  api,
  projectId,
  source,
}: {
  api: IntakeSourcesApi
  projectId: string
  source: IntakeSourceSummary
}) {
  const { t } = useTranslation('intake-sources')
  const errorText = useErrorText()
  const [outcome, setOutcome] = useState<InboundOutcome | ''>('')
  const log = useInfiniteQuery({
    queryKey: [...projectQueryKey(projectId, 'intake-sources'), source.id, 'requests', outcome],
    queryFn: ({ pageParam }) =>
      api.requests(projectId, source.id, {
        ...(outcome ? { outcome } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: '',
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    retry: false,
  })
  const requests = log.data?.pages.flatMap((page) => page.data) ?? []

  return (
    <section className="intake-sources__log" aria-label={t('journal.title')}>
      <h3>{t('journal.title')}</h3>
      <p className="directory__hint">{t('journal.hint')}</p>
      <div className="intake-sources__filters">
        <Field label={t('journal.filter')}>
          <Select
            size="sm"
            value={outcome}
            onChange={(event) => setOutcome(event.target.value as InboundOutcome | '')}
          >
            <option value="">{t('journal.all')}</option>
            {INBOUND_OUTCOMES.map((value) => (
              <option key={value} value={value}>
                {t(`journal.outcome.${value}`)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {log.isPending && <Skeleton />}
      {log.isError && (
        <p className="ui-notice" role="alert">
          {errorText(log.error)}
        </p>
      )}
      {log.isSuccess && requests.length === 0 && <p>{t('journal.empty')}</p>}
      {requests.length > 0 && (
        <ul className="intake-sources__requests">
          {requests.map((request) => (
            <InboundItem key={request.id} request={request} />
          ))}
        </ul>
      )}
      {log.hasNextPage && (
        <div className="directory__row">
          <Button size="sm" busy={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
            {t('journal.loadMore')}
          </Button>
        </div>
      )}
    </section>
  )
}

function InboundItem({ request }: { request: InboundRequestView }) {
  const { t } = useTranslation('intake-sources')
  const date = useDateFormat('medium')
  const code = useProjectCode()
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const titleId = useId()
  const registrationId = idOf(request.result, 'registration_id')
  const contactId = idOf(request.result, 'contact_id')
  const dealId = idOf(request.result, 'deal_id')
  const channel = request.channel.split('.').at(-1) ?? request.channel
  const outcomeText = t(`journal.outcome.${request.outcome}`)
  return (
    <li
      id={inboundAnchor(request.id)}
      className="intake-sources__request"
      aria-label={`${date(request.receivedAt)} · ${outcomeText}`}
    >
      <div className="intake-sources__request-head">
        <span className="intake-sources__request-time">{date(request.receivedAt)}</span>
        <Badge tone={OUTCOME_TONES[request.outcome] ?? 'ask'}>{outcomeText}</Badge>
        <span>{t('journal.status', { code: request.statusCode })}</span>
        {request.replayOf && (
          <span>
            {t('journal.replayed')} ·{' '}
            <a href={`#${inboundAnchor(request.replayOf)}`}>{t('journal.original')}</a>
          </span>
        )}
      </div>
      <div className="intake-sources__request-meta">
        {request.channel !== 'intake.registration' && (
          <span>{t(`journal.channel.${channel}`, { defaultValue: request.channel })}</span>
        )}
        {request.eventId && <code>{request.eventId}</code>}
        {request.errorCode && <span>{t('journal.errorCode', { code: request.errorCode })}</span>}
        {registrationId && (
          <span>{t('journal.registration', { id: registrationId.slice(0, 8) })}</span>
        )}
        {contactId && (
          <Link to="/p/$code/contacts/$contactId" params={{ code, contactId }}>
            {t('journal.contact')}
          </Link>
        )}
        {dealId && (
          <Link to="/p/$code/deals/$dealId" params={{ code, dealId }}>
            {t('journal.deal')}
          </Link>
        )}
      </div>
      {request.warnings.length > 0 && (
        <div className="intake-sources__request-meta">
          <span>{t('journal.warnings')}:</span>
          {request.warnings.map((warning) => (
            <code key={warning}>{warning}</code>
          ))}
        </div>
      )}
      <div className="directory__row">
        <Button
          size="sm"
          variant="quiet"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
        >
          {t('journal.showBody')}
        </Button>
      </div>
      {open && (
        <section id={bodyId} aria-labelledby={titleId}>
          <h4 id={titleId} className="intake-sources__subtitle">
            {t('journal.body')}
          </h4>
          <pre className="intake-sources__code">{request.body}</pre>
        </section>
      )}
    </li>
  )
}
