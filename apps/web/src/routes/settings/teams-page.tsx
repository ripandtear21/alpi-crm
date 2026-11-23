import type { MemberSummary, TeamSummary } from '@alpi/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  projectQueryKey,
  useCurrentProject,
} from '../../components/project-switcher/current-project.tsx'
import type { MembersApi } from './members-api.ts'
import { useApiErrorText } from './members-page.tsx'
import { RolesApiError } from './roles-api.ts'
import './members.css'
import './settings.css'
import { Button } from '../../ui/button.tsx'

// Настройки → команды: создать команду с тимлидом, переименовать, сменить тимлида, добавить и
// убрать участников. Тимлид один и сам состоит в команде, участник — не больше чем в одной
// команде (держит база); перевод участника из другой команды уводит его оттуда.

export function TeamsPage({ api }: { api: MembersApi }) {
  const { t } = useTranslation('settings')
  const { current } = useCurrentProject()
  if (!current) {
    return (
      <section>
        <h1>{t('teams.title')}</h1>
        <p>{t('members.noProject')}</p>
      </section>
    )
  }
  return <TeamsEditor key={current.id} api={api} projectId={current.id} />
}

function TeamsEditor({ api, projectId }: { api: MembersApi; projectId: string }) {
  const { t } = useTranslation('settings')
  const errorText = useApiErrorText()
  const queryClient = useQueryClient()
  const membersKey = projectQueryKey(projectId, 'members')
  const teamsKey = projectQueryKey(projectId, 'teams')
  const members = useQuery({
    queryKey: membersKey,
    queryFn: () => api.list(projectId),
    retry: false,
  })
  const teams = useQuery({
    queryKey: teamsKey,
    queryFn: () => api.listTeams(projectId),
    retry: false,
  })
  const [message, setMessage] = useState<string | null>(null)

  const change = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: membersKey })
      await queryClient.invalidateQueries({ queryKey: teamsKey })
      setMessage(t('members.saved'))
    },
    onError: (error) => setMessage(errorText(error)),
  })

  if (members.isPending || teams.isPending) return <p>{t('members.loading')}</p>
  if (members.isError || teams.isError) {
    const error = members.error ?? teams.error
    const denied = error instanceof RolesApiError && error.status === 403
    return (
      <section>
        <h1>{t('teams.title')}</h1>
        <p className="ui-notice" role="alert">
          {denied ? t('roles.noAccess') : t('roles.errors.unknown')}
        </p>
      </section>
    )
  }

  const run = (action: () => Promise<unknown>) => {
    setMessage(null)
    change.mutate(action)
  }
  // Тимлидом и участником команды становится только действующий участник.
  const active = members.data.filter((m) => !m.disabled)
  const nameOf = (userId: string) => {
    const member = members.data.find((m) => m.userId === userId)
    return member ? member.name || member.email : userId
  }

  return (
    <section className="members">
      <h1>{t('teams.title')}</h1>
      {message && (
        <p className="ui-notice" role="status">
          {message}
        </p>
      )}
      {teams.data.length === 0 && <p>{t('teams.empty')}</p>}
      {teams.data.map((team) => (
        <TeamCard
          key={team.id}
          team={team}
          members={active}
          nameOf={nameOf}
          isDisabled={(userId) => members.data.some((m) => m.userId === userId && m.disabled)}
          pending={change.isPending}
          onRename={(name) => run(() => api.updateTeam(projectId, team.id, { name }))}
          onLead={(leadUserId) => run(() => api.updateTeam(projectId, team.id, { leadUserId }))}
          onAdd={(userId) => run(() => api.setTeam(projectId, userId, team.id))}
          onRemove={(userId) => run(() => api.setTeam(projectId, userId, null))}
          onDelete={() => run(() => api.removeTeam(projectId, team.id))}
        />
      ))}
      <CreateTeamForm
        members={active}
        teams={teams.data}
        nameOf={nameOf}
        pending={change.isPending}
        onCreate={(input) => run(() => api.createTeam(projectId, input))}
      />
    </section>
  )
}

function TeamCard({
  team,
  members,
  nameOf,
  isDisabled,
  pending,
  onRename,
  onLead,
  onAdd,
  onRemove,
  onDelete,
}: {
  team: TeamSummary
  members: MemberSummary[]
  nameOf: (userId: string) => string
  isDisabled: (userId: string) => boolean
  pending: boolean
  onRename: (name: string) => void
  onLead: (userId: string) => void
  onAdd: (userId: string) => void
  onRemove: (userId: string) => void
  onDelete: () => void
}) {
  const { t } = useTranslation('settings')
  const [name, setName] = useState(team.name)
  const [toAdd, setToAdd] = useState('')
  const outside = members.filter((m) => m.teamId !== team.id)

  return (
    <article className="members__team" aria-label={team.name}>
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault()
          if (name.trim() !== '' && name.trim() !== team.name) onRename(name.trim())
        }}
      >
        <label>
          {t('teams.name')}{' '}
          <input
            className="ui-input ui-input--sm"
            value={name}
            maxLength={60}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </label>{' '}
        <Button size="sm" type="submit" disabled={pending}>
          {t('teams.rename')}
        </Button>
      </form>
      <label>
        {t('teams.lead')}{' '}
        <select
          className="ui-select ui-select--sm"
          aria-label={t('teams.leadOf', { name: team.name })}
          value={team.leadUserId}
          disabled={pending}
          onChange={(event) => onLead(event.target.value)}
        >
          {/* Тимлид может быть уже отключён на экране пользователей — он всё равно в списке. */}
          {!members.some((m) => m.userId === team.leadUserId) && (
            <option value={team.leadUserId}>{nameOf(team.leadUserId)}</option>
          )}
          {members.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.name || m.email}
            </option>
          ))}
        </select>
      </label>
      <ul aria-label={t('teams.membersOf', { name: team.name })}>
        {team.memberUserIds.map((userId) => (
          <li key={userId}>
            {nameOf(userId)}
            {/* Отключённый остаётся в команде: его закрытые сделки — история команды. */}
            {isDisabled(userId) && (
              <span className="members__hint"> — {t('members.disabledMark')}</span>
            )}
            {userId === team.leadUserId ? (
              <span className="members__hint"> — {t('teams.leadMark')}</span>
            ) : (
              <>
                {' '}
                <Button size="sm" type="button" disabled={pending} onClick={() => onRemove(userId)}>
                  {t('teams.remove', { name: nameOf(userId) })}
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
      <label>
        {t('teams.addMember')}{' '}
        <select
          className="ui-select ui-select--sm"
          aria-label={t('teams.addMemberTo', { name: team.name })}
          value={toAdd}
          onChange={(event) => setToAdd(event.target.value)}
        >
          <option value="">—</option>
          {outside.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.name || m.email}
            </option>
          ))}
        </select>
      </label>{' '}
      <Button
        size="sm"
        type="button"
        disabled={pending || toAdd === ''}
        onClick={() => {
          onAdd(toAdd)
          setToAdd('')
        }}
      >
        {t('teams.add')}
      </Button>{' '}
      <Button size="sm" variant="danger" type="button" disabled={pending} onClick={onDelete}>
        {t('teams.delete', { name: team.name })}
      </Button>
    </article>
  )
}

function CreateTeamForm({
  members,
  teams,
  nameOf,
  pending,
  onCreate,
}: {
  members: MemberSummary[]
  teams: TeamSummary[]
  nameOf: (userId: string) => string
  pending: boolean
  onCreate: (input: { name: string; leadUserId: string }) => void
}) {
  const { t } = useTranslation('settings')
  // Тот, кто уже ведёт команду, вторую не ведёт.
  const leads = new Set(teams.map((team) => team.leadUserId))
  const candidates = members.filter((m) => !leads.has(m.userId))
  return (
    <form
      className="members__add"
      aria-label={t('teams.new')}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        const form = new FormData(event.currentTarget)
        const name = String(form.get('name')).trim()
        const leadUserId = String(form.get('leadUserId'))
        if (name !== '' && leadUserId !== '') {
          onCreate({ name, leadUserId })
          event.currentTarget.reset()
        }
      }}
    >
      <h2>{t('teams.new')}</h2>
      <label>
        {t('teams.name')}{' '}
        <input className="ui-input ui-input--sm" name="name" maxLength={60} required />
      </label>
      <label>
        {t('teams.lead')}{' '}
        <select className="ui-select ui-select--sm" name="leadUserId" required defaultValue="">
          <option value="" disabled>
            —
          </option>
          {candidates.map((m) => (
            <option key={m.userId} value={m.userId}>
              {nameOf(m.userId)}
            </option>
          ))}
        </select>
      </label>
      <Button size="sm" type="submit" variant="primary" disabled={pending}>
        {t('teams.create')}
      </Button>
    </form>
  )
}
