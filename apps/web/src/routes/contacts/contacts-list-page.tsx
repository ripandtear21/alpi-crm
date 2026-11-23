import { type QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import {
  projectQueryKey,
  useCurrentProject,
} from '../../components/project-switcher/current-project.tsx'
import { creatorFilterOptions } from '../deals/list/filter-options.ts'
import { type ListColumnDef, ListView } from '../deals/list/list-view.tsx'
import type { ContactRow, ListsApi } from '../deals/list/lists-api.ts'

// Экран «Контакти» — список контактов (тикет crm-deals/12): охват роли соблюдает сервер,
// фильтр, сортировка, колонки и выгрузка — общие со списком сделок.

export function ContactsListPage({
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
      <ContactsList api={api} userId={userId} />
    </QueryClientProvider>
  )
}

function ContactsList({ api, userId }: { api: ListsApi; userId: string }) {
  const { t } = useTranslation('lists')
  const { current } = useCurrentProject()
  if (!current) {
    return (
      <section>
        <h1>{t('contacts.title')}</h1>
        <p>{t('noProject')}</p>
      </section>
    )
  }
  return <ContactsListBody key={current.id} api={api} projectId={current.id} userId={userId} />
}

function ContactsListBody({
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
  const name = (row: ContactRow) => [row.firstName, row.lastName].filter(Boolean).join(' ')

  const columns: Record<string, ListColumnDef<ContactRow>> = {
    name: {
      key: 'name',
      cell: (row) => (
        <Link to="/contacts/$contactId" params={{ contactId: row.id }}>
          {name(row)}
        </Link>
      ),
    },
    phone: { key: 'phone', cell: (row) => row.phone ?? '' },
    email: { key: 'email', cell: (row) => row.email ?? '' },
    organization: {
      key: 'organization',
      cell: (row) =>
        row.organizationId && row.organizationName ? (
          <Link to="/organizations/$organizationId" params={{ organizationId: row.organizationId }}>
            {row.organizationName}
          </Link>
        ) : (
          ''
        ),
    },
    language: {
      key: 'language',
      cell: (row) =>
        row.language === 'uk' || row.language === 'ru' ? t(`values.language.${row.language}`) : '',
    },
    possibleDuplicate: {
      key: 'possibleDuplicate',
      cell: (row) => (row.possibleDuplicate ? t('filter.yes') : ''),
    },
    createdAt: { key: 'createdAt', cell: (row) => date.format(new Date(row.createdAt)) },
    updatedAt: { key: 'updatedAt', cell: (row) => date.format(new Date(row.updatedAt)) },
  }

  return (
    <ListView
      entity="contacts"
      api={api}
      projectId={projectId}
      userId={userId}
      title={t('contacts.title')}
      columns={columns}
      defaultSort="createdAt:desc"
      options={creatorFilterOptions(owners.data ?? [])}
      rowTitle={name}
    />
  )
}
