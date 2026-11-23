import type { PipelineSummary, ProjectAccess } from '@alpi/shared'
import {
  type QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatMoney } from '../../../components/deal-card/deal-card.tsx'
import {
  projectQueryKey,
  useCurrentProject,
  useProjectCode,
} from '../../../components/project-switcher/current-project.tsx'
import { Button } from '../../../ui/button.tsx'
import { allowedBulkActions, BulkDialog } from './bulk-dialog.tsx'
import { dealFilterFromSearch, dealFilterOptions } from './filter-options.ts'
import { type ListColumnDef, ListView, type SelectionActions } from './list-view.tsx'
import type { DealRow, ListOwner, ListsApi } from './lists-api.ts'

// Экран «Угоди — список» (тикет crm-deals/12): та же выдача API, что у канбана, со всеми
// статусами; фильтр, сортировка, выбор колонок, выгрузка и массовые действия.

export interface DealsListSearch {
  pipeline?: string
  stage?: string
  filter?: string
}

export function DealsListPage({
  api,
  userId,
  queryClient,
  search,
}: {
  api: ListsApi
  userId: string
  queryClient: QueryClient
  search: DealsListSearch
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <DealsList api={api} userId={userId} search={search} />
    </QueryClientProvider>
  )
}

function DealsList({
  api,
  userId,
  search,
}: {
  api: ListsApi
  userId: string
  search: DealsListSearch
}) {
  const { t } = useTranslation('lists')
  const { current } = useCurrentProject()
  if (!current) {
    return (
      <section>
        <h1>{t('deals.title')}</h1>
        <p>{t('noProject')}</p>
      </section>
    )
  }
  return (
    <DealsListBody
      key={current.id}
      api={api}
      projectId={current.id}
      userId={userId}
      search={search}
    />
  )
}

function DealsListBody({
  api,
  projectId,
  userId,
  search,
}: {
  api: ListsApi
  projectId: string
  userId: string
  search: DealsListSearch
}) {
  const { t, i18n } = useTranslation('lists')
  const code = useProjectCode()
  const pipelines = useQuery({
    queryKey: projectQueryKey(projectId, 'lists', 'pipelines'),
    queryFn: () => api.pipelines(projectId),
    retry: false,
  })
  const owners = useQuery({
    queryKey: projectQueryKey(projectId, 'lists', 'owners'),
    queryFn: () => api.owners(projectId),
    retry: false,
  })
  const lostReasons = useQuery({
    queryKey: projectQueryKey(projectId, 'lists', 'lost-reasons'),
    queryFn: () => api.lostReasons(projectId),
    retry: false,
  })

  const pipelineName = new Map<string, string>()
  const stageName = new Map<string, string>()
  for (const p of pipelines.data ?? []) {
    pipelineName.set(p.id, p.name)
    for (const s of p.stages) stageName.set(s.id, s.name)
  }
  const reasonName = new Map<string, string>()
  for (const group of lostReasons.data ?? []) {
    for (const reason of group.reasons) reasonName.set(reason.id, reason.name)
  }
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short' })
  const at = (value: string | null) => (value ? date.format(new Date(value)) : '')

  const columns: Record<string, ListColumnDef<DealRow>> = {
    title: {
      key: 'title',
      cell: (row) => (
        <Link to="/p/$code/deals/$dealId" params={{ code, dealId: row.id }}>
          {row.title}
        </Link>
      ),
    },
    pipeline: { key: 'pipeline', cell: (row) => pipelineName.get(row.pipelineId) ?? '' },
    stage: { key: 'stage', cell: (row) => stageName.get(row.stageId) ?? '' },
    status: { key: 'status', cell: (row) => t(`values.status.${row.status}`) },
    amount: {
      key: 'amount',
      numeric: true,
      cell: (row) => formatMoney(row.amount, row.currency, i18n.language),
    },
    currency: { key: 'currency', cell: (row) => row.currency },
    owner: { key: 'owner', cell: (row) => row.ownerName ?? t('queue') },
    contact: {
      key: 'contact',
      cell: (row) =>
        row.contactName ? (
          <Link
            to="/p/$code/contacts/$contactId"
            params={{ code, contactId: row.primaryContactId }}
          >
            {row.contactName}
          </Link>
        ) : (
          ''
        ),
    },
    organization: {
      key: 'organization',
      cell: (row) =>
        row.organizationId && row.organizationName ? (
          <Link
            to="/p/$code/organizations/$organizationId"
            params={{ code, organizationId: row.organizationId }}
          >
            {row.organizationName}
          </Link>
        ) : (
          ''
        ),
    },
    createdAt: { key: 'createdAt', cell: (row) => at(row.createdAt) },
    stageChangedAt: { key: 'stageChangedAt', cell: (row) => at(row.stageChangedAt) },
    wonAt: { key: 'wonAt', cell: (row) => at(row.wonAt) },
    lostAt: { key: 'lostAt', cell: (row) => at(row.lostAt) },
    lostReason: {
      key: 'lostReason',
      cell: (row) => (row.lostReasonId ? (reasonName.get(row.lostReasonId) ?? '') : ''),
    },
    archivedAt: { key: 'archivedAt', cell: (row) => at(row.archivedAt) },
  }

  const options = {
    ...dealFilterOptions(pipelines.data ?? [], owners.data ?? []),
    lostReason: [...reasonName].map(([value, label]) => ({ value, label })),
  }

  return (
    <ListView
      entity="deals"
      api={api}
      projectId={projectId}
      userId={userId}
      title={t('deals.title')}
      toolbar={
        <Link to="/p/$code/deals" params={{ code }} className="list-head__link">
          {t('deals.kanban')}
        </Link>
      }
      columns={columns}
      defaultSort="stageChangedAt:desc"
      initialFilter={dealFilterFromSearch(search)}
      options={options}
      rowTitle={(row) => row.title}
      selectable
      renderSelection={(selection, access) => (
        <DealBulk
          api={api}
          projectId={projectId}
          selection={selection}
          access={access}
          pipelines={pipelines.data ?? []}
          owners={owners.data ?? []}
        />
      )}
    />
  )
}

/** Кнопка «Масова дія» над выбранными сделками; без права на массовые операции её нет. */
function DealBulk({
  api,
  projectId,
  selection,
  access,
  pipelines,
  owners,
}: {
  api: ListsApi
  projectId: string
  selection: SelectionActions
  access: ProjectAccess
  pipelines: PipelineSummary[]
  owners: ListOwner[]
}) {
  const { t } = useTranslation('lists')
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [finished, setFinished] = useState(false)
  const actions = allowedBulkActions(access.permissions)
  if (actions.length === 0) return null
  return (
    <>
      <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
        {t('bulk.title')}
      </Button>
      {open && (
        <BulkDialog
          api={api}
          projectId={projectId}
          selection={selection.selection}
          total={selection.count}
          actions={actions}
          pipelines={pipelines.filter((p) => p.archivedAt === null)}
          owners={owners}
          onFinished={() => {
            setFinished(true)
            void queryClient.invalidateQueries({
              queryKey: projectQueryKey(projectId, 'lists', 'deals'),
            })
            void queryClient.invalidateQueries({
              queryKey: projectQueryKey(projectId, 'deals'),
            })
          }}
          onClose={() => {
            setOpen(false)
            if (finished) selection.clear()
          }}
        />
      )}
    </>
  )
}
