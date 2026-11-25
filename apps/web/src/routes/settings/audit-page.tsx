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
import './settings.css'
import { Button } from '../../ui/button.tsx'

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
      case 'member.created':
      case 'member.disabled':
      case 'member.enabled':
        return entry.entityName ?? entry.entityId ?? ''
      case 'member.team_changed':
        return t('summary.teamChanged', {
          user: entry.entityName ?? entry.entityId ?? '',
          before: text(before.teamName) || t('summary.noTeam'),
          after: text(after.teamName) || t('summary.noTeam'),
        })
      case 'team.created':
        return t('summary.teamCreated', { team: text(after.name), lead: text(after.leadName) })
      case 'team.updated':
        return t('summary.renamed', { before: text(before.name), after: text(after.name) })
      case 'team.deleted':
        return text(before.name)
      case 'contact.purged':
      case 'organization.purged':
      case 'deal.purged':
        return entry.entityId ?? ''
      // Тикет crm-deals/12: выгрузка списка в CSV.
      case 'export.downloaded':
        return text(entry.details.list)
      case 'team.lead_assigned':
        return t('summary.leadAssigned', {
          team: text(entry.details.team),
          before: text(before.leadName),
          after: text(after.leadName),
        })
      case 'bulk.started':
        return text(entry.details.action)
      // Тикет crm-deals/02: воронки, этапы и причины проигрыша.
      case 'pipeline.created':
      case 'lost_reason_group.created':
        return text(after.name)
      case 'stage.created':
        return t('summary.inside', { parent: text(entry.details.pipeline), name: text(after.name) })
      case 'lost_reason.created':
        return t('summary.inside', { parent: text(entry.details.group), name: text(after.name) })
      case 'stage.deleted':
        return t('summary.inside', {
          parent: text(entry.details.pipeline),
          name: text(before.name),
        })
      case 'pipeline.updated':
      case 'stage.updated':
      case 'lost_reason_group.updated':
      case 'lost_reason.updated': {
        const changes: string[] = []
        if ('name' in after) {
          changes.push(t('summary.renamed', { before: text(before.name), after: text(after.name) }))
        }
        if ('code' in after) {
          changes.push(
            t('summary.codeChanged', { before: text(before.code), after: text(after.code) }),
          )
        }
        if ('isUpsell' in after) {
          changes.push(after.isUpsell === true ? t('summary.upsellOn') : t('summary.upsellOff'))
        }
        if ('archived' in after) {
          changes.push(after.archived === true ? t('summary.archived') : t('summary.restored'))
        }
        const name = text(entry.details.name)
        return name !== '' && !('name' in after)
          ? `${name}: ${changes.join('; ')}`
          : changes.join('; ')
      }
      case 'pipeline.reordered':
      case 'lost_reason_group.reordered':
        return t('summary.reordered')
      case 'stage.reordered':
        return `${text(entry.details.pipeline)}: ${t('summary.reordered')}`
      case 'lost_reason.reordered':
        return `${text(entry.details.group)}: ${t('summary.reordered')}`
      case 'project.preset_applied':
        return t('summary.presetApplied', { preset: text(entry.details.preset) })
      // Тикет crm-fields/01: конструктор полей; в подробностях — название (и код) поля.
      case 'field_group.reordered':
      case 'field.reordered':
        return t('summary.reordered')
      case 'field_group.created':
      case 'field_group.updated':
      case 'field_group.deleted':
      case 'field.created':
      case 'field.updated':
      case 'field.archived':
      case 'field.restored':
      case 'field.deleted':
      case 'field.purge_requested':
      case 'field.purged':
      case 'field_option.created':
      case 'field_option.updated':
      case 'field_option.reordered': {
        const code = text(entry.details.code)
        return code === '' ? text(entry.details.name) : `${text(entry.details.name)} (${code})`
      }
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
        <p className="ui-notice" role="alert">
          {denied ? t('noAccess') : t('error')}
        </p>
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
            className="ui-select ui-select--sm"
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
          <select
            className="ui-select ui-select--sm"
            value={actor}
            onChange={(e) => setActor(e.target.value)}
          >
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
        <div className="ui-table-wrap">
          <table className="ui-table audit__table">
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
        <Button
          size="sm"
          type="button"
          onClick={() => log.fetchNextPage()}
          disabled={log.isFetchingNextPage}
        >
          {t('more')}
        </Button>
      )}
    </section>
  )
}
