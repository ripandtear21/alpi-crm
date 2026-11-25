import {
  type FieldDefinitionSummary,
  type FieldGroupSummary,
  type FieldOptionSummary,
  fieldCodeFromName,
  fullPermissions,
  type PipelineSummary,
  ROLE_TEMPLATES,
  type RolePermissions,
  type RoleSummary,
} from '@alpi/shared'
import { FieldsApiError, type FieldsSettingsApi } from './fields-api.ts'

// Подставной клиент экрана полей для тестов: группы, поля, воронки и роли в памяти, изменения
// записываются в `calls`; `failNext` — следующее изменение отвечает этой ошибкой.

export const fakeId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

export const PIPELINE_ALPI: PipelineSummary = {
  id: fakeId(900),
  code: 'alpi',
  name: 'ALPI',
  position: 1,
  isUpsell: false,
  archivedAt: null,
  stages: [
    { id: fakeId(901), pipelineId: fakeId(900), name: 'Новий лід', position: 1 },
    { id: fakeId(902), pipelineId: fakeId(900), name: '!Приймає рішення', position: 2 },
    { id: fakeId(903), pipelineId: fakeId(900), name: 'Оплата', position: 3 },
  ],
}

export const GROUP_MAIN: FieldGroupSummary = {
  id: fakeId(100),
  entity: 'deal',
  nameUk: 'Основні',
  nameRu: 'Основные',
  position: 1,
}

export function fakeField(
  overrides: Partial<FieldDefinitionSummary> & Pick<FieldDefinitionSummary, 'id' | 'nameUk'>,
): FieldDefinitionSummary {
  return {
    entity: 'deal',
    groupId: GROUP_MAIN.id,
    code: fieldCodeFromName(overrides.nameUk),
    nameRu: null,
    type: 'text',
    position: 1,
    pipelines: 'all',
    required: { mode: 'none' },
    isImportant: false,
    isFrequentlyFiltered: false,
    firstValueAt: null,
    convertingTo: null,
    archivedAt: null,
    purgeRequestedAt: null,
    options: [],
    indexState: null,
    indexError: null,
    ...overrides,
  }
}

export interface FakeCall {
  method: keyof FieldsSettingsApi
  args: unknown[]
}

export interface FakeFieldsApi extends FieldsSettingsApi {
  calls: FakeCall[]
  groupList: FieldGroupSummary[]
  fieldList: FieldDefinitionSummary[]
  roleList: RoleSummary[]
  failNext: FieldsApiError | null
}

export function fakeFieldsApi({
  permissions = fullPermissions(),
  groups = [GROUP_MAIN],
  fields = [],
  denyRoles = false,
}: {
  permissions?: RolePermissions
  groups?: FieldGroupSummary[]
  fields?: FieldDefinitionSummary[]
  denyRoles?: boolean
} = {}): FakeFieldsApi {
  let nextId = 1000
  const clone = <T>(value: T): T => structuredClone(value)

  function record(method: keyof FieldsSettingsApi, ...args: unknown[]) {
    api.calls.push({ method, args: clone(args) })
    const failure = api.failNext
    if (failure) {
      api.failNext = null
      throw failure
    }
  }

  function field(id: string): FieldDefinitionSummary {
    const found = api.fieldList.find((f) => f.id === id)
    if (!found) throw new FieldsApiError(404, 'NOT_FOUND')
    return found
  }

  const option = (nameUk: string, nameRu: string | null, position: number): FieldOptionSummary => ({
    id: fakeId(nextId++),
    nameUk,
    nameRu,
    position,
    archivedAt: null,
  })

  const api: FakeFieldsApi = {
    calls: [],
    groupList: clone(groups),
    fieldList: clone(fields),
    roleList: ROLE_TEMPLATES.map((template, index) => ({
      id: fakeId(index + 1),
      name: template.name,
      templateKey: template.key,
      isAdmin: template.key === 'admin',
      permissions: clone(template.permissions),
      memberCount: 1,
    })),
    failNext: null,
    async access() {
      return { userId: fakeId(1), permissions: clone(permissions) }
    },
    async groups(_projectId, entity) {
      return clone(
        api.groupList.filter((g) => g.entity === entity).sort((a, b) => a.position - b.position),
      )
    },
    async fields(_projectId, entity) {
      return clone(api.fieldList.filter((f) => f.entity === entity))
    },
    async createGroup(projectId, input) {
      record('createGroup', projectId, input)
      const group: FieldGroupSummary = {
        id: fakeId(nextId++),
        ...input,
        position: api.groupList.filter((g) => g.entity === input.entity).length + 1,
      }
      api.groupList.push(group)
      return clone(group)
    },
    async updateGroup(projectId, groupId, input) {
      record('updateGroup', projectId, groupId, input)
      api.groupList = api.groupList.map((g) => (g.id === groupId ? { ...g, ...input } : g))
      return clone(api.groupList.find((g) => g.id === groupId) as FieldGroupSummary)
    },
    async reorderGroups(projectId, entity, ids) {
      record('reorderGroups', projectId, entity, ids)
      for (const g of api.groupList) {
        if (ids.includes(g.id)) g.position = ids.indexOf(g.id) + 1
      }
      return null
    },
    async removeGroup(projectId, groupId) {
      record('removeGroup', projectId, groupId)
      api.groupList = api.groupList.filter((g) => g.id !== groupId)
    },
    async createField(projectId, input) {
      record('createField', projectId, input)
      const group = api.groupList.find((g) => g.id === input.groupId)
      if (!group) throw new FieldsApiError(422, 'FIELD_GROUP_NOT_FOUND', { path: 'groupId' })
      const created = fakeField({
        id: fakeId(nextId++),
        entity: group.entity,
        groupId: group.id,
        nameUk: input.nameUk,
        nameRu: input.nameRu,
        code: input.code ?? fieldCodeFromName(input.nameUk),
        type: input.type,
        position: api.fieldList.filter((f) => f.groupId === group.id).length + 1,
        pipelines: input.pipelines ?? 'all',
        required: input.required,
        isImportant: input.isImportant,
        isFrequentlyFiltered: input.isFrequentlyFiltered,
        indexState: input.isFrequentlyFiltered ? 'building' : null,
        options: (input.options ?? []).map((o, index) => option(o.nameUk, o.nameRu, index + 1)),
      })
      api.fieldList.push(created)
      return clone(created)
    },
    async updateField(projectId, fieldId, change) {
      record('updateField', projectId, fieldId, change)
      Object.assign(field(fieldId), change)
      return clone(field(fieldId))
    },
    async reorderFields(projectId, groupId, ids) {
      record('reorderFields', projectId, groupId, ids)
      for (const f of api.fieldList) {
        if (ids.includes(f.id)) f.position = ids.indexOf(f.id) + 1
      }
      return null
    },
    async restoreField(projectId, fieldId) {
      record('restoreField', projectId, fieldId)
      field(fieldId).archivedAt = null
      return clone(field(fieldId))
    },
    async removeField(projectId, fieldId) {
      record('removeField', projectId, fieldId)
      const target = field(fieldId)
      if (target.firstValueAt === null) {
        api.fieldList = api.fieldList.filter((f) => f.id !== fieldId)
        return null
      }
      if (target.archivedAt === null) target.archivedAt = new Date().toISOString()
      else target.purgeRequestedAt = new Date().toISOString()
      return clone(target)
    },
    async createOption(projectId, fieldId, input) {
      record('createOption', projectId, fieldId, input)
      const target = field(fieldId)
      const created = option(input.nameUk, input.nameRu, target.options.length + 1)
      target.options.push(created)
      return clone(created)
    },
    async updateOption(projectId, fieldId, optionId, change) {
      record('updateOption', projectId, fieldId, optionId, change)
      const target = field(fieldId).options.find((o) => o.id === optionId)
      if (!target) throw new FieldsApiError(404, 'NOT_FOUND')
      if (change.nameUk !== undefined) target.nameUk = change.nameUk
      if (change.nameRu !== undefined) target.nameRu = change.nameRu
      if (change.archived !== undefined) {
        target.archivedAt = change.archived ? new Date().toISOString() : null
      }
      return clone(target)
    },
    async reorderOptions(projectId, fieldId, ids) {
      record('reorderOptions', projectId, fieldId, ids)
      const target = field(fieldId)
      target.options = ids.map((id, index) => ({
        ...(target.options.find((o) => o.id === id) as FieldOptionSummary),
        position: index + 1,
      }))
      return clone(target.options)
    },
    async pipelines() {
      return [clone(PIPELINE_ALPI)]
    },
    async roles() {
      if (denyRoles) throw new FieldsApiError(403, 'PERMISSION_DENIED')
      return clone(api.roleList)
    },
    async updateRole(projectId, roleId, input) {
      record('updateRole', projectId, roleId, input)
      api.roleList = api.roleList.map((r) => (r.id === roleId ? { ...r, ...input } : r))
      return clone(api.roleList.find((r) => r.id === roleId) as RoleSummary)
    },
  }
  return api
}
