import {
  type FilterCondition,
  type FilterEntity,
  type FilterGroup,
  type FilterNode,
  groupParts,
  isFilterGroup,
  mentionsField,
  parseCustomRef,
  parseFilter,
} from '@alpi/shared'
import { type RawBuilder, type SqlBool, sql } from 'kysely'
import { likePattern } from '../contacts/http.ts'
import { type CatalogField, compileCustomCondition, meOf, type RecordTable } from './custom.ts'

// Построитель условий фильтра (тикет crm-deals/12): дерево формата packages/shared/src/filters
// → условие WHERE. Одна функция на список, канбан, счётчик, выгрузку и массовые действия.
//
// Безопасность: имя поля из запроса в SQL не попадает никогда — поле ищется в белом списке
// FIELD_SQL, и в запрос идёт столбец, записанный здесь в коде. Оператор — тоже из белого
// списка: каждый оператор — своя ветка switch с готовым текстом SQL. Значения — только
// параметрами запроса ($1, $2…), с явным приведением типа. sql.raw здесь не используется.
// Пользовательские поля (`custom.<id>`, тикет crm-fields/07) — по каталогу того, кто смотрит
// (filters/custom.ts): код поля тоже идёт параметром.

/** Как сравнивать значения поля: тип базы, к которому приводится параметр. */
type Cast = 'uuid' | 'text' | 'numeric' | 'timestamptz'

const CAST: Record<Cast, (value: unknown) => RawBuilder<unknown>> = {
  uuid: (value) => sql`cast(${value} as uuid)`,
  text: (value) => sql`cast(${value} as text)`,
  numeric: (value) => sql`cast(${value} as numeric)`,
  timestamptz: (value) => sql`cast(${value} as timestamptz)`,
}

const CAST_ARRAY: Record<Cast, (values: readonly unknown[]) => RawBuilder<unknown>> = {
  uuid: (values) => sql`cast(${values} as uuid[])`,
  text: (values) => sql`cast(${values} as text[])`,
  numeric: (values) => sql`cast(${values} as numeric[])`,
  timestamptz: (values) => sql`cast(${values} as timestamptz[])`,
}

/** Поле фильтра в SQL: столбец (или выражение) и приведение значения; у boolean — условие. */
type FieldSql =
  | { column: RawBuilder<unknown>; cast: Cast; user?: boolean }
  | { truthy: RawBuilder<SqlBool> }

const ref = (column: string) => sql.ref(column)

/** Белый список полей: поле формата → столбец таблицы списка. */
const FIELD_SQL: { [E in FilterEntity]: Record<string, FieldSql> } = {
  deals: {
    pipeline: { column: ref('deal.pipeline_id'), cast: 'uuid' },
    stage: { column: ref('deal.stage_id'), cast: 'uuid' },
    status: { column: ref('deal.status'), cast: 'text' },
    owner: { column: ref('deal.owner_id'), cast: 'text', user: true },
    amount: { column: ref('deal.amount'), cast: 'numeric' },
    currency: { column: ref('deal.currency'), cast: 'text' },
    title: { column: ref('deal.title'), cast: 'text' },
    organization: { column: ref('deal.organization_id'), cast: 'uuid' },
    createdAt: { column: ref('deal.created_at'), cast: 'timestamptz' },
    stageChangedAt: { column: ref('deal.stage_changed_at'), cast: 'timestamptz' },
    wonAt: { column: ref('deal.won_at'), cast: 'timestamptz' },
    lostAt: { column: ref('deal.lost_at'), cast: 'timestamptz' },
    lostReason: { column: ref('deal.lost_reason_id'), cast: 'uuid' },
    archived: { truthy: sql<SqlBool>`(deal.archived_at is not null)` },
  },
  contacts: {
    name: {
      column: sql`concat_ws(' ', contact.first_name, contact.last_name)`,
      cast: 'text',
    },
    language: { column: ref('contact.language'), cast: 'text' },
    organization: { column: ref('contact.organization_id'), cast: 'uuid' },
    possibleDuplicate: { truthy: sql<SqlBool>`(contact.possible_duplicate)` },
    createdBy: { column: ref('contact.created_by'), cast: 'text', user: true },
    createdAt: { column: ref('contact.created_at'), cast: 'timestamptz' },
    updatedAt: { column: ref('contact.updated_at'), cast: 'timestamptz' },
  },
  organizations: {
    name: { column: ref('organization.name'), cast: 'text' },
    address: { column: ref('organization.address'), cast: 'text' },
    website: { column: ref('organization.website'), cast: 'text' },
    createdBy: { column: ref('organization.created_by'), cast: 'text', user: true },
    createdAt: { column: ref('organization.created_at'), cast: 'timestamptz' },
    updatedAt: { column: ref('organization.updated_at'), cast: 'timestamptz' },
  },
}

/** Для кого строится фильтр: значение 'me' у поля-пользователя — это он. */
export interface FilterViewer {
  /**
   * null — ключ API (тикет crm-api/01): «я» у него нет. Фильтр с «я» отклоняет разбор
   * (readFilterParam с `me: false`); дошёл до построителя — ошибка кода, а не пустое значение.
   */
  actorId: string | null
  /**
   * Пользовательские поля, которые он видит (loadFilterCatalog): по ним проверены условия
   * `custom.<id>`. Нет — в фильтре таких условий быть не может.
   */
  custom?: readonly CatalogField[]
}

/** Таблица списка в запросе. */
const RECORD_TABLE: Record<FilterEntity, RecordTable> = {
  deals: 'deal',
  contacts: 'contact',
  organizations: 'organization',
}

const TRUE = sql<SqlBool>`true`

function compileCondition(
  entity: FilterEntity,
  condition: FilterCondition,
  viewer: FilterViewer,
): RawBuilder<SqlBool> {
  const ref = parseCustomRef(condition.field)
  if (ref) {
    const custom = viewer.custom?.find((f) => f.id === ref.key)
    // parseFilter с тем же каталогом пропускает только его поля и приводит ссылку к id.
    if (!custom) throw new Error(`поле фильтра ${condition.field} не из каталога`)
    return compileCustomCondition(RECORD_TABLE[entity], custom, condition, viewer.actorId)
  }
  const field = FIELD_SQL[entity][condition.field]
  // parseFilter пропускает только поля из FILTER_FIELDS; расхождение каталога и этой таблицы —
  // ошибка кода, а не запроса.
  if (!field) throw new Error(`поле фильтра ${entity}.${condition.field} не описано в SQL`)
  if ('truthy' in field) {
    return condition.value === true ? field.truthy : sql<SqlBool>`(not ${field.truthy})`
  }
  const { column, cast } = field
  const me = (value: unknown) => (field.user && value === 'me' ? meOf(viewer.actorId) : value)
  const value = me(condition.value)
  const list = Array.isArray(condition.value) ? condition.value.map(me) : []
  switch (condition.op) {
    case 'eq':
      return sql<SqlBool>`(${column} = ${CAST[cast](value)})`
    case 'neq':
      return sql<SqlBool>`(${column} is distinct from ${CAST[cast](value)})`
    case 'in':
      return sql<SqlBool>`(${column} = any(${CAST_ARRAY[cast](list)}))`
    case 'not_in':
      return sql<SqlBool>`(${column} is null or ${column} <> all(${CAST_ARRAY[cast](list)}))`
    case 'lt':
      return sql<SqlBool>`(${column} < ${CAST[cast](value)})`
    case 'lte':
      return sql<SqlBool>`(${column} <= ${CAST[cast](value)})`
    case 'gt':
      return sql<SqlBool>`(${column} > ${CAST[cast](value)})`
    case 'gte':
      return sql<SqlBool>`(${column} >= ${CAST[cast](value)})`
    case 'contains':
      return sql<SqlBool>`(${column} ilike ${likePattern(String(value))})`
    case 'empty':
      return sql<SqlBool>`(${column} is null)`
    case 'not_empty':
      return sql<SqlBool>`(${column} is not null)`
    case 'between':
      throw new Error(`оператор between у системного поля ${entity}.${condition.field}`)
  }
}

function compileNode(
  entity: FilterEntity,
  node: FilterNode,
  viewer: FilterViewer,
): RawBuilder<SqlBool> {
  if (!isFilterGroup(node)) return compileCondition(entity, node, viewer)
  const { op, items } = groupParts(node)
  // Пустая группа ничего не ограничивает — и в «И», и в «ИЛИ» (так её видит пользователь:
  // группа без условий).
  if (items.length === 0) return TRUE
  const parts = items.map((item) => compileNode(entity, item, viewer))
  return sql<SqlBool>`(${sql.join(parts, op === 'and' ? sql` and ` : sql` or `)})`
}

/**
 * Условие WHERE фильтра `filter` (уже проверенного parseFilter) по таблице списка `entity`
 * (deal, contact, organization — в запросе под своими именами).
 */
export function compileFilter(
  entity: FilterEntity,
  filter: FilterGroup,
  viewer: FilterViewer,
): RawBuilder<SqlBool> {
  return compileNode(entity, filter, viewer)
}

/**
 * Фильтр сделок: архивные скрыты, пока в фильтре нет условия на архив (`hideArchived` —
 * вызывающий ещё не решил вопрос архива сам).
 */
export function compileDealFilter(
  filter: FilterGroup,
  viewer: FilterViewer,
  hideArchived: boolean,
): RawBuilder<SqlBool> {
  const compiled = compileFilter('deals', filter, viewer)
  if (!hideArchived || mentionsField(filter, 'archived')) return compiled
  return sql<SqlBool>`(${compiled} and deal.archived_at is null)`
}

/** Наибольшая длина параметра `filter` (JSON) в строке запроса. */
const MAX_FILTER_PARAM = 20_000

export type FilterParam =
  | { ok: true; filter: FilterGroup | undefined }
  | {
      ok: false
      path: string
      message: string
      /** Пользовательское поле не из каталога: ответ 422 CUSTOM_FIELD_UNKNOWN. */
      unknownCustomField?: string
    }

/**
 * Фильтр из параметра запроса `filter` (JSON); нет параметра — undefined. Условия по
 * пользовательским полям — из каталога `custom` того, кто смотрит. `me` — есть ли у него «я»:
 * у ключа API нет (тикет crm-api/03), и фильтр с «я» у поля-пользователя — ошибка запроса.
 */
export function readFilterParam(
  entity: FilterEntity,
  raw: string | undefined,
  custom: readonly CatalogField[] = [],
  { me = true }: { me?: boolean } = {},
): FilterParam {
  if (raw === undefined) return { ok: true, filter: undefined }
  if (raw.length > MAX_FILTER_PARAM) {
    return { ok: false, path: 'filter', message: 'слишком длинный фильтр' }
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { ok: false, path: 'filter', message: 'фильтр — не JSON' }
  }
  const parsed = parseFilter(entity, value, custom)
  if (!parsed.ok) {
    return {
      ok: false,
      path: parsed.error.path ? `filter${parsed.error.path}` : 'filter',
      message: parsed.error.message,
      ...(parsed.error.unknownCustomField === undefined
        ? {}
        : { unknownCustomField: parsed.error.unknownCustomField }),
    }
  }
  if (!me && usesMe(entity, parsed.filter, custom)) {
    return { ok: false, path: 'filter', message: 'значения «я» у ключа API нет' }
  }
  return { ok: true, filter: parsed.filter }
}

/** Есть ли в фильтре значение «я» у поля-пользователя (системного или пользовательского). */
function usesMe(entity: FilterEntity, node: FilterNode, custom: readonly CatalogField[]): boolean {
  if (isFilterGroup(node)) return groupParts(node).items.some((n) => usesMe(entity, n, custom))
  const ref = parseCustomRef(node.field)
  const field = ref ? undefined : FIELD_SQL[entity][node.field]
  const user = ref
    ? custom.find((f) => f.id === ref.key)?.type === 'user'
    : field !== undefined && 'user' in field && field.user === true
  const values: unknown[] = Array.isArray(node.value) ? node.value : [node.value]
  return user && values.includes('me')
}
