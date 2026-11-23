import { can } from '@alpi/shared'
import {
  type QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  projectQueryKey,
  useCurrentProject,
} from '../../components/project-switcher/current-project.tsx'
import { Button } from '../../ui/button.tsx'
import { Dialog } from '../../ui/dialog.tsx'
import { Notice, Skeleton } from '../../ui/feedback.tsx'
import { Tabs } from '../../ui/tabs.tsx'
import {
  type ListsApi,
  ListsApiError,
  type TrashItem,
  type TrashType,
} from '../deals/list/lists-api.ts'
import '../deals/list/lists.css'

// Настройки → «Кошик» (тикет crm-deals/12): удалённые сделки, контакты и организации по
// вкладкам; восстановить (право «Кошик: змінювати») и удалить окончательно (право «Кошик:
// видаляти»). Охват роли соблюдает сервер; кнопки без права скрыты. Через 30 дней запись
// удаляется сама — колонка «Остаточне видалення» показывает когда.

const TYPES: TrashType[] = ['deal', 'contact', 'organization']

export function TrashPage({ api, queryClient }: { api: ListsApi; queryClient: QueryClient }) {
  return (
    <QueryClientProvider client={queryClient}>
      <Trash api={api} />
    </QueryClientProvider>
  )
}

function Trash({ api }: { api: ListsApi }) {
  const { t } = useTranslation('lists')
  const { current } = useCurrentProject()
  if (!current) {
    return (
      <section>
        <h1>{t('trash.title')}</h1>
        <p>{t('noProject')}</p>
      </section>
    )
  }
  return <TrashBody key={current.id} api={api} projectId={current.id} />
}

function TrashBody({ api, projectId }: { api: ListsApi; projectId: string }) {
  const { t } = useTranslation('lists')
  const access = useQuery({
    queryKey: projectQueryKey(projectId, 'access'),
    queryFn: () => api.access(projectId),
    retry: false,
  })
  if (access.isPending) {
    return (
      <section>
        <h1>{t('trash.title')}</h1>
        <Skeleton />
      </section>
    )
  }
  const permissions = access.data?.permissions
  if (!permissions || !can(permissions, 'trash', 'view')) {
    return (
      <section>
        <h1>{t('trash.title')}</h1>
        <Notice kind="alert">{t('trash.noAccess')}</Notice>
      </section>
    )
  }
  const resourceOf = { deal: 'deals', contact: 'contacts', organization: 'organizations' } as const
  const visible = TYPES.filter((type) => can(permissions, resourceOf[type], 'view'))
  return (
    <section>
      <h1>{t('trash.title')}</h1>
      <Tabs
        label={t('trash.title')}
        tabs={visible.map((type) => ({
          id: type,
          label: t(`trash.types.${type}`),
          content: (
            <TrashTab
              api={api}
              projectId={projectId}
              type={type}
              canRestore={can(permissions, 'trash', 'edit')}
              canPurge={can(permissions, 'trash', 'delete')}
            />
          ),
        }))}
      />
    </section>
  )
}

function TrashTab({
  api,
  projectId,
  type,
  canRestore,
  canPurge,
}: {
  api: ListsApi
  projectId: string
  type: TrashType
  canRestore: boolean
  canPurge: boolean
}) {
  const { t, i18n } = useTranslation('lists')
  const queryClient = useQueryClient()
  const [notice, setNotice] = useState<{ kind: 'status' | 'alert'; text: string } | null>(null)
  const [purging, setPurging] = useState<TrashItem | null>(null)
  const key = projectQueryKey(projectId, 'trash', type)
  const items = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => api.trash(projectId, type, pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    retry: false,
  })
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short', timeStyle: 'short' })
  const day = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short' })
  const rows = items.data?.pages.flatMap((page) => page.items) ?? []

  function failure(error: unknown): string {
    if (!(error instanceof ListsApiError)) return t('trash.errors.unknown')
    if (error.status === 403) return t('trash.errors.PERMISSION_DENIED')
    return t(`trash.errors.${error.code}` as 'trash.errors.unknown', {
      defaultValue: t('trash.errors.unknown'),
    })
  }

  async function act(item: TrashItem, action: 'restore' | 'purge') {
    setNotice(null)
    try {
      if (action === 'restore') await api.restore(projectId, type, item.id)
      else await api.purge(projectId, type, item.id)
      setNotice({
        kind: 'status',
        text: t(action === 'restore' ? 'trash.restored' : 'trash.purged', { title: item.title }),
      })
      // Восстановленная запись снова в списках и на канбане.
      void queryClient.invalidateQueries({ queryKey: projectQueryKey(projectId) })
    } catch (error) {
      setNotice({ kind: 'alert', text: failure(error) })
    }
  }

  if (items.isPending) return <Skeleton />
  if (items.isError) return <Notice kind="alert">{failure(items.error)}</Notice>

  return (
    <div className="trash-tab">
      {notice && <Notice kind={notice.kind}>{notice.text}</Notice>}
      {rows.length === 0 ? (
        <p>{t('trash.empty')}</p>
      ) : (
        <div className="ui-table-wrap">
          <table className="ui-table">
            <caption className="visually-hidden">
              {t('trash.caption')} — {t(`trash.types.${type}`)}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t('trash.name')}</th>
                <th scope="col">{t('trash.deletedAt')}</th>
                <th scope="col">{t('trash.deletedBy')}</th>
                <th scope="col">{t('trash.purgeAt')}</th>
                {(canRestore || canPurge) && <th scope="col">{t('trash.actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => (
                <tr key={item.id}>
                  <td>{item.title}</td>
                  <td>{date.format(new Date(item.deletedAt))}</td>
                  <td>{item.deletedByName ?? ''}</td>
                  <td>{day.format(new Date(item.purgeAt))}</td>
                  {(canRestore || canPurge) && (
                    <td className="trash-actions">
                      {canRestore && (
                        <Button size="sm" onClick={() => void act(item, 'restore')}>
                          {t('trash.restore')}
                        </Button>
                      )}
                      {canPurge && (
                        <Button size="sm" variant="danger" onClick={() => setPurging(item)}>
                          {t('trash.purge')}
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {items.hasNextPage && (
        <Button
          size="sm"
          disabled={items.isFetchingNextPage}
          onClick={() => void items.fetchNextPage()}
        >
          {t('more')}
        </Button>
      )}
      {purging && (
        <Dialog
          open
          onClose={() => setPurging(null)}
          title={t('trash.purge')}
          footer={
            <>
              <Button variant="quiet" onClick={() => setPurging(null)}>
                {t('saved.cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  const item = purging
                  setPurging(null)
                  void act(item, 'purge')
                }}
              >
                {t('trash.purge')}
              </Button>
            </>
          }
        >
          <p>{t('trash.purgeConfirm', { title: purging.title })}</p>
        </Dialog>
      )}
    </div>
  )
}
