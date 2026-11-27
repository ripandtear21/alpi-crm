import {
  can,
  type IntakeSourceSummary,
  type IntakeSourceWithKey,
  MAX_INTAKE_SOURCE_NAME_LENGTH,
  type RolePermissions,
} from '@alpi/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, type ReactNode, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  projectQueryKey,
  useCurrentProject,
} from '../../../components/project-switcher/current-project.tsx'
import { NoAccess } from '../../../layout/no-access.tsx'
import { Badge } from '../../../ui/badge.tsx'
import { Button } from '../../../ui/button.tsx'
import { Dialog } from '../../../ui/dialog.tsx'
import { Skeleton } from '../../../ui/feedback.tsx'
import { Field, Input, Select } from '../../../ui/field.tsx'
import { type Notice, NoticeLine } from '../directory-controls.tsx'
import { InboundJournal } from './inbound-journal.tsx'
import { InboundReplay } from './inbound-replay.tsx'
import type { IntakeSourcesApi } from './intake-sources-api.ts'
import { useDateFormat, useErrorText } from './intake-sources-format.ts'
import '../directory.css'
import './intake-sources.css'

// Налаштування → Джерела (тикет crm-intake/07): источники регистраций проекта (тикет 03), журнал
// входящих каждого источника и «провести заново» (тикет 06).
// - Экран и пункт меню — по праву «інтеграції: дивитися»; без него — «немає доступу». Кнопка
//   создания — по праву «створювати», смена ключа, отключение и включение — «змінювати». Каждое
//   действие проверяет и сервер.
// - Ключ источника показывается один раз — в окне после создания и после смены ключа; живёт
//   только в состоянии окна и пропадает, когда окно закрыли. В списке — первые 12 символов.
// - Журнал источника (сырые тела с персональными данными) — внутри карточки источника, на том же
//   праве «інтеграції: дивитися», что и весь экран.
// - «Провести заново» — только администратору проекта: API отвечает на запрос хода 403 всем
//   остальным, и раздел не показывается.

/** Описание API для автоматизаций: раздел `intake` там же. */
const DOCS_URL = '/api/v1/docs'

type ConfirmAction = 'reissue' | 'disable' | 'enable'
type Confirm = { action: ConfirmAction; source: IntakeSourceSummary } | null
type Issued = IntakeSourceWithKey & { rotated: boolean }

export function IntakeSourcesPage({ api }: { api: IntakeSourcesApi }) {
  const { t } = useTranslation('intake-sources')
  const { current } = useCurrentProject()
  if (!current) {
    return (
      <section>
        <h1>{t('title')}</h1>
        <p>{t('noProject')}</p>
      </section>
    )
  }
  return <IntakeSourcesScreen key={current.id} api={api} projectId={current.id} />
}

function IntakeSourcesScreen({ api, projectId }: { api: IntakeSourcesApi; projectId: string }) {
  const { t } = useTranslation('intake-sources')
  const access = useQuery({
    queryKey: projectQueryKey(projectId, 'access'),
    queryFn: () => api.access(projectId),
    retry: false,
  })
  if (access.isPending) {
    return (
      <section>
        <h1>{t('title')}</h1>
        <Skeleton />
      </section>
    )
  }
  const permissions = access.data?.permissions
  if (!permissions || !can(permissions, 'integrations', 'view')) return <NoAccess />
  return <IntakeSourcesEditor api={api} projectId={projectId} permissions={permissions} />
}

function IntakeSourcesEditor({
  api,
  projectId,
  permissions,
}: {
  api: IntakeSourcesApi
  projectId: string
  permissions: RolePermissions
}) {
  const { t } = useTranslation('intake-sources')
  const errorText = useErrorText()
  const queryClient = useQueryClient()
  const listKey = projectQueryKey(projectId, 'intake-sources')
  const list = useQuery({ queryKey: listKey, queryFn: () => api.list(projectId), retry: false })
  const [notice, setNotice] = useState<Notice>(null)
  const [creating, setCreating] = useState(false)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [issued, setIssued] = useState<Issued | null>(null)
  const [openLog, setOpenLog] = useState<string | null>(null)
  const allowed = {
    create: can(permissions, 'integrations', 'create'),
    edit: can(permissions, 'integrations', 'edit'),
  }

  // Журналы источников лежат под тем же ключом: после изменения перечитываются и они.
  const change = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSettled: () => queryClient.invalidateQueries({ queryKey: listKey }),
  })

  if (list.isPending) {
    return (
      <section>
        <h1>{t('title')}</h1>
        <Skeleton />
      </section>
    )
  }
  if (list.isError) {
    return (
      <section>
        <h1>{t('title')}</h1>
        <p className="ui-notice" role="alert">
          {t('loadFailed')}
        </p>
      </section>
    )
  }

  const confirmAction = async () => {
    if (!confirm) return
    const { action, source } = confirm
    setConfirm(null)
    setNotice(null)
    try {
      if (action === 'reissue') {
        const result = (await change.mutateAsync(() =>
          api.reissueKey(projectId, source.id),
        )) as IntakeSourceWithKey
        setIssued({ ...result, rotated: true })
        return
      }
      await change.mutateAsync(() =>
        action === 'disable' ? api.disable(projectId, source.id) : api.enable(projectId, source.id),
      )
      setNotice({ kind: 'status', text: t(`done.${action}`, { name: source.name }) })
    } catch (error) {
      setNotice({ kind: 'alert', text: errorText(error) })
    }
  }

  return (
    <section className="directory intake-sources">
      <h1>{t('title')}</h1>
      <p className="directory__hint">{t('hint')}</p>
      <NoticeLine notice={notice} />
      {allowed.create && (
        <div className="directory__row">
          <Button variant="primary" onClick={() => setCreating(true)}>
            {t('create')}
          </Button>
        </div>
      )}
      <InboundReplay api={api} projectId={projectId} />
      {list.data.length === 0 && <p>{t('empty')}</p>}
      {list.data.map((source) => (
        <SourceCard
          key={source.id}
          source={source}
          canEdit={allowed.edit}
          pending={change.isPending}
          logOpen={openLog === source.id}
          onToggleLog={() => setOpenLog(openLog === source.id ? null : source.id)}
          onConfirm={(action) => setConfirm({ action, source })}
        >
          <InboundJournal api={api} projectId={projectId} source={source} />
        </SourceCard>
      ))}
      {creating && (
        <CreateDialog
          api={api}
          projectId={projectId}
          pending={change.isPending}
          onClose={() => setCreating(false)}
          onSubmit={async (input) => {
            const result = (await change.mutateAsync(() =>
              api.create(projectId, input),
            )) as IntakeSourceWithKey
            setCreating(false)
            setIssued({ ...result, rotated: false })
          }}
        />
      )}
      {confirm && (
        <Dialog
          open
          onClose={() => setConfirm(null)}
          title={t(`confirm.${confirm.action}.title`, { name: confirm.source.name })}
          footer={
            <>
              <Button variant="quiet" onClick={() => setConfirm(null)}>
                {t('confirm.cancel')}
              </Button>
              <Button
                variant={confirm.action === 'enable' ? 'primary' : 'danger'}
                busy={change.isPending}
                onClick={() => void confirmAction()}
              >
                {t(`confirm.${confirm.action}.submit`)}
              </Button>
            </>
          }
        >
          <p>{t(`confirm.${confirm.action}.text`)}</p>
        </Dialog>
      )}
      {issued && <KeyDialog issued={issued} onClose={() => setIssued(null)} />}
    </section>
  )
}

function SourceCard({
  source,
  canEdit,
  pending,
  logOpen,
  onToggleLog,
  onConfirm,
  children,
}: {
  source: IntakeSourceSummary
  canEdit: boolean
  pending: boolean
  logOpen: boolean
  onToggleLog: () => void
  onConfirm: (action: ConfirmAction) => void
  children: ReactNode
}) {
  const { t } = useTranslation('intake-sources')
  const date = useDateFormat()
  const enabled = source.disabledAt === null
  const logId = useId()
  return (
    <article
      className={enabled ? 'directory__card' : 'directory__card intake-sources__card--disabled'}
      aria-label={source.name}
    >
      <h2 className="intake-sources__name">
        <span>{source.name}</span>
        <Badge tone={enabled ? 'win' : 'danger'}>
          {t(enabled ? 'state.enabled' : 'state.disabled')}
        </Badge>
      </h2>
      <dl className="intake-sources__facts">
        <dt>{t('facts.pipeline')}</dt>
        <dd>{source.pipeline.name}</dd>
        <dt>{t('facts.key')}</dt>
        <dd>
          <code>{source.keyPrefix}…</code>
        </dd>
        <dt>{t('facts.created')}</dt>
        <dd>
          {t('facts.createdBy', { name: source.createdBy.name, date: date(source.createdAt) })}
        </dd>
        <dt>{t('facts.lastUsed')}</dt>
        <dd>{source.lastUsedAt ? date(source.lastUsedAt) : t('facts.never')}</dd>
        {source.disabledAt && (
          <>
            <dt>{t('facts.disabled')}</dt>
            <dd>
              {t('facts.disabledBy', {
                name: source.disabledBy?.name ?? '',
                date: date(source.disabledAt),
              })}
            </dd>
          </>
        )}
      </dl>
      <div className="directory__row">
        <Button size="sm" aria-expanded={logOpen} aria-controls={logId} onClick={onToggleLog}>
          {t('actions.showLog')}
        </Button>
        {canEdit && (
          <>
            <Button size="sm" disabled={pending} onClick={() => onConfirm('reissue')}>
              {t('actions.reissueKey')}
            </Button>
            {enabled ? (
              <Button size="sm" disabled={pending} onClick={() => onConfirm('disable')}>
                {t('actions.disable')}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                disabled={pending}
                onClick={() => onConfirm('enable')}
              >
                {t('actions.enable')}
              </Button>
            )}
          </>
        )}
      </div>
      {logOpen && <div id={logId}>{children}</div>}
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
  api: IntakeSourcesApi
  projectId: string
  pending: boolean
  onClose: () => void
  onSubmit: (input: { name: string; pipelineId: string }) => Promise<void>
}) {
  const { t } = useTranslation('intake-sources')
  const errorText = useErrorText()
  const pipelines = useQuery({
    queryKey: projectQueryKey(projectId, 'pipelines'),
    queryFn: () => api.pipelines(projectId),
    retry: false,
  })
  const [name, setName] = useState('')
  const [pipelineId, setPipelineId] = useState('')
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Новые сделки приёма в архивную воронку не ставятся: API ответил бы PIPELINE_NOT_FOUND.
  const options = (pipelines.data ?? []).filter((pipeline) => pipeline.archivedAt === null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (name.trim() === '' || pipelineId === '') {
      setMissing(true)
      return
    }
    setError(null)
    try {
      await onSubmit({ name: name.trim(), pipelineId })
    } catch (failure) {
      setError(errorText(failure))
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('form.title')}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            {t('form.cancel')}
          </Button>
          <Button type="submit" form="intake-source-form" variant="primary" busy={pending}>
            {t('form.submit')}
          </Button>
        </>
      }
    >
      <form
        id="intake-source-form"
        className="intake-sources__form"
        aria-label={t('form.title')}
        onSubmit={submit}
        noValidate
      >
        {error && (
          <p className="ui-notice" role="alert">
            {error}
          </p>
        )}
        <Field
          label={t('form.name')}
          hint={t('form.nameHint')}
          error={missing && name.trim() === '' ? t('form.required') : undefined}
        >
          <Input
            value={name}
            maxLength={MAX_INTAKE_SOURCE_NAME_LENGTH}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field
          label={t('form.pipeline')}
          error={missing && pipelineId === '' ? t('form.required') : undefined}
        >
          <Select value={pipelineId} onChange={(event) => setPipelineId(event.target.value)}>
            <option value="">{t('form.pipelinePlaceholder')}</option>
            {options.map((pipeline) => (
              <option key={pipeline.id} value={pipeline.id}>
                {pipeline.name}
              </option>
            ))}
          </Select>
        </Field>
      </form>
    </Dialog>
  )
}

/** Пример запроса приёма: данные выдуманные, ключ — из переменной окружения, не из окна. */
function curlExample(origin: string): string {
  const body = {
    event_id: 'form-2026-0001',
    phone: '+380501234567',
    email: 'olena.test@example.com',
    name: 'Олена Тестова',
    form: 'Лендинг вебінару',
  }
  return [
    `curl -X POST '${origin}/api/intake/registrations' \\`,
    `  -H "Authorization: Bearer $ALPI_SOURCE_KEY" \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '${JSON.stringify(body)}'`,
  ].join('\n')
}

function KeyDialog({ issued, onClose }: { issued: Issued; onClose: () => void }) {
  const { t } = useTranslation('intake-sources')
  const [copied, setCopied] = useState<'done' | 'failed' | null>(null)
  const exampleId = useId()
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Буфер обмена недоступен')
      await navigator.clipboard.writeText(issued.key)
      setCopied('done')
    } catch {
      setCopied('failed')
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('key.title', { name: issued.source.name })}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('key.done')}
        </Button>
      }
    >
      <div className="intake-sources__form">
        <p className="ui-notice" role="alert">
          {t('key.once')}
        </p>
        {issued.rotated && <p className="ui-notice">{t('key.rotated')}</p>}
        <Field label={t('key.label')}>
          <Input
            readOnly
            value={issued.key}
            className="intake-sources__key"
            onFocus={(event) => event.currentTarget.select()}
          />
        </Field>
        <div className="directory__row">
          <Button onClick={() => void copy()}>{t('key.copy')}</Button>
          {copied && (
            <span role="status">{copied === 'done' ? t('key.copied') : t('key.copyFailed')}</span>
          )}
        </div>
        <section aria-labelledby={exampleId}>
          <h3 id={exampleId} className="intake-sources__subtitle">
            {t('key.example')}
          </h3>
          <pre className="intake-sources__code">{curlExample(window.location.origin)}</pre>
        </section>
        <a href={DOCS_URL} target="_blank" rel="noreferrer">
          {t('key.docs')}
        </a>
      </div>
    </Dialog>
  )
}
