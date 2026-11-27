import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import {
  MergedNotice,
  MergeList,
  mergedIntoId,
  UndoDialog,
} from '../../../../components/merge/undo-merge.tsx'
import {
  projectQueryKey,
  useProjectCode,
} from '../../../../components/project-switcher/current-project.tsx'
import type { DealCardApi } from '../deal-card-api.ts'
import { type DealUndoResult, useDealMergesApi } from './deal-merges-api.tsx'

// Откат слияния сделок (тикет crm-intake/02; ADR 0005): «Скасувати об'єднання» в карточке
// оставшейся (список слияний за 30 дней), на странице слитой сделки и в журнале проекта.
// Окно, список и страница — общие с контактами (components/merge/undo-merge.tsx, тикет
// crm-intake/12); здесь — клиент сделок, названия и ссылки.

/** Ключ запроса слияний в сделку `dealId`. */
export const dealMergesQueryKey = (projectId: string, dealId: string) =>
  projectQueryKey(projectId, 'deal-merges', dealId)

/** Название заполнявшегося поля сделки в итоге отката. */
function useFieldName() {
  const { t } = useTranslation('deal-card')
  return (field: string): string => t(`fields.${field}`, { defaultValue: field })
}

/** Подтверждение отката и его итог. */
export function UndoDealMergeDialog({
  projectId,
  mergeId,
  mergedTitle,
  onClose,
  onUndone,
}: {
  projectId: string
  mergeId: string
  /** Название слитой сделки для текста подтверждения; null — неизвестно (журнал). */
  mergedTitle: string | null
  onClose: () => void
  /** Откат прошёл: вызывается сразу, итог остаётся на экране до «Закрити». */
  onUndone: (result: DealUndoResult) => void
}) {
  const merges = useDealMergesApi()
  return (
    <UndoDialog
      ns="deal-card"
      undo={() => merges.undo(projectId, mergeId)}
      mergedName={mergedTitle}
      doneName={(result) => result.mergedDeal.title}
      fieldName={useFieldName()}
      onClose={onClose}
      onUndone={onUndone}
    />
  )
}

/** Слияния в эту сделку за 30 дней с «Скасувати об'єднання». Пусто — блока нет. */
export function DealMerges({
  projectId,
  dealId,
  canUndo,
  onUndone,
}: {
  projectId: string
  dealId: string
  canUndo: boolean
  onUndone: () => void
}) {
  const merges = useDealMergesApi()
  const list = useQuery({
    queryKey: dealMergesQueryKey(projectId, dealId),
    queryFn: () => merges.dealMerges(projectId, dealId),
    retry: false,
  })
  return (
    <MergeList
      ns="deal-card"
      headingId="deal-merges"
      block={{
        section: 'deal-card__block',
        head: 'deal-card__block-head',
        list: 'deal-card__block-body',
      }}
      items={list.data ?? []}
      mergedName={(item) => item.mergedDeal.title}
      canUndo={canUndo}
      renderUndo={(target, close) => (
        <UndoDealMergeDialog
          projectId={projectId}
          mergeId={target.id}
          mergedTitle={target.name}
          onClose={close}
          onUndone={() => {
            void list.refetch()
            onUndone()
          }}
        />
      )}
    />
  )
}

/**
 * Прямая ссылка на слитую сделку: «Угоду об'єднано з Y» со ссылкой на оставшуюся и кнопкой
 * отката, пока он доступен (30 дней, право «угоди: змінювати»).
 */
export function MergedDealNotice({
  api,
  projectId,
  details,
  canUndo,
  onUndone,
}: {
  api: DealCardApi
  projectId: string
  /** Подробности ответа 404 DEAL_MERGED (apps/api/src/merge/merged.ts). */
  details: Record<string, unknown>
  canUndo: boolean
  onUndone: () => void
}) {
  const { t } = useTranslation('deal-card')
  const code = useProjectCode()
  const survivorId = mergedIntoId(details)
  const survivor = useQuery({
    queryKey: projectQueryKey(projectId, 'deal', survivorId),
    queryFn: () => api.deal(projectId, survivorId ?? ''),
    enabled: survivorId !== null,
    retry: false,
  })
  return (
    <MergedNotice
      ns="deal-card"
      headingId="deal-merged-title"
      details={details}
      canUndo={canUndo}
      survivorLink={(dealId) => (
        <Link to="/p/$code/deals/$dealId" params={{ code, dealId }}>
          {survivor.data ? survivor.data.title : t('merge.survivorLink')}
        </Link>
      )}
      renderUndo={(mergeId, close) => (
        <UndoDealMergeDialog
          projectId={projectId}
          mergeId={mergeId}
          mergedTitle={null}
          onClose={() => {
            close()
            onUndone()
          }}
          onUndone={() => {}}
        />
      )}
    />
  )
}
