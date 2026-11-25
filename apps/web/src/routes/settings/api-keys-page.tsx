import {
  type ApiKeySummary,
  type ApiKeyWithSecret,
  MAX_API_KEY_NAME_LENGTH,
  type RoleSummary,
  SCOPED_RESOURCES,
} from '@alpi/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  projectQueryKey,
  useCurrentProject,
} from '../../components/project-switcher/current-project.tsx'
import { Button } from '../../ui/button.tsx'
import { Dialog } from '../../ui/dialog.tsx'
import { Field, Input, Select } from '../../ui/field.tsx'
import type { ApiKeysApi } from './api-keys-api.ts'
import { type Notice, NoticeLine } from './directory-controls.tsx'
import { RolesApiError } from './roles-api.ts'
import { useRoleName } from './roles-page.tsx'
import './api-keys.css'

// Налаштування → Ключі API (тикет crm-api/01): ключи доступа внешней автоматизации к проекту.
// Список (название, роль, первые символы секрета, кто и когда создал, срок, последний запрос,
// отозван ли); создание — название, роль и срок по желанию; секрет показывается один раз в
// окне с кнопкой «скопіювати»; перевыпуск и отзыв — с подтверждением. Секрет живёт только в
// состоянии окна и пропадает, когда окно закрыли.

export function ApiKeysPage({ api }: { api: ApiKeysApi }) {
  const { t } = useTranslation('settings')
  const { current } = useCurrentProject()
  if (!current) {
    return (
      <section>
        <h1>{t('apiKeys.title')}</h1>
        <p>{t('apiKeys.noProject')}</p>
      </section>
    )
  }
  return <ApiKeysEditor key={current.id} api={api} projectId={current.id} />
}

function useApiKeyErrorText() {
  const { t } = useTranslation('settings')
  return (error: unknown) => {
    const code = error instanceof RolesApiError ? error.code : ''
    return t(`apiKeys.errors.${code}`, {
      defaultValue: t(`roles.errors.${code}`, { defaultValue: t('roles.errors.unknown') }),
    })
  }
}

/** Охват роли не «все» хотя бы для одной части системы: ключ увидит только общую очередь. */
function narrowScope(role: RoleSummary): boolean {
  if (role.isAdmin) return false
  return SCOPED_RESOURCES.some((resource) => {
    const scope = role.permissions.scopes[resource]
    return scope.read !== 'all' || scope.write !== 'all'
  })
}

/** Подтверждение перевыпуска или отзыва ключа. */
type Confirm = { action: 'reissue' | 'revoke'; key: ApiKeySummary } | null

function ApiKeysEditor({ api, projectId }: { api: ApiKeysApi; projectId: string }) {
  const { t } = useTranslation('settings')
  const errorText = useApiKeyErrorText()
  const queryClient = useQueryClient()
  const key = projectQueryKey(projectId, 'api-keys')
  const keys = useQuery({ queryKey: key, queryFn: () => api.list(projectId), retry: false })
  const [notice, setNotice] = useState<Notice>(null)
  const [creating, setCreating] = useState(false)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [issued, setIssued] = useState<ApiKeyWithSecret | null>(null)

  const change = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onError: (error) => setNotice({ kind: 'alert', text: errorText(error) }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  })

  /** Выполняет изменение; ответ API или null, если отказ (он уже показан сообщением). */
  const run = <T,>(action: () => Promise<T>): Promise<T | null> => {
    setNotice(null)
    return change.mutateAsync(action).then(
      (value) => value as T,
      () => null,
    )
  }

  if (keys.isPending) return <p>{t('apiKeys.loading')}</p>
  if (keys.isError) {
    const denied = keys.error instanceof RolesApiError && keys.error.status === 403
    return (
      <section>
        <h1>{t('apiKeys.title')}</h1>
        <p className="ui-notice" role="alert">
          {denied ? t('apiKeys.noAccess') : t('roles.errors.unknown')}
        </p>
      </section>
    )
  }

  const confirmAction = async () => {
    if (!confirm) return
    const { action, key: target } = confirm
    setConfirm(null)
    if (action === 'reissue') {
      const result = await run(() => api.reissue(projectId, target.id))
      if (result) setIssued(result)
    } else if (await run(() => api.revoke(projectId, target.id))) {
      setNotice({ kind: 'status', text: t('apiKeys.revoked', { name: target.name }) })
    }
  }

  return (
    <section className="directory api-keys">
      <h1>{t('apiKeys.title')}</h1>
      <p className="directory__hint">{t('apiKeys.hint')}</p>
      <NoticeLine notice={notice} />
      <div className="directory__row">
        <Button variant="primary" onClick={() => setCreating(true)}>
          {t('apiKeys.create')}
        </Button>
      </div>
      {keys.data.length === 0 && <p>{t('apiKeys.empty')}</p>}
      {keys.data.map((item) => (
        <ApiKeyCard
          key={item.id}
          apiKey={item}
          pending={change.isPending}
          onReissue={() => setConfirm({ action: 'reissue', key: item })}
          onRevoke={() => setConfirm({ action: 'revoke', key: item })}
        />
      ))}
      {creating && (
        <CreateDialog
          api={api}
          projectId={projectId}
          pending={change.isPending}
          onClose={() => setCreating(false)}
          onSubmit={async (input) => {
            const result = await run(() => api.create(projectId, input))
            if (result) {
              setCreating(false)
              setIssued(result)
            }
          }}
        />
      )}
      {confirm && (
        <Dialog
          open
          onClose={() => setConfirm(null)}
          title={t(`apiKeys.confirm.${confirm.action}.title`, { name: confirm.key.name })}
          footer={
            <>
              <Button variant="quiet" onClick={() => setConfirm(null)}>
                {t('apiKeys.cancel')}
              </Button>
              <Button variant="danger" busy={change.isPending} onClick={() => void confirmAction()}>
                {t(`apiKeys.confirm.${confirm.action}.submit`)}
              </Button>
            </>
          }
        >
          <p>{t(`apiKeys.confirm.${confirm.action}.text`)}</p>
        </Dialog>
      )}
      {issued && <SecretDialog issued={issued} onClose={() => setIssued(null)} />}
    </section>
  )
}

function ApiKeyCard({
  apiKey,
  pending,
  onReissue,
  onRevoke,
}: {
  apiKey: ApiKeySummary
  pending: boolean
  onReissue: () => void
  onRevoke: () => void
}) {
  const { t, i18n } = useTranslation('settings')
  const roleName = useRoleName()
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short', timeStyle: 'short' })
  const when = (value: string | null, none: string) => (value ? date.format(new Date(value)) : none)
  const revoked = apiKey.revokedAt !== null
  const expired =
    !revoked && apiKey.expiresAt !== null && Date.parse(apiKey.expiresAt) <= Date.now()
  return (
    <article
      className={revoked ? 'directory__card directory__card--archived' : 'directory__card'}
      aria-label={apiKey.name}
    >
      <h2>
        {apiKey.name}
        {revoked && <span className="directory__mark"> · {t('apiKeys.revokedMark')}</span>}
        {expired && <span className="directory__mark"> · {t('apiKeys.expiredMark')}</span>}
      </h2>
      <dl className="api-keys__facts">
        <dt>{t('apiKeys.role')}</dt>
        <dd>{apiKey.role ? roleName(apiKey.role) : t('apiKeys.noRole')}</dd>
        <dt>{t('apiKeys.secret')}</dt>
        <dd>
          <code>{apiKey.secretPrefix}…</code>
        </dd>
        <dt>{t('apiKeys.created')}</dt>
        <dd>
          {t('apiKeys.createdBy', {
            name: apiKey.createdBy.name,
            date: date.format(new Date(apiKey.createdAt)),
          })}
        </dd>
        <dt>{t('apiKeys.expires')}</dt>
        <dd>{when(apiKey.expiresAt, t('apiKeys.noExpiry'))}</dd>
        <dt>{t('apiKeys.lastUsed')}</dt>
        <dd>{when(apiKey.lastUsedAt, t('apiKeys.neverUsed'))}</dd>
        {revoked && (
          <>
            <dt>{t('apiKeys.revokedAt')}</dt>
            <dd>{when(apiKey.revokedAt, '')}</dd>
          </>
        )}
      </dl>
      {!revoked && (
        <div className="directory__row">
          <Button size="sm" disabled={pending} onClick={onReissue}>
            {t('apiKeys.reissue')}
          </Button>
          <Button size="sm" variant="danger" disabled={pending} onClick={onRevoke}>
            {t('apiKeys.revoke')}
          </Button>
        </div>
      )}
    </article>
  )
}

function CreateDialog({
  api,
  projectId,
  pending,
  onClose,
  onSubmit,
}: {
  api: ApiKeysApi
  projectId: string
  pending: boolean
  onClose: () => void
  onSubmit: (input: { name: string; roleId: string; expiresAt: string | null }) => Promise<void>
}) {
  const { t } = useTranslation('settings')
  const roleName = useRoleName()
  const roles = useQuery({
    queryKey: projectQueryKey(projectId, 'roles'),
    queryFn: () => api.roles(projectId),
    retry: false,
  })
  const [name, setName] = useState('')
  const [roleId, setRoleId] = useState('')
  const [expires, setExpires] = useState('')
  const [missing, setMissing] = useState(false)
  const role = roles.data?.find((r) => r.id === roleId)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (name.trim() === '' || !role) {
      setMissing(true)
      return
    }
    // Дата без времени — ключ действует до конца этого дня по местному времени.
    const expiresAt = expires === '' ? null : new Date(`${expires}T23:59:59`).toISOString()
    await onSubmit({ name: name.trim(), roleId: role.id, expiresAt })
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('apiKeys.new')}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            {t('apiKeys.cancel')}
          </Button>
          <Button type="submit" form="api-key-create" variant="primary" busy={pending}>
            {t('apiKeys.createSubmit')}
          </Button>
        </>
      }
    >
      <form
        id="api-key-create"
        className="api-keys__form"
        aria-label={t('apiKeys.new')}
        onSubmit={submit}
        noValidate
      >
        <Field
          label={t('apiKeys.name')}
          error={missing && name.trim() === '' ? t('apiKeys.required') : undefined}
        >
          <Input
            value={name}
            maxLength={MAX_API_KEY_NAME_LENGTH}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field
          label={t('apiKeys.role')}
          error={missing && !role ? t('apiKeys.required') : undefined}
          hint={t('apiKeys.roleHint')}
        >
          <Select value={roleId} onChange={(event) => setRoleId(event.target.value)}>
            <option value="">{t('apiKeys.chooseRole')}</option>
            {roles.data?.map((item) => (
              <option key={item.id} value={item.id}>
                {roleName(item)}
              </option>
            ))}
          </Select>
        </Field>
        {role && narrowScope(role) && (
          <p className="ui-notice" role="status">
            {t('apiKeys.narrowScope')}
          </p>
        )}
        <Field label={t('apiKeys.expiresOptional')}>
          <Input type="date" value={expires} onChange={(event) => setExpires(event.target.value)} />
        </Field>
      </form>
    </Dialog>
  )
}

function SecretDialog({ issued, onClose }: { issued: ApiKeyWithSecret; onClose: () => void }) {
  const { t } = useTranslation('settings')
  const [copied, setCopied] = useState<'done' | 'failed' | null>(null)
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Буфер обмена недоступен')
      await navigator.clipboard.writeText(issued.secret)
      setCopied('done')
    } catch {
      setCopied('failed')
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('apiKeys.secretTitle', { name: issued.key.name })}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('apiKeys.done')}
        </Button>
      }
    >
      <div className="api-keys__form">
        <p className="ui-notice" role="alert">
          {t('apiKeys.secretOnce')}
        </p>
        <Field label={t('apiKeys.secret')}>
          <Input
            readOnly
            value={issued.secret}
            className="api-keys__secret"
            onFocus={(event) => event.currentTarget.select()}
          />
        </Field>
        <div className="directory__row">
          <Button onClick={() => void copy()}>{t('apiKeys.copy')}</Button>
          {copied && (
            <span role="status">
              {copied === 'done' ? t('apiKeys.copied') : t('apiKeys.copyFailed')}
            </span>
          )}
        </div>
      </div>
    </Dialog>
  )
}
