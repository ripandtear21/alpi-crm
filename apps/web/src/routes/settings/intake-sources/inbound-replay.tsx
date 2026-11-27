import { INBOUND_RETENTION_DAYS, type InboundReplayRun } from '@alpi/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { projectQueryKey } from '../../../components/project-switcher/current-project.tsx'
import { Button } from '../../../ui/button.tsx'
import { Dialog } from '../../../ui/dialog.tsx'
import { Field, Input } from '../../../ui/field.tsx'
import { type Notice, NoticeLine } from '../directory-controls.tsx'
import type { IntakeSourcesApi } from './intake-sources-api.ts'
import { useDateFormat, useErrorText } from './intake-sources-format.ts'

// «Провести заново вхідні з моменту…» (тикет crm-intake/07 на API тикета 06): только
// администратору проекта. Кто администратор, экран узнаёт по запросу хода (`GET
// /v1/inbound/replay`): остальным API отвечает 403, и раздела нет (решено без владельца —
// подтвердить); другой сбой этого запроса — сообщение в разделе. Момент — дата и время по
// местному времени, не старше 30 дней; после подтверждения задача уходит в очередь, экран
// перечитывает её ход, пока не придёт итог: числа или «не завершилось» (задача провалила все
// попытки, apps/api/src/intake/replay-status.ts).

/** Как часто перечитывать ход, пока задача идёт, мс. */
const RUNNING_REFRESH_MS = 3000

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Самый ранний момент, который примет API. shortcut: минута запаса на дорогу запроса у границы
 * 30 дней; дольше — API ответит 422 REPLAY_TOO_OLD, и экран покажет причину.
 */
const earliest = () => Date.now() - INBOUND_RETENTION_DAYS * DAY_MS + 60 * 1000

/** Значение поля type="datetime-local" (`YYYY-MM-DDTHH:mm`) по местному времени. */
function localMinute(time: number): string {
  const date = new Date(time)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

/** Порядок счётчиков итога; незнакомые (новые итоги) — после них. */
const COUNT_ORDER = ['accepted', 'repeats', 'errors', 'unmatched']

export function InboundReplay({ api, projectId }: { api: IntakeSourcesApi; projectId: string }) {
  const { t } = useTranslation('intake-sources')
  const errorText = useErrorText()
  const date = useDateFormat()
  const queryClient = useQueryClient()
  const statusKey = projectQueryKey(projectId, 'inbound-replay')
  const status = useQuery({
    queryKey: statusKey,
    queryFn: () => api.replayStatus(projectId),
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.latest && query.state.data.latest.finishedAt === null
        ? RUNNING_REFRESH_MS
        : false,
  })
  const start = useMutation({
    mutationFn: (since: string) => api.replay(projectId, since),
    onSettled: () => queryClient.invalidateQueries({ queryKey: statusKey }),
  })
  const [since, setSince] = useState('')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const titleId = useId()

  // Не администратор (403) или ещё не ответили — раздела нет. Другой сбой запроса хода —
  // сообщение: кнопка не должна пропадать у администратора молча.
  if (status.data === null) return null
  if (status.data === undefined) {
    if (!status.isError) return null
    return (
      <section className="directory__card intake-sources__replay" aria-labelledby={titleId}>
        <h2 id={titleId}>{t('replay.title')}</h2>
        <p className="ui-notice" role="alert">
          {t('replay.statusFailed')}
        </p>
      </section>
    )
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setNotice(null)
    const time = since === '' ? Number.NaN : new Date(since).getTime()
    if (Number.isNaN(time)) return setFieldError(t('replay.required'))
    if (time < earliest()) return setFieldError(t('replay.tooOld'))
    if (time > Date.now()) return setFieldError(t('replay.inFuture'))
    setFieldError(null)
    setConfirming(new Date(time).toISOString())
  }

  const run = async () => {
    if (!confirming) return
    const value = confirming
    setConfirming(null)
    try {
      await start.mutateAsync(value)
    } catch (error) {
      setNotice({ kind: 'alert', text: errorText(error) })
    }
  }

  return (
    <section className="directory__card intake-sources__replay" aria-labelledby={titleId}>
      <h2 id={titleId}>{t('replay.title')}</h2>
      <p className="directory__hint">{t('replay.hint')}</p>
      <form className="intake-sources__filters" onSubmit={submit} noValidate>
        <Field label={t('replay.since')} error={fieldError ?? undefined}>
          <Input
            type="datetime-local"
            min={localMinute(earliest())}
            max={localMinute(Date.now())}
            value={since}
            onChange={(event) => {
              setSince(event.target.value)
              setFieldError(null)
            }}
          />
        </Field>
        <Button type="submit" busy={start.isPending}>
          {t('replay.submit')}
        </Button>
      </form>
      <NoticeLine notice={notice} />
      {status.data.latest && <ReplayRun run={status.data.latest} date={date} />}
      {confirming && (
        <Dialog
          open
          onClose={() => setConfirming(null)}
          title={t('replay.confirm.title', { date: date(confirming) })}
          footer={
            <>
              <Button variant="quiet" onClick={() => setConfirming(null)}>
                {t('confirm.cancel')}
              </Button>
              <Button variant="primary" onClick={() => void run()}>
                {t('replay.confirm.submit')}
              </Button>
            </>
          }
        >
          <p>{t('replay.confirm.text')}</p>
        </Dialog>
      )}
    </section>
  )
}

function ReplayRun({ run, date }: { run: InboundReplayRun; date: (value: string) => string }) {
  const { t } = useTranslation('intake-sources')
  const period = { since: date(run.since), until: date(run.until) }
  if (run.finishedAt === null) {
    return (
      <p className="ui-notice" role="status">
        {t('replay.running', period)}
      </p>
    )
  }
  if (run.failed || run.counts === null) {
    return (
      <p className="ui-notice" role="alert">
        {t('replay.failed', period)}
      </p>
    )
  }
  const counts = run.counts
  const keys = Object.keys(counts).sort(
    (a, b) =>
      (COUNT_ORDER.indexOf(a) + 1 || COUNT_ORDER.length + 1) -
      (COUNT_ORDER.indexOf(b) + 1 || COUNT_ORDER.length + 1),
  )
  return (
    <p className="ui-notice" role="status">
      {t('replay.finished', period)} —{' '}
      {keys
        .map((key) => t(`replay.counts.${key}`, { n: counts[key], defaultValue: `${key}: {{n}}` }))
        .join(', ')}
    </p>
  )
}
