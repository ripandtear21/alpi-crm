import { useNavigate } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../ui/button.tsx'
import { Dialog } from '../../../ui/dialog.tsx'
import { Field, Input, Select } from '../../../ui/field.tsx'
import type { DealCardModel } from './deal-card-page.tsx'
import { ActionError } from './deal-errors.tsx'
import { contactName } from './deal-sidebar.tsx'

// Диалоги карточки: «Програно» (группа → причина), допродажа (воронка и название), смена
// воронки и этапа, удаление в корзину.
// Диалог «Програно» есть и у канбана (тикет 11): небольшое дублирование, отмечено в
// результате тикета.

const MAX_TITLE_LENGTH = 200

/** «Програно»: без выбранной причины запрос не уходит. */
export function LoseDialog({ card, onClose }: { card: DealCardModel; onClose: () => void }) {
  const { t } = useTranslation('deal-card')
  const groups = card.reasons
    .filter((group) => group.archivedAt === null)
    .map((group) => ({
      ...group,
      reasons: group.reasons.filter((reason) => reason.archivedAt === null),
    }))
    .filter((group) => group.reasons.length > 0)
  const [groupId, setGroupId] = useState(groups.length === 1 ? (groups[0]?.id ?? '') : '')
  const [reasonId, setReasonId] = useState('')
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const group = groups.find((item) => item.id === groupId)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (reasonId === '') {
      setMissing(true)
      return
    }
    const failure = await card.act(() => card.api.lose(card.projectId, card.deal.id, reasonId))
    if (failure) setError(failure)
    else onClose()
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('lose.title')}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="deal-lose" variant="danger" busy={card.busy}>
            {t('lose.submit')}
          </Button>
        </>
      }
    >
      <form id="deal-lose" className="deal-card__dialog-form" onSubmit={submit} noValidate>
        {groups.length === 0 && <p>{t('lose.noReasons')}</p>}
        <Field label={t('lose.group')}>
          <Select
            value={groupId}
            onChange={(event) => {
              setGroupId(event.target.value)
              setReasonId('')
            }}
          >
            <option value="">{t('lose.chooseGroup')}</option>
            {groups.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={t('lose.reason')}
          error={missing && reasonId === '' ? t('lose.required') : undefined}
        >
          <Select
            value={reasonId}
            disabled={!group}
            onChange={(event) => setReasonId(event.target.value)}
          >
            <option value="">{t('lose.chooseReason')}</option>
            {group?.reasons.map((reason) => (
              <option key={reason.id} value={reason.id}>
                {reason.name}
              </option>
            ))}
          </Select>
        </Field>
        <ActionError error={error} />
      </form>
    </Dialog>
  )
}

/** Допродажа: воронка допродаж предвыбрана, название предзаполнено. */
export function UpsellDialog({ card, onClose }: { card: DealCardModel; onClose: () => void }) {
  const { t } = useTranslation('deal-card')
  const navigate = useNavigate()
  const pipelines = card.pipelines.filter((pipeline) => pipeline.archivedAt === null)
  const preferred =
    pipelines.find((pipeline) => pipeline.isUpsell) ??
    pipelines.find((pipeline) => pipeline.id === card.deal.pipelineId)
  const [pipelineId, setPipelineId] = useState(preferred?.id ?? '')
  // Как название допродажи по умолчанию в API: «Ім'я Прізвище — допродаж»; пока контакт
  // не загружен — по названию сделки. Введённое пользователем не подменяется.
  const [typed, setTitle] = useState<string | null>(null)
  const title =
    typed ??
    t('upsell.defaultTitle', {
      title: card.contact ? contactName(card.contact) : card.deal.title,
    }).slice(0, MAX_TITLE_LENGTH)
  const [error, setError] = useState<unknown>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (pipelineId === '' || title.trim() === '') return
    setError(null)
    // Допродажа — новая сделка, текущая не меняется: в кэш её не кладём.
    const created: { id?: string } = {}
    const failure = await card.act(async () => {
      const upsell = await card.api.upsell(card.projectId, card.deal.id, {
        pipelineId,
        title: title.trim(),
      })
      created.id = upsell.id
      return undefined
    })
    if (failure || created.id === undefined) {
      setError(failure)
      return
    }
    onClose()
    await navigate({ to: '/deals/$dealId', params: { dealId: created.id } })
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('upsell.title')}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="deal-upsell" variant="primary" busy={card.busy}>
            {t('upsell.submit')}
          </Button>
        </>
      }
    >
      <form id="deal-upsell" className="deal-card__dialog-form" onSubmit={submit}>
        <Field label={t('upsell.pipeline')}>
          <Select value={pipelineId} onChange={(event) => setPipelineId(event.target.value)}>
            {pipelines.map((pipeline) => (
              <option key={pipeline.id} value={pipeline.id}>
                {pipeline.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('upsell.name')}>
          <Input
            required
            maxLength={MAX_TITLE_LENGTH}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <ActionError error={error} />
      </form>
    </Dialog>
  )
}

/** «Воронка → Етап»: другая воронка (и этап в ней) или другой этап этой же. */
export function MoveDialog({ card, onClose }: { card: DealCardModel; onClose: () => void }) {
  const { t } = useTranslation('deal-card')
  const pipelines = card.pipelines.filter(
    (pipeline) => pipeline.archivedAt === null || pipeline.id === card.deal.pipelineId,
  )
  const [pipelineId, setPipelineId] = useState(card.deal.pipelineId)
  const [stageId, setStageId] = useState(card.deal.stageId)
  const [error, setError] = useState<unknown>(null)
  const pipeline = pipelines.find((item) => item.id === pipelineId)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (stageId === '') return
    const { api, projectId, deal } = card
    const failure = await card.act(() =>
      pipelineId === deal.pipelineId
        ? api.changeStage(projectId, deal.id, stageId)
        : api.move(projectId, deal.id, pipelineId, stageId),
    )
    if (failure) setError(failure)
    else onClose()
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('move.title')}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="deal-move" variant="primary" busy={card.busy}>
            {t('move.submit')}
          </Button>
        </>
      }
    >
      <form id="deal-move" className="deal-card__dialog-form" onSubmit={submit}>
        <Field label={t('move.pipeline')}>
          <Select
            value={pipelineId}
            onChange={(event) => {
              const next = pipelines.find((item) => item.id === event.target.value)
              setPipelineId(event.target.value)
              setStageId(next?.stages[0]?.id ?? '')
            }}
          >
            {pipelines.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('move.stage')}>
          <Select value={stageId} onChange={(event) => setStageId(event.target.value)}>
            {pipeline?.stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </Select>
        </Field>
        <ActionError error={error} />
      </form>
    </Dialog>
  )
}

/** Удаление в корзину: сделку можно восстановить из корзины 30 дней. */
export function DeleteDialog({ card, onClose }: { card: DealCardModel; onClose: () => void }) {
  const { t } = useTranslation('deal-card')
  const navigate = useNavigate()
  const [error, setError] = useState<unknown>(null)
  const confirm = async () => {
    const { api, projectId, deal } = card
    try {
      await api.remove(projectId, deal.id)
    } catch (failure) {
      setError(failure)
      return
    }
    onClose()
    await navigate({ to: '/deals' })
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('remove.title')}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="danger" onClick={confirm}>
            {t('remove.submit')}
          </Button>
        </>
      }
    >
      <p>{t('remove.text', { title: card.deal.title })}</p>
      <ActionError error={error} />
    </Dialog>
  )
}
