import type { PipelineSummary, StageSummary } from '@alpi/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  projectQueryKey,
  useCurrentProject,
} from '../../components/project-switcher/current-project.tsx'
import { Button } from '../../ui/button.tsx'
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
import type { PipelineChange, PipelinesApi } from './pipelines-api.ts'
import { RolesApiError } from './roles-api.ts'

// Настройки → Воронки (тикет crm-deals/02): воронки проекта и их этапы — создать, переименовать,
// сменить код и отметку «воронка допродажу», переставить кнопками, отправить воронку в архив,
// удалить этап (после подтверждения; этап с открытыми сделками API не удалит). Смотреть может
// каждый с правом «сделки: смотреть», менять — право «воронки и этапы»: отказ API показывается
// сообщением.

export function PipelinesPage({ api }: { api: PipelinesApi }) {
  const { t } = useTranslation('settings')
  const { current } = useCurrentProject()
  if (!current) {
    return (
      <section>
        <h1>{t('pipelines.title')}</h1>
        <p>{t('pipelines.noProject')}</p>
      </section>
    )
  }
  return <PipelinesEditor key={current.id} api={api} projectId={current.id} />
}

function PipelinesEditor({ api, projectId }: { api: PipelinesApi; projectId: string }) {
  const { t } = useTranslation('settings')
  const errorText = useDirectoryErrorText()
  const queryClient = useQueryClient()
  const key = projectQueryKey(projectId, 'pipelines')
  const pipelines = useQuery({ queryKey: key, queryFn: () => api.list(projectId), retry: false })
  const [notice, setNotice] = useState<Notice>(null)

  const change = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: () => setNotice({ kind: 'status', text: t('directory.saved') }),
    onError: (error) => setNotice({ kind: 'alert', text: errorText(error) }),
    // И после отказа: список мог измениться в другой вкладке.
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  })

  if (pipelines.isPending) return <p>{t('pipelines.loading')}</p>
  if (pipelines.isError) {
    const denied = pipelines.error instanceof RolesApiError && pipelines.error.status === 403
    return (
      <section>
        <h1>{t('pipelines.title')}</h1>
        <p className="ui-notice" role="alert">
          {denied ? t('pipelines.noAccess') : t('roles.errors.unknown')}
        </p>
      </section>
    )
  }

  /** Выполняет изменение; true — API принял его (формы создания очищаются только тогда). */
  const run = (action: () => Promise<unknown>): Promise<boolean> => {
    setNotice(null)
    return change.mutateAsync(action).then(
      () => true,
      // Отказ уже показан сообщением (onError).
      () => false,
    )
  }
  const ids = pipelines.data.map((p) => p.id)

  return (
    <section className="directory">
      <h1>{t('pipelines.title')}</h1>
      <NoticeLine notice={notice} />
      {pipelines.data.length === 0 && <p>{t('pipelines.empty')}</p>}
      {pipelines.data.map((pipeline, index) => (
        <PipelineCard
          key={pipeline.id}
          pipeline={pipeline}
          index={index}
          count={pipelines.data.length}
          pending={change.isPending}
          onMove={(delta) => run(() => api.reorder(projectId, moved(ids, index, delta)))}
          onChange={(value) => run(() => api.update(projectId, pipeline.id, value))}
          onAddStage={(name) => run(() => api.createStage(projectId, pipeline.id, name))}
          onRenameStage={(stageId, name) =>
            run(() => api.renameStage(projectId, pipeline.id, stageId, name))
          }
          onReorderStages={(stageIds) =>
            run(() => api.reorderStages(projectId, pipeline.id, stageIds))
          }
          onDeleteStage={(stageId) => run(() => api.removeStage(projectId, pipeline.id, stageId))}
        />
      ))}
      <CreatePipelineForm
        pending={change.isPending}
        onCreate={(input) => run(() => api.create(projectId, input))}
      />
    </section>
  )
}

function PipelineCard({
  pipeline,
  index,
  count,
  pending,
  onMove,
  onChange,
  onAddStage,
  onRenameStage,
  onReorderStages,
  onDeleteStage,
}: {
  pipeline: PipelineSummary
  index: number
  count: number
  pending: boolean
  onMove: (delta: -1 | 1) => void
  onChange: (change: PipelineChange) => void
  onAddStage: (name: string) => Promise<boolean>
  onRenameStage: (stageId: string, name: string) => void
  onReorderStages: (ids: string[]) => void
  onDeleteStage: (stageId: string) => void
}) {
  const { t } = useTranslation('settings')
  const archived = pipeline.archivedAt !== null
  const stageIds = pipeline.stages.map((s) => s.id)
  return (
    <article
      className={archived ? 'directory__card directory__card--archived' : 'directory__card'}
      aria-label={pipeline.name}
    >
      <h2>
        {pipeline.name}{' '}
        <span className="directory__mark">
          {pipeline.code}
          {pipeline.isUpsell && ` · ${t('pipelines.upsellMark')}`}
          {archived && ` · ${t('directory.archivedMark')}`}
        </span>
      </h2>
      <PipelineSettings
        key={`${pipeline.name}|${pipeline.code}|${pipeline.isUpsell}`}
        pipeline={pipeline}
        pending={pending}
        onChange={onChange}
      />
      <div className="directory__row">
        <OrderButtons
          name={pipeline.name}
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
      {pipeline.stages.length === 0 && <p className="directory__hint">{t('pipelines.noStages')}</p>}
      <ol className="directory__list" aria-label={t('pipelines.stagesOf', { name: pipeline.name })}>
        {pipeline.stages.map((stage, stageIndex) => (
          <StageRow
            key={`${stage.id}|${stage.name}`}
            stage={stage}
            index={stageIndex}
            count={pipeline.stages.length}
            pending={pending}
            onRename={(name) => onRenameStage(stage.id, name)}
            onMove={(delta) => onReorderStages(moved(stageIds, stageIndex, delta))}
            onDelete={() => onDeleteStage(stage.id)}
          />
        ))}
      </ol>
      <AddForm
        label={t('pipelines.newStageOf', { name: pipeline.name })}
        pending={pending}
        onAdd={onAddStage}
      />
    </article>
  )
}

function PipelineSettings({
  pipeline,
  pending,
  onChange,
}: {
  pipeline: PipelineSummary
  pending: boolean
  onChange: (change: PipelineChange) => void
}) {
  const { t } = useTranslation('settings')
  const [name, setName] = useState(pipeline.name)
  const [code, setCode] = useState(pipeline.code)
  const [isUpsell, setIsUpsell] = useState(pipeline.isUpsell)
  return (
    <form
      className="directory__settings"
      aria-label={t('pipelines.settingsOf', { name: pipeline.name })}
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        const change: PipelineChange = {}
        if (name.trim() !== '' && name.trim() !== pipeline.name) change.name = name.trim()
        if (code.trim() !== pipeline.code) change.code = code.trim()
        if (isUpsell !== pipeline.isUpsell) change.isUpsell = isUpsell
        if (Object.keys(change).length > 0) onChange(change)
      }}
    >
      <label>
        {t('pipelines.name')}{' '}
        <input
          className="ui-input ui-input--sm"
          value={name}
          maxLength={80}
          required
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label>
        {t('pipelines.code')}{' '}
        <input
          className="ui-input ui-input--sm"
          value={code}
          maxLength={40}
          pattern="[a-z][a-z0-9_\-]*"
          required
          onChange={(event) => setCode(event.target.value)}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={isUpsell}
          onChange={(event) => setIsUpsell(event.target.checked)}
        />{' '}
        {t('pipelines.upsell')}
      </label>
      <Button size="sm" type="submit" disabled={pending}>
        {t('directory.save')}
      </Button>
    </form>
  )
}

function StageRow({
  stage,
  index,
  count,
  pending,
  onRename,
  onMove,
  onDelete,
}: {
  stage: StageSummary
  index: number
  count: number
  pending: boolean
  onRename: (name: string) => void
  onMove: (delta: -1 | 1) => void
  onDelete: () => void
}) {
  const { t } = useTranslation('settings')
  const [confirming, setConfirming] = useState(false)
  return (
    <li>
      <RenameForm
        label={t('pipelines.stageName', { name: stage.name })}
        value={stage.name}
        submitLabel={t('pipelines.rename')}
        pending={pending}
        onSubmit={onRename}
      />
      <OrderButtons
        name={stage.name}
        index={index}
        count={count}
        pending={pending}
        onMove={onMove}
      />
      {confirming ? (
        <>
          <span className="directory__hint">{t('pipelines.deleteHint')}</span>
          <Button
            size="sm"
            variant="danger"
            type="button"
            disabled={pending}
            onClick={() => {
              setConfirming(false)
              onDelete()
            }}
          >
            {t('pipelines.confirmDelete', { name: stage.name })}
          </Button>
          <Button size="sm" type="button" onClick={() => setConfirming(false)}>
            {t('directory.cancel')}
          </Button>
        </>
      ) : (
        <Button size="sm" type="button" disabled={pending} onClick={() => setConfirming(true)}>
          {t('pipelines.deleteStage', { name: stage.name })}
        </Button>
      )}
    </li>
  )
}

function CreatePipelineForm({
  pending,
  onCreate,
}: {
  pending: boolean
  onCreate: (input: { name: string; code: string; isUpsell: boolean }) => Promise<boolean>
}) {
  const { t } = useTranslation('settings')
  return (
    <form
      className="directory__card directory__settings"
      aria-label={t('pipelines.new')}
      onSubmit={async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        const element = event.currentTarget
        const form = new FormData(element)
        const name = String(form.get('name') ?? '').trim()
        const code = String(form.get('code') ?? '').trim()
        // Очищается только после ответа API: при отказе (код занят) введённое остаётся.
        if (
          name !== '' &&
          code !== '' &&
          (await onCreate({ name, code, isUpsell: form.get('isUpsell') === 'on' }))
        ) {
          element.reset()
        }
      }}
    >
      <h2>{t('pipelines.new')}</h2>
      <label>
        {t('pipelines.name')}{' '}
        <input className="ui-input ui-input--sm" name="name" maxLength={80} required />
      </label>
      <label>
        {t('pipelines.code')}{' '}
        <input
          className="ui-input ui-input--sm"
          name="code"
          maxLength={40}
          pattern="[a-z][a-z0-9_\-]*"
          required
        />
      </label>
      <label>
        <input type="checkbox" name="isUpsell" /> {t('pipelines.upsell')}
      </label>
      <Button size="sm" type="submit" variant="primary" disabled={pending}>
        {t('pipelines.create')}
      </Button>
    </form>
  )
}
