import {
  ACTIONS,
  type Action,
  parseRolePermissions,
  RESOURCES,
  type Resource,
  ROLE_TEMPLATES,
  type RolePermissions,
  type RoleSummary,
  SCOPED_RESOURCES,
  SCOPES,
  type Scope,
  type ScopedResource,
  STANDALONE_PERMISSIONS,
  type StandalonePermission,
} from '@alpi/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  projectQueryKey,
  useCurrentProject,
} from '../../components/project-switcher/current-project.tsx'
import { type RoleInput, type RolesApi, RolesApiError } from './roles-api.ts'
import './roles.css'
import './settings.css'
import { Button } from '../../ui/button.tsx'

// Настройки → роли: список ролей проекта и редактор прав роли — таблица «часть системы ×
// действие», охват для частей с ответственным, отдельные права. Роль «администратор» —
// только для чтения: её не меняет и API (база отклоняет).

/** Права пустой новой роли: ничего не разрешено, охват «свои». */
function emptyPermissions(): RolePermissions {
  const parsed = parseRolePermissions({})
  if (!parsed.ok) throw new Error('пустые права не прошли проверку каталога')
  return parsed.permissions
}

/** Название для показа: у неизменённого шаблона — перевод, у своей роли — как ввёл пользователь. */
export function useRoleName() {
  const { t } = useTranslation('settings')
  return (role: Pick<RoleSummary, 'name' | 'templateKey'>) => {
    const template = ROLE_TEMPLATES.find((tpl) => tpl.key === role.templateKey)
    return template && template.name === role.name
      ? t(`roles.templates.${template.key}`)
      : role.name
  }
}

function toggleAction(
  permissions: RolePermissions,
  resource: Resource,
  action: Action,
  checked: boolean,
): RolePermissions {
  const current = new Set(permissions.actions[resource])
  if (checked) {
    current.add(action)
    // Менять то, чего не видишь, нельзя: любое действие включает «смотреть».
    current.add('view')
  } else if (action === 'view') {
    current.clear()
  } else {
    current.delete(action)
  }
  return {
    ...permissions,
    actions: { ...permissions.actions, [resource]: ACTIONS.filter((a) => current.has(a)) },
  }
}

function setScope(
  permissions: RolePermissions,
  resource: ScopedResource,
  kind: 'read' | 'write',
  scope: Scope,
): RolePermissions {
  return {
    ...permissions,
    scopes: {
      ...permissions.scopes,
      [resource]: { ...permissions.scopes[resource], [kind]: scope },
    },
  }
}

function toggleStandalone(
  permissions: RolePermissions,
  permission: StandalonePermission,
  checked: boolean,
): RolePermissions {
  const current = new Set(permissions.standalone)
  if (checked) current.add(permission)
  else current.delete(permission)
  return { ...permissions, standalone: STANDALONE_PERMISSIONS.filter((p) => current.has(p)) }
}

interface Draft extends RoleInput {
  /** id сохранённой роли; null — новая роль. */
  id: string | null
  isAdmin: boolean
  /** Название в базе и как его показывает интерфейс (у шаблона — перевод). */
  storedName: string
  shownName: string
}

function newDraft(name: string, permissions: RolePermissions): Draft {
  return { id: null, isAdmin: false, storedName: name, shownName: name, name, permissions }
}

/**
 * Что отправить в API: неизменённое переведённое название шаблона уходит как в базе — иначе
 * сохранение в русском интерфейсе переименовало бы шаблон.
 */
function inputOf(draft: Draft): RoleInput {
  const name = draft.name === draft.shownName ? draft.storedName : draft.name.trim()
  return { name, permissions: draft.permissions }
}

export function RolesPage({ api }: { api: RolesApi }) {
  const { t } = useTranslation('settings')
  const { current } = useCurrentProject()
  if (!current) {
    return (
      <section>
        <h1>{t('roles.title')}</h1>
        <p>{t('roles.noProject')}</p>
      </section>
    )
  }
  // key: при смене проекта редактор начинается заново, без черновика прежнего проекта.
  return <RolesEditor key={current.id} api={api} projectId={current.id} />
}

function RolesEditor({ api, projectId }: { api: RolesApi; projectId: string }) {
  const { t } = useTranslation('settings')
  const roleName = useRoleName()
  const draftOf = (role: RoleSummary): Draft => {
    const shownName = roleName(role)
    return {
      id: role.id,
      isAdmin: role.isAdmin,
      storedName: role.name,
      shownName,
      name: shownName,
      permissions: role.permissions,
    }
  }
  const queryClient = useQueryClient()
  const queryKey = projectQueryKey(projectId, 'roles')
  const roles = useQuery({ queryKey, queryFn: () => api.list(projectId), retry: false })
  const [draft, setDraft] = useState<Draft | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const list = roles.data ?? []
  const firstRole = list[0]
  // Пока ничего не выбрано — первая роль списка (администратор).
  const shown = draft ?? (firstRole ? draftOf(firstRole) : null)

  const errorText = (error: unknown) =>
    t(`roles.errors.${error instanceof RolesApiError ? error.code : ''}`, {
      defaultValue: t('roles.errors.unknown'),
    })

  const save = useMutation({
    mutationFn: (value: Draft) =>
      value.id === null
        ? api.create(projectId, inputOf(value))
        : api.update(projectId, value.id, inputOf(value)),
    onSuccess: async (role) => {
      await queryClient.invalidateQueries({ queryKey })
      setDraft(draftOf(role))
      setMessage(t('roles.saved'))
    },
    onError: (error) => setMessage(errorText(error)),
  })

  const remove = useMutation({
    mutationFn: (roleId: string) => api.remove(projectId, roleId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey })
      setDraft(null)
      setMessage(t('roles.deleted'))
    },
    onError: (error) => setMessage(errorText(error)),
  })

  if (roles.isPending) {
    return <p>{t('roles.loading')}</p>
  }
  if (roles.isError) {
    const denied = roles.error instanceof RolesApiError && roles.error.status === 403
    return (
      <section>
        <h1>{t('roles.title')}</h1>
        <p className="ui-notice" role="alert">
          {denied ? t('roles.noAccess') : t('roles.errors.unknown')}
        </p>
      </section>
    )
  }

  const edit = (change: (p: RolePermissions) => RolePermissions) => {
    if (!shown || shown.isAdmin) return
    setDraft({ ...shown, permissions: change(shown.permissions) })
    setMessage(null)
  }
  const select = (role: RoleSummary) => {
    setDraft(draftOf(role))
    setMessage(null)
  }
  const readOnly = shown?.isAdmin ?? true
  const actionLabel = (action: Action) => t(`roles.actions.${action}`)
  const resourceLabel = (resource: Resource) => t(`roles.resources.${resource}`)

  return (
    <section className="roles">
      <h1>{t('roles.title')}</h1>
      <div className="roles__layout">
        <div className="roles__list">
          <ul aria-label={t('roles.listLabel')}>
            {list.map((role) => (
              <li key={role.id}>
                <Button
                  size="sm"
                  type="button"
                  aria-pressed={shown?.id === role.id}
                  onClick={() => select(role)}
                >
                  {roleName(role)}{' '}
                  <span className="roles__count">
                    {t('roles.members', { count: role.memberCount })}
                  </span>
                </Button>
              </li>
            ))}
          </ul>
          <Button
            size="sm"
            type="button"
            onClick={() => {
              setDraft(newDraft('', emptyPermissions()))
              setMessage(null)
            }}
          >
            {t('roles.new')}
          </Button>
        </div>

        {shown && (
          <form
            className="roles__editor"
            aria-label={t('roles.editorLabel')}
            onSubmit={(event) => {
              event.preventDefault()
              if (!readOnly) save.mutate(shown)
            }}
          >
            {readOnly && <p className="roles__note">{t('roles.adminReadOnly')}</p>}
            <label>
              {t('roles.name')}{' '}
              <input
                className="ui-input ui-input--sm"
                value={shown.name}
                readOnly={readOnly}
                maxLength={60}
                required
                onChange={(event) => {
                  setDraft({ ...shown, name: event.target.value })
                  setMessage(null)
                }}
              />
            </label>

            <div className="ui-table-wrap">
              <table className="ui-table roles__matrix">
                <caption>{t('roles.matrixCaption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('roles.resource')}</th>
                    {ACTIONS.map((action) => (
                      <th key={action} scope="col">
                        {actionLabel(action)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {RESOURCES.map((resource) => (
                    <tr key={resource}>
                      <th scope="row">{resourceLabel(resource)}</th>
                      {ACTIONS.map((action) => (
                        <td key={action}>
                          <input
                            type="checkbox"
                            aria-label={`${resourceLabel(resource)}: ${actionLabel(action)}`}
                            checked={shown.permissions.actions[resource].includes(action)}
                            disabled={readOnly}
                            onChange={(event) =>
                              edit((p) => toggleAction(p, resource, action, event.target.checked))
                            }
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <fieldset>
              <legend>{t('roles.scopeTitle')}</legend>
              <p className="roles__hint">{t('roles.scopeHint')}</p>
              {SCOPED_RESOURCES.map((resource) => (
                <div key={resource} className="roles__scope">
                  <span>{resourceLabel(resource)}</span>
                  {(['read', 'write'] as const).map((kind) => (
                    <label key={kind}>
                      {t(`roles.scopeKind.${kind}`)}{' '}
                      <select
                        className="ui-select ui-select--sm"
                        aria-label={`${resourceLabel(resource)}: ${t(`roles.scopeKind.${kind}`)}`}
                        value={shown.permissions.scopes[resource][kind]}
                        disabled={readOnly}
                        onChange={(event) =>
                          edit((p) => setScope(p, resource, kind, event.target.value as Scope))
                        }
                      >
                        {SCOPES.map((scope) => (
                          <option key={scope} value={scope}>
                            {t(`roles.scopes.${scope}`)}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              ))}
            </fieldset>

            <fieldset>
              <legend>{t('roles.standaloneTitle')}</legend>
              {STANDALONE_PERMISSIONS.map((permission) => (
                <label key={permission} className="roles__standalone">
                  <input
                    type="checkbox"
                    checked={shown.permissions.standalone.includes(permission)}
                    disabled={readOnly}
                    onChange={(event) =>
                      edit((p) => toggleStandalone(p, permission, event.target.checked))
                    }
                  />{' '}
                  {t(`roles.standalone.${permission}`)}
                </label>
              ))}
            </fieldset>

            <div className="roles__actions">
              {!readOnly && (
                <Button size="sm" type="submit" variant="primary" busy={save.isPending}>
                  {t('roles.save')}
                </Button>
              )}
              {/* Копия любой роли, и администратора тоже, — новая своя роль. */}
              {shown.id !== null && (
                <Button
                  size="sm"
                  type="button"
                  onClick={() => {
                    setDraft(newDraft(t('roles.copyName', { name: shown.name }), shown.permissions))
                    setMessage(null)
                  }}
                >
                  {t('roles.copy')}
                </Button>
              )}
              {!readOnly && shown.id !== null && (
                <Button
                  size="sm"
                  variant="danger"
                  type="button"
                  disabled={remove.isPending}
                  onClick={() => shown.id !== null && remove.mutate(shown.id)}
                >
                  {t('roles.delete')}
                </Button>
              )}
            </div>
            {message && (
              <p className="ui-notice" role="status">
                {message}
              </p>
            )}
          </form>
        )}
      </div>
    </section>
  )
}
