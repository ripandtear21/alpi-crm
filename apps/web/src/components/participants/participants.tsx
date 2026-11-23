import { type FormEvent, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/button.tsx'
import { Combobox, type ComboboxOption } from '../../ui/combobox.tsx'
import { Field, Input } from '../../ui/field.tsx'
import './participants.css'

// Участники сделки с ролями (тикет crm-deals/13): список, добавить — найти контакт или завести
// новый, изменить роль, убрать. Данные и запросы — у экрана: компонент получает участников с
// уже известными именами и вызывает действия; отказ действия показывает текстом errorText.

/** Наибольшая длина роли — как в API (MAX_ROLE_LENGTH в apps/api/src/deals/deals.ts). */
const MAX_ROLE_LENGTH = 100
/** Пауза перед поиском контакта: не запрос на каждую букву. */
const SEARCH_DELAY_MS = 250

export interface ParticipantRow {
  contactId: string
  role: string | null
  /** Имя контакта; null — ещё не загружено или не видно. */
  name: string | null
}

export interface NewParticipantInput {
  firstName: string
  lastName: string
  phone: string
}

export interface ParticipantsProps {
  participants: ParticipantRow[]
  canEdit: boolean
  search: (query: string) => Promise<ComboboxOption[]>
  onAdd: (contactId: string, role: string | null) => Promise<unknown>
  onCreate: (input: NewParticipantInput, role: string | null) => Promise<unknown>
  onRoleChange: (contactId: string, role: string | null) => Promise<unknown>
  onRemove: (contactId: string) => Promise<unknown>
  errorText: (error: unknown) => string
}

const roleOrNull = (value: string) => (value.trim() === '' ? null : value.trim())

export function Participants(props: ParticipantsProps) {
  const { t } = useTranslation('deal-card')
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  /** Действие с отказом в строке ошибки; true — API принял. */
  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    setError(null)
    try {
      await action()
      return true
    } catch (failure) {
      setError(props.errorText(failure))
      return false
    }
  }

  return (
    <div className="participants">
      {props.participants.length === 0 ? (
        <p className="participants__empty">{t('participants.empty')}</p>
      ) : (
        <ul className="participants__list">
          {props.participants.map((participant) => (
            <ParticipantItem
              // Новая роль с сервера — поле заново.
              key={`${participant.contactId}|${participant.role ?? ''}`}
              participant={participant}
              canEdit={props.canEdit}
              run={run}
              onRoleChange={props.onRoleChange}
              onRemove={props.onRemove}
            />
          ))}
        </ul>
      )}
      {error && (
        <p className="ui-notice" role="alert">
          {error}
        </p>
      )}
      {props.canEdit &&
        (adding ? (
          <AddParticipant {...props} run={run} onDone={() => setAdding(false)} />
        ) : (
          <Button size="sm" variant="quiet" onClick={() => setAdding(true)}>
            {t('participants.add')}
          </Button>
        ))}
    </div>
  )
}

function ParticipantItem({
  participant,
  canEdit,
  run,
  onRoleChange,
  onRemove,
}: {
  participant: ParticipantRow
  canEdit: boolean
  run: (action: () => Promise<unknown>) => Promise<boolean>
  onRoleChange: ParticipantsProps['onRoleChange']
  onRemove: ParticipantsProps['onRemove']
}) {
  const { t } = useTranslation('deal-card')
  const [role, setRole] = useState(participant.role ?? '')
  const [busy, setBusy] = useState(false)
  const name = participant.name ?? t('participants.unknown')
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true)
    await run(action)
    setBusy(false)
  }
  return (
    <li className="participants__item">
      <span className="participants__name">{name}</span>
      {canEdit ? (
        <form
          className="participants__role"
          aria-label={t('participants.roleOf', { name })}
          onSubmit={(event) => {
            event.preventDefault()
            act(() => onRoleChange(participant.contactId, roleOrNull(role)))
          }}
        >
          <Input
            size="sm"
            aria-label={t('participants.role')}
            placeholder={t('participants.rolePlaceholder')}
            maxLength={MAX_ROLE_LENGTH}
            value={role}
            onChange={(event) => setRole(event.target.value)}
          />
          {role !== (participant.role ?? '') && (
            <Button type="submit" size="sm" busy={busy}>
              {t('participants.saveRole')}
            </Button>
          )}
          <Button
            size="sm"
            variant="quiet"
            busy={busy}
            aria-label={t('participants.remove', { name })}
            title={t('participants.remove', { name })}
            onClick={() => act(() => onRemove(participant.contactId))}
          >
            <span aria-hidden="true">✕</span>
          </Button>
        </form>
      ) : (
        participant.role && <span className="participants__role-text">{participant.role}</span>
      )}
    </li>
  )
}

function AddParticipant({
  search,
  onAdd,
  onCreate,
  run,
  onDone,
}: ParticipantsProps & {
  run: (action: () => Promise<unknown>) => Promise<boolean>
  onDone: () => void
}) {
  const { t } = useTranslation('deal-card')
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<ComboboxOption[]>([])
  const [role, setRole] = useState('')
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState<NewParticipantInput>({
    firstName: '',
    lastName: '',
    phone: '',
  })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const text = query.trim()
    if (text === '') {
      setOptions([])
      return
    }
    let stale = false
    const timer = setTimeout(() => {
      search(text).then(
        (found) => {
          if (!stale) setOptions(found)
        },
        () => {
          if (!stale) setOptions([])
        },
      )
    }, SEARCH_DELAY_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [query, search])

  const finish = async (action: () => Promise<unknown>) => {
    setBusy(true)
    const done = await run(action)
    setBusy(false)
    if (done) onDone()
  }

  const create = (event: FormEvent) => {
    event.preventDefault()
    if (draft.firstName.trim() === '') return
    finish(() => onCreate(draft, roleOrNull(role)))
  }

  return (
    <div className="participants__add">
      <Field label={t('participants.role')}>
        <Input
          size="sm"
          maxLength={MAX_ROLE_LENGTH}
          placeholder={t('participants.rolePlaceholder')}
          value={role}
          onChange={(event) => setRole(event.target.value)}
        />
      </Field>
      {creating ? (
        <form className="participants__new" aria-label={t('participants.new')} onSubmit={create}>
          <Field label={t('participants.firstName')}>
            <Input
              size="sm"
              required
              value={draft.firstName}
              onChange={(event) => setDraft({ ...draft, firstName: event.target.value })}
            />
          </Field>
          <Field label={t('participants.lastName')}>
            <Input
              size="sm"
              value={draft.lastName}
              onChange={(event) => setDraft({ ...draft, lastName: event.target.value })}
            />
          </Field>
          <Field label={t('participants.phone')}>
            <Input
              size="sm"
              type="tel"
              value={draft.phone}
              onChange={(event) => setDraft({ ...draft, phone: event.target.value })}
            />
          </Field>
          <div className="participants__actions">
            <Button type="submit" size="sm" variant="primary" busy={busy}>
              {t('participants.createAndAdd')}
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setCreating(false)}>
              {t('participants.backToSearch')}
            </Button>
          </div>
        </form>
      ) : (
        <>
          <Combobox
            label={t('participants.search')}
            value={query}
            onValueChange={setQuery}
            options={options}
            emptyText={t('participants.notFound')}
            onSelect={(option) => finish(() => onAdd(option.id, roleOrNull(role)))}
          />
          <div className="participants__actions">
            <Button size="sm" variant="quiet" onClick={() => setCreating(true)}>
              {t('participants.newContact')}
            </Button>
            <Button size="sm" variant="quiet" onClick={onDone}>
              {t('participants.cancel')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
