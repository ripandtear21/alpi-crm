// Формат фильтров списков и канбана (тикет crm-deals/12). Один формат для сервера и клиента:
// клиент строит дерево условий, сервер проверяет его здесь же (parseFilter) и превращает в
// параметризованный SQL (apps/api/src/filters/compile.ts). Поля и операторы — только из
// белых списков ниже: имя поля из запроса никогда не попадает в SQL, значения идут
// параметрами запроса.
//
// Дерево: группа `{ and: [...] }` или `{ or: [...] }`, внутри — условия
// `{ field, op, value }` и вложенные группы. Пример «(этап = Новий лід И создана раньше даты)
// ИЛИ ответственный пуст»:
//   { or: [ { and: [ { field: 'stage', op: 'eq', value: '<uuid>' },
//                    { field: 'createdAt', op: 'lt', value: '2026-11-01T00:00:00.000Z' } ] },
//           { field: 'owner', op: 'empty' } ] }
//
// Пользовательские поля, регистрации и «следующая задача» добавят их эпики — новыми полями в
// FILTER_FIELDS.

/** Списки, у которых есть фильтры. */
export const FILTER_ENTITIES = ['deals', 'contacts', 'organizations'] as const
export type FilterEntity = (typeof FILTER_ENTITIES)[number]

/**
 * Тип поля задаёт операторы и форму значения:
 * - id — uuid записи справочника (воронка, этап, причина, организация);
 * - user — id пользователя или 'me' (тот, кто смотрит список);
 * - enum — одно из `values`;
 * - number — число не меньше нуля;
 * - date — момент времени ISO 8601 с часовым поясом (клиент сам переводит дату в полночь
 *   своего часового пояса);
 * - text — подстрока без учёта регистра;
 * - boolean — да / нет.
 */
export type FilterFieldType = 'id' | 'user' | 'enum' | 'number' | 'date' | 'text' | 'boolean'

export interface FilterFieldSpec {
  type: FilterFieldType
  /** Поле может быть пустым: доступны операторы empty и not_empty. */
  nullable?: boolean
  /** Допустимые значения поля типа enum. */
  values?: readonly string[]
}

export const FILTER_OPERATORS = [
  'eq',
  'neq',
  'in',
  'not_in',
  'lt',
  'lte',
  'gt',
  'gte',
  'contains',
  'empty',
  'not_empty',
] as const
export type FilterOperator = (typeof FILTER_OPERATORS)[number]

/** Операторы без значения. */
export const VALUELESS_OPERATORS: readonly FilterOperator[] = ['empty', 'not_empty']

const OPERATORS_BY_TYPE: Record<FilterFieldType, readonly FilterOperator[]> = {
  id: ['eq', 'neq', 'in', 'not_in'],
  user: ['eq', 'neq', 'in', 'not_in'],
  enum: ['eq', 'neq', 'in', 'not_in'],
  number: ['eq', 'neq', 'lt', 'lte', 'gt', 'gte'],
  date: ['lt', 'lte', 'gt', 'gte'],
  text: ['contains'],
  boolean: ['eq'],
}

/** Операторы поля: по типу, у пустого поля — ещё «пусто» и «не пусто». */
export function operatorsOf(spec: FilterFieldSpec): readonly FilterOperator[] {
  const base = OPERATORS_BY_TYPE[spec.type]
  return spec.nullable ? [...base, 'empty', 'not_empty'] : base
}

/** Системные поля фильтров по спискам. */
export const FILTER_FIELDS = {
  deals: {
    pipeline: { type: 'id' },
    stage: { type: 'id' },
    status: { type: 'enum', values: ['open', 'won', 'lost'] },
    /** Ответственный; пусто — общая очередь («без відповідального»). */
    owner: { type: 'user', nullable: true },
    amount: { type: 'number' },
    currency: { type: 'enum', values: ['EUR', 'UAH', 'USD'] },
    title: { type: 'text' },
    organization: { type: 'id', nullable: true },
    createdAt: { type: 'date' },
    stageChangedAt: { type: 'date' },
    wonAt: { type: 'date', nullable: true },
    lostAt: { type: 'date', nullable: true },
    lostReason: { type: 'id', nullable: true },
    /** Архив; без условия на него архивные сделки скрыты. */
    archived: { type: 'boolean' },
  },
  contacts: {
    name: { type: 'text' },
    language: { type: 'enum', values: ['uk', 'ru'], nullable: true },
    organization: { type: 'id', nullable: true },
    possibleDuplicate: { type: 'boolean' },
    createdBy: { type: 'user', nullable: true },
    createdAt: { type: 'date' },
    updatedAt: { type: 'date' },
  },
  organizations: {
    name: { type: 'text' },
    address: { type: 'text', nullable: true },
    website: { type: 'text', nullable: true },
    createdBy: { type: 'user', nullable: true },
    createdAt: { type: 'date' },
    updatedAt: { type: 'date' },
  },
} as const satisfies Record<FilterEntity, Record<string, FilterFieldSpec>>

export type FilterField<E extends FilterEntity> = keyof (typeof FILTER_FIELDS)[E] & string

export type FilterValue = string | number | boolean | readonly string[]

export interface FilterCondition {
  field: string
  op: FilterOperator
  /** Нет у empty / not_empty; список — у in / not_in. */
  value?: FilterValue
}

export type FilterGroup = { and: FilterNode[] } | { or: FilterNode[] }
export type FilterNode = FilterCondition | FilterGroup

/** Пустой фильтр: все записи (архивные сделки скрыты). */
export const EMPTY_FILTER: FilterGroup = { and: [] }

/** Пределы фильтра: защита базы от огромных запросов. */
export const FILTER_LIMITS = {
  /** Глубина вложенности групп (корень — 1). */
  depth: 3,
  /** Условий во всём дереве. */
  conditions: 50,
  /** Значений в списке in / not_in. */
  listValues: 200,
  /** Длина текстового значения. */
  text: 200,
  /** Наибольшее число (сумма сделки — numeric(14, 2)). */
  number: 999_999_999_999,
} as const

export interface FilterError {
  path: string
  message: string
}

export type FilterParseResult =
  | { ok: true; filter: FilterGroup }
  | { ok: false; error: FilterError }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/
const MAX_USER_ID = 100

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isFilterGroup(node: FilterNode): node is FilterGroup {
  return 'and' in node || 'or' in node
}

/** Условия группы и её связка. */
export function groupParts(group: FilterGroup): { op: 'and' | 'or'; items: FilterNode[] } {
  return 'and' in group ? { op: 'and', items: group.and } : { op: 'or', items: group.or }
}

/** Есть ли в дереве условие на поле `field`. */
export function mentionsField(node: FilterNode, field: string): boolean {
  if (!isFilterGroup(node)) return node.field === field
  return groupParts(node).items.some((item) => mentionsField(item, field))
}

/** Одиночное значение поля типа `spec`: null — не годится. */
function readScalar(spec: FilterFieldSpec, value: unknown): string | number | boolean | null {
  switch (spec.type) {
    case 'id':
      return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null
    case 'user':
      return typeof value === 'string' && value !== '' && value.length <= MAX_USER_ID ? value : null
    case 'enum':
      return typeof value === 'string' && (spec.values ?? []).includes(value) ? value : null
    case 'number':
      return typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= FILTER_LIMITS.number
        ? value
        : null
    case 'date': {
      if (typeof value !== 'string' || !ISO_TIME.test(value)) return null
      return Number.isNaN(new Date(value).getTime()) ? null : value
    }
    case 'text': {
      if (typeof value !== 'string') return null
      const text = value.trim()
      return text !== '' && text.length <= FILTER_LIMITS.text ? text : null
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : null
  }
}

/**
 * Проверяет фильтр списка `entity`, пришедший снаружи (параметр запроса, тело, сохранённый
 * фильтр), и приводит к единому виду: id в нижнем регистре, текст без пробелов по краям,
 * списки без повторов. Неизвестное поле, оператор не своего типа или значение не той формы —
 * ошибка с путём, а не молча отброшенное условие.
 */
export function parseFilter(entity: FilterEntity, input: unknown): FilterParseResult {
  const fields: Record<string, FilterFieldSpec> = FILTER_FIELDS[entity]
  let conditions = 0
  let error: FilterError | null = null
  const fail = (path: string, message: string) => {
    error ??= { path, message }
    return null
  }

  function node(value: unknown, path: string, depth: number): FilterNode | null {
    if (!isPlainObject(value)) return fail(path, 'ожидается условие или группа')
    if ('and' in value || 'or' in value) return group(value, path, depth)
    return condition(value, path)
  }

  function group(value: Record<string, unknown>, path: string, depth: number): FilterGroup | null {
    const keys = Object.keys(value)
    const op = keys[0]
    if (keys.length !== 1 || (op !== 'and' && op !== 'or')) {
      return fail(path, 'группа — ровно одно поле and или or')
    }
    if (depth > FILTER_LIMITS.depth) return fail(path, 'слишком глубокая вложенность групп')
    const items = value[op]
    if (!Array.isArray(items)) return fail(`${path}.${op}`, 'ожидается список')
    const parsed: FilterNode[] = []
    for (const [index, item] of items.entries()) {
      const child = node(item, `${path}.${op}.${index}`, depth + 1)
      if (!child) return null
      parsed.push(child)
    }
    return op === 'and' ? { and: parsed } : { or: parsed }
  }

  function condition(value: Record<string, unknown>, path: string): FilterCondition | null {
    for (const key of Object.keys(value)) {
      if (key !== 'field' && key !== 'op' && key !== 'value') {
        return fail(`${path}.${key}`, 'неизвестное поле условия')
      }
    }
    conditions += 1
    if (conditions > FILTER_LIMITS.conditions) return fail(path, 'слишком много условий')
    const { field, op } = value
    if (typeof field !== 'string' || !Object.hasOwn(fields, field)) {
      return fail(`${path}.field`, 'неизвестное поле')
    }
    const spec = fields[field] as FilterFieldSpec
    if (typeof op !== 'string' || !operatorsOf(spec).includes(op as FilterOperator)) {
      return fail(`${path}.op`, 'оператор не подходит к полю')
    }
    const operator = op as FilterOperator
    if (VALUELESS_OPERATORS.includes(operator)) {
      if (value.value !== undefined) return fail(`${path}.value`, 'у оператора нет значения')
      return { field, op: operator }
    }
    if (operator === 'in' || operator === 'not_in') {
      const list = value.value
      if (!Array.isArray(list) || list.length === 0 || list.length > FILTER_LIMITS.listValues) {
        return fail(`${path}.value`, 'ожидается непустой список значений')
      }
      const read: string[] = []
      for (const item of list) {
        const scalar = readScalar(spec, item)
        if (typeof scalar !== 'string') return fail(`${path}.value`, 'значение не той формы')
        read.push(scalar)
      }
      return { field, op: operator, value: [...new Set(read)] }
    }
    const scalar = readScalar(spec, value.value)
    if (scalar === null) return fail(`${path}.value`, 'значение не той формы')
    return { field, op: operator, value: scalar }
  }

  if (!isPlainObject(input)) return { ok: false, error: { path: '', message: 'ожидается группа' } }
  const root = group(input, '', 1)
  if (!root) {
    return { ok: false, error: error ?? { path: '', message: 'ожидается группа' } }
  }
  return { ok: true, filter: root }
}

// ---- Колонки и сортировка списков -------------------------------------------------------------

/** Колонки списков: ключ — для выбора колонок, сортировки и выгрузки CSV. */
export const LIST_COLUMNS = {
  deals: [
    'title',
    'pipeline',
    'stage',
    'status',
    'amount',
    'currency',
    'owner',
    'contact',
    'organization',
    'createdAt',
    'stageChangedAt',
    'wonAt',
    'lostAt',
    'lostReason',
    'archivedAt',
  ],
  contacts: [
    'name',
    'phone',
    'email',
    'organization',
    'language',
    'possibleDuplicate',
    'createdAt',
    'updatedAt',
  ],
  organizations: ['name', 'address', 'website', 'createdAt', 'updatedAt'],
} as const satisfies Record<FilterEntity, readonly string[]>

export type ListColumn<E extends FilterEntity> = (typeof LIST_COLUMNS)[E][number]

/** Колонки по умолчанию, пока пользователь не выбрал свои. */
export const DEFAULT_LIST_COLUMNS: { [E in FilterEntity]: readonly ListColumn<E>[] } = {
  deals: ['title', 'stage', 'status', 'amount', 'owner', 'contact', 'createdAt'],
  contacts: ['name', 'phone', 'email', 'organization', 'createdAt'],
  organizations: ['name', 'address', 'website', 'createdAt'],
}

/**
 * Колонки, по которым список сортируется. Только непустые столбцы: курсор (значение и id
 * последней строки) у них однозначен.
 */
export const SORTABLE_COLUMNS = {
  deals: ['title', 'amount', 'createdAt', 'stageChangedAt'],
  contacts: ['name', 'createdAt', 'updatedAt'],
  organizations: ['name', 'createdAt', 'updatedAt'],
} as const satisfies { [E in FilterEntity]: readonly ListColumn<E>[] }

export type SortableColumn<E extends FilterEntity> = (typeof SORTABLE_COLUMNS)[E][number]
export type SortDirection = 'asc' | 'desc'

export interface ListSort<E extends FilterEntity> {
  column: SortableColumn<E>
  direction: SortDirection
}

/** Сортировка из параметра `sort=<колонка>:<asc|desc>`; null — не годится. */
export function parseSort<E extends FilterEntity>(entity: E, raw: string): ListSort<E> | null {
  const [column, direction, ...rest] = raw.split(':')
  if (rest.length > 0 || (direction !== 'asc' && direction !== 'desc')) return null
  const columns: readonly string[] = SORTABLE_COLUMNS[entity]
  if (column === undefined || !columns.includes(column)) return null
  return { column: column as SortableColumn<E>, direction }
}

/**
 * Счётчик результатов: до порога — точное число, выше — оценка базы (`approximate: true`,
 * интерфейс показывает «≈»).
 */
export interface ListCount {
  count: number
  approximate: boolean
}

/** До скольких строк счётчик точный. */
export const EXACT_COUNT_LIMIT = 10_000

// ---- Сохранённые фильтры ----------------------------------------------------------------------

/** Кто видит сохранённый фильтр: только автор, команда автора, весь проект. */
export const SAVED_FILTER_VISIBILITIES = ['personal', 'team', 'project'] as const
export type SavedFilterVisibility = (typeof SAVED_FILTER_VISIBILITIES)[number]

/** Сохранённый фильтр в ответах API (`GET /v1/saved-filters`). */
export interface SavedFilterSummary {
  id: string
  entity: FilterEntity
  name: string
  visibility: SavedFilterVisibility
  /** Команда фильтра с видимостью team. */
  teamId: string | null
  ownerId: string
  filter: FilterGroup
  /** Может ли пользователь удалить фильтр. */
  canDelete: boolean
  createdAt: string
}
