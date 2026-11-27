import {
  type UseQueryResult,
  useInfiniteQuery,
  useQueries,
  useQueryClient,
} from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useCurrentProject } from '../../components/project-switcher/current-project.tsx'
import { duplicatesQueryKey, useDuplicateCounts } from '../../layout/duplicates-counter.tsx'
import { NoAccess } from '../../layout/no-access.tsx'
import { Badge } from '../../ui/badge.tsx'
import { Button } from '../../ui/button.tsx'
import { Dialog } from '../../ui/dialog.tsx'
import { EmptyState, Notice, Skeleton } from '../../ui/feedback.tsx'
import { Tabs } from '../../ui/tabs.tsx'
import { DealPairs, swapDealPair } from '../contacts/merge/merge-dialog.tsx'
import type { DealPairPreview } from '../contacts/merge/merges-api.tsx'
import {
  type DuplicateContact,
  type DuplicateDeal,
  type DuplicateGroup,
  type DuplicatePair,
  type DuplicatesApi,
  DuplicatesApiError,
  type DuplicateType,
  type MergePreview,
} from './duplicates-api.ts'
import './duplicates.css'

// Экран «Дублі» (тикет crm-intake/05; пункт 33): группы похожих контактов и сделок, которые
// нашёл надсмотрщик. У группы — причины, записи и пары. «Об'єднати»: выбор остающейся записи,
// предпросмотр каждого слияния (`…/merge/preview`) и подтверждение; группа из нескольких
// записей — последовательные слияния в выбранную, каждое со своим откатом (решено без
// владельца — подтвердить). Конфликтующие сделки контактов (тикет crm-intake/04) — блоком окна
// слияния карточки контакта: какая сделка остаётся, «Поміняти» (`keep_deal_ids`); пара без права
// на сделки — объяснение, и «Об'єднати» недоступна. Отказ сервера в предпросмотре или слиянии
// показывается как пришёл. «Не дубль» — на паре.
// Вкладки — только разделы, на которые у пользователя есть «змінювати» (счётчик в шапке).

type GroupRecord = DuplicateContact | DuplicateDeal

const isContact = (record: GroupRecord): record is DuplicateContact => 'firstName' in record

const recordName = (record: GroupRecord) =>
  isContact(record) ? [record.firstName, record.lastName].filter(Boolean).join(' ') : record.title

function useErrorText() {
  const { t } = useTranslation('duplicates')
  return (error: unknown) => {
    const code = error instanceof DuplicatesApiError ? error.code : ''
    return t(`errors.${code}`, { defaultValue: t('errors.unknown', { code }) })
  }
}

export function DuplicatesPage({ api }: { api: DuplicatesApi }) {
  const { current } = useCurrentProject()
  if (!current) return <NoAccess />
  return <DuplicatesScreen key={current.id} api={api} projectId={current.id} code={current.code} />
}

function DuplicatesScreen({
  api,
  projectId,
  code,
}: {
  api: DuplicatesApi
  projectId: string
  code: string
}) {
  const { t } = useTranslation('duplicates')
  const counts = useDuplicateCounts(api)
  if (counts.isPending) return <Skeleton lines={5} />
  if (!counts.data) return <NoAccess />
  const data = counts.data
  const types = (['contact', 'deal'] as const).filter((type) => data[type] !== null)
  const list = (type: DuplicateType) => (
    <GroupList api={api} projectId={projectId} code={code} type={type} />
  )
  return (
    <section className="duplicates">
      <h1>{t('title')}</h1>
      <p className="duplicates__intro">{t('intro')}</p>
      {types.length === 1 && types[0] ? (
        list(types[0])
      ) : (
        <Tabs
          label={t('tabs.label')}
          tabs={types.map((type) => ({
            id: type,
            label: t(`tabs.${type}`, { count: data[type] ?? 0 }),
            content: list(type),
          }))}
        />
      )}
    </section>
  )
}

function GroupList({
  api,
  projectId,
  code,
  type,
}: {
  api: DuplicatesApi
  projectId: string
  code: string
  type: DuplicateType
}) {
  const { t } = useTranslation('duplicates')
  const errorText = useErrorText()
  const queryClient = useQueryClient()
  // Окно объединения — здесь, а не в карточке группы: после слияния группа уходит из списка,
  // а окно с откатом каждого слияния остаётся открытым (с той группой, какой она была).
  const [merging, setMerging] = useState<DuplicateGroup | null>(null)
  const groups = useInfiniteQuery({
    queryKey: [...duplicatesQueryKey(projectId), 'groups', type],
    queryFn: ({ pageParam }) => api.groups(projectId, type, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    retry: false,
  })
  if (groups.isPending) return <Skeleton lines={4} />
  if (groups.isError) return <Notice kind="alert">{errorText(groups.error)}</Notice>
  const all = groups.data.pages.flatMap((page) => page.data)
  const dialog = merging && (
    <MergeDialog
      api={api}
      projectId={projectId}
      group={merging}
      onClose={() => {
        setMerging(null)
        void queryClient.invalidateQueries({ queryKey: duplicatesQueryKey(projectId) })
      }}
    />
  )
  // Окно — на одном месте дерева и при пустом списке: иначе React пересоздал бы его.
  if (all.length === 0) {
    return (
      <>
        {dialog}
        <EmptyState title={t(`empty.${type}`)} />
      </>
    )
  }
  return (
    <>
      {dialog}
      <div className="duplicates__list">
        {all.map((group) => (
          <GroupCard
            key={group.id}
            api={api}
            projectId={projectId}
            code={code}
            group={group}
            onMerge={() => setMerging(group)}
          />
        ))}
        {groups.hasNextPage && (
          <Button busy={groups.isFetchingNextPage} onClick={() => groups.fetchNextPage()}>
            {t('more')}
          </Button>
        )}
      </div>
    </>
  )
}

function RecordLine({ record, code }: { record: GroupRecord; code: string }) {
  const { t } = useTranslation('duplicates')
  if (isContact(record)) {
    return (
      <>
        <Link to="/p/$code/contacts/$contactId" params={{ code, contactId: record.id }}>
          {recordName(record)}
        </Link>
        <span className="duplicates__meta">
          {[...record.phones, ...record.emails].join(' · ') || t('record.noKeys')}
        </span>
      </>
    )
  }
  return (
    <>
      <Link to="/p/$code/deals/$dealId" params={{ code, dealId: record.id }}>
        {record.title}
      </Link>
      {record.archived && <Badge>{t('record.archived')}</Badge>}
      <span className="duplicates__meta">
        {[
          `${record.pipelineName} · ${record.stageName}`,
          record.contactName ?? t('record.contactHidden'),
          `${record.amount} ${record.currency}`,
          record.ownerName ?? t('record.noOwner'),
        ].join(' · ')}
      </span>
    </>
  )
}

function GroupCard({
  api,
  projectId,
  code,
  group,
  onMerge,
}: {
  api: DuplicatesApi
  projectId: string
  code: string
  group: DuplicateGroup
  onMerge: () => void
}) {
  const { t } = useTranslation('duplicates')
  const errorText = useErrorText()
  const queryClient = useQueryClient()
  const [busyPair, setBusyPair] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const byId = new Map(group.records.map((record) => [record.id, record]))
  const name = (id: string) => {
    const record = byId.get(id)
    return record ? recordName(record) : id
  }

  async function notDuplicate(pair: DuplicatePair) {
    setBusyPair(`${pair.aId}:${pair.bId}`)
    setError(null)
    try {
      await api.notDuplicate(projectId, group.type, pair.aId, pair.bId)
      await queryClient.invalidateQueries({ queryKey: duplicatesQueryKey(projectId) })
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusyPair(null)
    }
  }

  return (
    <article
      className="duplicates__group"
      aria-label={t('group.label', { count: group.records.length })}
    >
      <div className="duplicates__reasons">
        {group.reasons.map((reason) => (
          <Badge key={reason} tone="ask">
            {t(`reasons.${reason}`)}
          </Badge>
        ))}
      </div>
      <ul className="duplicates__records">
        {group.records.map((record) => (
          <li key={record.id}>
            <RecordLine record={record} code={code} />
          </li>
        ))}
      </ul>
      <ul className="duplicates__pairs" aria-label={t('group.pairs')}>
        {group.pairs.map((pair) => (
          <li key={`${pair.aId}:${pair.bId}`}>
            <span>
              {t('group.pair', { a: name(pair.aId), b: name(pair.bId) })}{' '}
              <span className="duplicates__meta">
                {pair.reasons.map((reason) => t(`reasons.${reason}`)).join(', ')}
              </span>
            </span>
            <Button
              size="sm"
              variant="quiet"
              busy={busyPair === `${pair.aId}:${pair.bId}`}
              onClick={() => notDuplicate(pair)}
              aria-label={t('group.notDuplicateLabel', { a: name(pair.aId), b: name(pair.bId) })}
            >
              {t('group.notDuplicate')}
            </Button>
          </li>
        ))}
      </ul>
      {error && <Notice kind="alert">{error}</Notice>}
      <div className="duplicates__actions">
        <Button variant="primary" onClick={onMerge}>
          {t('group.merge')}
        </Button>
      </div>
    </article>
  )
}

/** Числа и списки предпросмотра, которые показывает окно (поле ответа → ключ перевода). */
const PREVIEW_ITEMS = [
  'fields',
  'phones',
  'emails',
  'deals',
  'participations',
  'products',
  'participants',
  'notes',
  'files',
] as const

function previewCount(preview: MergePreview, key: string): number {
  const value = preview[key]
  if (Array.isArray(value)) return value.length
  return typeof value === 'number' ? value : 0
}

/** Пары конфликтующих сделок в предпросмотре слияния контактов; у сделок их нет. */
function dealPairsOf(preview: MergePreview | undefined): DealPairPreview[] {
  return Array.isArray(preview?.dealPairs) ? (preview.dealPairs as DealPairPreview[]) : []
}

function PreviewOf({
  merged,
  preview,
  onSwap,
}: {
  merged: GroupRecord
  preview: UseQueryResult<MergePreview>
  /** «Поміняти» на паре конфликтующих сделок. */
  onSwap: (pair: DealPairPreview) => void
}) {
  const { t } = useTranslation('duplicates')
  const errorText = useErrorText()
  return (
    <li>
      <strong>{t('merge.from', { name: recordName(merged) })}</strong>
      {preview.isPending && <Skeleton lines={1} />}
      {preview.isError && <Notice kind="alert">{errorText(preview.error)}</Notice>}
      {preview.data && (
        <>
          <DealPairs pairs={dealPairsOf(preview.data)} onSwap={onSwap} />
          <ul className="duplicates__preview">
            {PREVIEW_ITEMS.filter((key) => previewCount(preview.data, key) > 0).map((key) => (
              <li key={key}>{t(`preview.${key}`, { count: previewCount(preview.data, key) })}</li>
            ))}
            {PREVIEW_ITEMS.every((key) => previewCount(preview.data, key) === 0) && (
              <li>{t('preview.nothing')}</li>
            )}
          </ul>
        </>
      )}
    </li>
  )
}

/** Слияние, сделанное в окне: можно откатить, пока окно открыто (дальше — карточка записи). */
interface DoneMerge {
  mergedId: string
  mergeId: string
  undone: boolean
}

function MergeDialog({
  api,
  projectId,
  group,
  onClose,
}: {
  api: DuplicatesApi
  projectId: string
  group: DuplicateGroup
  onClose: () => void
}) {
  const { t, i18n } = useTranslation('duplicates')
  const errorText = useErrorText()
  const queryClient = useQueryClient()
  // По умолчанию остаётся самая старая запись: у неё обычно история и сделки.
  const oldest = [...group.records].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0]
  const [survivorId, setSurvivorId] = useState(oldest?.id ?? '')
  /** Для каждой сливаемой записи — сделки пар, которые остаются вместо сделки оставшегося. */
  const [keep, setKeep] = useState<Record<string, string[]>>({})
  const [done, setDone] = useState<DoneMerge[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const others = group.records.filter((record) => record.id !== survivorId)
  const keepOf = (id: string) => keep[id] ?? []
  const previews = useQueries({
    queries: others.map((record) => ({
      queryKey: [
        ...duplicatesQueryKey(projectId),
        'preview',
        group.type,
        survivorId,
        record.id,
        keepOf(record.id),
      ],
      queryFn: () => api.preview(projectId, group.type, survivorId, record.id, keepOf(record.id)),
      retry: false,
    })),
  })
  // Пара конфликтующих сделок без права на них: слияние ответило бы 403 MERGE_DEAL_FORBIDDEN.
  const forbidden = previews.some((preview) =>
    dealPairsOf(preview.data).some((pair) => pair.forbidden),
  )
  const name = (id: string) => {
    const record = group.records.find((r) => r.id === id)
    return record ? recordName(record) : id
  }
  const refresh = () => queryClient.invalidateQueries({ queryKey: duplicatesQueryKey(projectId) })

  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      // По одному: каждое слияние — своё действие со своим откатом.
      for (const record of others) {
        if (done.some((merge) => merge.mergedId === record.id && !merge.undone)) continue
        const { mergeId } = await api.merge(
          projectId,
          group.type,
          survivorId,
          record.id,
          keepOf(record.id),
        )
        setDone((list) => [...list, { mergedId: record.id, mergeId, undone: false }])
      }
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
      await refresh()
    }
  }

  async function undo(merge: DoneMerge) {
    setBusy(true)
    setError(null)
    try {
      await api.undo(projectId, merge.mergeId)
      setDone((list) =>
        list.map((item) => (item.mergeId === merge.mergeId ? { ...item, undone: true } : item)),
      )
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
      await refresh()
    }
  }

  const started = done.length > 0
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('merge.title')}
      className="duplicates__dialog"
      footer={
        started ? (
          <Button onClick={onClose}>{t('merge.close')}</Button>
        ) : (
          <>
            <Button onClick={onClose}>{t('merge.cancel')}</Button>
            <Button variant="primary" busy={busy} disabled={forbidden} onClick={confirm}>
              {t('merge.confirm', { count: others.length })}
            </Button>
          </>
        )
      }
    >
      {!started && (
        <>
          <fieldset className="duplicates__keep">
            <legend>{t('merge.keep')}</legend>
            {group.records.map((record) => (
              <label key={record.id}>
                <input
                  type="radio"
                  name={`survivor-${group.id}`}
                  checked={record.id === survivorId}
                  onChange={() => {
                    setSurvivorId(record.id)
                    setKeep({})
                  }}
                />
                <span>
                  {recordName(record)}{' '}
                  <span className="duplicates__meta">
                    {t('merge.created', {
                      date: new Date(record.createdAt).toLocaleDateString(i18n.language),
                    })}
                    {isContact(record) &&
                      [...record.phones, ...record.emails].map((key) => ` · ${key}`).join('')}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <p>{t('merge.hint', { name: name(survivorId) })}</p>
          <ul className="duplicates__previews">
            {others.map((record, index) => (
              <PreviewOf
                key={`${survivorId}:${record.id}`}
                merged={record}
                preview={previews[index] as UseQueryResult<MergePreview>}
                onSwap={(pair) =>
                  setKeep((value) => ({
                    ...value,
                    [record.id]: swapDealPair(value[record.id] ?? [], pair),
                  }))
                }
              />
            ))}
          </ul>
        </>
      )}
      {started && (
        <ul className="duplicates__done">
          {done.map((merge) => (
            <li key={merge.mergeId}>
              <span>
                {t(merge.undone ? 'merge.undone' : 'merge.merged', {
                  name: name(merge.mergedId),
                  survivor: name(survivorId),
                })}
              </span>
              {!merge.undone && (
                <Button size="sm" busy={busy} onClick={() => undo(merge)}>
                  {t('merge.undo')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <Notice kind="alert">{error}</Notice>}
    </Dialog>
  )
}
