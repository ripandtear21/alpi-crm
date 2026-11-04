import type { MemberSummary, RoleSummary, TeamSummary } from '@alpi/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  projectQueryKey,
  useCurrentProject,
} from '../../components/project-switcher/current-project.tsx'
import type { MembersApi } from './members-api.ts'
import { type RolesApi, RolesApiError } from './roles-api.ts'
import { useRoleName } from './roles-page.tsx'
import './members.css'

// Настройки → пользователи: участники проекта с ролью, командой, приёмом новых сделок и
// отключением; добавление существующего пользователя или новой учётной записи с временным
// паролем (показывается один раз). Что кому можно, решает API (права и правила guard.ts):
// экран показывает его отказ текстом.

/** Текст ошибки API: сначала коды участников, затем коды ролей. */
export function useApiErrorText() {
  const { t } = useTranslation('settings')
  return (error: unknown) => {
    const code = error instanceof RolesApiError ? error.code : ''
    return t(`members.errors.${code}`, {
      defaultValue: t(`roles.errors.${code}`, { defaultValue: t('roles.errors.unknown') }),
    })
  }
}

export function MembersPage({ api, roles }: { api: MembersApi; roles: RolesApi }) {
  const { t } = useTranslation('settings')
  const { current } = useCurrentProject()
  if (!current) {
    return (
      <section>
        <h1>{t('members.title')}</h1>
        <p>{t('members.noProject')}</p>
      </section>
    )
  }
  return <MembersEditor key={current.id} api={api} roles={roles} projectId={current.id} />
}

function MembersEditor({
  api,
  roles,
  projectId,
}: {
  api: MembersApi
  roles: RolesApi
  projectId: string
}) {
  const { t } = useTranslation('settings')
  const roleName = useRoleName()
  const errorText = useApiErrorText()
  const queryClient = useQueryClient()
  const membersKey = projectQueryKey(projectId, 'members')
  const teamsKey = projectQueryKey(projectId, 'teams')
  const rolesKey = projectQueryKey(projectId, 'roles')
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
  const roleList = useQuery({
    queryKey: rolesKey,
    queryFn: () => roles.list(projectId),
    retry: false,
  })
  const [message, setMessage] = useState<string | null>(null)
  const [password, setPassword] = useState<{ email: string; value: string } | null>(null)

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: membersKey })
    await queryClient.invalidateQueries({ queryKey: teamsKey })
    // Число участников роли — на экране ролей.
    await queryClient.invalidateQueries({ queryKey: rolesKey })
  }

  const change = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: async () => {
      await refresh()
      setMessage(t('members.saved'))
    },
    onError: (error) => setMessage(errorText(error)),
  })

  if (members.isPending || teams.isPending || roleList.isPending) {
    return <p>{t('members.loading')}</p>
  }
  if (members.isError || teams.isError || roleList.isError) {
    const error = members.error ?? teams.error ?? roleList.error
    const denied = error instanceof RolesApiError && error.status === 403
    return (
      <section>
        <h1>{t('members.title')}</h1>
        <p role="alert">{denied ? t('roles.noAccess') : t('roles.errors.unknown')}</p>
      </section>
    )
  }

  const run = (action: () => Promise<unknown>) => {
    setMessage(null)
    change.mutate(action)
  }

  return (
    <section className="members">
      <h1>{t('members.title')}</h1>

      {password && (
        <TemporaryPassword
          email={password.email}
          password={password.value}
          onDone={() => setPassword(null)}
        />
      )}

      <div className="members__table">
        <table>
          <caption>{t('members.listLabel')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('members.user')}</th>
              <th scope="col">{t('members.role')}</th>
              <th scope="col">{t('members.team')}</th>
              <th scope="col">{t('members.acceptsNewDeals')}</th>
              <th scope="col">{t('members.status')}</th>
            </tr>
          </thead>
          <tbody>
            {members.data.map((member) => (
              <MemberRow
                key={member.userId}
                member={member}
                roles={roleList.data}
                teams={teams.data}
                roleName={roleName}
                pending={change.isPending}
                onRole={(roleId) => run(() => api.setRole(projectId, member.userId, roleId))}
                onTeam={(teamId) => run(() => api.setTeam(projectId, member.userId, teamId))}
                onAccepts={(value) =>
                  run(() => api.setAcceptsNewDeals(projectId, member.userId, value))
                }
                onToggle={() =>
                  run(() =>
                    member.disabled
                      ? api.enable(projectId, member.userId)
                      : api.disable(projectId, member.userId),
                  )
                }
              />
            ))}
          </tbody>
        </table>
      </div>
      {message && <p role="status">{message}</p>}

      <AddMemberForm
        roles={roleList.data}
        teams={teams.data}
        roleName={roleName}
        onSubmit={async (input) => {
          setMessage(null)
          try {
            if (input.name === null) {
              await api.addExisting(projectId, input)
              setMessage(t('members.added'))
            } else {
              const created = await api.create(projectId, { ...input, name: input.name })
              setPassword({ email: created.member.email, value: created.temporaryPassword })
              setMessage(t('members.created'))
            }
            await refresh()
            return true
          } catch (error) {
            setMessage(errorText(error))
            return false
          }
        }}
      />
    </section>
  )
}

function MemberRow({
  member,
  roles,
  teams,
  roleName,
  pending,
  onRole,
  onTeam,
  onAccepts,
  onToggle,
}: {
  member: MemberSummary
  roles: RoleSummary[]
  teams: TeamSummary[]
  roleName: (role: RoleSummary) => string
  pending: boolean
  onRole: (roleId: string) => void
  onTeam: (teamId: string | null) => void
  onAccepts: (value: boolean) => void
  onToggle: () => void
}) {
  const { t } = useTranslation('settings')
  const who = member.name || member.email
  return (
    <tr className={member.disabled ? 'members__disabled' : undefined}>
      <th scope="row">
        {member.name}
        <span className="members__email">{member.email}</span>
      </th>
      <td>
        <select
          aria-label={t('members.roleOf', { name: who })}
          value={member.roleId}
          disabled={pending}
          onChange={(event) => onRole(event.target.value)}
        >
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {roleName(role)}
            </option>
          ))}
        </select>
      </td>
      <td>
        <select
          aria-label={t('members.teamOf', { name: who })}
          value={member.teamId ?? ''}
          disabled={pending}
          onChange={(event) => onTeam(event.target.value === '' ? null : event.target.value)}
        >
          <option value="">{t('members.noTeam')}</option>
          {teams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input
          type="checkbox"
          aria-label={t('members.acceptsOf', { name: who })}
          checked={member.acceptsNewDeals}
          disabled={pending}
          onChange={(event) => onAccepts(event.target.checked)}
        />
      </td>
      <td>
        {member.disabled ? t('members.disabled') : t('members.active')}{' '}
        <button type="button" disabled={pending} onClick={onToggle}>
          {member.disabled
            ? t('members.enable', { name: who })
            : t('members.disable', { name: who })}
        </button>
      </td>
    </tr>
  )
}

interface AddInput {
  email: string
  /** null — существующий пользователь; строка — новая учётная запись с этим именем. */
  name: string | null
  roleId: string
  teamId: string | null
}

function AddMemberForm({
  roles,
  teams,
  roleName,
  onSubmit,
}: {
  roles: RoleSummary[]
  teams: TeamSummary[]
  roleName: (role: RoleSummary) => string
  onSubmit: (input: AddInput) => Promise<boolean>
}) {
  const { t } = useTranslation('settings')
  const [isNew, setIsNew] = useState(false)
  const [pending, setPending] = useState(false)
  // По умолчанию — роль «менеджер», если она есть: её дают чаще всего.
  const defaultRole = roles.find((r) => r.templateKey === 'manager') ?? roles[0]

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const teamId = String(form.get('teamId'))
    setPending(true)
    const done = await onSubmit({
      email: String(form.get('email')).trim(),
      name: isNew ? String(form.get('name')).trim() : null,
      roleId: String(form.get('roleId')),
      teamId: teamId === '' ? null : teamId,
    })
    setPending(false)
    if (done) formElement.reset()
  }

  return (
    <form className="members__add" aria-label={t('members.addLabel')} onSubmit={submit}>
      <h2>{t('members.addLabel')}</h2>
      <label>
        <input
          type="checkbox"
          checked={isNew}
          onChange={(event) => setIsNew(event.target.checked)}
        />{' '}
        {t('members.createNew')}
      </label>
      <p className="members__hint">{isNew ? t('members.createHint') : t('members.addHint')}</p>
      <label>
        {t('members.email')} <input name="email" type="email" required maxLength={254} />
      </label>
      {isNew && (
        <label>
          {t('members.name')} <input name="name" required maxLength={100} />
        </label>
      )}
      <label>
        {t('members.role')}{' '}
        <select name="roleId" defaultValue={defaultRole?.id}>
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {roleName(role)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t('members.team')}{' '}
        <select name="teamId" defaultValue="">
          <option value="">{t('members.noTeam')}</option>
          {teams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={pending}>
        {isNew ? t('members.createSubmit') : t('members.addSubmit')}
      </button>
    </form>
  )
}

/** Временный пароль новой учётной записи: показывается один раз, с кнопкой копирования. */
function TemporaryPassword({
  email,
  password,
  onDone,
}: {
  email: string
  password: string
  onDone: () => void
}) {
  const { t } = useTranslation('settings')
  const [copied, setCopied] = useState(false)
  return (
    <section className="members__password" aria-label={t('members.passwordLabel')}>
      <p>{t('members.passwordHint', { email })}</p>
      <code>{password}</code>{' '}
      <button
        type="button"
        onClick={async () => {
          // Без доступа к буферу (не HTTPS, запрет браузера) пароль остаётся на экране — его
          // можно выделить и скопировать вручную.
          try {
            await navigator.clipboard.writeText(password)
            setCopied(true)
          } catch {
            setCopied(false)
          }
        }}
      >
        {copied ? t('members.copied') : t('members.copy')}
      </button>{' '}
      <button type="button" onClick={onDone}>
        {t('members.passwordDone')}
      </button>
    </section>
  )
}
