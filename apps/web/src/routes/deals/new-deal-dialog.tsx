import type { PipelineSummary } from '@alpi/shared'
import { useQuery } from '@tanstack/react-query'
import { type FormEvent, type ReactNode, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FieldDraft } from '../../components/custom-fields/field-values.ts'
import {
  collectRequired,
  type RequiredFieldProblem,
  readRequiredFieldsMissing,
  requiredAlways,
  requiredDrafts,
  requiredOnStage,
  splitByAccess,
} from '../../components/custom-fields/required-fields.ts'
import {
  RequiredFieldInputs,
  useMissingFieldsText,
} from '../../components/custom-fields/required-fields-form.tsx'
import {
  projectHref,
  projectQueryKey,
  useProjectCode,
} from '../../components/project-switcher/current-project.tsx'
import { Button } from '../../ui/button.tsx'
import { Combobox } from '../../ui/combobox.tsx'
import { Dialog } from '../../ui/dialog.tsx'
import { Field, Input, Select } from '../../ui/field.tsx'
import {
  type ContactOption,
  DEAL_CURRENCIES,
  type DealCurrency,
  type DealOwner,
  type DealsApi,
  DealsApiError,
  type NewDealInput,
} from './deals-api.ts'

// Форма «+ Угода» (тикет crm-deals/11): контакт — найти существующий или ввести нового, воронка
// и этап, название (предзаполнено «Ім'я Прізвище — »), сумма и валюта, ответственный (по
// умолчанию я). «Чужой клиент» показывается текстом «клієнт уже в роботі у <менеджер>» без
// его данных; «одна открытая сделка» — подсказкой со ссылкой на открытую сделку, если она видна.
// Обязательные пользовательские поля (тикет crm-fields/04): поля сделки «всегда» и обязательные
// на выбранном этапе выбранной воронки, а у нового контакта — его поля «всегда»; сразу в форме,
// без них запрос не уходит. Поля групп «только чтение» — строкой, без правки и без отправки.
// Остальное (поля скрытых от роли групп) решает сервер: отказ 422 — текстом со списком.

const AMOUNT = /^\d{1,12}([.,]\d{1,2})?$/

function contactName(contact: { firstName: string; lastName: string | null }): string {
  return [contact.firstName, contact.lastName].filter(Boolean).join(' ')
}

interface FormError {
  text: string
  /** Ссылка на открытую сделку того же клиента. */
  dealId?: string
}

export function NewDealDialog({
  api,
  projectId,
  pipelines,
  pipelineId: initialPipelineId,
  owners,
  userId,
  contact,
  onClose,
  onCreated,
}: {
  api: DealsApi
  projectId: string
  /** Действующие воронки проекта. */
  pipelines: PipelineSummary[]
  pipelineId: string
  /** Возможные ответственные; пусто — только я. */
  owners: DealOwner[]
  userId: string
  /** Контакт выбран заранее (кнопка «+ Угода» в карточке контакта, тикет crm-deals/14). */
  contact?: ContactOption
  onClose: () => void
  onCreated: () => void
}) {
  const { t } = useTranslation('deals')
  const code = useProjectCode()
  const formId = useId()
  const [search, setSearch] = useState(contact ? contactName(contact) : '')
  const [chosen, setChosen] = useState<ContactOption | null>(contact ?? null)
  const [isNewContact, setIsNewContact] = useState(false)
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [phone, setPhone] = useState('')
  const [pipelineId, setPipelineId] = useState(initialPipelineId)
  const pipeline = pipelines.find((p) => p.id === pipelineId) ?? pipelines[0]
  const [stageId, setStageId] = useState(pipeline?.stages[0]?.id ?? '')
  const [title, setTitle] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState<DealCurrency>('EUR')
  const [ownerId, setOwnerId] = useState(userId)
  const [error, setError] = useState<FormError | null>(null)
  const [sending, setSending] = useState(false)
  const missingText = useMissingFieldsText()
  // Тот же ключ, что у описаний полей канбана (kanban-page.tsx, boardKey): один запрос.
  const fields = useQuery({
    queryKey: projectQueryKey(projectId, 'deals', 'board', 'fields'),
    queryFn: () => api.fields(projectId),
    retry: false,
  })
  // Поля «всегда» нового контакта: описания грузятся сразу с формой, чтобы к нажатию «Новий
  // контакт» они уже были.
  const contactFields = useQuery({
    queryKey: projectQueryKey(projectId, 'deals', 'contact-fields'),
    queryFn: () => api.contactFields(projectId),
    retry: false,
  })
  // Права роли: поля групп «только чтение» не заполняются (тот же ключ, что у карточек).
  const access = useQuery({
    queryKey: projectQueryKey(projectId, 'access'),
    queryFn: () => api.access(projectId),
    retry: false,
  })
  const permissions = access.data?.permissions ?? null
  const { editable: required, readOnly } = splitByAccess(
    pipeline ? requiredOnStage(fields.data ?? [], pipeline, stageId) : [],
    permissions,
  )
  const [edited, setEdited] = useState<Record<string, FieldDraft>>({})
  const drafts = { ...requiredDrafts(required), ...edited }
  const [problems, setProblems] = useState<Record<string, RequiredFieldProblem>>({})
  const { editable: contactRequired, readOnly: contactReadOnly } = splitByAccess(
    isNewContact ? requiredAlways(contactFields.data ?? []) : [],
    permissions,
  )
  // Отдельно от полей сделки: коды полей уникальны только внутри сущности.
  const [contactEdited, setContactEdited] = useState<Record<string, FieldDraft>>({})
  const contactDrafts = { ...requiredDrafts(contactRequired), ...contactEdited }
  const [contactProblems, setContactProblems] = useState<Record<string, RequiredFieldProblem>>({})

  const text = search.trim()
  const suggestions = useQuery({
    queryKey: projectQueryKey(projectId, 'deals', 'contact-search', text),
    queryFn: () => api.searchContacts(projectId, text),
    enabled: !isNewContact && chosen === null && text.length >= 2,
    retry: false,
  })

  const name = isNewContact
    ? contactName({ firstName: firstName.trim(), lastName: lastName.trim() || null })
    : chosen
      ? contactName(chosen)
      : ''
  // Пока пользователь сам не правил название, оно следует за контактом.
  const titleValue = title ?? (name ? `${name} — ` : '')
  const ownerOptions = owners.some((o) => o.id === userId)
    ? owners
    : [{ id: userId, name: '' }, ...owners]
  // Варианты полей типа «користувач»: возможные ответственные.
  const members = ownerOptions.map((o) => ({
    userId: o.id,
    name: o.name || t('newDeal.meOnly'),
    disabled: false,
  }))

  function errorFor(failure: unknown): FormError {
    if (!(failure instanceof DealsApiError)) return { text: t('errors.unknown') }
    const manager =
      typeof failure.details.managerName === 'string' ? failure.details.managerName : null
    const missing = readRequiredFieldsMissing(failure.code, failure.details)
    if (missing) {
      const fields = missingText(missing)
      return {
        text:
          failure.code === 'STAGE_REQUIREMENTS_MISSING'
            ? t('errors.STAGE_REQUIREMENTS_MISSING', { fields })
            : t('errors.REQUIRED_FIELDS_MISSING', { fields }),
      }
    }
    switch (failure.code) {
      case 'OPEN_DEAL_EXISTS':
        if (typeof failure.details.dealId === 'string') {
          return { text: t('newDeal.openDealExists'), dealId: failure.details.dealId }
        }
        return {
          text: manager ? t('newDeal.inWorkAt', { name: manager }) : t('newDeal.inWorkElsewhere'),
        }
      case 'CONTACT_OUT_OF_SCOPE':
        return {
          text: manager ? t('newDeal.inWorkAt', { name: manager }) : t('newDeal.inWorkElsewhere'),
        }
      case 'CONTACT_EXISTS':
        return { text: t('newDeal.contactExists') }
      case 'INVALID_PHONE':
        return { text: t('newDeal.invalidPhone') }
      case 'INVALID_DEAL':
      case 'INVALID_CONTACT': {
        const path = typeof failure.details.path === 'string' ? failure.details.path : ''
        return { text: t('newDeal.invalidField', { field: t(`fields.${path}`, path) }) }
      }
      default:
        return { text: t(`errors.${failure.code}`, { defaultValue: t('errors.unknown') }) }
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    if (isNewContact ? firstName.trim() === '' : chosen === null) {
      setError({ text: t('newDeal.contactRequired') })
      return
    }
    if (titleValue.trim() === '') {
      setError({ text: t('newDeal.titleRequired') })
      return
    }
    const sum = amount.trim() === '' ? '0' : amount.trim()
    if (!AMOUNT.test(sum)) {
      setError({ text: t('newDeal.amountInvalid') })
      return
    }
    if (!pipeline) return
    // Описания полей нового контакта ещё грузятся — его поля «всегда» неизвестны: ждём.
    if (isNewContact && contactFields.isPending) return
    const collected = collectRequired(required, drafts)
    setProblems(collected.ok ? {} : collected.problems)
    const contactCollected = collectRequired(contactRequired, contactDrafts)
    setContactProblems(contactCollected.ok ? {} : contactCollected.problems)
    if (!collected.ok || !contactCollected.ok) {
      setError({ text: t('newDeal.requiredFields') })
      return
    }
    const input: NewDealInput = {
      title: titleValue.trim(),
      pipelineId: pipeline.id,
      stageId,
      amount: Number(sum.replace(',', '.')),
      currency,
      ownerId,
      ...(isNewContact
        ? {
            contact: {
              firstName: firstName.trim(),
              lastName: lastName.trim() || null,
              phones: phone.trim() === '' ? [] : [phone.trim()],
              ...(Object.keys(contactCollected.custom).length > 0
                ? { custom: contactCollected.custom }
                : {}),
            },
          }
        : { contactId: chosen?.id ?? '' }),
      ...(Object.keys(collected.custom).length > 0 ? { custom: collected.custom } : {}),
    }
    setSending(true)
    try {
      await api.create(projectId, input)
      onCreated()
    } catch (failure) {
      setError(errorFor(failure))
    } finally {
      setSending(false)
    }
  }

  let contactBlock: ReactNode
  if (isNewContact) {
    contactBlock = (
      <>
        <Field label={t('newDeal.firstName')}>
          <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} maxLength={100} />
        </Field>
        <Field label={t('newDeal.lastName')}>
          <Input value={lastName} onChange={(e) => setLastName(e.target.value)} maxLength={100} />
        </Field>
        <Field label={t('newDeal.phone')}>
          <Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        {contactRequired.length + contactReadOnly.length > 0 && (
          <fieldset className="kanban-form__required">
            <legend>{t('fill.contact')}</legend>
            <RequiredFieldInputs
              fields={contactRequired}
              readOnly={contactReadOnly}
              drafts={contactDrafts}
              onDraft={(fieldCode, draft) =>
                setContactEdited((current) => ({ ...current, [fieldCode]: draft }))
              }
              problems={contactProblems}
              members={members}
            />
          </fieldset>
        )}
        <Button variant="quiet" size="sm" onClick={() => setIsNewContact(false)}>
          {t('newDeal.existingContact')}
        </Button>
      </>
    )
  } else {
    contactBlock = (
      <>
        <Combobox
          label={t('newDeal.contactSearch')}
          value={search}
          onValueChange={(value) => {
            setSearch(value)
            setChosen(null)
          }}
          options={(suggestions.data ?? []).map((c) => ({
            id: c.id,
            label: contactName(c),
            ...(c.phones[0] ? { hint: c.phones[0] } : {}),
          }))}
          onSelect={(option) => {
            const contact = suggestions.data?.find((c) => c.id === option.id) ?? null
            setChosen(contact)
            setSearch(option.label)
          }}
          placeholder={t('newDeal.contactPlaceholder')}
          emptyText={t('newDeal.noContacts')}
        />
        <Button variant="quiet" size="sm" onClick={() => setIsNewContact(true)}>
          {t('newDeal.newContact')}
        </Button>
      </>
    )
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('newDeal.title')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('newDeal.cancel')}
          </Button>
          <Button variant="primary" type="submit" form={formId} disabled={sending}>
            {t('newDeal.submit')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="kanban-form"
        aria-label={t('newDeal.title')}
        onSubmit={(e) => void submit(e)}
      >
        {contactBlock}
        <Field label={t('newDeal.pipeline')}>
          <Select
            value={pipeline?.id ?? ''}
            onChange={(e) => {
              setPipelineId(e.target.value)
              const next = pipelines.find((p) => p.id === e.target.value)
              setStageId(next?.stages[0]?.id ?? '')
            }}
          >
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('newDeal.stage')}>
          <Select value={stageId} onChange={(e) => setStageId(e.target.value)}>
            {pipeline?.stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </Select>
        </Field>
        {required.length + readOnly.length > 0 && (
          <fieldset className="kanban-form__required">
            <legend>{t('fill.create')}</legend>
            <RequiredFieldInputs
              fields={required}
              readOnly={readOnly}
              drafts={drafts}
              onDraft={(fieldCode, draft) =>
                setEdited((current) => ({ ...current, [fieldCode]: draft }))
              }
              problems={problems}
              members={members}
            />
          </fieldset>
        )}
        <Field label={t('newDeal.dealTitle')}>
          <Input value={titleValue} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </Field>
        <div className="kanban-form__pair">
          <Field label={t('newDeal.amount')}>
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label={t('newDeal.currency')}>
            <Select value={currency} onChange={(e) => setCurrency(e.target.value as DealCurrency)}>
              {DEAL_CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={t('newDeal.owner')}>
          <Select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            {ownerOptions.map((owner) => (
              <option key={owner.id} value={owner.id}>
                {owner.id === userId
                  ? owner.name
                    ? t('newDeal.me', { name: owner.name })
                    : t('newDeal.meOnly')
                  : owner.name}
              </option>
            ))}
          </Select>
        </Field>
        {error && (
          <p className="ui-notice" role="alert">
            {error.text}
            {error.dealId && (
              <>
                {' '}
                <a href={projectHref(code, `/deals/${error.dealId}`)}>{t('newDeal.openDeal')}</a>
              </>
            )}
          </p>
        )}
      </form>
    </Dialog>
  )
}
