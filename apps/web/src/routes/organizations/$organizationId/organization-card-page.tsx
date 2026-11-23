import { formatPhone } from '@alpi/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ContactFormDialog,
  contactName,
  FormErrorNotice,
} from '../../../components/contact-form/contact-form.tsx'
import {
  type ContactRecord,
  type ContactsApi,
  ContactsApiError,
  type OrganizationRecord,
  RECORD_LIST_LIMIT,
} from '../../../components/contact-form/contacts-api.ts'
import { RecordDealsList } from '../../../components/contact-form/record-deals.tsx'
import { type RecordRights, recordRights } from '../../../components/contact-form/record-rights.ts'
import { CopyLinkButton } from '../../../components/copy-link/copy-link-button.tsx'
import {
  projectQueryKey,
  useCurrentProject,
  useProjectCode,
} from '../../../components/project-switcher/current-project.tsx'
import { Timeline, timelineQueryKey } from '../../../components/timeline/timeline.tsx'
import type { TimelineApi } from '../../../components/timeline/timeline-api.ts'
import { NoAccess } from '../../../layout/no-access.tsx'
import { Button } from '../../../ui/button.tsx'
import { Combobox } from '../../../ui/combobox.tsx'
import { Dialog } from '../../../ui/dialog.tsx'
import { Skeleton } from '../../../ui/feedback.tsx'
import { Field, Input } from '../../../ui/field.tsx'
import '../../../components/contact-form/record-card.css'

// Карточка организации (тикет crm-deals/14; spec.md MVP, раздел 5.2): название, адрес, сайт
// (без права «організації: змінювати» — только чтение); контакты организации в охвате
// пользователя (добавить существующий или нового, убрать); сделки организации; лента.
//
// Удаление — в корзину с предупреждением, сколько контактов и сделок с ней связано (видимых
// пользователю). Организация удалённая или несуществующая — экран «немає доступу».

export interface CardUser {
  id: string
  name: string
}

export function OrganizationCardPage({
  api,
  timeline,
  organizationId,
  user,
}: {
  api: ContactsApi
  timeline: TimelineApi
  organizationId: string
  user: CardUser
}) {
  const { current } = useCurrentProject()
  if (!current) return <NoAccess />
  return (
    <OrganizationCardScreen
      key={`${current.id}|${organizationId}`}
      api={api}
      timeline={timeline}
      projectId={current.id}
      organizationId={organizationId}
      user={user}
    />
  )
}

/** Число в предупреждении: «200+», если загружена не вся выдача. */
const countText = (count: number, more: boolean) => (more ? `${count}+` : String(count))

function OrganizationCardScreen({
  api,
  timeline,
  projectId,
  organizationId,
  user,
}: {
  api: ContactsApi
  timeline: TimelineApi
  projectId: string
  organizationId: string
  user: CardUser
}) {
  const { t } = useTranslation('organization-card')
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const code = useProjectCode()
  const [dialog, setDialog] = useState<'remove' | 'contact' | null>(null)
  const organizationKey = projectQueryKey(projectId, 'organization', organizationId)
  const contactsKey = projectQueryKey(projectId, 'organization-contacts', organizationId)
  const organization = useQuery({
    queryKey: organizationKey,
    queryFn: () => api.organization(projectId, organizationId),
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
  const contacts = useQuery({
    queryKey: contactsKey,
    queryFn: () => api.organizationContacts(projectId, organizationId),
    enabled: organization.isSuccess,
    retry: false,
  })
  const deals = useQuery({
    queryKey: projectQueryKey(projectId, 'organization-deals', organizationId),
    queryFn: () => api.organizationDeals(projectId, organizationId),
    enabled: organization.isSuccess,
    retry: false,
  })

  if (organization.isError) {
    const status = organization.error instanceof ContactsApiError ? organization.error.status : 0
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
  if (organization.isPending || access.isPending) {
    return <Skeleton lines={5} label={t('loading')} />
  }

  const record = organization.data
  const rights = recordRights(access.data)
  const contactCount = contacts.data?.length ?? 0
  const refreshTimeline = () =>
    queryClient.invalidateQueries({
      queryKey: timelineQueryKey(projectId, 'organizations', organizationId),
    })

  return (
    <article className="record-card" aria-label={record.name}>
      <header className="record-card__head">
        <div className="record-card__title-wrap">
          <h1 className="record-card__title">{record.name}</h1>
        </div>
        <div className="record-card__actions">
          <CopyLinkButton />
          {rights.organizationDelete && (
            <Button
              variant="danger"
              size="sm"
              disabled={contacts.isPending || deals.isPending}
              onClick={() => setDialog('remove')}
            >
              {t('actions.remove')}
            </Button>
          )}
        </div>
      </header>
      <div className="record-card__body">
        <aside className="record-card__side" aria-label={t('side.label')}>
          <section className="record-card__block" aria-labelledby="organization-details">
            <h2 id="organization-details" className="record-card__block-head">
              {t('side.details')}
            </h2>
            {rights.organizationEdit ? (
              <OrganizationForm
                key={record.id}
                api={api}
                projectId={projectId}
                organization={record}
                onSaved={(saved) => {
                  queryClient.setQueryData(organizationKey, saved)
                  void refreshTimeline()
                }}
              />
            ) : (
              <OrganizationDetails organization={record} />
            )}
          </section>
          <section className="record-card__block" aria-labelledby="organization-contacts">
            <h2 id="organization-contacts" className="record-card__block-head">
              {t('contacts.title')}
              {rights.contactCreate && (
                <Button size="sm" variant="quiet" onClick={() => setDialog('contact')}>
                  {t('contacts.create')}
                </Button>
              )}
            </h2>
            <OrganizationContacts
              api={api}
              projectId={projectId}
              organizationId={organizationId}
              contacts={contacts.data}
              failed={contacts.isError}
              rights={rights}
              onChanged={() => queryClient.invalidateQueries({ queryKey: contactsKey })}
            />
          </section>
          <section className="record-card__block" aria-labelledby="organization-deals">
            <h2 id="organization-deals" className="record-card__block-head">
              {t('side.deals')}
            </h2>
            <RecordDealsList
              deals={deals.data}
              pipelines={pipelines.data ?? []}
              failed={deals.isError}
            />
          </section>
        </aside>
        <div className="record-card__main">
          <Timeline
            api={timeline}
            projectId={projectId}
            entity="organizations"
            id={organizationId}
            currentUserId={user.id}
            canWrite={rights.organizationEdit}
            canDeleteOthers={rights.organizationDelete}
          />
        </div>
      </div>
      {dialog === 'contact' && (
        <ContactFormDialog
          api={api}
          projectId={projectId}
          contact={null}
          organization={record}
          canCreateOrganization={rights.organizationCreate}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null)
            void queryClient.invalidateQueries({ queryKey: contactsKey })
          }}
        />
      )}
      {dialog === 'remove' && (
        <RemoveOrganizationDialog
          api={api}
          projectId={projectId}
          organization={record}
          contacts={countText(contactCount, contactCount >= RECORD_LIST_LIMIT)}
          deals={countText(deals.data?.items.length ?? 0, deals.data?.more ?? false)}
          onClose={() => setDialog(null)}
          onRemoved={() => {
            queryClient.removeQueries({ queryKey: organizationKey })
            void navigate({ to: '/p/$code/contacts', params: { code } })
          }}
        />
      )}
    </article>
  )
}

function OrganizationDetails({ organization }: { organization: OrganizationRecord }) {
  const { t } = useTranslation('organization-card')
  return (
    <dl className="record-card__rows">
      <div className="record-card__row">
        <dt>{t('side.address')}</dt>
        <dd>{organization.address ?? t('side.none')}</dd>
      </div>
      <div className="record-card__row">
        <dt>{t('side.website')}</dt>
        <dd>{organization.website ?? t('side.none')}</dd>
      </div>
    </dl>
  )
}

/** Поля организации для пользователя с правом «організації: змінювати». */
function OrganizationForm({
  api,
  projectId,
  organization,
  onSaved,
}: {
  api: ContactsApi
  projectId: string
  organization: OrganizationRecord
  onSaved: (organization: OrganizationRecord) => void
}) {
  const { t } = useTranslation('organization-card')
  const [name, setName] = useState(organization.name)
  const [address, setAddress] = useState(organization.address ?? '')
  const [website, setWebsite] = useState(organization.website ?? '')
  const [nameError, setNameError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    if (name.trim() === '') {
      setNameError(t('side.nameRequired'))
      return
    }
    setNameError(null)
    setSending(true)
    try {
      onSaved(
        await api.updateOrganization(projectId, organization.id, {
          name: name.trim(),
          address: address.trim() || null,
          website: website.trim() || null,
        }),
      )
    } catch (failure) {
      const code = failure instanceof ContactsApiError ? failure.code : ''
      setError(t(`errors.${code}`, { defaultValue: t('errors.unknown') }))
    } finally {
      setSending(false)
    }
  }

  return (
    <form
      className="record-card__form"
      aria-label={t('side.details')}
      noValidate
      onSubmit={(e) => void submit(e)}
    >
      <Field label={t('side.name')} error={nameError}>
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
      </Field>
      <Field label={t('side.address')}>
        <Input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={500} />
      </Field>
      <Field label={t('side.website')}>
        <Input value={website} onChange={(e) => setWebsite(e.target.value)} maxLength={500} />
      </Field>
      <div>
        <Button type="submit" size="sm" variant="primary" busy={sending}>
          {t('save')}
        </Button>
      </div>
      {error && (
        <p className="ui-notice" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}

/** Контакты организации: ссылки на карточки, «прибрати», добавить существующий. */
function OrganizationContacts({
  api,
  projectId,
  organizationId,
  contacts,
  failed,
  rights,
  onChanged,
}: {
  api: ContactsApi
  projectId: string
  organizationId: string
  contacts: ContactRecord[] | undefined
  failed: boolean
  rights: RecordRights
  onChanged: () => void
}) {
  const { t } = useTranslation('organization-card')
  const { t: tc } = useTranslation('contact-card')
  const code = useProjectCode()
  const [search, setSearch] = useState('')
  const [error, setError] = useState<{ text: string; contactId?: string } | null>(null)
  const text = search.trim()
  const suggestions = useQuery({
    queryKey: projectQueryKey(projectId, 'contacts', 'search', text),
    queryFn: () => api.searchContacts(projectId, text),
    enabled: rights.contactEdit && text.length >= 2,
    retry: false,
  })

  async function link(contactId: string, target: string | null) {
    setError(null)
    try {
      await api.updateContact(projectId, contactId, { organizationId: target })
      onChanged()
    } catch (failure) {
      const code = failure instanceof ContactsApiError ? failure.code : ''
      setError({ text: tc(`errors.${code}`, { defaultValue: tc('errors.unknown') }) })
    }
  }

  if (failed) return <p className="record-card__stub">{t('errors.unknown')}</p>
  if (!contacts) return <Skeleton lines={2} />
  const linked = new Set(contacts.map((contact) => contact.id))
  return (
    <div className="record-card__form">
      {contacts.length === 0 ? (
        <p className="record-card__stub">{t('contacts.empty')}</p>
      ) : (
        <ul className="record-card__list" aria-label={t('contacts.title')}>
          {contacts.map((contact) => (
            <li key={contact.id} className="record-card__item">
              <span className="record-card__item-main">
                <Link to="/p/$code/contacts/$contactId" params={{ code, contactId: contact.id }}>
                  {contactName(contact)}
                </Link>
                {contact.phones[0] && (
                  <span className="record-card__item-meta">{formatPhone(contact.phones[0])}</span>
                )}
              </span>
              {rights.contactEdit && (
                <Button
                  variant="quiet"
                  size="sm"
                  aria-label={t('contacts.detachLabel', { name: contactName(contact) })}
                  onClick={() => void link(contact.id, null)}
                >
                  {t('contacts.detach')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {rights.contactEdit && (
        <Combobox
          label={t('contacts.add')}
          value={search}
          onValueChange={setSearch}
          options={(suggestions.data ?? [])
            .filter((contact) => !linked.has(contact.id))
            .map((contact) => ({
              id: contact.id,
              label: contactName(contact),
              ...(contact.phones[0] ? { hint: formatPhone(contact.phones[0]) } : {}),
            }))}
          onSelect={(option) => {
            setSearch('')
            void link(option.id, organizationId)
          }}
          placeholder={t('contacts.addPlaceholder')}
          emptyText={t('contacts.noContacts')}
        />
      )}
      <FormErrorNotice error={error} />
    </div>
  )
}

function RemoveOrganizationDialog({
  api,
  projectId,
  organization,
  contacts,
  deals,
  onClose,
  onRemoved,
}: {
  api: ContactsApi
  projectId: string
  organization: OrganizationRecord
  contacts: string
  deals: string
  onClose: () => void
  onRemoved: () => void
}) {
  const { t } = useTranslation('organization-card')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  async function confirm() {
    setError(null)
    setSending(true)
    try {
      await api.removeOrganization(projectId, organization.id)
      onRemoved()
    } catch (failure) {
      const code = failure instanceof ContactsApiError ? failure.code : ''
      setError(t(`errors.${code}`, { defaultValue: t('errors.unknown') }))
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
            {t('remove.submit')}
          </Button>
        </>
      }
    >
      <p>{t('remove.text', { name: organization.name })}</p>
      <p>{t('remove.linked', { contacts, deals })}</p>
      {error && (
        <p className="ui-notice" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  )
}
