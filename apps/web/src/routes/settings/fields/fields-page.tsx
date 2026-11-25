import { FIELD_ENTITIES } from '@alpi/shared'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  projectQueryKey,
  useCurrentProject,
} from '../../../components/project-switcher/current-project.tsx'
import { NoAccess } from '../../../layout/no-access.tsx'
import { Skeleton } from '../../../ui/feedback.tsx'
import { Tabs } from '../../../ui/tabs.tsx'
import { ArchiveTab } from './archive-tab.tsx'
import { EntityTab } from './entity-tab.tsx'
import type { FieldsSettingsApi } from './fields-api.ts'
import { fieldsSettingsAllowed } from './fields-data.ts'
import '../settings.css'
import './fields.css'

// Налаштування → Поля (тикет crm-fields/05): конструктор пользовательских полей сделок,
// контактов и организаций — вкладки сущностей с группами и полями и вкладка «Архів». Открывается
// по праву «поля»; без него — экран «немає доступу». Работает через запросы тикетов 01, 03 и 07;
// каждый запрос проверяет сервер, интерфейс только прячет действия без права.

export function FieldsPage({ api }: { api: FieldsSettingsApi }) {
  const { t } = useTranslation('fields-settings')
  const { current } = useCurrentProject()
  if (!current) {
    return (
      <section>
        <h1>{t('title')}</h1>
        <p>{t('noProject')}</p>
      </section>
    )
  }
  return <FieldsScreen key={current.id} api={api} projectId={current.id} />
}

function FieldsScreen({ api, projectId }: { api: FieldsSettingsApi; projectId: string }) {
  const { t } = useTranslation('fields-settings')
  const access = useQuery({
    queryKey: projectQueryKey(projectId, 'access'),
    queryFn: () => api.access(projectId),
    retry: false,
  })
  if (access.isPending) {
    return (
      <section>
        <h1>{t('title')}</h1>
        <Skeleton />
      </section>
    )
  }
  const permissions = access.data?.permissions
  if (!permissions || !fieldsSettingsAllowed(permissions)) return <NoAccess />

  return (
    <section className="fields-settings">
      <h1>{t('title')}</h1>
      <Tabs
        label={t('tabsLabel')}
        tabs={[
          ...FIELD_ENTITIES.map((entity) => ({
            id: entity,
            label: t(`tabs.${entity}`),
            content: (
              <EntityTab
                key={entity}
                api={api}
                projectId={projectId}
                entity={entity}
                permissions={permissions}
              />
            ),
          })),
          {
            id: 'archive',
            label: t('tabs.archive'),
            content: <ArchiveTab api={api} projectId={projectId} permissions={permissions} />,
          },
        ]}
      />
    </section>
  )
}
