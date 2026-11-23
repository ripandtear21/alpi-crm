import type { BulkJobProgress, MemberSummary } from '@alpi/shared'
import { useQuery } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { projectQueryKey } from '../../components/project-switcher/current-project.tsx'
import { Button } from '../../ui/button.tsx'
import { Dialog } from '../../ui/dialog.tsx'
import { type MembersApi, MembersApiError } from './members-api.ts'

// Диалог «Передать сделки» на экране участников (тикет crm-deals/09): кому — участнику проекта
// или в общую очередь, затем ход массовой операции и отключение участника. Права и охват
// проверяет API; диалог показывает его отказ текстом. Построен на общем Dialog (тикет
// crm-deals/01): рамка, Esc, возврат фокуса и область уведомлений — оттуда.
//
// Диалог модальный (showModal): пока он открыт, страница за ним недоступна, и передачу другого
// участника не начать поверх недоконченной. Экран участников вдобавок пересоздаёт диалог на
// каждого участника (key), чтобы ход чужой операции не достался следующему.

/** Как часто спрашивать ход операции, мс. */
const POLL_MS = 1000

type Step = { kind: 'choose' } | { kind: 'running'; jobId: string }

export function TransferDealsDialog({
  api,
  projectId,
  member,
  members,
  errorText,
  onClose,
  onDisabled,
}: {
  api: MembersApi
  projectId: string
  /** Чьи сделки. */
  member: MemberSummary
  /** Участники проекта: получатели — действующие, кроме самого участника. */
  members: MemberSummary[]
  /** Текст отказа API — тот же, что у экрана участников. */
  errorText: (error: unknown) => string
  onClose: () => void
  /** Участник `userId` отключён после передачи. */
  onDisabled: (userId: string) => void
}) {
  const { t } = useTranslation('settings')
  const [step, setStep] = useState<Step>({ kind: 'choose' })
  const [message, setMessage] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const who = member.name || member.email
  const recipients = members.filter((m) => !m.disabled && m.userId !== member.userId)

  const job = useQuery({
    queryKey: projectQueryKey(projectId, 'bulk-job', step.kind === 'running' ? step.jobId : null),
    queryFn: () => api.bulkJob(projectId, step.kind === 'running' ? step.jobId : ''),
    enabled: step.kind === 'running',
    retry: false,
    refetchInterval: (query) => (finished(query.state.data) ? false : POLL_MS),
  })

  async function transfer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = String(new FormData(event.currentTarget).get('toUserId') ?? '')
    setMessage(null)
    setPending(true)
    try {
      const started = await api.transferDeals(projectId, member.userId, {
        toUserId: value === '' ? null : value,
      })
      setStep({ kind: 'running', jobId: started.id })
    } catch (error) {
      setMessage(errorText(error))
    } finally {
      setPending(false)
    }
  }

  async function disable() {
    setMessage(null)
    setPending(true)
    try {
      await api.disable(projectId, member.userId)
      onDisabled(member.userId)
    } catch (error) {
      const count = error instanceof MembersApiError ? error.details?.count : undefined
      if (error instanceof MembersApiError && error.code === 'HAS_OPEN_DEALS') {
        // Пока шла передача, участнику дали новые сделки: передать снова.
        setStep({ kind: 'choose' })
        setMessage(t('members.transfer.newDeals', { number: Number(count ?? 0) }))
      } else {
        setMessage(errorText(error))
      }
    } finally {
      setPending(false)
    }
  }

  const progress = job.data
  return (
    <Dialog
      // Открыт всё время, пока смонтирован: экран участников монтирует диалог на участника.
      // Escape, кнопка «Закрыть» в заголовке, щелчок по затемнению и закрытие браузером
      // (событие close) убирают диалог через onClose.
      open
      onClose={onClose}
      title={t('members.transfer.title', { name: who })}
      className="transfer-dialog"
    >
      {step.kind === 'choose' && (
        <form className="transfer-dialog__form" onSubmit={transfer}>
          <p className="members__hint">{t('members.transfer.hint')}</p>
          <label>
            {t('members.transfer.to')}{' '}
            <select
              className="ui-select ui-select--sm"
              name="toUserId"
              defaultValue=""
              disabled={pending}
            >
              <option value="">{t('members.transfer.queue')}</option>
              {recipients.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name || m.email}
                </option>
              ))}
            </select>
          </label>
          <Button size="sm" type="submit" variant="primary" disabled={pending}>
            {t('members.transfer.submit')}
          </Button>
        </form>
      )}

      {step.kind === 'running' && (
        <div className="transfer-dialog__progress">
          {job.isError ? (
            <p className="ui-notice" role="alert">
              {errorText(job.error)}
            </p>
          ) : (
            <Progress job={progress} />
          )}
          {progress?.status === 'done' && (
            <Button size="sm" type="button" variant="danger" disabled={pending} onClick={disable}>
              {t('members.disable', { name: who })}
            </Button>
          )}
        </div>
      )}

      {message && (
        <p className="ui-notice" role="status">
          {message}
        </p>
      )}
    </Dialog>
  )
}

function finished(job: BulkJobProgress | undefined): boolean {
  return job?.status === 'done' || job?.status === 'failed'
}

function Progress({ job }: { job: BulkJobProgress | undefined }) {
  const { t } = useTranslation('settings')
  if (!job || job.total === null) {
    return (
      <p role="status" aria-live="polite">
        {t('members.transfer.preparing')}
      </p>
    )
  }
  const transferred = job.processed - job.failed
  return (
    <div role="status" aria-live="polite">
      <progress
        max={Math.max(job.total, 1)}
        value={job.total === 0 ? 1 : job.processed}
        aria-label={t('members.transfer.progressLabel')}
      />
      <p>
        {job.status === 'failed'
          ? t('members.transfer.stopped', { code: job.failure ?? '' })
          : job.status === 'done'
            ? t('members.transfer.done', { transferred, total: job.total })
            : t('members.transfer.running', { processed: job.processed, total: job.total })}
      </p>
      {job.failed > 0 && <p>{t('members.transfer.failed', { failed: job.failed })}</p>}
    </div>
  )
}
