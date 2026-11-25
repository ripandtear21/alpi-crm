import type {
  FieldDefinitionSummary,
  FieldEntity,
  FieldGroupSummary,
  MemberSummary,
} from '@alpi/shared'
import { createContext, type ReactNode, use } from 'react'
import { projectHeaders } from '../project-switcher/projects-api.ts'

// Запросы пользовательских полей для карточек (тикет crm-fields/06): группы и описания полей
// сущности (`/api/v1/field-groups`, `/api/v1/fields` — тикеты 01 и 03: скрытые от роли группы и
// их поля не приходят), участники проекта для поля «пользователь» и правка значения записи —
// `PUT /v1/{deals|contacts|organizations}/:id` с одним кодом в `custom` (тикет 02).
//
// Клиент берётся из контекста: карточки получают его без новых зависимостей маршрутизатора,
// тесты подставляют свой через CustomFieldsApiProvider.

/** Значения пользовательских полей записи по коду, как в `custom` ответа API. */
export type CustomValues = Record<string, unknown>

/** Сегмент пути API записи сущности. */
export const ENTITY_PATH: Record<FieldEntity, 'deals' | 'contacts' | 'organizations'> = {
  deal: 'deals',
  contact: 'contacts',
  organization: 'organizations',
}

/** Отказ API: код ответа, код ошибки и `details` тела, если есть. */
export class CustomFieldsApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Record<string, unknown> | null

  constructor(status: number, code: string, details: Record<string, unknown> | null = null) {
    super(`API ответил ${status} ${code}`)
    this.status = status
    this.code = code
    this.details = details
  }
}

export interface CustomFieldsApi {
  /** Группы сущности по порядку, без скрытых от роли. */
  groups(projectId: string, entity: FieldEntity): Promise<FieldGroupSummary[]>
  /** Описания полей сущности вместе с архивными: лента показывает и их изменения. */
  fields(projectId: string, entity: FieldEntity): Promise<FieldDefinitionSummary[]>
  /** Участники проекта — только с правом «пользователи і ролі: бачити», иначе 403. */
  members(projectId: string): Promise<MemberSummary[]>
  /**
   * Меняет значения записи: только переданные коды, null — убрать. Ответ — запись целиком,
   * как её отдаёт API сущности (в ней новый `custom`).
   */
  save<T>(
    projectId: string,
    entity: FieldEntity,
    recordId: string,
    custom: CustomValues,
  ): Promise<T>
}

export function createCustomFieldsApi(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): CustomFieldsApi {
  async function send<T>(
    projectId: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers = projectHeaders(projectId)
    if (body !== undefined) headers.set('content-type', 'application/json')
    const res = await fetchImpl(`/api${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as {
        code?: unknown
        details?: unknown
      } | null
      const details =
        typeof payload?.details === 'object' && payload.details !== null
          ? (payload.details as Record<string, unknown>)
          : null
      throw new CustomFieldsApiError(
        res.status,
        typeof payload?.code === 'string' ? payload.code : '',
        details,
      )
    }
    return (await res.json()) as T
  }

  return {
    groups: (projectId, entity) =>
      send(projectId, 'GET', `/v1/field-groups?${new URLSearchParams({ entity })}`),
    fields: (projectId, entity) =>
      send(
        projectId,
        'GET',
        `/v1/fields?${new URLSearchParams({ entity, includeArchived: 'true' })}`,
      ),
    members: (projectId) => send(projectId, 'GET', '/members'),
    save: (projectId, entity, recordId, custom) =>
      send(projectId, 'PUT', `/v1/${ENTITY_PATH[entity]}/${encodeURIComponent(recordId)}`, {
        custom,
      }),
  }
}

const CustomFieldsApiContext = createContext<CustomFieldsApi>(createCustomFieldsApi())

export function CustomFieldsApiProvider({
  api,
  children,
}: {
  api: CustomFieldsApi
  children: ReactNode
}) {
  return <CustomFieldsApiContext value={api}>{children}</CustomFieldsApiContext>
}

export function useCustomFieldsApi(): CustomFieldsApi {
  return use(CustomFieldsApiContext)
}

/** `custom` записи из ответа API; нет или не объект — пусто. */
export function customOf(record: object): CustomValues {
  const custom: unknown = 'custom' in record ? record.custom : undefined
  return typeof custom === 'object' && custom !== null && !Array.isArray(custom)
    ? (custom as CustomValues)
    : {}
}
