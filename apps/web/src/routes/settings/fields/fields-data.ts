import {
  ACTIONS,
  can,
  type FieldEntity,
  type FieldNames,
  fieldName,
  type RolePermissions,
} from '@alpi/shared'
import { type QueryKey, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { projectQueryKey } from '../../../components/project-switcher/current-project.tsx'
import { FieldsApiError, type FieldsSettingsApi } from './fields-api.ts'

// Данные экрана полей: ключи кэша, общие запросы вкладок и текст отказа API.

/**
 * Экран открывается по праву «поля» (`fields`) — любому его действию: смотреть настройки,
 * создавать, изменять или удалять. Какие кнопки видны — по каждому действию отдельно.
 */
export function fieldsSettingsAllowed(permissions: RolePermissions): boolean {
  return ACTIONS.some((action) => can(permissions, 'fields', action))
}

export const fieldsSettingsKey = (projectId: string, ...rest: unknown[]): QueryKey =>
  projectQueryKey(projectId, 'fields-settings', ...rest)

export function useGroups(api: FieldsSettingsApi, projectId: string, entity: FieldEntity) {
  return useQuery({
    queryKey: fieldsSettingsKey(projectId, 'groups', entity),
    queryFn: () => api.groups(projectId, entity),
    retry: false,
  })
}

export function useFields(api: FieldsSettingsApi, projectId: string, entity: FieldEntity) {
  return useQuery({
    queryKey: fieldsSettingsKey(projectId, 'fields', entity),
    queryFn: () => api.fields(projectId, entity),
    retry: false,
  })
}

export function usePipelines(api: FieldsSettingsApi, projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: fieldsSettingsKey(projectId, 'pipelines'),
    queryFn: () => api.pipelines(projectId),
    retry: false,
    enabled,
  })
}

/** Роли проекта; без права «користувачі і ролі» — ошибка 403, экран обходится без них. */
export function useRoles(api: FieldsSettingsApi, projectId: string) {
  return useQuery({
    queryKey: fieldsSettingsKey(projectId, 'roles'),
    queryFn: () => api.roles(projectId),
    retry: false,
  })
}

/** После изменения — заново все данные экрана: порядок и состав групп меняет сервер. */
export function useRefresh(projectId: string) {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: fieldsSettingsKey(projectId) })
}

/** Текст отказа API по коду ошибки. */
export function useErrorText() {
  const { t } = useTranslation('fields-settings')
  return (error: unknown) => {
    const code = error instanceof FieldsApiError ? error.code : ''
    return t(`errors.${code}`, { defaultValue: t('errors.unknown') })
  }
}

/** Название на языке интерфейса: русского нет — украинское. */
export function useLocalName() {
  const { i18n } = useTranslation()
  return (names: FieldNames) => fieldName(names, i18n.language === 'ru' ? 'ru' : 'uk')
}

export function useDateText() {
  const { i18n } = useTranslation()
  const format = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' })
  return (date: Date | string) => format.format(new Date(date))
}
