import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { contactName } from '../../../components/contact-form/contact-form.tsx'
import type { ContactsApi } from '../../../components/contact-form/contacts-api.ts'
import {
  MergedNotice,
  MergeList,
  mergedIntoId,
  UndoDialog,
} from '../../../components/merge/undo-merge.tsx'
import {
  projectQueryKey,
  useProjectCode,
} from '../../../components/project-switcher/current-project.tsx'
import { type UndoResult, useMergesApi } from './merges-api.tsx'

// Откат слияния контактов (тикет crm-intake/01; ADR 0005): «Скасувати об'єднання» в карточке
// оставшегося (список слияний за 30 дней), на странице слитого контакта и в журнале проекта.
// Окно, список и страница — общие со сделками (components/merge/undo-merge.tsx, тикет
// crm-intake/12); здесь — клиент контактов, имена и ссылки.

/** Название заполнявшегося поля контакта в итоге отката. */
function useFieldName() {
  const { t } = useTranslation('contact-card')
  return (field: string): string =>
    field === 'lastName'
      ? t('form.lastName')
      : field === 'language'
        ? t('side.language')
        : field === 'organizationId'
          ? t('side.organization')
          : t('merge.customField', { code: field })
}

/** Подтверждение отката и его итог. */
export function UndoMergeDialog({
  projectId,
  mergeId,
  mergedName,
  onClose,
  onUndone,
}: {
  projectId: string
  mergeId: string
  /** Имя слитого контакта для текста подтверждения; null — неизвестно (журнал). */
  mergedName: string | null
  onClose: () => void
  /** Откат прошёл: вызывается сразу, итог остаётся на экране до «Закрити». */
  onUndone: (result: UndoResult) => void
}) {
  const merges = useMergesApi()
  return (
    <UndoDialog
      ns="contact-card"
      undo={() => merges.undo(projectId, mergeId)}
      mergedName={mergedName}
      doneName={(result) => contactName(result.mergedContact)}
      fieldName={useFieldName()}
      onClose={onClose}
      onUndone={onUndone}
    />
  )
}

/** Слияния в этот контакт за 30 дней с «Скасувати об'єднання». Пусто — блока нет. */
export function ContactMerges({
  projectId,
  contactId,
  canUndo,
  onUndone,
}: {
  projectId: string
  contactId: string
  canUndo: boolean
  onUndone: () => void
}) {
  const merges = useMergesApi()
  const list = useQuery({
    queryKey: projectQueryKey(projectId, 'contact-merges', contactId),
    queryFn: () => merges.contactMerges(projectId, contactId),
    retry: false,
  })
  return (
    <MergeList
      ns="contact-card"
      headingId="contact-merges"
      block={{ section: 'record-card__block', head: 'record-card__block-head' }}
      items={list.data ?? []}
      mergedName={(item) => contactName(item.mergedContact)}
      canUndo={canUndo}
      renderUndo={(target, close) => (
        <UndoMergeDialog
          projectId={projectId}
          mergeId={target.id}
          mergedName={target.name}
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
 * Прямая ссылка на слитый контакт: «Контакт об'єднано з X» со ссылкой на оставшийся и кнопкой
 * отката, пока он доступен (30 дней, право «контакти: змінювати»).
 */
export function MergedContactNotice({
  contacts,
  projectId,
  details,
  canUndo,
  onUndone,
}: {
  contacts: ContactsApi
  projectId: string
  /** Подробности ответа 404 CONTACT_MERGED (apps/api/src/merge/merged.ts). */
  details: Record<string, unknown>
  canUndo: boolean
  onUndone: () => void
}) {
  const { t } = useTranslation('contact-card')
  const code = useProjectCode()
  const survivorId = mergedIntoId(details)
  const survivor = useQuery({
    queryKey: projectQueryKey(projectId, 'contact', survivorId),
    queryFn: () => contacts.contact(projectId, survivorId ?? ''),
    enabled: survivorId !== null,
    retry: false,
  })
  return (
    <MergedNotice
      ns="contact-card"
      headingId="merged-title"
      details={details}
      canUndo={canUndo}
      survivorLink={(contactId) => (
        <Link to="/p/$code/contacts/$contactId" params={{ code, contactId }}>
          {survivor.data ? contactName(survivor.data) : t('merge.survivorLink')}
        </Link>
      )}
      renderUndo={(mergeId, close) => (
        <UndoMergeDialog
          projectId={projectId}
          mergeId={mergeId}
          mergedName={null}
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
