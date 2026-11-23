import { formatPhone } from '@alpi/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ContactFormDialog, contactName } from '../../../components/contact-form/contact-form.tsx'
import {
  type ContactRecord,
  type ContactsApi,
  ContactsApiError,
  type DependentDeal,
} from '../../../components/contact-form/contacts-api.ts'
import { RecordDealsList } from '../../../components/contact-form/record-deals.tsx'
import { recordRights } from '../../../components/contact-form/record-rights.ts'
import {
  projectQueryKey,
  useCurrentProject,
} from '../../../components/project-switcher/current-project.tsx'
import { Timeline, timelineQueryKey } from '../../../components/timeline/timeline.tsx'
import type { TimelineApi } from '../../../components/timeline/timeline-api.ts'
import { Badge } from '../../../ui/badge.tsx'
import { Button } from '../../../ui/button.tsx'
import { Dialog } from '../../../ui/dialog.tsx'
import { Skeleton } from '../../../ui/feedback.tsx'
import type { DealsApi } from '../../deals/deals-api.ts'
import { NewDealDialog } from '../../deals/new-deal-dialog.tsx'
import '../../../components/contact-form/record-card.css'

// Карточка контакта (тикет crm-deals/14; spec.md MVP, раздел 5.2): шапка с именем, пометкой
// «можливий дубль» и действиями; слева — телефоны (основной первым, в международном виде),
// email, язык общения, организация и сделки контакта (основной или участник, с воронкой, этапом
// и статусом, кнопка «+ Угода»); справа — лента (тикет 07) с заметками и файлами.
//
// Контакт меняется только действием пользователя (ADR 0003). Контакт вне охвата, удалённый и
// несуществующий — один экран «немає доступу» без его данных: API отвечает на всё это 404.

export interface CardUser {
  id: string
  name: string
}

export function ContactCardPage({
  api,
  deals,
  timeline,
  contactId,
  user,
}: {
  api: ContactsApi
  /** Клиент канбана: форма «+ Угода» (тикет 11). */
  deals: DealsApi
  timeline: TimelineApi
  contactId: string
  user: CardUser
}) {
  const { current } = useCurrentProject()
  if (!current) return <NoAccess />
  return (
    <ContactCardScreen
      key={`${current.id}|${contactId}`}
      api={api}
      deals={deals}
      timeline={timeline}
      projectId={current.id}
      contactId={contactId}
      user={user}
    />
  )
}

/** Контакта нет, он удалён или вне охвата: экран без каких-либо его данных. */
function NoAccess() {
  const { t } = useTranslation('contact-card')
  return (
    <section className="record-card__denied">
      <h1>{t('denied.title')}</h1>
      <p>{t('denied.text')}</p>
      <Link to="/contacts">{t('denied.back')}</Link>
    </section>
  )
}

type OpenDialog = 'edit' | 'remove' | 'deal' | null

function ContactCardScreen({
  api,
  deals,
  timeline,
  projectId,
  contactId,
  user,
}: {
  api: ContactsApi
  deals: DealsApi
  timeline: TimelineApi
  projectId: string
  contactId: string
  user: CardUser
}) {
  const { t } = useTranslation('contact-card')
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [dialog, setDialog] = useState<OpenDialog>(null)
  const contactKey = projectQueryKey(projectId, 'contact', contactId)
  const dealsKey = projectQueryKey(projectId, 'contact-deals', contactId)
  const contact = useQuery({
    queryKey: contactKey,
    queryFn: () => api.contact(projectId, contactId),
    retry: false,
  })
  const access = useQuery({
    queryKey: projectQueryKey(projectId, 'access'),
    queryFn: () => api.access(projectId),
    retry: false,
  })
  const pipelines = useQuery({
    queryKey: projectQueryKey(projectId, 'pipelines'),
    queryFn: () => api.pipelines(projectId),
    retry: false,
  })
  const contactDeals = useQuery({
    queryKey: dealsKey,
    queryFn: () => api.contactDeals(projectId, contactId),
    enabled: contact.isSuccess,
    retry: false,
  })
  const organizationId = contact.data?.organizationId ?? null
  const organization = useQuery({
    queryKey: projectQueryKey(projectId, 'organization', organizationId),
    queryFn: () => api.organization(projectId, organizationId ?? ''),
    enabled: organizationId !== null,
    retry: false,
  })
  const owners = useQuery({
    queryKey: projectQueryKey(projectId, 'deals', 'owners'),
    queryFn: () => deals.owners(projectId),
    enabled: dialog === 'deal',
    retry: false,
  })

  if (contact.isError) {
    const status = contact.error instanceof ContactsApiError ? contact.error.status : 0
    if (status === 404 || status === 403) return <NoAccess />
    return (
      <p className="ui-notice" role="alert">
        {t('errors.unknown')}
      </p>
    )
  }
  if (access.isError) {
    return (
      <p className="ui-notice" role="alert">
        {t('errors.unknown')}
      </p>
    )
  }
  if (contact.isPending || access.isPending) {
    return <Skeleton lines={5} label={t('loading')} />
  }

  const record = contact.data
  const rights = recordRights(access.data)
  const name = contactName(record)
  const activePipelines = (pipelines.data ?? []).filter((p) => p.archivedAt === null)
  const primaryDeals: DependentDeal[] = (contactDeals.data?.items ?? [])
    .filter((deal) => deal.primaryContactId === record.id)
    .map(({ id, title }) => ({ id, title }))
  const refreshTimeline = () =>
    queryClient.invalidateQueries({ queryKey: timelineQueryKey(projectId, 'contacts', contactId) })

  return (
    <article className="record-card" aria-label={name}>
      <header className="record-card__head">
        <div className="record-card__title-wrap">
          <h1 className="record-card__title">{name}</h1>
          {record.possibleDuplicate && (
            <span title={t('duplicateHint')}>
              <Badge tone="ask">{t('duplicate')}</Badge>
            </span>
          )}
        </div>
        <div className="record-card__actions">
          {rights.dealCreate && activePipelines.length > 0 && (
            <Button variant="primary" size="sm" onClick={() => setDialog('deal')}>
              {t('actions.newDeal')}
            </Button>
          )}
          {rights.contactEdit && (
            <Button size="sm" onClick={() => setDialog('edit')}>
              {t('actions.edit')}
            </Button>
          )}
          {rights.contactDelete && (
            <Button
              variant="danger"
              size="sm"
              disabled={contactDeals.isPending}
              onClick={() => setDialog('remove')}
            >
              {t('actions.remove')}
            </Button>
          )}
        </div>
      </header>
      <div className="record-card__body">
        <aside className="record-card__side" aria-label={t('side.label')}>
          <section className="record-card__block" aria-labelledby="contact-details">
            <h2 id="contact-details" className="record-card__block-head">
              {t('side.details')}
            </h2>
            <ContactDetails contact={record} organizationName={organization.data?.name ?? null} />
          </section>
          <section className="record-card__block" aria-labelledby="contact-deals">
            <h2 id="contact-deals" className="record-card__block-head">
              {t('deals.title')}
            </h2>
            <RecordDealsList
              deals={contactDeals.data}
              pipelines={pipelines.data ?? []}
              contactId={record.id}
              failed={contactDeals.isError}
            />
          </section>
        </aside>
        <div className="record-card__main">
          <Timeline
            api={timeline}
            projectId={projectId}
            entity="contacts"
            id={contactId}
            currentUserId={user.id}
            canWrite={rights.contactEdit}
            canDeleteOthers={rights.contactDelete}
          />
        </div>
      </div>
      {dialog === 'edit' && (
        <ContactFormDialog
          api={api}
          projectId={projectId}
          contact={record}
          canCreateOrganization={rights.organizationCreate}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            setDialog(null)
            queryClient.setQueryData(contactKey, saved)
            void refreshTimeline()
          }}
        />
      )}
      {dialog === 'remove' && (
        <RemoveContactDialog
          api={api}
          projectId={projectId}
          contact={record}
          primaryDeals={primaryDeals}
          onClose={() => setDialog(null)}
          onRemoved={() => {
            queryClient.removeQueries({ queryKey: contactKey })
            void navigate({ to: '/contacts' })
          }}
        />
      )}
      {dialog === 'deal' && activePipelines[0] && (
        <NewDealDialog
          api={deals}
          projectId={projectId}
          pipelines={activePipelines}
          pipelineId={activePipelines[0].id}
          owners={owners.data ?? []}
          userId={user.id}
          contact={{
            id: record.id,
            firstName: record.firstName,
            lastName: record.lastName,
            phones: record.phones,
          }}
          onClose={() => setDialog(null)}
          onCreated={() => {
            setDialog(null)
            void queryClient.invalidateQueries({ queryKey: dealsKey })
          }}
        />
      )}
    </article>
  )
}

function ContactDetails({
  contact,
  organizationName,
}: {
  contact: ContactRecord
  organizationName: string | null
}) {
  const { t } = useTranslation('contact-card')
  return (
    <dl className="record-card__rows">
      {contact.phones.map((phone, index) => (
        <div key={phone} className="record-card__row">
          <dt>{t('side.phone')}</dt>
          <dd>
            <a href={`tel:${phone}`}>{formatPhone(phone)}</a>
            {index === 0 && contact.phones.length > 1 && (
              <span className="record-card__muted">{t('side.primary')}</span>
            )}
          </dd>
        </div>
      ))}
      {contact.emails.map((email, index) => (
        <div key={email} className="record-card__row">
          <dt>{t('side.email')}</dt>
          <dd>
            <a href={`mailto:${email}`}>{email}</a>
            {index === 0 && contact.emails.length > 1 && (
              <span className="record-card__muted">{t('side.primary')}</span>
            )}
          </dd>
        </div>
      ))}
      <div className="record-card__row">
        <dt>{t('side.language')}</dt>
        <dd>{contact.language ? t(`languages.${contact.language}`) : t('side.none')}</dd>
      </div>
      <div className="record-card__row">
        <dt>{t('side.organization')}</dt>
        <dd>
          {contact.organizationId === null ? (
            t('side.none')
          ) : (
            <Link
              to="/organizations/$organizationId"
              params={{ organizationId: contact.organizationId }}
            >
              {organizationName ?? '…'}
            </Link>
          )}
        </dd>
      </div>
    </dl>
  )
}

/**
 * Удаление контакта в корзину. Сделки, где он основной, уходят вместе с ним: диалог показывает
 * их список, и запрос несёт подтверждение ровно этого списка. Если за это время список сменился,
 * API отвечает 409 CONTACT_HAS_DEALS с новым списком — его надо подтвердить ещё раз.
 */
function RemoveContactDialog({
  api,
  projectId,
  contact,
  primaryDeals,
  onClose,
  onRemoved,
}: {
  api: ContactsApi
  projectId: string
  contact: ContactRecord
  primaryDeals: DependentDeal[]
  onClose: () => void
  onRemoved: () => void
}) {
  const { t } = useTranslation('contact-card')
  const [dependents, setDependents] = useState(primaryDeals)
  const [changed, setChanged] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  async function confirm() {
    setError(null)
    setSending(true)
    try {
      await api.removeContact(
        projectId,
        contact.id,
        dependents.map((deal) => deal.id),
      )
      onRemoved()
    } catch (failure) {
      if (failure instanceof ContactsApiError && failure.code === 'CONTACT_HAS_DEALS') {
        const list = Array.isArray(failure.details.deals) ? failure.details.deals : []
        setDependents(
          list.flatMap((item: unknown) => {
            const { id, title } = (item ?? {}) as Record<string, unknown>
            return typeof id === 'string' && typeof title === 'string' ? [{ id, title }] : []
          }),
        )
        setChanged(true)
      } else {
        const code = failure instanceof ContactsApiError ? failure.code : ''
        setError(t(`errors.${code}`, { defaultValue: t('errors.unknown') }))
      }
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('remove.title')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="danger" busy={sending} onClick={() => void confirm()}>
            {dependents.length > 0 ? t('remove.submitWithDeals') : t('remove.submit')}
          </Button>
        </>
      }
    >
      <p>{t('remove.text', { name: contactName(contact) })}</p>
      {dependents.length > 0 && (
        <>
          <p>{t('remove.withDeals')}</p>
          <ul className="record-card__deps" aria-label={t('remove.withDeals')}>
            {dependents.map((deal) => (
              <li key={deal.id}>{deal.title}</li>
            ))}
          </ul>
        </>
      )}
      {changed && (
        <p className="ui-notice" role="status">
          {t('remove.changed')}
        </p>
      )}
      {error && (
        <p className="ui-notice" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  )
}
