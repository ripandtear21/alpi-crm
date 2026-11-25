import type {
  FieldDefinitionSummary,
  FieldEntity,
  FieldGroupSummary,
  FieldOptionSummary,
  FieldPipelines,
  FieldRequirement,
  FieldType,
  PipelineSummary,
  ProjectAccess,
  RoleSummary,
} from '@alpi/shared'
import { projectHeaders } from '../../../components/project-switcher/projects-api.ts'
import type { RoleInput } from '../roles-api.ts'

// Запросы экрана «Налаштування → Поля» (тикет crm-fields/05) к готовому API: группы
// (`/api/v1/field-groups`, apps/api/src/fields/groups.ts), описания полей и варианты
// (`/api/v1/fields`, apps/api/src/fields/fields.ts), права ролей на группы — через запрос ролей
// (`/api/roles`, тикет crm-fields/03), воронки с этапами для правила «з етапу» и права самого
// пользователя (`/api/project/access`). Своих запросов экран не добавляет.

/** Название группы, поля или варианта: украинское обязательно, русское — null, если нет. */
export interface NamesInput {
  nameUk: string
  nameRu: string | null
}

export interface GroupInput extends NamesInput {
  entity: FieldEntity
}

/** Тело создания поля: code не передан — сервер возьмёт его из украинского названия. */
export interface FieldInput extends NamesInput {
  groupId: string
  code?: string
  type: FieldType
  pipelines?: FieldPipelines
  required: FieldRequirement
  isImportant: boolean
  isFrequentlyFiltered: boolean
  options?: NamesInput[]
}

/** Изменение поля: только переданные ключи. */
export type FieldChange = Partial<Omit<FieldInput, 'options'>>

export interface OptionChange {
  nameUk?: string
  nameRu?: string | null
  archived?: boolean
}

export interface FieldsSettingsApi {
  access(projectId: string): Promise<ProjectAccess>
  groups(projectId: string, entity: FieldEntity): Promise<FieldGroupSummary[]>
  /** Описания полей сущности вместе с архивными. */
  fields(projectId: string, entity: FieldEntity): Promise<FieldDefinitionSummary[]>
  /** Одно поле с вариантами — перечитать после частичного сохранения. */
  field(projectId: string, fieldId: string): Promise<FieldDefinitionSummary>
  createGroup(projectId: string, input: GroupInput): Promise<FieldGroupSummary>
  updateGroup(projectId: string, groupId: string, input: NamesInput): Promise<FieldGroupSummary>
  reorderGroups(projectId: string, entity: FieldEntity, ids: string[]): Promise<unknown>
  removeGroup(projectId: string, groupId: string): Promise<void>
  createField(projectId: string, input: FieldInput): Promise<FieldDefinitionSummary>
  updateField(
    projectId: string,
    fieldId: string,
    change: FieldChange,
  ): Promise<FieldDefinitionSummary>
  reorderFields(projectId: string, groupId: string, ids: string[]): Promise<unknown>
  restoreField(projectId: string, fieldId: string): Promise<FieldDefinitionSummary>
  /**
   * Удаление: поле без значений удаляется сразу (null); со значениями — уходит в архив;
   * архивное — окончательно, фоновой задачей (ответ — поле с purgeRequestedAt).
   */
  removeField(projectId: string, fieldId: string): Promise<FieldDefinitionSummary | null>
  createOption(projectId: string, fieldId: string, input: NamesInput): Promise<FieldOptionSummary>
  updateOption(
    projectId: string,
    fieldId: string,
    optionId: string,
    change: OptionChange,
  ): Promise<FieldOptionSummary>
  reorderOptions(projectId: string, fieldId: string, ids: string[]): Promise<FieldOptionSummary[]>
  pipelines(projectId: string): Promise<PipelineSummary[]>
  /** Роли проекта — только с правом «користувачі і ролі», иначе 403. */
  roles(projectId: string): Promise<RoleSummary[]>
  updateRole(projectId: string, roleId: string, input: RoleInput): Promise<RoleSummary>
}

/** Отказ API: код ответа, код ошибки и `details` тела (`path` — поле запроса). */
export class FieldsApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Record<string, unknown> | null

  constructor(status: number, code: string, details: Record<string, unknown> | null = null) {
    super(`API полей ответил ${status} ${code}`)
    this.status = status
    this.code = code
    this.details = details
  }
}

export function createFieldsSettingsApi(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): FieldsSettingsApi {
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
      throw new FieldsApiError(
        res.status,
        typeof payload?.code === 'string' ? payload.code : '',
        details,
      )
    }
    return (res.status === 204 ? null : await res.json()) as T
  }

  return {
    access: (projectId) => send(projectId, 'GET', '/project/access'),
    groups: (projectId, entity) => send(projectId, 'GET', `/v1/field-groups?entity=${entity}`),
    fields: (projectId, entity) =>
      send(projectId, 'GET', `/v1/fields?entity=${entity}&includeArchived=true`),
    field: (projectId, fieldId) => send(projectId, 'GET', `/v1/fields/${fieldId}`),
    createGroup: (projectId, input) => send(projectId, 'POST', '/v1/field-groups', input),
    updateGroup: (projectId, groupId, input) =>
      send(projectId, 'PUT', `/v1/field-groups/${groupId}`, input),
    reorderGroups: (projectId, entity, ids) =>
      send(projectId, 'PUT', '/v1/field-groups/order', { entity, ids }),
    removeGroup: (projectId, groupId) => send(projectId, 'DELETE', `/v1/field-groups/${groupId}`),
    createField: (projectId, input) => send(projectId, 'POST', '/v1/fields', input),
    updateField: (projectId, fieldId, change) =>
      send(projectId, 'PUT', `/v1/fields/${fieldId}`, change),
    reorderFields: (projectId, groupId, ids) =>
      send(projectId, 'PUT', '/v1/fields/order', { groupId, ids }),
    restoreField: (projectId, fieldId) => send(projectId, 'POST', `/v1/fields/${fieldId}/restore`),
    removeField: (projectId, fieldId) => send(projectId, 'DELETE', `/v1/fields/${fieldId}`),
    createOption: (projectId, fieldId, input) =>
      send(projectId, 'POST', `/v1/fields/${fieldId}/options`, input),
    updateOption: (projectId, fieldId, optionId, change) =>
      send(projectId, 'PUT', `/v1/fields/${fieldId}/options/${optionId}`, change),
    reorderOptions: (projectId, fieldId, ids) =>
      send(projectId, 'PUT', `/v1/fields/${fieldId}/options/order`, { ids }),
    pipelines: (projectId) => send(projectId, 'GET', '/v1/pipelines'),
    roles: (projectId) => send(projectId, 'GET', '/roles'),
    updateRole: (projectId, roleId, input) => send(projectId, 'PUT', `/roles/${roleId}`, input),
  }
}
