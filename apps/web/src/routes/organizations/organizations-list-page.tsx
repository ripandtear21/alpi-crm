import { type QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import {
  projectQueryKey,
  useCurrentProject,
} from '../../components/project-switcher/current-project.tsx'
import { creatorFilterOptions } from '../deals/list/filter-options.ts'
import { type ListColumnDef, ListView } from '../deals/list/list-view.tsx'
import type { ListsApi, OrganizationRow } from '../deals/list/lists-api.ts'

// Экран «Організації» — список организаций (тикет crm-deals/12): фильтр, сортировка,
// колонки и выгрузка — общие со списком сделок.

export function OrganizationsListPage({
  api,
  userId,
  queryClient,
}: {
  api: ListsApi
  userId: string
  queryClient: QueryClient
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <OrganizationsList api={api} userId={userId} />
    </QueryClientProvider>
  )
}

function OrganizationsList({ api, userId }: { api: ListsApi; userId: string }) {
  const { t } = useTranslation('lists')
  const { current } = useCurrentProject()
  if (!current) {
    return (
      <section>
        <h1>{t('organizations.title')}</h1>
        <p>{t('noProject')}</p>
      </section>
    )
  }
  return <OrganizationsListBody key={current.id} api={api} projectId={current.id} userId={userId} />
}

function OrganizationsListBody({
  api,
  projectId,
  userId,
}: {
  api: ListsApi
  projectId: string
  userId: string
}) {
  const { t, i18n } = useTranslation('lists')
  const owners = useQuery({
    queryKey: projectQueryKey(projectId, 'lists', 'owners'),
    queryFn: () => api.owners(projectId),
    retry: false,
  })
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short' })

  const columns: Record<string, ListColumnDef<OrganizationRow>> = {
    name: {
      key: 'name',
      cell: (row) => (
        <Link to="/organizations/$organizationId" params={{ organizationId: row.id }}>
          {row.name}
        </Link>
      ),
    },
    address: { key: 'address', cell: (row) => row.address ?? '' },
    website: { key: 'website', cell: (row) => row.website ?? '' },
    createdAt: { key: 'createdAt', cell: (row) => date.format(new Date(row.createdAt)) },
    updatedAt: { key: 'updatedAt', cell: (row) => date.format(new Date(row.updatedAt)) },
  }

  return (
    <ListView
      entity="organizations"
      api={api}
      projectId={projectId}
      userId={userId}
      title={t('organizations.title')}
      columns={columns}
      defaultSort="name:asc"
      options={creatorFilterOptions(owners.data ?? [])}
      rowTitle={(row) => row.name}
    />
  )
}
