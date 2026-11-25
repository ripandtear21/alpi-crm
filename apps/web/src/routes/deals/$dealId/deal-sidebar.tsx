import { useQueries, useQuery } from '@tanstack/react-query'
import { type FormEvent, type ReactNode, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CustomFieldGroups } from '../../../components/custom-fields/custom-field-groups.tsx'
import { DealProducts, formatMoney } from '../../../components/deal-products/deal-products.tsx'
import { Participants } from '../../../components/participants/participants.tsx'
import { projectQueryKey } from '../../../components/project-switcher/current-project.tsx'
import { Badge } from '../../../ui/badge.tsx'
import { Button } from '../../../ui/button.tsx'
import { Combobox, type ComboboxOption } from '../../../ui/combobox.tsx'
import { Input, Select } from '../../../ui/field.tsx'
import {
  type ContactCard,
  DEAL_CURRENCIES,
  type DealCard,
  type DealChange,
} from './deal-card-api.ts'
import type { DealCardModel } from './deal-card-page.tsx'
import { ActionError, useCardErrorText } from './deal-errors.tsx'

// Левая колонка карточки: поиск по полям, затем сворачиваемые блоки — «Заповніть» (важные
// пустые поля), «Підсумок», «Деталі», группы пользовательских полей (тикет crm-fields/06),
// «Контакт», «Організація», «Учасники», «Товари» и заглушки «Платежі» и «Реєстрації» до их
// эпиков.

export const contactName = (contact: ContactCard) =>
  [contact.firstName, contact.lastName].filter(Boolean).join(' ')

function contactOption(contact: ContactCard): ComboboxOption {
  const hint = contact.phones[0] ?? contact.emails[0]
  return hint
    ? { id: contact.id, label: contactName(contact), hint }
    : { id: contact.id, label: contactName(contact) }
}

export function DealSidebar({ card }: { card: DealCardModel }) {
  const { t } = useTranslation('deal-card')
  const [filter, setFilter] = useState('')
  const { deal, api, projectId } = card
  const organizationId = deal.organizationId
  const organization = useQuery({
    queryKey: projectQueryKey(projectId, 'organization', organizationId),
    queryFn: () => api.organization(projectId, organizationId ?? ''),
    enabled: organizationId !== null,
    retry: false,
  })

  const matches = (label: string) =>
    filter.trim() === '' || label.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())

  return (
    <aside className="deal-card__side" aria-label={t('side.label')}>
      <Input
        size="sm"
        type="search"
        className="deal-card__filter"
        aria-label={t('side.filter')}
        placeholder={t('side.filter')}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <ToFill card={card} />
      <Block title={t('summary.title')}>
        <Summary
          card={card}
          contact={card.contact}
          organizationName={organization.data?.name ?? null}
          matches={matches}
        />
      </Block>
      <Block title={t('details.title')}>
        <Details card={card} matches={matches} />
      </Block>
      <CustomFieldGroups<DealCard>
        entity="deal"
        projectId={projectId}
        user={{ userId: card.user.id, name: card.user.name, disabled: false }}
        record={deal}
        permissions={card.permissions}
        canEdit={card.rights.edit}
        deal={deal}
        pipelines={card.pipelines}
        matches={matches}
        onSaved={card.replace}
      />
      <Block title={t('contact.title')}>
        <PrimaryContact card={card} contact={card.contact} hidden={card.contactHidden} />
      </Block>
      <Block title={t('organization.title')}>
        {organizationId === null ? (
          <p className="deal-card__stub">{t('organization.none')}</p>
        ) : organization.isError ? (
          <p className="deal-card__stub">{t('organization.hidden')}</p>
        ) : (
          organization.data && (
            <dl className="deal-card__rows">
              <Row label={t('organization.name')}>{organization.data.name}</Row>
              {organization.data.address && (
                <Row label={t('organization.address')}>{organization.data.address}</Row>
              )}
              {organization.data.website && (
                <Row label={t('organization.website')}>{organization.data.website}</Row>
              )}
            </dl>
          )
        )}
      </Block>
      <Block title={t('participants.title')} count={deal.participants.length}>
        <DealParticipants card={card} />
      </Block>
      <Block title={t('products.title')} count={deal.products.length} id="deal-products">
        <DealLines card={card} />
      </Block>
      <Block title={t('payments.title')}>
        <p className="deal-card__stub">{t('payments.stub')}</p>
      </Block>
      <Block title={t('registrations.title')}>
        <p className="deal-card__stub">{t('registrations.stub')}</p>
      </Block>
    </aside>
  )
}

/** Сворачиваемый блок колонки: заголовок 56 px, линия 1 px между блоками. */
function Block({
  title,
  count,
  id,
  children,
}: {
  title: string
  count?: number
  id?: string
  children: ReactNode
}) {
  return (
    <details className="deal-card__block" open id={id}>
      <summary className="deal-card__block-head">
        <span>{title}</span>
        {count !== undefined && count > 0 && <Badge>{count}</Badge>}
      </summary>
      <div className="deal-card__block-body">{children}</div>
    </details>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="deal-card__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/** «Заповніть»: важные поля, которые ещё пусты. */
function ToFill({ card }: { card: DealCardModel }) {
  const { t } = useTranslation('deal-card')
  const { deal } = card
  const empty: string[] = []
  if (deal.amount === 0) empty.push(t('fields.amount'))
  if (deal.expectedCloseDate === null) empty.push(t('fields.expectedCloseDate'))
  if (deal.organizationId === null) empty.push(t('fields.organizationId'))
  if (empty.length === 0) return null
  return (
    <Block title={t('toFill.title')} count={empty.length}>
      <ul className="deal-card__to-fill">
        {empty.map((label) => (
          <li key={label}>{label}</li>
        ))}
      </ul>
    </Block>
  )
}

function Summary({
  card,
  contact,
  organizationName,
  matches,
}: {
  card: DealCardModel
  contact: ContactCard | null
  organizationName: string | null
  matches: (label: string) => boolean
}) {
  const { t, i18n } = useTranslation('deal-card')
  const { deal } = card
  const money = (value: number) => formatMoney(value, deal.currency, i18n.language)
  const rows: [string, ReactNode][] = [
    [
      t('fields.amount'),
      <>
        <span data-testid="deal-amount">{money(deal.amount)}</span>{' '}
        <a href="#deal-products" className="deal-card__link">
          {t('summary.products', { count: deal.products.length })}
        </a>
      </>,
    ],
    [t('summary.productsTotal'), money(deal.productsTotal)],
    [t('fields.organizationId'), organizationName ?? t('summary.empty')],
    [
      t('fields.primaryContactId'),
      <>
        {contact ? contactName(contact) : '—'}
        {deal.participants.length > 0 &&
          ` ${t('summary.participants', { count: deal.participants.length })}`}
      </>,
    ],
    [
      t('fields.expectedCloseDate'),
      deal.expectedCloseDate
        ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeZone: 'UTC' }).format(
            new Date(`${deal.expectedCloseDate}T00:00:00Z`),
          )
        : t('summary.empty'),
    ],
  ]
  return (
    <dl className="deal-card__rows">
      {rows
        .filter(([label]) => matches(label))
        .map(([label, value]) => (
          <Row key={label} label={label}>
            {value}
          </Row>
        ))}
    </dl>
  )
}

/** «Деталі»: поля сделки, каждое правится на месте. */
function Details({ card, matches }: { card: DealCardModel; matches: (label: string) => boolean }) {
  const { t, i18n } = useTranslation('deal-card')
  const { deal, rights } = card
  const [error, setError] = useState<unknown>(null)
  const save = async (change: DealChange) => {
    setError(null)
    const failure = await card.act(() => card.api.update(card.projectId, deal.id, change))
    setError(failure)
    return failure === null
  }
  const fields = [
    {
      label: t('fields.amount'),
      filled: deal.amount > 0,
      node: (
        <EditableValue
          label={t('fields.amount')}
          shown={formatMoney(deal.amount, deal.currency, i18n.language)}
          initial={String(deal.amount)}
          canEdit={rights.edit}
          input={(value, set) => (
            <Input
              size="sm"
              type="number"
              min={0}
              step="0.01"
              aria-label={t('fields.amount')}
              value={value}
              onChange={(event) => set(event.target.value)}
            />
          )}
          onSave={(value) => {
            const amount = Number(value.replace(',', '.'))
            return Number.isFinite(amount) && amount >= 0
              ? save({ amount: Math.round(amount * 100) / 100 })
              : Promise.resolve(false)
          }}
        />
      ),
    },
    {
      label: t('fields.currency'),
      filled: true,
      node: (
        <EditableValue
          label={t('fields.currency')}
          shown={deal.currency}
          initial={deal.currency}
          canEdit={rights.edit}
          input={(value, set) => (
            <Select
              size="sm"
              aria-label={t('fields.currency')}
              value={value}
              onChange={(event) => set(event.target.value)}
            >
              {DEAL_CURRENCIES.map((currency) => (
                <option key={currency} value={currency}>
                  {currency}
                </option>
              ))}
            </Select>
          )}
          onSave={(value) => {
            const currency = DEAL_CURRENCIES.find((item) => item === value)
            return currency ? save({ currency }) : Promise.resolve(false)
          }}
        />
      ),
    },
    {
      label: t('fields.expectedCloseDate'),
      filled: deal.expectedCloseDate !== null,
      node: (
        <EditableValue
          label={t('fields.expectedCloseDate')}
          shown={deal.expectedCloseDate ?? t('summary.empty')}
          initial={deal.expectedCloseDate ?? ''}
          canEdit={rights.edit}
          input={(value, set) => (
            <Input
              size="sm"
              type="date"
              aria-label={t('fields.expectedCloseDate')}
              value={value}
              onChange={(event) => set(event.target.value)}
            />
          )}
          onSave={(value) => save({ expectedCloseDate: value === '' ? null : value })}
        />
      ),
    },
    {
      label: t('fields.createdAt'),
      filled: true,
      node: new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(
        new Date(deal.createdAt),
      ),
    },
  ]
  const shown = fields.filter((field) => matches(field.label))
  return (
    <details className="deal-card__group" open>
      <summary className="deal-card__group-head">
        <span>{t('details.main')}</span>
        <span className="deal-card__group-count">
          {t('details.filled', {
            filled: fields.filter((field) => field.filled).length,
            total: fields.length,
          })}
        </span>
      </summary>
      <dl className="deal-card__rows">
        {shown.map((field) => (
          <Row key={field.label} label={field.label}>
            {field.node}
          </Row>
        ))}
      </dl>
      <ActionError error={error} />
    </details>
  )
}

/** Значение поля; нажатие — поле ввода с «Зберегти» и «Скасувати». */
function EditableValue({
  label,
  shown,
  initial,
  canEdit,
  input,
  onSave,
}: {
  label: string
  shown: ReactNode
  initial: string
  canEdit: boolean
  input: (value: string, set: (value: string) => void) => ReactNode
  onSave: (value: string) => Promise<boolean>
}) {
  const { t } = useTranslation('deal-card')
  const [draft, setDraft] = useState<string | null>(null)
  if (!canEdit) return <span>{shown}</span>
  if (draft === null) {
    return (
      <button
        type="button"
        className="deal-card__value"
        aria-label={t('details.edit', { field: label })}
        onClick={() => setDraft(initial)}
      >
        {shown}
      </button>
    )
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (draft === initial || (await onSave(draft))) setDraft(null)
  }
  return (
    <form className="deal-card__value-form" aria-label={label} onSubmit={submit}>
      {input(draft, setDraft)}
      <Button type="submit" size="sm" variant="primary">
        {t('save')}
      </Button>
      <Button size="sm" variant="quiet" onClick={() => setDraft(null)}>
        {t('cancel')}
      </Button>
    </form>
  )
}

function PrimaryContact({
  card,
  contact,
  hidden,
}: {
  card: DealCardModel
  contact: ContactCard | null
  hidden: boolean
}) {
  const { t } = useTranslation('deal-card')
  const [changing, setChanging] = useState(false)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<unknown>(null)
  const search = useContactSearch(card)
  const [options, setOptions] = useState<ComboboxOption[]>([])

  if (hidden) return <p className="deal-card__stub">{t('contact.hidden')}</p>
  if (!contact) return <p className="deal-card__stub">{t('loading')}</p>

  return (
    <div className="deal-card__contact">
      <p className="deal-card__contact-name">
        {contactName(contact)}
        {contact.possibleDuplicate && <Badge tone="ask">{t('contact.duplicate')}</Badge>}
      </p>
      <dl className="deal-card__rows">
        {contact.phones.map((phone) => (
          <Row key={phone} label={t('contact.phone')}>
            <a href={`tel:${phone}`}>{phone}</a>
          </Row>
        ))}
        {contact.emails.map((email) => (
          <Row key={email} label={t('contact.email')}>
            <a href={`mailto:${email}`}>{email}</a>
          </Row>
        ))}
      </dl>
      {card.rights.edit &&
        (changing ? (
          <div className="deal-card__contact-change">
            <Combobox
              label={t('contact.search')}
              value={query}
              onValueChange={(value) => {
                setQuery(value)
                if (value.trim() === '') setOptions([])
                else
                  search(value.trim()).then(
                    (found) => setOptions(found.filter((option) => option.id !== contact.id)),
                    () => setOptions([]),
                  )
              }}
              options={options}
              emptyText={t('participants.notFound')}
              onSelect={async (option) => {
                const failure = await card.act(() =>
                  card.api.update(card.projectId, card.deal.id, { primaryContactId: option.id }),
                )
                setError(failure)
                if (!failure) setChanging(false)
              }}
            />
            <Button size="sm" variant="quiet" onClick={() => setChanging(false)}>
              {t('cancel')}
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="quiet" onClick={() => setChanging(true)}>
            {t('contact.change')}
          </Button>
        ))}
      <ActionError error={error} />
    </div>
  )
}

function useContactSearch(card: DealCardModel) {
  const { api, projectId } = card
  return useCallback(
    async (query: string) => (await api.searchContacts(projectId, query)).map(contactOption),
    [api, projectId],
  )
}

function DealParticipants({ card }: { card: DealCardModel }) {
  const { deal, api, projectId } = card
  const errorText = useCardErrorText()
  const search = useContactSearch(card)
  const contacts = useQueries({
    queries: deal.participants.map((participant) => ({
      queryKey: projectQueryKey(projectId, 'contact', participant.contactId),
      queryFn: () => api.contact(projectId, participant.contactId),
      retry: false,
    })),
  })
  const act = async (action: () => Promise<DealCard | undefined>) => {
    const failure = await card.act(action)
    if (failure) throw failure
  }
  return (
    <Participants
      participants={deal.participants.map((participant, index) => {
        const found = contacts[index]?.data
        return { ...participant, name: found ? contactName(found) : null }
      })}
      canEdit={card.rights.edit}
      search={async (query) => {
        const taken = new Set([deal.primaryContactId, ...deal.participants.map((p) => p.contactId)])
        return (await search(query)).filter((option) => !taken.has(option.id))
      }}
      onAdd={(contactId, role) =>
        act(() => api.addParticipant(projectId, deal.id, contactId, role))
      }
      onCreate={async (input, role) => {
        const created = await api.createContact(projectId, {
          firstName: input.firstName.trim(),
          ...(input.lastName.trim() === '' ? {} : { lastName: input.lastName.trim() }),
          ...(input.phone.trim() === '' ? {} : { phones: [input.phone.trim()] }),
        })
        await act(() => api.addParticipant(projectId, deal.id, created.id, role))
      }}
      onRoleChange={(contactId, role) =>
        act(() => api.updateParticipant(projectId, deal.id, contactId, role))
      }
      onRemove={(contactId) =>
        act(async () => {
          await api.removeParticipant(projectId, deal.id, contactId)
          return undefined
        })
      }
      errorText={errorText}
    />
  )
}

function DealLines({ card }: { card: DealCardModel }) {
  const { deal, api, projectId } = card
  const errorText = useCardErrorText()
  const catalogue = useQuery({
    queryKey: projectQueryKey(projectId, 'products'),
    queryFn: () => api.products(projectId),
    enabled: card.rights.edit,
    retry: false,
  })
  const act = async (action: () => Promise<DealCard | undefined>) => {
    const failure = await card.act(action)
    if (failure) throw failure
  }
  return (
    <DealProducts
      lines={deal.products}
      productsTotal={deal.productsTotal}
      amount={deal.amount}
      currency={deal.currency}
      canEdit={card.rights.edit}
      catalogue={catalogue.data}
      onAdd={(input) => act(() => api.addLine(projectId, deal.id, input))}
      onUpdate={(lineId, change) => act(() => api.updateLine(projectId, deal.id, lineId, change))}
      onRemove={(lineId) =>
        act(async () => {
          await api.removeLine(projectId, deal.id, lineId)
          return undefined
        })
      }
      onApplyTotal={() => act(() => api.applyProductsTotal(projectId, deal.id))}
      errorText={errorText}
    />
  )
}
