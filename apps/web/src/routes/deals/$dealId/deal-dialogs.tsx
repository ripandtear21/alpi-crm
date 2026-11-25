import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { fieldsQueryKey } from '../../../components/custom-fields/custom-field-groups.tsx'
import { useCustomFieldsApi } from '../../../components/custom-fields/custom-fields-api.tsx'
import type { FieldDraft } from '../../../components/custom-fields/field-values.ts'
import {
  collectRequired,
  type RequiredFieldProblem,
  requiredDrafts,
  requiredOnStage,
  splitByAccess,
} from '../../../components/custom-fields/required-fields.ts'
import { RequiredFieldInputs } from '../../../components/custom-fields/required-fields-form.tsx'
import { useProjectCode } from '../../../components/project-switcher/current-project.tsx'
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

/**
 * Допродажа: воронка допродаж предвыбрана, название предзаполнено. Новая сделка встаёт на первый
 * этап выбранной воронки: его обязательные поля и поля «всегда» (тикет crm-fields/04) — в форме,
 * без них запрос не уходит; поля групп «только чтение» — строкой, без правки.
 */
export function UpsellDialog({ card, onClose }: { card: DealCardModel; onClose: () => void }) {
  const { t } = useTranslation('deal-card')
  const navigate = useNavigate()
  const code = useProjectCode()
  const pipelines = card.pipelines.filter((pipeline) => pipeline.archivedAt === null)
  const preferred =
    pipelines.find((pipeline) => pipeline.isUpsell) ??
    pipelines.find((pipeline) => pipeline.id === card.deal.pipelineId)
  const [pipelineId, setPipelineId] = useState(preferred?.id ?? '')
  const pipeline = pipelines.find((item) => item.id === pipelineId)
  // Тот же запрос описаний полей, что у шапки и групп полей карточки (fieldsQueryKey).
  const fieldsApi = useCustomFieldsApi()
  const fields = useQuery({
    queryKey: fieldsQueryKey(card.projectId, 'deal'),
    queryFn: () => fieldsApi.fields(card.projectId, 'deal'),
    retry: false,
  })
  const firstStage = pipeline?.stages[0]?.id
  const { editable: required, readOnly } = splitByAccess(
    pipeline && firstStage ? requiredOnStage(fields.data ?? [], pipeline, firstStage) : [],
    card.permissions,
  )
  const [edited, setEdited] = useState<Record<string, FieldDraft>>({})
  const drafts = { ...requiredDrafts(required), ...edited }
  const [problems, setProblems] = useState<Record<string, RequiredFieldProblem>>({})
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
    // Описания полей ещё грузятся — обязательные поля неизвестны: запрос не уходит.
    if (pipelineId === '' || title.trim() === '' || fields.isPending) return
    const collected = collectRequired(required, drafts)
    setProblems(collected.ok ? {} : collected.problems)
    if (!collected.ok) return
    setError(null)
    // Допродажа — новая сделка, текущая не меняется: в кэш её не кладём.
    const created: { id?: string } = {}
    const failure = await card.act(async () => {
      const upsell = await card.api.upsell(card.projectId, card.deal.id, {
        pipelineId,
        title: title.trim(),
        ...(Object.keys(collected.custom).length > 0 ? { custom: collected.custom } : {}),
      })
      created.id = upsell.id
      return undefined
    })
    if (failure || created.id === undefined) {
      setError(failure)
      return
    }
    onClose()
    await navigate({ to: '/p/$code/deals/$dealId', params: { code, dealId: created.id } })
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
            {pipelines.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
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
        {required.length + readOnly.length > 0 && (
          <fieldset className="deal-card__required">
            <legend>{t('upsell.required')}</legend>
            <RequiredFieldInputs
              fields={required}
              readOnly={readOnly}
              drafts={drafts}
              onDraft={(fieldCode, draft) =>
                setEdited((current) => ({ ...current, [fieldCode]: draft }))
              }
              problems={problems}
              members={card.members ?? []}
            />
          </fieldset>
        )}
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
  const code = useProjectCode()
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
    await navigate({ to: '/p/$code/deals', params: { code } })
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
