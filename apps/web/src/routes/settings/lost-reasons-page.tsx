import type { LostReasonGroupSummary, LostReasonSummary } from '@alpi/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  projectQueryKey,
  useCurrentProject,
} from '../../components/project-switcher/current-project.tsx'
import {
  AddForm,
  ArchiveButton,
  moved,
  type Notice,
  NoticeLine,
  OrderButtons,
  RenameForm,
  useDirectoryErrorText,
} from './directory-controls.tsx'
import type { DirectoryChange, PipelinesApi } from './pipelines-api.ts'
import { RolesApiError } from './roles-api.ts'

// Настройки → Причины проигрыша (тикет crm-deals/02): группы и причины — создать,
// переименовать, переставить кнопками, отправить в архив и вернуть. Причины не удаляются:
// архивная не предлагается при проигрыше, но остаётся у старых сделок. Права — как у воронок.

export function LostReasonsPage({ api }: { api: PipelinesApi }) {
  const { t } = useTranslation('settings')
  const { current } = useCurrentProject()
  if (!current) {
    return (
      <section>
        <h1>{t('lostReasons.title')}</h1>
        <p>{t('lostReasons.noProject')}</p>
      </section>
    )
  }
  return <LostReasonsEditor key={current.id} api={api} projectId={current.id} />
}

function LostReasonsEditor({ api, projectId }: { api: PipelinesApi; projectId: string }) {
  const { t } = useTranslation('settings')
  const errorText = useDirectoryErrorText()
  const queryClient = useQueryClient()
  const key = projectQueryKey(projectId, 'lost-reasons')
  const groups = useQuery({
    queryKey: key,
    queryFn: () => api.listLostReasons(projectId),
    retry: false,
  })
  const [notice, setNotice] = useState<Notice>(null)

  const change = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: () => setNotice({ kind: 'status', text: t('directory.saved') }),
    onError: (error) => setNotice({ kind: 'alert', text: errorText(error) }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  })

  if (groups.isPending) return <p>{t('lostReasons.loading')}</p>
  if (groups.isError) {
    const denied = groups.error instanceof RolesApiError && groups.error.status === 403
    return (
      <section>
        <h1>{t('lostReasons.title')}</h1>
        <p role="alert">{denied ? t('lostReasons.noAccess') : t('roles.errors.unknown')}</p>
      </section>
    )
  }

  const run = (action: () => Promise<unknown>) => {
    setNotice(null)
    change.mutate(action)
  }
  const ids = groups.data.map((g) => g.id)

  return (
    <section className="directory">
      <h1>{t('lostReasons.title')}</h1>
      <p className="directory__hint">{t('lostReasons.hint')}</p>
      <NoticeLine notice={notice} />
      {groups.data.length === 0 && <p>{t('lostReasons.empty')}</p>}
      {groups.data.map((group, index) => (
        <GroupCard
          key={group.id}
          group={group}
          index={index}
          count={groups.data.length}
          pending={change.isPending}
          onMove={(delta) => run(() => api.reorderGroups(projectId, moved(ids, index, delta)))}
          onChange={(value) => run(() => api.updateGroup(projectId, group.id, value))}
          onAddReason={(name) => run(() => api.createReason(projectId, group.id, name))}
          onChangeReason={(reasonId, value) =>
            run(() => api.updateReason(projectId, reasonId, value))
          }
          onReorderReasons={(reasonIds) =>
            run(() => api.reorderReasons(projectId, group.id, reasonIds))
          }
        />
      ))}
      <CreateGroupForm
        pending={change.isPending}
        onCreate={(name) => run(() => api.createGroup(projectId, name))}
      />
    </section>
  )
}

function GroupCard({
  group,
  index,
  count,
  pending,
  onMove,
  onChange,
  onAddReason,
  onChangeReason,
  onReorderReasons,
}: {
  group: LostReasonGroupSummary
  index: number
  count: number
  pending: boolean
  onMove: (delta: -1 | 1) => void
  onChange: (change: DirectoryChange) => void
  onAddReason: (name: string) => void
  onChangeReason: (reasonId: string, change: DirectoryChange) => void
  onReorderReasons: (ids: string[]) => void
}) {
  const { t } = useTranslation('settings')
  const archived = group.archivedAt !== null
  const reasonIds = group.reasons.map((r) => r.id)
  return (
    <article
      className={archived ? 'directory__card directory__card--archived' : 'directory__card'}
      aria-label={group.name}
    >
      <h2>
        {group.name}
        {archived && <span className="directory__mark"> · {t('directory.archivedMark')}</span>}
      </h2>
      <div className="directory__row">
        <RenameForm
          key={group.name}
          label={t('lostReasons.groupNameOf', { name: group.name })}
          value={group.name}
          submitLabel={t('lostReasons.rename')}
          pending={pending}
          onSubmit={(name) => onChange({ name })}
        />
        <OrderButtons
          name={group.name}
          index={index}
          count={count}
          pending={pending}
          onMove={onMove}
        />
        <ArchiveButton
          archived={archived}
          pending={pending}
          onChange={(value) => onChange({ archived: value })}
        />
      </div>
      {group.reasons.length === 0 && (
        <p className="directory__hint">{t('lostReasons.noReasons')}</p>
      )}
      <ol className="directory__list" aria-label={t('lostReasons.reasonsOf', { name: group.name })}>
        {group.reasons.map((reason, reasonIndex) => (
          <ReasonRow
            key={`${reason.id}|${reason.name}`}
            reason={reason}
            index={reasonIndex}
            count={group.reasons.length}
            pending={pending}
            onChange={(value) => onChangeReason(reason.id, value)}
            onMove={(delta) => onReorderReasons(moved(reasonIds, reasonIndex, delta))}
          />
        ))}
      </ol>
      <AddForm
        label={t('lostReasons.newReasonOf', { name: group.name })}
        pending={pending}
        onAdd={onAddReason}
      />
    </article>
  )
}

function ReasonRow({
  reason,
  index,
  count,
  pending,
  onChange,
  onMove,
}: {
  reason: LostReasonSummary
  index: number
  count: number
  pending: boolean
  onChange: (change: DirectoryChange) => void
  onMove: (delta: -1 | 1) => void
}) {
  const { t } = useTranslation('settings')
  const archived = reason.archivedAt !== null
  return (
    <li className={archived ? 'directory__card--archived' : undefined}>
      <RenameForm
        label={t('lostReasons.reasonName', { name: reason.name })}
        value={reason.name}
        submitLabel={t('lostReasons.rename')}
        pending={pending}
        onSubmit={(name) => onChange({ name })}
      />
      {archived && <span className="directory__mark">{t('directory.archivedMark')}</span>}
      <OrderButtons
        name={reason.name}
        index={index}
        count={count}
        pending={pending}
        onMove={onMove}
      />
      <ArchiveButton
        archived={archived}
        pending={pending}
        onChange={(value) => onChange({ archived: value })}
      />
    </li>
  )
}

function CreateGroupForm({
  pending,
  onCreate,
}: {
  pending: boolean
  onCreate: (name: string) => void
}) {
  const { t } = useTranslation('settings')
  return (
    <form
      className="directory__card directory__settings"
      aria-label={t('lostReasons.newGroup')}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        const name = String(new FormData(event.currentTarget).get('name') ?? '').trim()
        if (name !== '') {
          onCreate(name)
          event.currentTarget.reset()
        }
      }}
    >
      <h2>{t('lostReasons.newGroup')}</h2>
      <label>
        {t('lostReasons.groupName')} <input name="name" maxLength={80} required />
      </label>
      <button type="submit" disabled={pending}>
        {t('lostReasons.createGroup')}
      </button>
    </form>
  )
}
