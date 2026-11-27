import { useInfiniteQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  projectQueryKey,
  useProjectCode,
} from '../../../../components/project-switcher/current-project.tsx'
import { Button } from '../../../../ui/button.tsx'
import { Skeleton } from '../../../../ui/feedback.tsx'
import {
  type Registration,
  type RegistrationsOwner,
  type RegistrationWatch,
  useRegistrationsApi,
} from './registrations-api.tsx'
import './registrations.css'

// Блок «Реєстрації» (тикет crm-intake/09) в карточке сделки и карточке контакта: список, новые
// сверху — время, источник, форма, вебинар, тариф (у контакта — ещё ссылка на сделку). «Усі
// дані» раскрывает метки, адрес страницы, referrer, user_agent, `extra` строками
// «ключ: значение» и просмотр вебинара. Много регистраций — «Показати ще» (курсор API).

/** Ключ запроса регистраций сделки или контакта. */
export const registrationsQueryKey = (projectId: string, owner: RegistrationsOwner) =>
  projectQueryKey(projectId, 'registrations', owner.kind, owner.id)

/** Метки рекламы и аналитики: подпись — имя поля, как его присылает форма. */
const MARKS = [
  ['utm_source', 'utmSource'],
  ['utm_medium', 'utmMedium'],
  ['utm_campaign', 'utmCampaign'],
  ['utm_term', 'utmTerm'],
  ['utm_content', 'utmContent'],
  ['ad_id', 'adId'],
  ['gclid', 'gclid'],
  ['gbraid', 'gbraid'],
  ['wbraid', 'wbraid'],
  ['fbclid', 'fbclid'],
  ['fbp', 'fbp'],
  ['fbc', 'fbc'],
] as const satisfies readonly (readonly [string, keyof Registration])[]

/** Значение `extra` строкой: строка — как есть, остальное — JSON. */
function valueText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="registrations__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/** Строки «ключ: значение» объекта. */
function ExtraRows({ extra }: { extra: Record<string, unknown> }) {
  return Object.entries(extra).map(([key, value]) => (
    <Row key={key} label={key}>
      {valueText(value)}
    </Row>
  ))
}

function useDateTime() {
  const { i18n } = useTranslation()
  const format = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short', timeStyle: 'short' })
  return (iso: string) => format.format(new Date(iso))
}

function Watch({ view }: { view: RegistrationWatch | null }) {
  const { t } = useTranslation('deal-card')
  const dateTime = useDateTime()
  if (view === null) return <p className="registrations__muted">{t('registrations.view.none')}</p>
  return (
    <dl className="registrations__rows">
      {view.startedAt && (
        <Row label={t('registrations.view.started')}>{dateTime(view.startedAt)}</Row>
      )}
      {view.finishedAt && (
        <Row label={t('registrations.view.finished')}>{dateTime(view.finishedAt)}</Row>
      )}
      {view.minutes !== null && (
        <Row label={t('registrations.view.minutes')}>{String(view.minutes)}</Row>
      )}
      {view.extra && <ExtraRows extra={view.extra} />}
    </dl>
  )
}

function Item({ registration, showDeal }: { registration: Registration; showDeal: boolean }) {
  const { t } = useTranslation('deal-card')
  const code = useProjectCode()
  const dateTime = useDateTime()
  const r = registration
  const marks = MARKS.filter(([, field]) => r[field] !== null)
  const extra = Object.keys(r.extra).length > 0
  return (
    <li className="registrations__item">
      <dl className="registrations__rows">
        <Row label={t('registrations.fields.time')}>
          <time dateTime={r.registeredAt ?? r.createdAt}>
            {dateTime(r.registeredAt ?? r.createdAt)}
          </time>
        </Row>
        <Row label={t('registrations.fields.source')}>{r.sourceName}</Row>
        {r.form && <Row label={t('registrations.fields.form')}>{r.form}</Row>}
        {r.webinar && <Row label={t('registrations.fields.webinar')}>{r.webinar}</Row>}
        {r.planName && <Row label={t('registrations.fields.plan')}>{r.planName}</Row>}
        {showDeal && (
          <Row label={t('registrations.fields.deal')}>
            {r.dealId === null ? (
              <span className="registrations__muted">{t('registrations.noDeal')}</span>
            ) : (
              <Link to="/p/$code/deals/$dealId" params={{ code, dealId: r.dealId }}>
                {r.dealTitle ?? r.dealId}
              </Link>
            )}
          </Row>
        )}
      </dl>
      <details className="registrations__more">
        <summary>{t('registrations.details')}</summary>
        <dl className="registrations__rows">
          {r.pageUrl && <Row label={t('registrations.fields.pageUrl')}>{r.pageUrl}</Row>}
          {r.referrer && <Row label="referrer">{r.referrer}</Row>}
          {r.userAgent && <Row label="user_agent">{r.userAgent}</Row>}
          {marks.map(([label, field]) => (
            <Row key={label} label={label}>
              {String(r[field])}
            </Row>
          ))}
        </dl>
        {extra && (
          <>
            <h3 className="registrations__subhead">{t('registrations.extra')}</h3>
            <dl className="registrations__rows">
              <ExtraRows extra={r.extra} />
            </dl>
          </>
        )}
        <h3 className="registrations__subhead">{t('registrations.view.title')}</h3>
        <Watch view={r.view} />
      </details>
    </li>
  )
}

/**
 * Регистрации сделки (`owner.kind` 'deal') или контакта ('contact' — по всем его сделкам, со
 * ссылкой на сделку).
 */
export function Registrations({
  projectId,
  owner,
}: {
  projectId: string
  owner: RegistrationsOwner
}) {
  const { t } = useTranslation('deal-card')
  const api = useRegistrationsApi()
  const query = useInfiniteQuery({
    queryKey: registrationsQueryKey(projectId, owner),
    queryFn: ({ pageParam }) => api.list(projectId, owner, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    retry: false,
  })
  if (query.isPending) return <Skeleton lines={2} label={t('registrations.loading')} />
  if (query.isError) return <p className="registrations__muted">{t('registrations.failed')}</p>
  const items = query.data.pages.flatMap((page) => page.data)
  if (items.length === 0) return <p className="registrations__muted">{t('registrations.empty')}</p>
  return (
    <div className="registrations">
      <ul className="registrations__list" aria-label={t('registrations.title')}>
        {items.map((registration) => (
          <Item
            key={registration.id}
            registration={registration}
            showDeal={owner.kind === 'contact'}
          />
        ))}
      </ul>
      {query.hasNextPage && (
        <Button
          size="sm"
          busy={query.isFetchingNextPage}
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {t('registrations.more')}
        </Button>
      )}
      {query.isFetchNextPageError && (
        <p className="registrations__muted" role="alert">
          {t('registrations.failed')}
        </p>
      )}
    </div>
  )
}
