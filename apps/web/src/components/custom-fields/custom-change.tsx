import { type FieldEntity, fieldName } from '@alpi/shared'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { TimelineItem } from '../timeline/timeline-api.ts'
import { fieldsQueryKey, membersQueryKey } from './custom-field-groups.tsx'
import { useCustomFieldsApi } from './custom-fields-api.tsx'
import { useFieldLocale, useFormatFieldValue } from './field-editor.tsx'

// Изменение пользовательского поля в ленте записи (тикет crm-fields/06): строка change_log с
// полем `custom.<код>` (apps/api/src/fields/values.ts) показывается как остальные «було → стало»
// — с текущим названием поля и названиями вариантов (у вариантов в истории лежат id). Описания
// полей — вместе с архивными: их изменения в ленте остаются.

type Change = NonNullable<TimelineItem['change']>

/** Префикс поля строки истории у пользовательских полей. */
export const CUSTOM_CHANGE_PREFIX = 'custom.'

/**
 * Описание изменения пользовательского поля; не пользовательское поле или описания поля нет
 * (ещё грузится, удалено) — null, и лента показывает строку по-своему.
 */
export function useDescribeCustomChange(
  projectId: string,
  entity: FieldEntity,
): (change: Change) => ReactNode | null {
  const api = useCustomFieldsApi()
  const locale = useFieldLocale()
  const format = useFormatFieldValue()
  const fields = useQuery({
    queryKey: fieldsQueryKey(projectId, entity),
    queryFn: () => api.fields(projectId, entity),
    retry: false,
  })
  const members = useQuery({
    queryKey: membersQueryKey(projectId),
    queryFn: () => api.members(projectId),
    enabled: (fields.data ?? []).some((field) => field.type === 'user'),
    retry: false,
  })

  return (change) => {
    if (!change.field.startsWith(CUSTOM_CHANGE_PREFIX)) return null
    const code = change.field.slice(CUSTOM_CHANGE_PREFIX.length)
    const field = fields.data?.find((item) => item.code === code)
    if (!field) return null
    const memberList = members.data ?? null
    return (
      <>
        {fieldName(field, locale)}: <b>{format(field, change.before, memberList)}</b> →{' '}
        <b>{format(field, change.after, memberList)}</b>
      </>
    )
  }
}
