import {
  can,
  EVENT_TYPE_TITLES,
  type EventType,
  MAX_WEBHOOK_DESCRIPTION_LENGTH,
  MAX_WEBHOOK_URL_LENGTH,
  type RolePermissions,
  WEBHOOK_DELIVERY_STATES,
  WEBHOOK_RETENTION_DAYS,
  type WebhookDeliveryState,
  type WebhookDeliveryView,
  type WebhookEndpointInput,
  type WebhookEndpointListItem,
  type WebhookEndpointWithSecret,
  type WebhookEventTypeInfo,
} from '@alpi/shared'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, type ReactNode, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  projectQueryKey,
  useCurrentProject,
} from '../../../components/project-switcher/current-project.tsx'
import { NoAccess } from '../../../layout/no-access.tsx'
import { Badge } from '../../../ui/badge.tsx'
import { Button } from '../../../ui/button.tsx'
import { Checkbox } from '../../../ui/checkbox.tsx'
import { Dialog } from '../../../ui/dialog.tsx'
import { Skeleton } from '../../../ui/feedback.tsx'
import { Field, Input, Select } from '../../../ui/field.tsx'
import { type Notice, NoticeLine } from '../directory-controls.tsx'
import { RolesApiError } from '../roles-api.ts'
import type { WebhooksApi } from './webhooks-api.ts'
import '../directory.css'
import './webhooks.css'

// Налаштування → Вебхуки (тикет crm-api/07): вебхуки проекта на запросах тикета 06.
// - Экран и пункт меню — по праву «інтеграції: дивитися»; без него — «немає доступу». Кнопки —
//   по действиям: создать, изменить (адрес, типы, секрет, включение, повторы), удалить (решено
//   без владельца — подтвердить). Каждое действие проверяет и сервер.
// - Секрет подписи показывается один раз — в окне после создания и после смены секрета; живёт
//   только в состоянии окна и пропадает, когда окно закрыли.
// - Журнал доставок раскрывается в карточке вебхука: фильтр, подгрузка курсором, попытки и тело
//   события; повторы недоступны отключённому вебхуку (API ответил бы 409).
// - «Наздогнати події з дати» (тикет crm-api/09): там же, с датой и подтверждением; события за
//   время отключения уходят обычной доставкой. Тоже только включённому вебхуку.

/** Ссылки справки о подписи — из исследования docs/research/webhook-delivery.md, раздел 3.4. */
const HELP_LINKS = {
  specLink:
    'https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md',
  n8nLink: 'https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.crypto/',
  makeLink: 'https://help.make.com/text-and-binary-functions',
} as const

/** Как часто перечитывать журнал, пока в нём есть ожидающие доставки, мс. */
const PENDING_REFRESH_MS = 5000

const DAY_MS = 24 * 60 * 60 * 1000

/** Дата `YYYY-MM-DD` по местному времени — значение поля type="date". */
function localDay(time: number): string {
  const date = new Date(time)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Самое раннее время, с которого API позволит «наздогнати події» (тикет 09): не раньше создания
 * вебхука и не старше срока хранения событий. shortcut: минута запаса на дорогу запроса до API
 * у границы 30 дней, когда запрос идёт дольше минуты — API ответит 422 и экран покажет причину.
 */
function catchUpBound(endpoint: WebhookEndpointListItem): number {
  return Math.max(
    Date.parse(endpoint.createdAt),
    Date.now() - WEBHOOK_RETENTION_DAYS * DAY_MS + 60 * 1000,
  )
}

/**
 * Начало выбранного дня по местному времени; в первый доступный день — сама граница: день
 * создания вебхука начинается раньше него, а API такую дату отклонил бы (422).
 */
function catchUpSince(day: string, bound: number): string {
  const start = new Date(`${day}T00:00:00`).getTime()
  return new Date(day === localDay(bound) ? Math.max(start, bound) : start).toISOString()
}

type Language = 'uk' | 'ru'

const nameOf = (endpoint: { description: string | null; url: string }) =>
  endpoint.description ?? endpoint.url

function useLanguage(): Language {
  const { i18n } = useTranslation()
  return i18n.language === 'ru' ? 'ru' : 'uk'
}

function useDateFormat(timeStyle: 'short' | 'medium' = 'short') {
  const { i18n } = useTranslation()
  const format = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short', timeStyle })
  return (value: string) => format.format(new Date(value))
}

function useErrorText() {
  const { t } = useTranslation('webhooks')
  return (error: unknown) => {
    const code = error instanceof RolesApiError ? error.code : ''
    return code ? t(`errors.${code}`, { defaultValue: t('errors.unknown') }) : t('errors.unknown')
  }
}

export function WebhooksPage({ api }: { api: WebhooksApi }) {
  const { t } = useTranslation('webhooks')
  const { current } = useCurrentProject()
  if (!current) {
    return (
      <section>
        <h1>{t('title')}</h1>
        <p>{t('noProject')}</p>
      </section>
    )
  }
  return <WebhooksScreen key={current.id} api={api} projectId={current.id} />
}

function WebhooksScreen({ api, projectId }: { api: WebhooksApi; projectId: string }) {
  const { t } = useTranslation('webhooks')
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
  return <WebhooksEditor api={api} projectId={projectId} permissions={permissions} />
}

type ConfirmAction = 'enable' | 'disable' | 'delete' | 'rotate'
type Confirm = { action: ConfirmAction; endpoint: WebhookEndpointListItem } | null
type Issued = WebhookEndpointWithSecret & { rotated: boolean }
/** Окно вебхука: новый (endpoint — null) или изменение существующего. */
type Editing = { endpoint: WebhookEndpointListItem | null } | null

function WebhooksEditor({
  api,
  projectId,
  permissions,
}: {
  api: WebhooksApi
  projectId: string
  permissions: RolePermissions
}) {
  const { t } = useTranslation('webhooks')
  const errorText = useErrorText()
  const queryClient = useQueryClient()
  const listKey = projectQueryKey(projectId, 'webhooks')
  const list = useQuery({ queryKey: listKey, queryFn: () => api.list(projectId), retry: false })
  const eventTypes = useQuery({
    queryKey: projectQueryKey(projectId, 'webhook-event-types'),
    queryFn: () => api.eventTypes(projectId),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const [notice, setNotice] = useState<Notice>(null)
  const [editing, setEditing] = useState<Editing>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [issued, setIssued] = useState<Issued | null>(null)
  const [openLog, setOpenLog] = useState<string | null>(null)
  const allowed = {
    create: can(permissions, 'integrations', 'create'),
    edit: can(permissions, 'integrations', 'edit'),
    delete: can(permissions, 'integrations', 'delete'),
  }

  // Журналы вебхуков лежат под тем же ключом: после изменения перечитываются и они.
  const change = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSettled: () => queryClient.invalidateQueries({ queryKey: listKey }),
  })

  /** Выполняет изменение; ответ API или null, если отказ (он уже показан сообщением). */
  const run = async <T,>(action: () => Promise<T>): Promise<{ value: T } | null> => {
    setNotice(null)
    try {
      return { value: (await change.mutateAsync(action)) as T }
    } catch (error) {
      setNotice({ kind: 'alert', text: errorText(error) })
      return null
    }
  }

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
    const { action, endpoint } = confirm
    setConfirm(null)
    if (action === 'rotate') {
      const result = await run(() => api.rotateSecret(projectId, endpoint.id))
      if (result) setIssued({ ...result.value, rotated: true })
      return
    }
    const request: () => Promise<unknown> = {
      enable: () => api.enable(projectId, endpoint.id),
      disable: () => api.disable(projectId, endpoint.id),
      delete: () => api.remove(projectId, endpoint.id),
    }[action]
    if (await run(request)) {
      setNotice({ kind: 'status', text: t(`done.${action}`, { name: nameOf(endpoint) }) })
      if (action === 'delete' && openLog === endpoint.id) setOpenLog(null)
    }
  }

  const totalTypes = eventTypes.data?.length ?? 0

  return (
    <section className="directory webhooks">
      <h1>{t('title')}</h1>
      <p className="directory__hint">{t('hint')}</p>
      <SignatureHelp />
      <NoticeLine notice={notice} />
      {allowed.create && (
        <div className="directory__row">
          <Button variant="primary" onClick={() => setEditing({ endpoint: null })}>
            {t('create')}
          </Button>
        </div>
      )}
      {list.data.length === 0 && <p>{t('empty')}</p>}
      {list.data.map((endpoint) => (
        <WebhookCard
          key={endpoint.id}
          endpoint={endpoint}
          totalTypes={totalTypes}
          allowed={allowed}
          pending={change.isPending}
          logOpen={openLog === endpoint.id}
          onToggleLog={() => setOpenLog(openLog === endpoint.id ? null : endpoint.id)}
          onEdit={() => setEditing({ endpoint })}
          onConfirm={(action) => setConfirm({ action, endpoint })}
        >
          <DeliveryLog api={api} projectId={projectId} endpoint={endpoint} canEdit={allowed.edit} />
        </WebhookCard>
      ))}
      {editing && (
        <WebhookDialog
          endpoint={editing.endpoint}
          eventTypes={eventTypes.data ?? []}
          pending={change.isPending}
          onClose={() => setEditing(null)}
          onSubmit={async (input) => {
            setNotice(null)
            const target = editing.endpoint
            if (target === null) {
              const result = await change.mutateAsync(() =>
                api.create(projectId, input as WebhookEndpointInput),
              )
              setEditing(null)
              setIssued({ ...(result as WebhookEndpointWithSecret), rotated: false })
              return
            }
            const saved = { ...target, ...input }
            if (Object.keys(input).length > 0) {
              await change.mutateAsync(() => api.update(projectId, target.id, input))
            }
            setEditing(null)
            setNotice({ kind: 'status', text: t('done.saved', { name: nameOf(saved) }) })
          }}
        />
      )}
      {confirm && (
        <Dialog
          open
          onClose={() => setConfirm(null)}
          title={t(`confirm.${confirm.action}.title`, { name: nameOf(confirm.endpoint) })}
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
      {issued && <SecretDialog issued={issued} onClose={() => setIssued(null)} />}
    </section>
  )
}

function SignatureHelp() {
  const { t } = useTranslation('webhooks')
  return (
    <details className="webhooks__help">
      <summary>{t('help.summary')}</summary>
      <p>{t('help.standard')}</p>
      <p>{t('help.rawBody')}</p>
      <p>{t('help.retries')}</p>
      <ul>
        {(Object.keys(HELP_LINKS) as (keyof typeof HELP_LINKS)[]).map((key) => (
          <li key={key}>
            <a href={HELP_LINKS[key]} target="_blank" rel="noreferrer">
              {t(`help.${key}`)}
            </a>
          </li>
        ))}
      </ul>
    </details>
  )
}

function WebhookCard({
  endpoint,
  totalTypes,
  allowed,
  pending,
  logOpen,
  onToggleLog,
  onEdit,
  onConfirm,
  children,
}: {
  endpoint: WebhookEndpointListItem
  totalTypes: number
  allowed: { create: boolean; edit: boolean; delete: boolean }
  pending: boolean
  logOpen: boolean
  onToggleLog: () => void
  onEdit: () => void
  onConfirm: (action: ConfirmAction) => void
  children: ReactNode
}) {
  const { t } = useTranslation('webhooks')
  const date = useDateFormat()
  const active = endpoint.state === 'active'
  const { finished, failed } = endpoint.deliveries24h
  const logId = useId()
  return (
    <article
      className={active ? 'directory__card' : 'directory__card webhooks__card--disabled'}
      aria-label={nameOf(endpoint)}
    >
      <h2 className="webhooks__name">
        <span>{nameOf(endpoint)}</span>
        <Badge tone={active ? 'win' : 'danger'}>{t(`state.${endpoint.state}`)}</Badge>
      </h2>
      {!active && endpoint.disabledReason && endpoint.disabledAt && (
        <p className="ui-notice webhooks__reason">
          {t('disabledSince', {
            date: date(endpoint.disabledAt),
            reason: t(`reason.${endpoint.disabledReason}`),
          })}
        </p>
      )}
      <dl className="webhooks__facts">
        <dt>{t('facts.url')}</dt>
        <dd>
          <code>{endpoint.url}</code>
        </dd>
        <dt>{t('facts.eventTypes')}</dt>
        <dd>
          {totalTypes > 0
            ? t('facts.eventTypesValue', { n: endpoint.eventTypes.length, total: totalTypes })
            : endpoint.eventTypes.length}
        </dd>
        <dt>{t('facts.lastSuccess')}</dt>
        <dd>{endpoint.lastSuccessAt ? date(endpoint.lastSuccessAt) : t('facts.never')}</dd>
        <dt>{t('facts.failures24h')}</dt>
        <dd>
          {finished === 0
            ? t('facts.noDeliveries24h')
            : t('facts.failuresValue', {
                failed,
                finished,
                percent: Math.round((failed / finished) * 100),
              })}
        </dd>
        {endpoint.previousSecretExpiresAt && (
          <>
            <dt>{t('facts.previousSecret')}</dt>
            <dd>{date(endpoint.previousSecretExpiresAt)}</dd>
          </>
        )}
        <dt>{t('facts.created')}</dt>
        <dd>
          {t('facts.createdBy', {
            name: endpoint.createdBy.name,
            date: date(endpoint.createdAt),
          })}
        </dd>
      </dl>
      <div className="directory__row">
        <Button size="sm" aria-expanded={logOpen} aria-controls={logId} onClick={onToggleLog}>
          {t('actions.showLog')}
        </Button>
        {allowed.edit && (
          <>
            <Button size="sm" disabled={pending} onClick={onEdit}>
              {t('actions.edit')}
            </Button>
            <Button size="sm" disabled={pending} onClick={() => onConfirm('rotate')}>
              {t('actions.rotate')}
            </Button>
            {active ? (
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
        {allowed.delete && (
          <Button size="sm" variant="danger" disabled={pending} onClick={() => onConfirm('delete')}>
            {t('actions.delete')}
          </Button>
        )}
      </div>
      {logOpen && <div id={logId}>{children}</div>}
    </article>
  )
}

/** Изменённые поля вебхука: PATCH отправляет только их (адрес без изменений не перепроверяется). */
function changedFields(
  endpoint: WebhookEndpointListItem,
  input: WebhookEndpointInput,
): Partial<WebhookEndpointInput> {
  const changes: Partial<WebhookEndpointInput> = {}
  if (input.url !== endpoint.url) changes.url = input.url
  if ((input.description ?? null) !== endpoint.description)
    changes.description = input.description ?? null
  if (input.eventTypes.join() !== endpoint.eventTypes.join()) changes.eventTypes = input.eventTypes
  return changes
}

function WebhookDialog({
  endpoint,
  eventTypes,
  pending,
  onClose,
  onSubmit,
}: {
  endpoint: WebhookEndpointListItem | null
  eventTypes: WebhookEventTypeInfo[]
  pending: boolean
  onClose: () => void
  onSubmit: (input: Partial<WebhookEndpointInput>) => Promise<void>
}) {
  const { t } = useTranslation('webhooks')
  const language = useLanguage()
  const errorText = useErrorText()
  const [url, setUrl] = useState(endpoint?.url ?? '')
  const [description, setDescription] = useState(endpoint?.description ?? '')
  const [selected, setSelected] = useState<ReadonlySet<EventType>>(
    () => new Set(endpoint?.eventTypes ?? []),
  )
  const [missing, setMissing] = useState(false)
  const [urlError, setUrlError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const title = endpoint ? t('form.editTitle', { name: nameOf(endpoint) }) : t('form.new')
  const entities = [...new Set(eventTypes.map((info) => info.entity))]
  const allSelected = eventTypes.length > 0 && eventTypes.every((info) => selected.has(info.type))

  const toggle = (type: EventType) => {
    const next = new Set(selected)
    if (next.has(type)) next.delete(type)
    else next.add(type)
    setSelected(next)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (url.trim() === '' || selected.size === 0) {
      setMissing(true)
      return
    }
    setUrlError(null)
    setError(null)
    const input: WebhookEndpointInput = {
      url: url.trim(),
      description: description.trim() === '' ? null : description.trim(),
      eventTypes: eventTypes.map((info) => info.type).filter((type) => selected.has(type)),
    }
    try {
      await onSubmit(endpoint ? changedFields(endpoint, input) : input)
    } catch (failure) {
      const code = failure instanceof RolesApiError ? failure.code : ''
      if (code.startsWith('WEBHOOK_URL_')) {
        setUrlError(t(`urlErrors.${code}`, { defaultValue: t('urlErrors.WEBHOOK_URL_INVALID') }))
      } else {
        setError(errorText(failure))
      }
    }
  }

  const urlFieldError = missing && url.trim() === '' ? t('form.required') : (urlError ?? undefined)

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            {t('form.cancel')}
          </Button>
          <Button type="submit" form="webhook-form" variant="primary" busy={pending}>
            {endpoint ? t('form.save') : t('form.createSubmit')}
          </Button>
        </>
      }
    >
      <form
        id="webhook-form"
        className="webhooks__form"
        aria-label={title}
        onSubmit={submit}
        noValidate
      >
        {error && (
          <p className="ui-notice" role="alert">
            {error}
          </p>
        )}
        <Field label={t('form.url')} hint={t('form.urlHint')} error={urlFieldError}>
          <Input
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://"
            value={url}
            maxLength={MAX_WEBHOOK_URL_LENGTH}
            onChange={(event) => {
              setUrl(event.target.value)
              setUrlError(null)
            }}
          />
        </Field>
        <Field label={t('form.description')} hint={t('form.descriptionHint')}>
          <Input
            value={description}
            maxLength={MAX_WEBHOOK_DESCRIPTION_LENGTH}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <fieldset className="webhooks__types">
          <legend>{t('form.eventTypes')}</legend>
          <Checkbox
            label={t('form.selectAll')}
            checked={allSelected}
            onChange={() =>
              setSelected(allSelected ? new Set() : new Set(eventTypes.map((info) => info.type)))
            }
          />
          {entities.map((entity) => (
            <fieldset key={entity} className="webhooks__group">
              <legend>{t(`form.entity.${entity}`)}</legend>
              {eventTypes
                .filter((info) => info.entity === entity)
                .map((info) => (
                  <Checkbox
                    key={info.type}
                    className="webhooks__type"
                    checked={selected.has(info.type)}
                    onChange={() => toggle(info.type)}
                    label={
                      <>
                        {info.title[language]} <code>{info.type}</code>
                      </>
                    }
                  />
                ))}
            </fieldset>
          ))}
          {missing && selected.size === 0 && (
            <span className="ui-field__error" role="alert">
              {t('form.noTypes')}
            </span>
          )}
        </fieldset>
      </form>
    </Dialog>
  )
}

function SecretDialog({ issued, onClose }: { issued: Issued; onClose: () => void }) {
  const { t } = useTranslation('webhooks')
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
      title={t('secret.title', { name: nameOf(issued.endpoint) })}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('secret.done')}
        </Button>
      }
    >
      <div className="webhooks__form">
        <p className="ui-notice" role="alert">
          {t('secret.once')}
        </p>
        {issued.rotated && <p className="ui-notice">{t('secret.overlap')}</p>}
        <Field label={t('secret.label')}>
          <Input
            readOnly
            value={issued.secret}
            className="webhooks__secret"
            onFocus={(event) => event.currentTarget.select()}
          />
        </Field>
        <div className="directory__row">
          <Button onClick={() => void copy()}>{t('secret.copy')}</Button>
          {copied && (
            <span role="status">
              {copied === 'done' ? t('secret.copied') : t('secret.copyFailed')}
            </span>
          )}
        </div>
        <SignatureHelp />
      </div>
    </Dialog>
  )
}

const STATE_TONES: Record<WebhookDeliveryState, 'neutral' | 'win' | 'danger' | 'ask'> = {
  pending: 'ask',
  succeeded: 'win',
  failed: 'danger',
  cancelled: 'neutral',
}

function DeliveryLog({
  api,
  projectId,
  endpoint,
  canEdit,
}: {
  api: WebhooksApi
  projectId: string
  endpoint: WebhookEndpointListItem
  canEdit: boolean
}) {
  const { t } = useTranslation('webhooks')
  const language = useLanguage()
  const errorText = useErrorText()
  const queryClient = useQueryClient()
  const [state, setState] = useState<WebhookDeliveryState | ''>('')
  const [type, setType] = useState<EventType | ''>('')
  const [since, setSince] = useState('')
  const [catchUpDay, setCatchUpDay] = useState('')
  const [confirmCatchUp, setConfirmCatchUp] = useState(false)
  const catchUpHintId = useId()
  const [notice, setNotice] = useState<Notice>(null)
  const disabled = endpoint.state !== 'active'
  // Под ключом списка: изменение вебхука перечитывает и журнал, повтор — и сводку в списке.
  const listKey = projectQueryKey(projectId, 'webhooks')
  const log = useInfiniteQuery({
    queryKey: [...listKey, endpoint.id, 'deliveries', state, type],
    queryFn: ({ pageParam }) =>
      api.deliveries(projectId, endpoint.id, {
        ...(state ? { state } : {}),
        ...(type ? { type } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: '',
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    retry: false,
    // Повтор возвращает доставку в «очікує»: попытка появится, когда её отправит фоновая задача.
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) => page.data.some((d) => d.state === 'pending'))
        ? PENDING_REFRESH_MS
        : false,
  })
  const retry = useMutation({
    mutationFn: (action: () => Promise<{ queued: number }>) => action(),
    onSettled: () => queryClient.invalidateQueries({ queryKey: listKey }),
  })

  const runRetry = async (
    action: () => Promise<{ queued: number }>,
    done: (n: number) => string,
  ) => {
    setNotice(null)
    try {
      const { queued } = await retry.mutateAsync(action)
      setNotice({ kind: 'status', text: done(queued) })
    } catch (error) {
      setNotice({ kind: 'alert', text: errorText(error) })
    }
  }

  const deliveries = log.data?.pages.flatMap((page) => page.data) ?? []
  const bound = catchUpBound(endpoint)
  const dayFormat = new Intl.DateTimeFormat(language, { dateStyle: 'long' })
  const catchUpDate = catchUpDay === '' ? '' : dayFormat.format(new Date(`${catchUpDay}T00:00:00`))

  const runCatchUp = () => {
    setConfirmCatchUp(false)
    void runRetry(
      () => api.catchUp(projectId, endpoint.id, catchUpSince(catchUpDay, bound)),
      (n) => t('log.catchUpQueued', { n }),
    )
  }

  return (
    <section className="webhooks__log" aria-label={t('log.title')}>
      <h3>{t('log.title')}</h3>
      <div className="webhooks__filters">
        <Field label={t('log.filterState')}>
          <Select
            size="sm"
            value={state}
            onChange={(event) => setState(event.target.value as WebhookDeliveryState | '')}
          >
            <option value="">{t('log.all')}</option>
            {WEBHOOK_DELIVERY_STATES.map((value) => (
              <option key={value} value={value}>
                {t(`log.state.${value}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('log.filterType')}>
          <Select
            size="sm"
            value={type}
            onChange={(event) => setType(event.target.value as EventType | '')}
          >
            <option value="">{t('log.all')}</option>
            {(Object.keys(EVENT_TYPE_TITLES) as EventType[]).map((value) => (
              <option key={value} value={value}>
                {EVENT_TYPE_TITLES[value][language]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {canEdit && (
        <div className="webhooks__filters">
          <Field label={t('log.since')}>
            <Input
              size="sm"
              type="date"
              value={since}
              onChange={(event) => setSince(event.target.value)}
            />
          </Field>
          <Button
            size="sm"
            disabled={disabled || since === '' || retry.isPending}
            onClick={() =>
              void runRetry(
                // Дата без времени — с начала этого дня по местному времени.
                () =>
                  api.retryFailed(
                    projectId,
                    endpoint.id,
                    new Date(`${since}T00:00:00`).toISOString(),
                  ),
                (n) => t('log.retryFailedQueued', { n }),
              )
            }
          >
            {t('log.retryFailed')}
          </Button>
        </div>
      )}
      {canEdit && (
        <div className="webhooks__filters">
          <Field label={t('log.catchUpSince')}>
            <Input
              size="sm"
              type="date"
              aria-describedby={catchUpHintId}
              min={localDay(bound)}
              max={localDay(Date.now())}
              value={catchUpDay}
              onChange={(event) => setCatchUpDay(event.target.value)}
            />
          </Field>
          <Button
            size="sm"
            disabled={disabled || catchUpDay === '' || retry.isPending}
            onClick={() => setConfirmCatchUp(true)}
          >
            {t('log.catchUp')}
          </Button>
        </div>
      )}
      {canEdit && (
        <p id={catchUpHintId} className="directory__hint">
          {t('log.catchUpHint')}
        </p>
      )}
      {canEdit && disabled && <p className="directory__hint">{t('log.disabledHint')}</p>}
      <NoticeLine notice={notice} />
      {log.isPending && <Skeleton />}
      {log.isError && (
        <p className="ui-notice" role="alert">
          {errorText(log.error)}
        </p>
      )}
      {log.isSuccess && deliveries.length === 0 && <p>{t('log.empty')}</p>}
      {deliveries.length > 0 && (
        <ul className="webhooks__deliveries">
          {deliveries.map((delivery) => (
            <DeliveryItem
              key={delivery.id}
              delivery={delivery}
              canRetry={canEdit}
              retryDisabled={disabled || delivery.state === 'pending' || retry.isPending}
              onRetry={() =>
                void runRetry(
                  () => api.retryDelivery(projectId, endpoint.id, delivery.id),
                  () => t('log.retryQueued'),
                )
              }
            />
          ))}
        </ul>
      )}
      {log.hasNextPage && (
        <div className="directory__row">
          <Button size="sm" busy={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
            {t('log.loadMore')}
          </Button>
        </div>
      )}
      {confirmCatchUp && (
        <Dialog
          open
          onClose={() => setConfirmCatchUp(false)}
          title={t('log.catchUpConfirm.title', { name: nameOf(endpoint) })}
          footer={
            <>
              <Button variant="quiet" onClick={() => setConfirmCatchUp(false)}>
                {t('confirm.cancel')}
              </Button>
              <Button variant="primary" onClick={runCatchUp}>
                {t('log.catchUpConfirm.submit')}
              </Button>
            </>
          }
        >
          <p>{t('log.catchUpConfirm.text', { date: catchUpDate })}</p>
        </Dialog>
      )}
    </section>
  )
}

function DeliveryItem({
  delivery,
  canRetry,
  retryDisabled,
  onRetry,
}: {
  delivery: WebhookDeliveryView
  canRetry: boolean
  retryDisabled: boolean
  onRetry: () => void
}) {
  const { t } = useTranslation('webhooks')
  const language = useLanguage()
  const date = useDateFormat('medium')
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const bodyId = useId()
  const attemptsId = useId()
  const title = EVENT_TYPE_TITLES[delivery.eventType][language]
  const response = (attempt: WebhookDeliveryView['attemptLog'][number]) =>
    attempt.statusCode !== null
      ? String(attempt.statusCode)
      : t(`log.error.${attempt.error ?? 'network'}`)
  const last = delivery.attemptLog.at(-1)
  return (
    <li className="webhooks__delivery" aria-label={`${title} · ${date(delivery.occurredAt)}`}>
      <div className="webhooks__delivery-head">
        <span className="webhooks__delivery-title">
          {title} <code>{delivery.eventType}</code>
        </span>
        <Badge tone={STATE_TONES[delivery.state]}>{t(`log.state.${delivery.state}`)}</Badge>
      </div>
      <div className="webhooks__delivery-meta">
        <span>{date(delivery.occurredAt)}</span>
        <code>{delivery.eventId}</code>
        <span>{t('log.attempts', { n: delivery.attempts })}</span>
        <span>{last ? t('log.lastCode', { code: response(last) }) : t('log.noAttempts')}</span>
        {delivery.nextAttemptAt && (
          <span>{t('log.nextAttempt', { date: date(delivery.nextAttemptAt) })}</span>
        )}
      </div>
      <div className="directory__row">
        <Button
          size="sm"
          variant="quiet"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen(!open)}
        >
          {t('log.details')}
        </Button>
      </div>
      {open && (
        <div id={detailsId} className="webhooks__details">
          <h4 id={attemptsId}>{t('log.attemptsTitle')}</h4>
          {delivery.attemptLog.length === 0 ? (
            <p>{t('log.noAttempts')}</p>
          ) : (
            <ol className="webhooks__attempts" aria-labelledby={attemptsId}>
              {delivery.attemptLog.map((attempt) => (
                <li key={attempt.attemptedAt}>
                  <span>{date(attempt.attemptedAt)}</span>
                  <strong>{response(attempt)}</strong>
                  <span>{t('log.duration', { ms: attempt.durationMs })}</span>
                  {attempt.responseBody && (
                    <code className="webhooks__response">{attempt.responseBody}</code>
                  )}
                </li>
              ))}
            </ol>
          )}
          <section aria-labelledby={bodyId}>
            <h4 id={bodyId}>{t('log.eventBody')}</h4>
            <pre className="webhooks__body">{JSON.stringify(delivery.event, null, 2)}</pre>
          </section>
          {canRetry && (
            <div className="directory__row">
              <Button size="sm" disabled={retryDisabled} onClick={onRetry}>
                {t('log.retry')}
              </Button>
            </div>
          )}
        </div>
      )}
    </li>
  )
}
