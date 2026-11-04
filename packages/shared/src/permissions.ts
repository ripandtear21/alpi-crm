// Права ролей проекта (.scratch/crm-mvp/spec.md, раздел 4; решение карты
// .scratch/crm-mvp/issues/07-roles-and-visibility.md). Общий каталог сервера и клиента:
// сервер проверяет по нему запросы, клиент строит таблицу галочек редактора ролей.
//
// Права роли хранятся в базе одним JSONB (`role.permissions`) в форме `RolePermissions`.
// Перед записью их проверяет `parseRolePermissions`: неизвестная часть системы, действие или
// охват — ошибка, а не молча сохранённый мусор.

/** Части системы — строки таблицы прав. */
export const RESOURCES = [
  'deals',
  'contacts',
  'organizations',
  'tasks',
  'payments',
  'products',
  'reports',
  'pipelines',
  'fields',
  'users_roles',
  'integrations',
  'trash',
] as const
export type Resource = (typeof RESOURCES)[number]

/**
 * Действия — столбцы таблицы прав. В корзине «изменять» — восстановить запись, «удалять» —
 * удалить окончательно.
 */
export const ACTIONS = ['view', 'create', 'edit', 'delete'] as const
export type Action = (typeof ACTIONS)[number]

/** Части системы с охватом: у их записей есть ответственный. */
export const SCOPED_RESOURCES = ['deals', 'contacts', 'tasks', 'payments'] as const
export type ScopedResource = (typeof SCOPED_RESOURCES)[number]

/**
 * Охват: только свои записи (пользователь — ответственный), записи своей команды
 * (ответственный — из команды пользователя), все записи проекта.
 */
export const SCOPES = ['own', 'team', 'all'] as const
export type Scope = (typeof SCOPES)[number]

/**
 * Охват задаётся отдельно для чтения и для изменения («видеть всё, менять только свои»).
 * `write` действует на изменение и удаление.
 */
export interface ResourceScope {
  read: Scope
  write: Scope
}

/** Отдельные права — вне таблицы «часть системы × действие». */
export const STANDALONE_PERMISSIONS = [
  'export',
  'bulk_operations',
  'transfer_deals',
  'project_settings',
] as const
export type StandalonePermission = (typeof STANDALONE_PERMISSIONS)[number]

/** Доступ к группе пользовательских полей: видно и можно менять / только чтение / скрыто. */
export const FIELD_GROUP_ACCESS = ['edit', 'read', 'hidden'] as const
export type FieldGroupAccess = (typeof FIELD_GROUP_ACCESS)[number]

/** Права роли — то, что лежит в `role.permissions`. */
export interface RolePermissions {
  /** Разрешённые действия по каждой части системы (в порядке ACTIONS). */
  actions: Record<Resource, Action[]>
  /** Охват по частям системы с ответственным. */
  scopes: Record<ScopedResource, ResourceScope>
  /** Включённые отдельные права (в порядке STANDALONE_PERMISSIONS). */
  standalone: StandalonePermission[]
  /**
   * Права на группы полей: id группы → доступ. Место зарезервировано: группы полей появятся
   * с пользовательскими полями, до тех пор объект пустой. Группа без записи — по правам
   * части системы.
   */
  fieldGroups: Record<string, FieldGroupAccess>
}

/** Шаблоны ролей, которые создаются в каждом новом проекте. */
export const ROLE_TEMPLATE_KEYS = ['admin', 'head', 'teamlead', 'manager'] as const
export type RoleTemplateKey = (typeof ROLE_TEMPLATE_KEYS)[number]

function includes<T extends string>(list: readonly T[], value: unknown): value is T {
  return list.some((item) => item === value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Ошибка формы прав: что именно не так, для ответа API 400. */
export interface PermissionsError {
  path: string
  message: string
}

export type ParseResult =
  | { ok: true; permissions: RolePermissions }
  | { ok: false; error: PermissionsError }

/**
 * Проверяет права роли, пришедшие снаружи (тело запроса, JSONB из базы), и приводит их к
 * единому виду: все части системы и охваты на месте, списки — в порядке каталога, без
 * повторов. Отсутствующая часть системы — без действий; отсутствующий охват — «свои».
 *
 * Любое действие, кроме «смотреть», требует «смотреть»: менять то, чего не видишь, нельзя.
 */
export function parseRolePermissions(input: unknown): ParseResult {
  const fail = (path: string, message: string): ParseResult => ({
    ok: false,
    error: { path, message },
  })
  if (!isPlainObject(input)) return fail('', 'ожидается объект')

  const known = ['actions', 'scopes', 'standalone', 'fieldGroups']
  for (const key of Object.keys(input)) {
    if (!known.includes(key)) return fail(key, 'неизвестное поле')
  }

  const rawActions = input.actions ?? {}
  if (!isPlainObject(rawActions)) return fail('actions', 'ожидается объект')
  for (const key of Object.keys(rawActions)) {
    if (!includes(RESOURCES, key)) return fail(`actions.${key}`, 'неизвестная часть системы')
  }
  const actions = {} as Record<Resource, Action[]>
  for (const resource of RESOURCES) {
    const list = rawActions[resource] ?? []
    if (!Array.isArray(list)) return fail(`actions.${resource}`, 'ожидается список')
    for (const action of list) {
      if (!includes(ACTIONS, action)) {
        return fail(`actions.${resource}`, `неизвестное действие ${JSON.stringify(action)}`)
      }
    }
    const set = new Set<unknown>(list)
    actions[resource] = ACTIONS.filter((action) => set.has(action))
    if (actions[resource].length > 0 && !set.has('view')) {
      return fail(`actions.${resource}`, 'действие без «смотреть»')
    }
  }

  const rawScopes = input.scopes ?? {}
  if (!isPlainObject(rawScopes)) return fail('scopes', 'ожидается объект')
  for (const key of Object.keys(rawScopes)) {
    if (!includes(SCOPED_RESOURCES, key)) return fail(`scopes.${key}`, 'у этой части нет охвата')
  }
  const scopes = {} as Record<ScopedResource, ResourceScope>
  for (const resource of SCOPED_RESOURCES) {
    const raw = rawScopes[resource] ?? {}
    if (!isPlainObject(raw)) return fail(`scopes.${resource}`, 'ожидается объект')
    for (const key of Object.keys(raw)) {
      if (key !== 'read' && key !== 'write')
        return fail(`scopes.${resource}.${key}`, 'неизвестное поле')
    }
    const read = raw.read ?? 'own'
    const write = raw.write ?? 'own'
    if (!includes(SCOPES, read)) return fail(`scopes.${resource}.read`, 'неизвестный охват')
    if (!includes(SCOPES, write)) return fail(`scopes.${resource}.write`, 'неизвестный охват')
    scopes[resource] = { read, write }
  }

  const rawStandalone = input.standalone ?? []
  if (!Array.isArray(rawStandalone)) return fail('standalone', 'ожидается список')
  for (const permission of rawStandalone) {
    if (!includes(STANDALONE_PERMISSIONS, permission)) {
      return fail('standalone', `неизвестное право ${JSON.stringify(permission)}`)
    }
  }
  const standaloneSet = new Set<unknown>(rawStandalone)
  const standalone = STANDALONE_PERMISSIONS.filter((p) => standaloneSet.has(p))

  const rawFieldGroups = input.fieldGroups ?? {}
  if (!isPlainObject(rawFieldGroups)) return fail('fieldGroups', 'ожидается объект')
  const fieldGroups: Record<string, FieldGroupAccess> = {}
  for (const [group, access] of Object.entries(rawFieldGroups)) {
    if (!includes(FIELD_GROUP_ACCESS, access)) {
      return fail(`fieldGroups.${group}`, 'неизвестный доступ')
    }
    fieldGroups[group] = access
  }

  return { ok: true, permissions: { actions, scopes, standalone, fieldGroups } }
}

/** Все права: так действует роль «администратор», что бы ни лежало в её строке. */
export function fullPermissions(): RolePermissions {
  return {
    actions: Object.fromEntries(RESOURCES.map((r) => [r, [...ACTIONS]])) as Record<
      Resource,
      Action[]
    >,
    scopes: Object.fromEntries(
      SCOPED_RESOURCES.map((r) => [r, { read: 'all', write: 'all' }]),
    ) as Record<ScopedResource, ResourceScope>,
    standalone: [...STANDALONE_PERMISSIONS],
    fieldGroups: {},
  }
}

/** Разрешено ли действие с частью системы. */
export function can(permissions: RolePermissions, resource: Resource, action: Action): boolean {
  return permissions.actions[resource].includes(action)
}

/** Включено ли отдельное право. */
export function hasStandalone(
  permissions: RolePermissions,
  permission: StandalonePermission,
): boolean {
  return permissions.standalone.includes(permission)
}

const VIEW_CREATE_EDIT: Action[] = ['view', 'create', 'edit']
const ALL_ACTIONS: Action[] = [...ACTIONS]

function scoped(read: Scope, write: Scope = read): Record<ScopedResource, ResourceScope> {
  return Object.fromEntries(SCOPED_RESOURCES.map((r) => [r, { read, write }])) as Record<
    ScopedResource,
    ResourceScope
  >
}

function actionsOf(partial: Partial<Record<Resource, Action[]>>): Record<Resource, Action[]> {
  return Object.fromEntries(RESOURCES.map((r) => [r, partial[r] ?? []])) as Record<
    Resource,
    Action[]
  >
}

export interface RoleTemplate {
  key: RoleTemplateKey
  /** Название роли при создании проекта (uk); интерфейс показывает перевод по `key`. */
  name: string
  permissions: RolePermissions
}

/**
 * Шаблоны ролей (spec.md, раздел 4, таблица шаблонов). Решено с владельцем: выгрузка только у
 * администратора; удаление и массовые операции — у администратора и руководителя. Остальное —
 * допущение спецификации.
 *
 * Миграция базы хранит свой снимок этих значений (миграция не должна меняться вместе с кодом);
 * тест apps/api/src/roles/roles.test.ts сверяет роли нового проекта с этим списком.
 */
export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  { key: 'admin', name: 'Адміністратор', permissions: fullPermissions() },
  {
    key: 'head',
    name: 'Керівник',
    permissions: {
      actions: actionsOf({
        deals: ALL_ACTIONS,
        contacts: ALL_ACTIONS,
        tasks: ALL_ACTIONS,
        payments: ALL_ACTIONS,
        organizations: ALL_ACTIONS,
        products: ['view'],
        reports: ['view'],
        trash: ['view', 'edit'],
      }),
      scopes: scoped('all'),
      standalone: ['bulk_operations', 'transfer_deals'],
      fieldGroups: {},
    },
  },
  {
    key: 'teamlead',
    name: 'Тімлід',
    permissions: {
      actions: actionsOf({
        deals: VIEW_CREATE_EDIT,
        contacts: VIEW_CREATE_EDIT,
        tasks: VIEW_CREATE_EDIT,
        payments: VIEW_CREATE_EDIT,
        organizations: VIEW_CREATE_EDIT,
        products: ['view'],
        reports: ['view'],
      }),
      scopes: scoped('team'),
      // Передача — в пределах охвата «команда»: чужие сделки тимлид не видит и не меняет.
      standalone: ['transfer_deals'],
      fieldGroups: {},
    },
  },
  {
    key: 'manager',
    name: 'Менеджер',
    permissions: {
      actions: actionsOf({
        deals: VIEW_CREATE_EDIT,
        contacts: VIEW_CREATE_EDIT,
        tasks: VIEW_CREATE_EDIT,
        payments: VIEW_CREATE_EDIT,
        organizations: VIEW_CREATE_EDIT,
        products: ['view'],
      }),
      scopes: scoped('own'),
      standalone: [],
      fieldGroups: {},
    },
  },
]

/** Роль в ответах API (`GET /roles`). */
export interface RoleSummary {
  id: string
  name: string
  /** Шаблон-источник; null — роль, созданная пользователем. */
  templateKey: RoleTemplateKey | null
  /** Роль «администратор»: не удаляется и не меняется, действует со всеми правами. */
  isAdmin: boolean
  permissions: RolePermissions
  /** Сколько участников проекта с этой ролью. */
  memberCount: number
}

/** Коды ошибок API ролей. */
export type RolesErrorCode =
  | 'PERMISSION_DENIED'
  | 'INVALID_ROLE'
  | 'ROLE_NOT_FOUND'
  | 'ROLE_NAME_TAKEN'
  | 'ADMIN_ROLE_LOCKED'
  | 'ROLE_IN_USE'
  | 'LAST_ADMIN'
  | 'MEMBER_NOT_FOUND'
