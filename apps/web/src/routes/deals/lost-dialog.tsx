import type { LostReasonGroupSummary } from '@alpi/shared'
import { type FormEvent, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/button.tsx'
import { Dialog } from '../../ui/dialog.tsx'
import { Field, Select } from '../../ui/field.tsx'
import type { BoardDeal } from './deals-api.ts'

// Диалог проигрыша: группа → причина, только действующие (архивные причины и группы не
// предлагаются). Без выбранной причины кнопка «Програти» недоступна и запрос не уходит — как и
// API, который без причины отвечает 422.

export function LostDialog({
  deal,
  groups,
  onClose,
  onSubmit,
}: {
  deal: BoardDeal
  /** undefined — справочник ещё загружается. */
  groups: LostReasonGroupSummary[] | undefined
  onClose: () => void
  onSubmit: (lostReasonId: string) => void
}) {
  const { t } = useTranslation('deals')
  const formId = useId()
  const [groupId, setGroupId] = useState('')
  const [reasonId, setReasonId] = useState('')
  const live = (groups ?? [])
    .filter((group) => group.archivedAt === null)
    .map((group) => ({
      ...group,
      reasons: group.reasons.filter((reason) => reason.archivedAt === null),
    }))
    .filter((group) => group.reasons.length > 0)
  const group = live.find((g) => g.id === groupId)

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!group?.reasons.some((reason) => reason.id === reasonId)) return
    onSubmit(reasonId)
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('lost.title', { title: deal.title })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('lost.cancel')}
          </Button>
          <Button variant="danger" type="submit" form={formId} disabled={reasonId === ''}>
            {t('lost.submit')}
          </Button>
        </>
      }
    >
      {groups === undefined ? (
        <p>{t('lost.loading')}</p>
      ) : live.length === 0 ? (
        <p>{t('lost.none')}</p>
      ) : (
        <form id={formId} className="kanban-form" onSubmit={submit}>
          <Field label={t('lost.group')}>
            <Select
              value={groupId}
              onChange={(event) => {
                setGroupId(event.target.value)
                setReasonId('')
              }}
            >
              <option value="">{t('lost.choose')}</option>
              {live.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('lost.reason')}>
            <Select
              value={reasonId}
              disabled={!group}
              onChange={(event) => setReasonId(event.target.value)}
            >
              <option value="">{t('lost.choose')}</option>
              {group?.reasons.map((reason) => (
                <option key={reason.id} value={reason.id}>
                  {reason.name}
                </option>
              ))}
            </Select>
          </Field>
        </form>
      )}
    </Dialog>
  )
}
