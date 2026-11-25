import { formatPhone, normalizeEmail, normalizePhone } from '@alpi/shared'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { type FormEvent, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/button.tsx'
import { Combobox, type ComboboxOption } from '../../ui/combobox.tsx'
import { Dialog } from '../../ui/dialog.tsx'
import { Field, Input, Select } from '../../ui/field.tsx'
import { fieldsQueryKey, membersQueryKey } from '../custom-fields/custom-field-groups.tsx'
import { useCustomFieldsApi } from '../custom-fields/custom-fields-api.tsx'
import type { FieldDraft } from '../custom-fields/field-values.ts'
import {
  collectRequired,
  type RequiredFieldProblem,
  readRequiredFieldsMissing,
  requiredAlways,
  requiredDrafts,
} from '../custom-fields/required-fields.ts'
import {
  RequiredFieldInputs,
  useMissingFieldsText,
} from '../custom-fields/required-fields-form.tsx'
import { projectQueryKey, useProjectCode } from '../project-switcher/current-project.tsx'
import {
  CONTACT_LANGUAGES,
  type ContactInput,
  type ContactLanguage,
  type ContactRecord,
  type ContactsApi,
  ContactsApiError,
  type OrganizationRecord,
} from './contacts-api.ts'
import './record-card.css'

// Форма контакта (тикет crm-deals/14): создание и изменение из карточек контакта и
// организации. Имя и фамилия, телефоны и email (несколько, первый — основной; телефон — в любом
// формате, сервер приводит его к E.164), язык общения, организация (найти или создать; не
// больше одной).
//
// Неразбираемый телефон или email подсвечивается у своего поля ещё до запроса. Ответы API:
// «чужий клієнт» — «клієнт уже в роботі у <менеджер>» без данных чужого контакта; телефон у
// видимого контакта — ссылка «відкрити існуючий»; совпал только email — контакт создаётся с
// пометкой «можливий дубль» (её показывает карточка).
//
// Новый контакт показывает пользовательские поля «всегда» (тикет crm-fields/04): без них запрос
// не уходит. Отказ 422 об обязательных полях (поля, скрытые от роли; «всегда» новой организации)
// — текстом со списком.

export function contactName(contact: { firstName: string; lastName: string | null }): string {
  return [contact.firstName, contact.lastName].filter(Boolean).join(' ')
}

interface Row {
  key: number
  value: string
}

interface FormError {
  text: string
  /** Ссылка на найденный контакт с тем же телефоном. */
  contactId?: string
}

const NEW_ORGANIZATION = 'new-organization'

/** Текст отказа API по контакту; `contactId` — ссылка на существующий контакт. */
function useContactError() {
  const { t } = useTranslation('contact-card')
  const missingText = useMissingFieldsText()
  return (failure: unknown): FormError => {
    if (!(failure instanceof ContactsApiError)) return { text: t('errors.unknown') }
    const missing = readRequiredFieldsMissing(failure.code, failure.details)
    if (missing)
      return { text: t('errors.REQUIRED_FIELDS_MISSING', { fields: missingText(missing) }) }
    if (failure.code === 'CONTACT_OUT_OF_SCOPE') {
      // Без данных чужого контакта: только имя менеджера, если клиент у него в работе.
      const manager =
        typeof failure.details.managerName === 'string' ? failure.details.managerName : null
      return {
        text: manager ? t('errors.inWorkAt', { name: manager }) : t('errors.inWorkElsewhere'),
      }
    }
    if (failure.code === 'CONTACT_EXISTS' && typeof failure.details.contactId === 'string') {
      return { text: t('errors.CONTACT_EXISTS'), contactId: failure.details.contactId }
    }
    return { text: t(`errors.${failure.code}`, { defaultValue: t('errors.unknown') }) }
  }
}

export function FormErrorNotice({
  error,
  onOpenExisting,
}: {
  error: FormError | null
  onOpenExisting?: () => void
}) {
  const { t } = useTranslation('contact-card')
  const code = useProjectCode()
  if (!error) return null
  return (
    <p className="ui-notice" role="alert">
      {error.text}
      {error.contactId && (
        <>
          {' '}
          <Link
            to="/p/$code/contacts/$contactId"
            params={{ code, contactId: error.contactId }}
            onClick={onOpenExisting}
          >
            {t('errors.openExisting')}
          </Link>
        </>
      )}
    </p>
  )
}

/**
 * Диалог формы контакта. `contact` — изменяемый контакт, null — новый; `organization` —
 * организация нового контакта по умолчанию (карточка организации).
 */
export function ContactFormDialog({
  api,
  projectId,
  contact,
  organization = null,
  canCreateOrganization,
  onClose,
  onSaved,
}: {
  api: ContactsApi
  projectId: string
  contact: ContactRecord | null
  organization?: OrganizationRecord | null
  canCreateOrganization: boolean
  onClose: () => void
  onSaved: (contact: ContactRecord) => void
}) {
  const { t } = useTranslation('contact-card')
  const formId = useId()
  const nextKey = useRef(0)
  const rows = (values: string[]): Row[] =>
    (values.length === 0 ? [''] : values).map((value) => ({ key: nextKey.current++, value }))

  const [firstName, setFirstName] = useState(contact?.firstName ?? '')
  const [lastName, setLastName] = useState(contact?.lastName ?? '')
  const [language, setLanguage] = useState<ContactLanguage | ''>(contact?.language ?? '')
  const [phones, setPhones] = useState(() => rows((contact?.phones ?? []).map(formatPhone)))
  const [emails, setEmails] = useState(() => rows(contact?.emails ?? []))
  const [chosenOrganization, setChosenOrganization] = useState<{
    id: string
    name: string
  } | null>(organization)
  const initialOrganizationId = contact?.organizationId ?? null
  // Организация изменяемого контакта: её название — отдельным запросом.
  const current = useQuery({
    queryKey: projectQueryKey(projectId, 'organization', initialOrganizationId),
    queryFn: () => api.organization(projectId, initialOrganizationId ?? ''),
    enabled: initialOrganizationId !== null && organization === null,
    retry: false,
  })
  const [organizationTouched, setOrganizationTouched] = useState(false)
  const shownOrganization = organizationTouched
    ? chosenOrganization
    : (chosenOrganization ??
      (initialOrganizationId === null
        ? null
        : { id: initialOrganizationId, name: current.data?.name ?? '…' }))
  const [organizationSearch, setOrganizationSearch] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [phoneErrors, setPhoneErrors] = useState<Record<number, string>>({})
  const [emailErrors, setEmailErrors] = useState<Record<number, string>>({})
  const [error, setError] = useState<FormError | null>(null)
  const [sending, setSending] = useState(false)
  const contactError = useContactError()
  // Поля «всегда» нового контакта (тикет crm-fields/04).
  const fieldsApi = useCustomFieldsApi()
  const fieldDefinitions = useQuery({
    queryKey: fieldsQueryKey(projectId, 'contact'),
    queryFn: () => fieldsApi.fields(projectId, 'contact'),
    enabled: contact === null,
    retry: false,
  })
  const required = contact === null ? requiredAlways(fieldDefinitions.data ?? []) : []
  const members = useQuery({
    queryKey: membersQueryKey(projectId),
    queryFn: () => fieldsApi.members(projectId),
    enabled: required.some((field) => field.type === 'user'),
    retry: false,
  })
  const [edited, setEdited] = useState<Record<string, FieldDraft>>({})
  const drafts = { ...requiredDrafts(required), ...edited }
  const [problems, setProblems] = useState<Record<string, RequiredFieldProblem>>({})

  const searchText = organizationSearch.trim()
  const suggestions = useQuery({
    queryKey: projectQueryKey(projectId, 'organizations', 'search', searchText),
    queryFn: () => api.searchOrganizations(projectId, searchText),
    enabled: searchText.length >= 1,
    retry: false,
  })
  const organizationOptions: ComboboxOption[] = [
    ...(suggestions.data ?? []).map((org) => ({ id: org.id, label: org.name })),
    ...(canCreateOrganization && searchText !== ''
      ? [{ id: NEW_ORGANIZATION, label: t('form.createOrganization', { name: searchText }) }]
      : []),
  ]

  async function chooseOrganization(option: ComboboxOption) {
    setError(null)
    if (option.id !== NEW_ORGANIZATION) {
      setChosenOrganization({ id: option.id, name: option.label })
      setOrganizationTouched(true)
      setOrganizationSearch('')
      return
    }
    try {
      const created = await api.createOrganization(projectId, { name: searchText })
      setChosenOrganization({ id: created.id, name: created.name })
      setOrganizationTouched(true)
      setOrganizationSearch('')
    } catch (failure) {
      setError(contactError(failure))
    }
  }

  /** Непустые значения и номера их строк в форме: по номеру ошибка API находит поле. */
  const filled = (list: Row[]) => list.filter((row) => row.value.trim() !== '')

  /** Номер строки формы для пути ошибки API `phones.N` / `emails.N`. */
  function rowIndexOf(list: Row[], path: unknown, field: 'phones' | 'emails'): number | null {
    if (typeof path !== 'string' || !path.startsWith(`${field}.`)) return null
    const sent = filled(list)[Number(path.slice(field.length + 1))]
    return sent ? list.indexOf(sent) : null
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    const name = firstName.trim()
    setNameError(name === '' ? t('form.firstNameRequired') : null)
    const badPhones: Record<number, string> = {}
    phones.forEach((row, index) => {
      if (row.value.trim() !== '' && normalizePhone(row.value) === null) {
        badPhones[index] = t('form.invalidPhone')
      }
    })
    const badEmails: Record<number, string> = {}
    emails.forEach((row, index) => {
      if (row.value.trim() !== '' && normalizeEmail(row.value) === null) {
        badEmails[index] = t('form.invalidEmail')
      }
    })
    setPhoneErrors(badPhones)
    setEmailErrors(badEmails)
    const collected = collectRequired(required, drafts)
    setProblems(collected.ok ? {} : collected.problems)
    if (name === '' || Object.keys(badPhones).length + Object.keys(badEmails).length > 0) return
    if (!collected.ok) return

    const input: ContactInput = {
      firstName: name,
      lastName: lastName.trim() || null,
      language: language === '' ? null : language,
      phones: filled(phones).map((row) => row.value.trim()),
      emails: filled(emails).map((row) => row.value.trim()),
    }
    if (contact === null || organizationTouched) {
      input.organizationId = shownOrganization?.id ?? null
    }
    if (Object.keys(collected.custom).length > 0) input.custom = collected.custom
    setSending(true)
    try {
      const saved =
        contact === null
          ? await api.createContact(projectId, input)
          : await api.updateContact(projectId, contact.id, input)
      onSaved(saved)
    } catch (failure) {
      if (failure instanceof ContactsApiError && failure.code === 'INVALID_PHONE') {
        const index = rowIndexOf(phones, failure.details.path, 'phones')
        if (index !== null) {
          setPhoneErrors({ [index]: t('form.invalidPhone') })
          return
        }
      }
      if (failure instanceof ContactsApiError && failure.code === 'INVALID_EMAIL') {
        const index = rowIndexOf(emails, failure.details.path, 'emails')
        if (index !== null) {
          setEmailErrors({ [index]: t('form.invalidEmail') })
          return
        }
      }
      setError(contactError(failure))
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={contact === null ? t('form.newTitle') : t('form.editTitle')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="primary" type="submit" form={formId} busy={sending}>
            {t('form.save')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="record-form"
        aria-label={contact === null ? t('form.newTitle') : t('form.editTitle')}
        noValidate
        onSubmit={(e) => void submit(e)}
      >
        <div className="record-form__pair">
          <Field label={t('form.firstName')} error={nameError}>
            <Input
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              maxLength={100}
            />
          </Field>
          <Field label={t('form.lastName')}>
            <Input value={lastName} onChange={(e) => setLastName(e.target.value)} maxLength={100} />
          </Field>
        </div>
        <KeyList
          rows={phones}
          errors={phoneErrors}
          type="tel"
          label={t('form.phone')}
          primaryLabel={t('form.phonePrimary')}
          addLabel={t('form.addPhone')}
          onChange={(next) => {
            setPhones(next)
            setPhoneErrors({})
          }}
          newRow={() => ({ key: nextKey.current++, value: '' })}
        />
        <KeyList
          rows={emails}
          errors={emailErrors}
          type="email"
          label={t('form.email')}
          primaryLabel={t('form.emailPrimary')}
          addLabel={t('form.addEmail')}
          onChange={(next) => {
            setEmails(next)
            setEmailErrors({})
          }}
          newRow={() => ({ key: nextKey.current++, value: '' })}
        />
        <Field label={t('form.language')}>
          <Select
            value={language}
            onChange={(e) => setLanguage(e.target.value as ContactLanguage | '')}
          >
            <option value="">{t('form.noLanguage')}</option>
            {CONTACT_LANGUAGES.map((code) => (
              <option key={code} value={code}>
                {t(`languages.${code}`)}
              </option>
            ))}
          </Select>
        </Field>
        {shownOrganization ? (
          <div className="record-form__organization">
            <span className="ui-field__label">{t('form.organization')}</span>
            <span className="record-form__organization-name">{shownOrganization.name}</span>
            <Button
              variant="quiet"
              size="sm"
              onClick={() => {
                setChosenOrganization(null)
                setOrganizationTouched(true)
              }}
            >
              {t('form.clearOrganization')}
            </Button>
          </div>
        ) : (
          <Combobox
            label={t('form.organizationSearch')}
            value={organizationSearch}
            onValueChange={setOrganizationSearch}
            options={organizationOptions}
            onSelect={(option) => void chooseOrganization(option)}
            placeholder={t('form.organizationPlaceholder')}
            emptyText={t('form.noOrganizations')}
          />
        )}
        <RequiredFieldInputs
          fields={required}
          drafts={drafts}
          onDraft={(code, draft) => setEdited((current) => ({ ...current, [code]: draft }))}
          problems={problems}
          members={members.data ?? []}
        />
        <FormErrorNotice error={error} onOpenExisting={onClose} />
      </form>
    </Dialog>
  )
}

/** Список телефонов или email: первый — основной, любой можно сделать основным или убрать. */
function KeyList({
  rows,
  errors,
  type,
  label,
  primaryLabel,
  addLabel,
  onChange,
  newRow,
}: {
  rows: Row[]
  errors: Record<number, string>
  type: 'tel' | 'email'
  label: string
  primaryLabel: string
  addLabel: string
  onChange: (rows: Row[]) => void
  newRow: () => Row
}) {
  const { t } = useTranslation('contact-card')
  return (
    <div className="record-form__keys">
      {rows.map((row, index) => (
        <div key={row.key} className="record-form__key">
          <Field label={index === 0 ? primaryLabel : label} error={errors[index]}>
            <Input
              type={type}
              value={row.value}
              onChange={(e) =>
                onChange(rows.map((r) => (r.key === row.key ? { ...r, value: e.target.value } : r)))
              }
            />
          </Field>
          <div className="record-form__key-actions">
            {index > 0 && (
              <Button
                variant="quiet"
                size="sm"
                onClick={() => onChange([row, ...rows.filter((r) => r.key !== row.key)])}
              >
                {t('form.makePrimary')}
              </Button>
            )}
            {rows.length > 1 && (
              <Button
                variant="quiet"
                size="sm"
                onClick={() => onChange(rows.filter((r) => r.key !== row.key))}
              >
                {t('form.removeItem')}
              </Button>
            )}
          </div>
        </div>
      ))}
      <Button variant="quiet" size="sm" onClick={() => onChange([...rows, newRow()])}>
        {addLabel}
      </Button>
    </div>
  )
}
