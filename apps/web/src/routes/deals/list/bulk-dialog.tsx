import type { FilterGroup, PipelineSummary, RolePermissions } from '@alpi/shared'
import { can, hasStandalone } from '@alpi/shared'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  projectHref,
  useProjectCode,
} from '../../../components/project-switcher/current-project.tsx'
import { Button } from '../../../ui/button.tsx'
import { Dialog } from '../../../ui/dialog.tsx'
import { Notice, Progress } from '../../../ui/feedback.tsx'
import { Field, Select } from '../../../ui/field.tsx'
import { type BulkJob, type ListOwner, type ListsApi, ListsApiError } from './lists-api.ts'
import './lists.css'

// Массовая дія над вибраними угодами або над усім результатом фільтра (тикет crm-deals/12):
// дію виконує сервер фоновою задачею (каркас тикета 04), діалог показує прогрес і журнал
// записів з помилкою. Кнопки дій без права приховані; перевіряє кожен запит усе одно сервер.

export const BULK_ACTIONS = [
  'deals.archive',
  'deals.unarchive',
  'deals.assign',
  'deals.stage',
  'deals.trash',
] as const
export type BulkActionCode = (typeof BULK_ACTIONS)[number]

/** Дії, доступні правам: «масові операції» плюс право самої дії. */
export function allowedBulkActions(permissions: RolePermissions): BulkActionCode[] {
  if (!hasStandalone(permissions, 'bulk_operations')) return []
  return BULK_ACTIONS.filter((action) => {
    if (action === 'deals.trash') return can(permissions, 'deals', 'delete')
    if (action === 'deals.assign') {
      return can(permissions, 'deals', 'edit') && hasStandalone(permissions, 'transfer_deals')
    }
    return can(permissions, 'deals', 'edit')
  })
}

/** Як часто питати прогрес. */
const POLL_MS = 1000

export function BulkDialog({
  api,
  projectId,
  selection,
  total,
  actions,
  pipelines,
  owners,
  onClose,
  onFinished,
}: {
  api: ListsApi
  projectId: string
  selection: { ids: string[] } | { filter: FilterGroup }
  /** Скільки записів вибрано (за фільтром — лічильник). */
  total: number
  actions: BulkActionCode[]
  pipelines: PipelineSummary[]
  owners: ListOwner[]
  onClose: () => void
  onFinished: () => void
}) {
  const { t } = useTranslation('lists')
  const code = useProjectCode()
  const [action, setAction] = useState<BulkActionCode>(actions[0] ?? 'deals.archive')
  const [owner, setOwner] = useState('')
  const [stage, setStage] = useState('')
  const [jobId, setJobId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const job = useQuery({
    queryKey: ['bulk-job', projectId, jobId],
    queryFn: async () => {
      const current = await api.bulkJob(projectId, jobId ?? '')
      if (current.status === 'done' || current.status === 'failed') onFinished()
      return current
    },
    enabled: jobId !== null,
    refetchInterval: (query) => {
      const status = (query.state.data as BulkJob | undefined)?.status
      return status === 'done' || status === 'failed' ? false : POLL_MS
    },
    retry: false,
  })

  const needsOwner = action === 'deals.assign'
  const needsStage = action === 'deals.stage'
  const ready = (!needsOwner || owner !== '') && (!needsStage || stage !== '')

  async function start() {
    setBusy(true)
    setError(null)
    try {
      const params = needsOwner
        ? { ownerId: owner === 'queue' ? null : owner }
        : needsStage
          ? { stageId: stage }
          : undefined
      const started = await api.startBulk(projectId, {
        action,
        selection,
        ...(params ? { params } : {}),
      })
      setJobId(started.id)
    } catch (caught) {
      setError(
        caught instanceof ListsApiError && caught.status === 403
          ? t('bulk.noAccess')
          : t('bulk.startFailed'),
      )
    } finally {
      setBusy(false)
    }
  }

  const current = job.data
  const finished = current?.status === 'done' || current?.status === 'failed'

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('bulk.title')}
      footer={
        jobId === null ? (
          <>
            <Button variant="quiet" onClick={onClose}>
              {t('bulk.cancel')}
            </Button>
            <Button variant="primary" disabled={!ready || busy} onClick={() => void start()}>
              {t('bulk.start')}
            </Button>
          </>
        ) : (
          <Button variant={finished ? 'primary' : 'quiet'} onClick={onClose}>
            {t('bulk.close')}
          </Button>
        )
      }
    >
      {jobId === null ? (
        <div className="bulk-form">
          <p>
            {'ids' in selection
              ? t('bulk.scopeIds', { count: total })
              : t('bulk.scopeFilter', { count: total })}
          </p>
          <Field label={t('bulk.action')}>
            <Select
              value={action}
              onChange={(event) => setAction(event.target.value as BulkActionCode)}
            >
              {actions.map((code) => (
                <option key={code} value={code}>
                  {t(`bulk.actions.${code}`)}
                </option>
              ))}
            </Select>
          </Field>
          {needsOwner && (
            <Field label={t('bulk.owner')}>
              <Select value={owner} onChange={(event) => setOwner(event.target.value)}>
                <option value="">—</option>
                <option value="queue">{t('bulk.queue')}</option>
                {owners.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {needsStage && (
            <Field label={t('bulk.stage')}>
              <Select value={stage} onChange={(event) => setStage(event.target.value)}>
                <option value="">—</option>
                {pipelines.map((pipeline) => (
                  <optgroup key={pipeline.id} label={pipeline.name}>
                    {pipeline.stages.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            </Field>
          )}
          {error && <Notice kind="alert">{error}</Notice>}
        </div>
      ) : (
        <div className="bulk-progress">
          <Progress
            label={t('bulk.progressLabel')}
            {...(current?.total ? { value: current.processed, max: current.total } : {})}
          />
          {current && !finished && (
            <p role="status">
              {t('bulk.progress', { processed: current.processed, total: current.total ?? '…' })}
            </p>
          )}
          {current?.status === 'done' && (
            <Notice kind="status">
              {t('bulk.done', { processed: current.processed, failed: current.failed })}
            </Notice>
          )}
          {current?.status === 'failed' && (
            <Notice kind="alert">{t('bulk.failedWhole', { reason: current.failure ?? '' })}</Notice>
          )}
          {finished && (current?.errors?.length ?? 0) > 0 && (
            <section aria-label={t('bulk.errorsTitle')}>
              <h3>{t('bulk.errorsTitle')}</h3>
              <ul className="bulk-errors">
                {current?.errors?.slice(0, 50).map((e) => (
                  <li key={e.position}>
                    <a href={projectHref(code, `/deals/${e.recordId}`)}>{e.recordId.slice(0, 8)}</a>
                    {' — '}
                    {t(`bulk.errors.${e.code}` as 'bulk.errors.FAILED', { defaultValue: e.code })}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Dialog>
  )
}
