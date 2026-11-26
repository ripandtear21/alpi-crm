import type { RequiredFieldsMissing } from '@alpi/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CopyLinkButton } from '../../../components/copy-link/copy-link-button.tsx'
import { fieldsQueryKey } from '../../../components/custom-fields/custom-field-groups.tsx'
import {
  type CustomValues,
  useCustomFieldsApi,
} from '../../../components/custom-fields/custom-fields-api.tsx'
import { readRequiredFieldsMissing } from '../../../components/custom-fields/required-fields.ts'
import { RequiredFieldsDialog } from '../../../components/custom-fields/required-fields-form.tsx'
import { useProjectCode } from '../../../components/project-switcher/current-project.tsx'
import { Badge } from '../../../ui/badge.tsx'
import { Button } from '../../../ui/button.tsx'
import { cx } from '../../../ui/cx.ts'
import { Input, Select } from '../../../ui/field.tsx'
import { Menu, type MenuItem } from '../../../ui/menu.tsx'
import { type DealCard, DealCardApiError } from './deal-card-api.ts'
import type { DealCardModel } from './deal-card-page.tsx'
import { DeleteDialog, LoseDialog, MoveDialog, UpsellDialog } from './deal-dialogs.tsx'
import { ActionError } from './deal-errors.tsx'
import { MergeDealDialog } from './merge/merge-deal-dialog.tsx'
import { dealMergesQueryKey } from './merge/undo-deal-merge.tsx'

// Шапка карточки на всю ширину, три строки: 1) название (правится на месте), ответственный,
// «Виграно» / «Програно» или статус с «Відкрити знову» и «Створити допродаж», «…» (архив,
// удаление); 2) путь этапов — нажатие меняет этап; 3) «Воронка → Етап» — смена воронки.
// Отказ 422 смены этапа или выигрыша о незаполненных обязательных полях (тикет crm-fields/04)
// открывает форму заполнения; «Зберегти» повторяет действие вместе со значениями.

const MAX_TITLE_LENGTH = 200
const DAY_MS = 86_400_000
/** Значение списка ответственных «в общую очередь». */
const QUEUE = ''

type Opened = 'lose' | 'upsell' | 'move' | 'remove' | 'merge' | null

/** Действие, которое может потребовать обязательные поля: значения формы уходят с ним. */
type Placing = (custom?: CustomValues) => Promise<DealCard>

/** Открытая форма заполнения. */
interface Filling {
  title: string
  missing: RequiredFieldsMissing
  submit: (custom: CustomValues) => void
}

export function DealHeader({ card }: { card: DealCardModel }) {
  const { t } = useTranslation('deal-card')
  const { deal, rights } = card
  const [opened, setOpened] = useState<Opened>(null)
  const [error, setError] = useState<unknown>(null)
  const [filling, setFilling] = useState<Filling | null>(null)
  const close = () => setOpened(null)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const code = useProjectCode()
  const fieldsApi = useCustomFieldsApi()
  const fields = useQuery({
    queryKey: fieldsQueryKey(card.projectId, 'deal'),
    queryFn: () => fieldsApi.fields(card.projectId, 'deal'),
    retry: false,
  })

  /** Действие из шапки: отказ — строкой под шапкой. */
  const run = async (action: () => Promise<DealCard | undefined>) => {
    setError(null)
    setError(await card.act(action))
  }
  const { api, projectId } = card
  const id = deal.id

  /**
   * Смена этапа или выигрыш: отказ о незаполненных обязательных полях открывает форму, её
   * «Зберегти» повторяет действие со значениями; другой отказ — строкой под шапкой.
   */
  const place = async (title: string, action: Placing, custom?: CustomValues) => {
    setError(null)
    setFilling(null)
    const failure = await card.act(() => action(custom))
    const missing =
      failure instanceof DealCardApiError
        ? readRequiredFieldsMissing(failure.code, failure.details)
        : null
    if (missing) {
      setFilling({ title, missing, submit: (values) => void place(title, action, values) })
    } else {
      setError(failure)
    }
  }

  const more: MenuItem[] = []
  if (rights.edit) {
    more.push(
      deal.archivedAt === null
        ? {
            id: 'archive',
            label: t('actions.archive'),
            onSelect: () => run(() => api.archive(projectId, id)),
          }
        : {
            id: 'unarchive',
            label: t('actions.unarchive'),
            onSelect: () => run(() => api.unarchive(projectId, id)),
          },
      { id: 'merge', label: t('actions.merge'), onSelect: () => setOpened('merge') },
    )
  }

  /** Слияние прошло: осталась эта — перечитать её; осталась вторая — перейти к ней. */
  const merged = (survivorId: string) => {
    close()
    if (survivorId === id) {
      card.refresh()
      void queryClient.invalidateQueries({ queryKey: dealMergesQueryKey(projectId, id) })
    } else {
      void navigate({ to: '/p/$code/deals/$dealId', params: { code, dealId: survivorId } })
    }
  }
  if (rights.remove) {
    more.push({
      id: 'remove',
      label: t('actions.remove'),
      danger: true,
      onSelect: () => setOpened('remove'),
    })
  }

  return (
    <header className="deal-card__head">
      <div className="deal-card__row1">
        <Title card={card} onError={setError} />
        <div className="deal-card__head-actions">
          <Owner card={card} run={run} />
          {deal.archivedAt !== null && <Badge>{t('status.archived')}</Badge>}
          {deal.status === 'open' && rights.edit && (
            <>
              <Button
                size="sm"
                className="deal-card__win"
                busy={card.busy}
                onClick={() => place(t('fill.win'), (custom) => api.win(projectId, id, custom))}
              >
                {t('actions.win')}
              </Button>
              <Button size="sm" variant="danger" onClick={() => setOpened('lose')}>
                {t('actions.lose')}
              </Button>
            </>
          )}
          {deal.status !== 'open' && <StatusBadge card={card} />}
          {deal.status !== 'open' && rights.edit && (
            <Button size="sm" busy={card.busy} onClick={() => run(() => api.reopen(projectId, id))}>
              {t('actions.reopen')}
            </Button>
          )}
          {rights.upsell && (
            <Button size="sm" variant="primary" onClick={() => setOpened('upsell')}>
              {t('actions.upsell')}
            </Button>
          )}
          <CopyLinkButton />
          {more.length > 0 && (
            <Menu
              label={t('actions.more')}
              icon={<span aria-hidden="true">⋯</span>}
              items={more}
              size="sm"
              align="end"
            />
          )}
        </div>
      </div>
      <StagePath card={card} place={place} />
      <p className="deal-card__row3">
        <PipelineLink card={card} onOpen={() => setOpened('move')} />
      </p>
      <ActionError error={error} />
      {opened === 'lose' && <LoseDialog card={card} onClose={close} />}
      {opened === 'upsell' && <UpsellDialog card={card} onClose={close} />}
      {opened === 'move' && <MoveDialog card={card} onClose={close} />}
      {opened === 'remove' && <DeleteDialog card={card} onClose={close} />}
      {opened === 'merge' && (
        <MergeDealDialog projectId={projectId} deal={deal} onClose={close} onMerged={merged} />
      )}
      {filling && (
        <RequiredFieldsDialog
          // Новый отказ — новая форма: черновики берутся из нового списка полей.
          key={JSON.stringify(filling.missing)}
          title={filling.title}
          missing={filling.missing}
          fields={(fields.data ?? []).filter((f) => f.archivedAt === null)}
          values={deal.custom}
          permissions={card.permissions}
          members={card.members ?? []}
          busy={card.busy}
          onCancel={() => setFilling(null)}
          onSubmit={filling.submit}
        />
      )}
    </header>
  )
}

function StatusBadge({ card }: { card: DealCardModel }) {
  const { t } = useTranslation('deal-card')
  const { deal } = card
  if (deal.status === 'won') return <Badge tone="win">{t('status.won')}</Badge>
  const reason = card.reasons
    .flatMap((group) => group.reasons)
    .find((item) => item.id === deal.lostReasonId)
  return (
    <Badge tone="danger">
      {reason ? t('status.lostWith', { reason: reason.name }) : t('status.lost')}
    </Badge>
  )
}

function Title({ card, onError }: { card: DealCardModel; onError: (error: unknown) => void }) {
  const { t } = useTranslation('deal-card')
  const [draft, setDraft] = useState<string | null>(null)
  const { deal } = card

  if (draft === null) {
    return (
      <div className="deal-card__title-wrap">
        <h1 className="deal-card__title">{deal.title}</h1>
        {card.rights.edit && (
          <Button
            size="sm"
            variant="quiet"
            icon
            aria-label={t('title.rename')}
            title={t('title.rename')}
            onClick={() => setDraft(deal.title)}
          >
            <span aria-hidden="true">✎</span>
          </Button>
        )}
      </div>
    )
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    const title = draft.trim()
    if (title === '' || title === deal.title) {
      setDraft(null)
      return
    }
    const failure = await card.act(() => card.api.update(card.projectId, deal.id, { title }))
    onError(failure)
    if (!failure) setDraft(null)
  }

  return (
    <form className="deal-card__title-form" aria-label={t('title.rename')} onSubmit={save}>
      <Input
        aria-label={t('title.label')}
        value={draft}
        maxLength={MAX_TITLE_LENGTH}
        autoFocus
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            setDraft(null)
          }
        }}
      />
      <Button type="submit" size="sm" variant="primary" busy={card.busy}>
        {t('save')}
      </Button>
      <Button size="sm" variant="quiet" onClick={() => setDraft(null)}>
        {t('cancel')}
      </Button>
    </form>
  )
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
}

function Owner({
  card,
  run,
}: {
  card: DealCardModel
  run: (action: () => Promise<DealCard | undefined>) => Promise<void>
}) {
  const { t } = useTranslation('deal-card')
  const { deal, rights, api, projectId } = card
  const name = card.ownerName(deal.ownerId)
  // Кому можно передать: участники проекта, если список доступен, иначе только себе.
  const candidates = (card.members ?? [])
    .filter((member) => !member.disabled)
    .map((member) => ({ id: member.userId, name: member.name }))
  if (!candidates.some((candidate) => candidate.id === card.user.id)) {
    candidates.unshift({ id: card.user.id, name: card.user.name })
  }
  if (deal.ownerId !== null && !candidates.some((candidate) => candidate.id === deal.ownerId)) {
    candidates.push({ id: deal.ownerId, name })
  }
  return (
    <div className="deal-card__owner">
      <span className="deal-card__avatar" aria-hidden="true">
        {deal.ownerId === null ? '—' : initials(name)}
      </span>
      <span className="deal-card__owner-text">
        <span className="deal-card__owner-name">{name}</span>
        <span className="deal-card__owner-label">{t('owner.label')}</span>
      </span>
      {rights.transfer && (
        <Select
          size="sm"
          aria-label={t('owner.change')}
          value={deal.ownerId ?? QUEUE}
          onChange={(event) => {
            const ownerId = event.target.value === QUEUE ? null : event.target.value
            void run(() => api.update(projectId, deal.id, { ownerId }))
          }}
        >
          {candidates.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
          <option value={QUEUE}>{t('owner.queue')}</option>
        </Select>
      )}
      {rights.take && (
        <Button size="sm" busy={card.busy} onClick={() => run(() => api.take(projectId, deal.id))}>
          {t('owner.take')}
        </Button>
      )}
    </div>
  )
}

function StagePath({
  card,
  place,
}: {
  card: DealCardModel
  place: (title: string, action: Placing) => Promise<void>
}) {
  const { t } = useTranslation('deal-card')
  const { deal, api, projectId } = card
  const pipeline = card.pipelines.find((item) => item.id === deal.pipelineId)
  const stages = pipeline?.stages ?? []
  const current = stages.findIndex((stage) => stage.id === deal.stageId)
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(deal.stageChangedAt)) / DAY_MS))
  return (
    <ol className="deal-card__path" aria-label={t('stages.label')}>
      {stages.map((stage, index) => (
        <li key={stage.id} className="deal-card__path-item">
          <button
            type="button"
            className={cx(
              'deal-card__stage',
              index < current && 'deal-card__stage--done',
              index === current && 'deal-card__stage--current',
            )}
            aria-current={index === current ? 'step' : undefined}
            title={stage.name}
            disabled={!card.rights.edit || card.busy}
            onClick={() => {
              if (index === current) return
              void place(t('fill.stage', { stage: stage.name }), (custom) =>
                api.changeStage(projectId, deal.id, stage.id, custom),
              )
            }}
          >
            <span>
              {index === current
                ? `${t('stages.days', { count: days })} · ${stage.name}`
                : stage.name}
            </span>
          </button>
        </li>
      ))}
    </ol>
  )
}

function PipelineLink({ card, onOpen }: { card: DealCardModel; onOpen: () => void }) {
  const { deal } = card
  const pipeline = card.pipelines.find((item) => item.id === deal.pipelineId)
  const stage = pipeline?.stages.find((item) => item.id === deal.stageId)
  const text = `${pipeline?.name ?? '—'} → ${stage?.name ?? '—'}`
  if (!card.rights.edit) return <span className="deal-card__pipeline">{text}</span>
  return (
    <button type="button" className="deal-card__pipeline" onClick={onOpen}>
      {text}
    </button>
  )
}
