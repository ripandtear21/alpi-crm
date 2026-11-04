import {
  type AuditEntry,
  isProjectAuditAction,
  PROJECT_AUDIT_ACTIONS,
  type ProjectAuditAction,
} from '@alpi/shared'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  projectQueryKey,
  useCurrentProject,
} from '../../components/project-switcher/current-project.tsx'
import { type AuditApi, AuditApiError } from './audit-api.ts'
import './audit.css'

// Настройки → журнал: опасные действия в текущем проекте, новые сверху, с фильтром по
// действию и пользователю; следующая страница — кнопкой «Показати ще». Право — «доступ до
// налаштувань проєкту» (у шаблонов — только администратор); без него API отвечает 403.

export function AuditPage({ api }: { api: AuditApi }) {
  const { t } = useTranslation('audit')
  const { current } = useCurrentProject()
  if (!current) {
    return (
      <section>
        <h1>{t('title')}</h1>
        <p>{t('noProject')}</p>
      </section>
    )
  }
  // key: при смене проекта фильтры начинаются заново.
  return <AuditLog key={current.id} api={api} projectId={current.id} />
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function part(details: Record<string, unknown>, key: 'before' | 'after') {
  const value = details[key]
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/** Что именно изменилось — одной строкой. */
function useSummary() {
  const { t } = useTranslation('audit')
  return (entry: AuditEntry<ProjectAuditAction>): string => {
    const before = part(entry.details, 'before')
    const after = part(entry.details, 'after')
    switch (entry.action) {
      case 'member.role_changed':
        return t('summary.roleChanged', {
          user: entry.entityName ?? entry.entityId ?? '',
          before: text(before.roleName),
          after: text(after.roleName),
        })
      case 'role.created':
        return text(after.name)
      case 'role.deleted':
        return text(before.name)
      case 'role.updated': {
        const changes: string[] = []
        if ('name' in after) {
          changes.push(t('summary.renamed', { before: text(before.name), after: text(after.name) }))
        }
        if ('permissions' in after) changes.push(t('summary.permissionsChanged'))
        return changes.join('; ')
      }
      case 'member.added':
      case 'member.disabled':
        return entry.entityName ?? entry.entityId ?? ''
    }
  }
}

function AuditLog({ api, projectId }: { api: AuditApi; projectId: string }) {
  const { t, i18n } = useTranslation('audit')
  const summary = useSummary()
  const [action, setAction] = useState<ProjectAuditAction | ''>('')
  const [actor, setActor] = useState('')
  const filter = { ...(action ? { action } : {}), ...(actor ? { actor } : {}) }

  const actors = useQuery({
    queryKey: projectQueryKey(projectId, 'audit', 'actors'),
    queryFn: () => api.actors(projectId),
    retry: false,
  })
  const log = useInfiniteQuery({
    queryKey: projectQueryKey(projectId, 'audit', filter),
    queryFn: ({ pageParam }) =>
      api.page(projectId, { ...filter, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  })

  const time = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short', timeStyle: 'medium' })

  if (log.isError) {
    const denied = log.error instanceof AuditApiError && log.error.status === 403
    return (
      <section>
        <h1>{t('title')}</h1>
        <p role="alert">{denied ? t('noAccess') : t('error')}</p>
      </section>
    )
  }

  const entries = log.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <section className="audit">
      <h1>{t('title')}</h1>
      <form className="audit__filters" aria-label={t('filtersLabel')}>
        <label>
          {t('filter.action')}
          <select
            value={action}
            onChange={(e) => setAction(isProjectAuditAction(e.target.value) ? e.target.value : '')}
          >
            <option value="">{t('filter.anyAction')}</option>
            {PROJECT_AUDIT_ACTIONS.map((code) => (
              <option key={code} value={code}>
                {t(`actions.${code}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('filter.actor')}
          <select value={actor} onChange={(e) => setActor(e.target.value)}>
            <option value="">{t('filter.anyActor')}</option>
            {(actors.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.email})
              </option>
            ))}
          </select>
        </label>
      </form>

      {log.isPending ? (
        <p>{t('loading')}</p>
      ) : entries.length === 0 ? (
        <p>{t('empty')}</p>
      ) : (
        <div className="audit__scroll">
          <table className="audit__table">
            <caption>{t('tableCaption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('column.time')}</th>
                <th scope="col">{t('column.actor')}</th>
                <th scope="col">{t('column.action')}</th>
                <th scope="col">{t('column.details')}</th>
                <th scope="col">{t('column.ip')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <time dateTime={entry.occurredAt}>
                      {time.format(new Date(entry.occurredAt))}
                    </time>
                  </td>
                  <td>{entry.actor ? entry.actor.name : t('system')}</td>
                  <td>{t(`actions.${entry.action}`)}</td>
                  <td>{summary(entry)}</td>
                  <td>{entry.ip ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {log.hasNextPage && (
        <button type="button" onClick={() => log.fetchNextPage()} disabled={log.isFetchingNextPage}>
          {t('more')}
        </button>
      )}
    </section>
  )
}
