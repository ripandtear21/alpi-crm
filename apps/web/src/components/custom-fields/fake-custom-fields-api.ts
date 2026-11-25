import {
  type FieldDefinitionSummary,
  type FieldEntity,
  type FieldGroupSummary,
  type MemberSummary,
  normalizeFieldValue,
} from '@alpi/shared'
import {
  type CustomFieldsApi,
  CustomFieldsApiError,
  type CustomValues,
} from './custom-fields-api.tsx'

// Подставной клиент пользовательских полей для тестов: группы, описания и участники в памяти;
// правка проверяет значение той же normalizeFieldValue, что и сервер (422 CUSTOM_FIELD_INVALID
// с причиной), и меняет `custom` записи, которую отдаёт `record` (запись подставного API карточки).
// `saves` — какие правки ушли; `failNext` — отказ на следующую правку.

let counter = 0
function fakeId(): string {
  counter += 1
  return `00000000-0000-4000-9400-${String(counter).padStart(12, '0')}`
}

/** Группа полей: по умолчанию — группа сделки «Анкета» на первом месте. */
export function fieldGroup(overrides: Partial<FieldGroupSummary> = {}): FieldGroupSummary {
  return {
    id: fakeId(),
    entity: 'deal',
    position: 1,
    nameUk: 'Анкета',
    nameRu: null,
    ...overrides,
  }
}

/** Описание поля: по умолчанию текстовое поле сделки, видимое во всех воронках. */
export function fieldDef(
  overrides: Partial<FieldDefinitionSummary> & Pick<FieldDefinitionSummary, 'groupId' | 'code'>,
): FieldDefinitionSummary {
  return {
    id: fakeId(),
    entity: 'deal',
    type: 'text',
    position: 1,
    nameUk: overrides.code,
    nameRu: null,
    pipelines: 'all',
    required: { mode: 'none' },
    isImportant: false,
    isFrequentlyFiltered: false,
    firstValueAt: null,
    convertingTo: null,
    archivedAt: null,
    purgeRequestedAt: null,
    options: [],
    ...overrides,
  }
}

export interface FakeCustomFieldsApi extends CustomFieldsApi {
  groupList: FieldGroupSummary[]
  fieldList: FieldDefinitionSummary[]
  /** null — список участников отвечает 403 (нет права «пользователи и роли»). */
  memberList: MemberSummary[] | null
  saves: { entity: FieldEntity; id: string; custom: CustomValues }[]
  failNext: CustomFieldsApiError | null
}

export function fakeCustomFieldsApi({
  groups = [],
  fields = [],
  members = [],
  record = () => undefined,
}: {
  groups?: FieldGroupSummary[]
  fields?: FieldDefinitionSummary[]
  members?: MemberSummary[] | null
  /** Запись сущности по id: её `custom` меняет правка. */
  record?: (entity: FieldEntity, id: string) => { custom: CustomValues } | undefined
} = {}): FakeCustomFieldsApi {
  const api: FakeCustomFieldsApi = {
    groupList: groups,
    fieldList: fields,
    memberList: members,
    saves: [],
    failNext: null,
    groups: async (_projectId, entity) =>
      structuredClone(api.groupList.filter((group) => group.entity === entity)),
    fields: async (_projectId, entity) =>
      structuredClone(api.fieldList.filter((field) => field.entity === entity)),
    members: async () => {
      if (api.memberList === null) throw new CustomFieldsApiError(403, 'PERMISSION_DENIED')
      return structuredClone(api.memberList)
    },
    save: async <T>(_projectId: string, entity: FieldEntity, id: string, custom: CustomValues) => {
      api.saves.push({ entity, id, custom: structuredClone(custom) })
      const failure = api.failNext
      if (failure) {
        api.failNext = null
        throw failure
      }
      const found = record(entity, id)
      if (!found) throw new CustomFieldsApiError(404, 'NOT_FOUND')
      const users = new Map(
        (api.memberList ?? []).map((member) => [member.userId, { disabled: member.disabled }]),
      )
      for (const [code, raw] of Object.entries(custom)) {
        const field = api.fieldList.find(
          (item) => item.entity === entity && item.code === code && item.archivedAt === null,
        )
        if (!field) throw new CustomFieldsApiError(422, 'CUSTOM_FIELD_UNKNOWN', { field: code })
        const result = normalizeFieldValue(field, raw, { users, previous: found.custom[code] })
        if (!result.ok) {
          throw new CustomFieldsApiError(422, 'CUSTOM_FIELD_INVALID', {
            field: code,
            reason: result.problem,
          })
        }
        if (result.value === null) delete found.custom[code]
        else found.custom[code] = result.value
      }
      return structuredClone(found) as T
    },
  }
  return api
}
