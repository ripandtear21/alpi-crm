import type { Database } from '@alpi/db'
import { type FilterGroup, type ListCount, type ListSort, parseSort } from '@alpi/shared'
import { type Expression, type ExpressionBuilder, type SqlBool, sql } from 'kysely'
import { type Ctx, ok, readLimit, refuse, UUID } from '../contacts/http.ts'
import { contactScopePredicate } from '../contacts/scope.ts'
import { compileDealFilter, readFilterParam } from '../filters/compile.ts'
import {
  afterPosition,
  countRows,
  decodePageCursor,
  encodePageCursor,
  numericKey,
  type PagePosition,
  type SortKey,
  textKey,
  timeKey,
} from '../filters/page.ts'
import { dealInScope, ownerInScope } from './scope.ts'
import type { DealContext, DealCurrency, DealStatus, Result } from './store.ts'

// Выдача сделок для канбана и агрегаты его колонок (тикет crm-deals/11).
//
// `GET /v1/deals` — страница сделок, новые на этапе сверху, с курсором:
//   pipeline=<uuid>    воронка (необязательно);
//   stage=<uuid>       этап (необязательно);
//   owner=me|none|<id> ответственный: я, без ответственного (общая очередь), участник;
//   contact=<uuid>     контакт — основной или участник сделки (карточка контакта, тикет 14);
//   organization=<uuid> организация сделки (карточка организации, тикет 14);
//   status=open|won|lost|any   по умолчанию open;
//   archived=false|true|any    по умолчанию false;
//   limit=1…200        по умолчанию 50;
//   cursor=<строка>    nextCursor предыдущей страницы, как есть;
//   filter=<JSON>      дерево условий фильтра (packages/shared/src/filters, тикет 12) — то же
//                      для списка, канбана, агрегатов, счётчика, выгрузки и массовых действий;
//                      без условия на архив архивные скрыты, если archived=any;
//   sort=<колонка>:<asc|desc>  сортировка списка (title, amount, createdAt, stageChangedAt),
//                      по умолчанию stageChangedAt:desc.
// Ответ — { items: BoardDeal[], nextCursor: string | null }; null — страниц больше нет.
// Порядок — (stage_changed_at desc, id desc); курсор — непрозрачная строка base64url с
// временем смены этапа (до микросекунд) и id последней сделки страницы: следующая страница
// начинается строго после неё, поэтому сделки с одинаковым временем не повторяются и не
// теряются. Курсор действует только с теми же фильтрами.
//
// `GET /v1/pipelines/:id/aggregates` — по каждому этапу воронки число сделок и суммы по каждой
// валюте отдельно, с тем же охватом и фильтрами (owner, status, archived), что у выдачи, —
// считает база, а не загруженные карточки. Этап без сделок в ответ не попадает.
//
// Охват — как у карточки сделки (deals/scope.ts): ответственный в охвате чтения или общая
// очередь. Сделки в корзине не показываются никогда. Дополнительное условие WHERE
// (`DealCondition`) принимают listDealsPage и pipelineAggregates — точка, куда построитель
// фильтров списка (тикет 12) подключает свои условия.

/** Карточка сделки на канбане. */
export interface BoardDeal {
  id: string
  title: string
  pipelineId: string
  stageId: string
  amount: number
  currency: DealCurrency
  /** null — общая очередь. */
  ownerId: string | null
  ownerName: string | null
  status: DealStatus
  primaryContactId: string
  /** «Ім'я Прізвище» основного контакта; null — контакт вне охвата контактов пользователя. */
  contactName: string | null
  stageChangedAt: string
  // Колонки списка (тикет 12).
  organizationId: string | null
  organizationName: string | null
  lostReasonId: string | null
  createdAt: string
  wonAt: string | null
  lostAt: string | null
  archivedAt: string | null
}

export interface DealsPage {
  items: BoardDeal[]
  nextCursor: string | null
}

/** Колонка канбана: число сделок и суммы по валютам (только валюты, где сделки есть). */
export interface StageAggregate {
  stageId: string
  count: number
  sums: Partial<Record<DealCurrency, number>>
}

export interface PipelineAggregates {
  stages: StageAggregate[]
}

/** Возможный ответственный для фильтра канбана: участник проекта в охвате пользователя. */
export interface DealOwner {
  id: string
  name: string
}

/** Дополнительное условие на строку `deal` (фильтры списка, тикет 12). */
export type DealCondition = (eb: ExpressionBuilder<Database, 'deal'>) => Expression<SqlBool>

const STATUS_FILTERS = ['open', 'won', 'lost', 'any'] as const
const ARCHIVED_FILTERS = ['false', 'true', 'any'] as const

/** Фильтры выдачи и агрегатов из параметров запроса. */
export interface DealFilters {
  pipelineId?: string
  stageId?: string
  /** Ответственный: id пользователя; null — общая очередь; undefined — любой в охвате. */
  ownerId?: string | null
  /** Контакт — основной или участник сделки. */
  contactId?: string
  organizationId?: string
  status: (typeof STATUS_FILTERS)[number]
  archived: (typeof ARCHIVED_FILTERS)[number]
  /** Фильтр списка (тикет 12), уже проверенный parseFilter. */
  filter?: FilterGroup
}

/** Кто смотрит: охват сделок и id пользователя (значение «я» в фильтре). */
export type DealViewer = Pick<DealContext, 'actorId' | 'scope' | 'viewer'>

const invalid = (path: string) => refuse(400, 'INVALID_DEAL', { path })

function oneOf<T extends string>(values: readonly T[], raw: string | undefined, fallback: T) {
  if (raw === undefined) return fallback
  return values.find((value) => value === raw)
}

function readUuidParam(c: Ctx, name: string): Result<string | undefined> {
  const raw = c.req.query(name)
  if (raw === undefined) return ok(undefined)
  return UUID.test(raw) ? ok(raw.toLowerCase()) : invalid(name)
}

/** Фильтры из параметров запроса; `pipelineId` маршрута агрегатов передаёт вызывающий. */
function readFilters(c: Ctx, ctx: DealViewer): Result<DealFilters> {
  const pipeline = readUuidParam(c, 'pipeline')
  if (!pipeline.ok) return pipeline
  const stage = readUuidParam(c, 'stage')
  if (!stage.ok) return stage
  const contact = readUuidParam(c, 'contact')
  if (!contact.ok) return contact
  const organization = readUuidParam(c, 'organization')
  if (!organization.ok) return organization
  const status = oneOf(STATUS_FILTERS, c.req.query('status'), 'open')
  if (status === undefined) return invalid('status')
  const archived = oneOf(ARCHIVED_FILTERS, c.req.query('archived'), 'false')
  if (archived === undefined) return invalid('archived')
  const owner = c.req.query('owner')
  if (owner !== undefined && (owner === '' || owner.length > 100)) return invalid('owner')
  const filter = readFilterParam('deals', c.req.query('filter'))
  if (!filter.ok) return refuse(400, 'INVALID_DEAL', { path: filter.path, message: filter.message })
  const filters: DealFilters = { status, archived }
  if (filter.filter !== undefined) filters.filter = filter.filter
  if (pipeline.value !== undefined) filters.pipelineId = pipeline.value
  if (stage.value !== undefined) filters.stageId = stage.value
  if (contact.value !== undefined) filters.contactId = contact.value
  if (organization.value !== undefined) filters.organizationId = organization.value
  if (owner !== undefined) {
    filters.ownerId = owner === 'me' ? ctx.actorId : owner === 'none' ? null : owner
  }
  return ok(filters)
}

/**
 * Условие WHERE выдачи: охват, не в корзине, фильтры и дополнительное условие `extra`. Одно на
 * канбан, список, агрегаты, счётчик, выгрузку и выбор массовой операции по фильтру.
 */
export function dealsWhere(
  eb: ExpressionBuilder<Database, 'deal'>,
  ctx: DealViewer,
  filters: DealFilters,
  extra: DealCondition | undefined,
): Expression<SqlBool> {
  const conditions: Expression<SqlBool>[] = [
    eb('deal.deleted_at', 'is', null),
    dealInScope(sql.ref('deal.owner_id'), ctx.scope.read, ctx.viewer),
  ]
  if (filters.pipelineId !== undefined) {
    conditions.push(eb('deal.pipeline_id', '=', filters.pipelineId))
  }
  if (filters.stageId !== undefined) conditions.push(eb('deal.stage_id', '=', filters.stageId))
  if (filters.contactId !== undefined) {
    const contactId = filters.contactId
    conditions.push(
      eb.or([
        eb('deal.primary_contact_id', '=', contactId),
        eb.exists(
          eb
            .selectFrom('deal_participant as p')
            .select('p.id')
            .whereRef('p.deal_id', '=', 'deal.id')
            .where('p.contact_id', '=', contactId),
        ),
      ]),
    )
  }
  if (filters.organizationId !== undefined) {
    conditions.push(eb('deal.organization_id', '=', filters.organizationId))
  }
  if (filters.ownerId === null) conditions.push(eb('deal.owner_id', 'is', null))
  else if (filters.ownerId !== undefined) {
    conditions.push(eb('deal.owner_id', '=', filters.ownerId))
  }
  if (filters.status !== 'any') conditions.push(eb('deal.status', '=', filters.status))
  if (filters.archived !== 'any') {
    conditions.push(eb('deal.archived_at', filters.archived === 'true' ? 'is not' : 'is', null))
  }
  if (filters.filter !== undefined) {
    conditions.push(
      compileDealFilter(filters.filter, { actorId: ctx.actorId }, filters.archived === 'any'),
    )
  }
  if (extra) conditions.push(extra(eb))
  return eb.and(conditions)
}

// ---- Сортировка и курсор --------------------------------------------------------------------

export type DealSort = ListSort<'deals'>

/** Порядок канбана: недавно пришедшие на этап сверху. */
export const DEFAULT_DEAL_SORT: DealSort = { column: 'stageChangedAt', direction: 'desc' }

/** Колонки сортировки списка → столбцы сделки (белый список, имя из запроса в SQL не идёт). */
const DEAL_SORT_KEYS: Record<DealSort['column'], SortKey> = {
  title: textKey('deal.title'),
  amount: numericKey('deal.amount'),
  createdAt: timeKey('deal.created_at'),
  stageChangedAt: timeKey('deal.stage_changed_at'),
}

const sortName = (sort: DealSort) => `${sort.column}:${sort.direction}`
const isDefaultSort = (sort: DealSort) => sortName(sort) === sortName(DEFAULT_DEAL_SORT)

/** Позиция в выдаче: значение колонки сортировки и id сделки. */
export type Cursor = PagePosition

/**
 * Курсор из строки запроса для сортировки `sort`; не тот формат — undefined (ответ 400, а не
 * ошибка базы). У порядка канбана курсор прежний (тикет 11): `{ t, id }` — время смены этапа
 * до микросекунд и id последней сделки.
 */
export function decodeCursor(raw: string, sort: DealSort = DEFAULT_DEAL_SORT): Cursor | undefined {
  if (!isDefaultSort(sort)) {
    return decodePageCursor(raw, sortName(sort), DEAL_SORT_KEYS[sort.column].cast)
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const { t, id } = value as Record<string, unknown>
  if (typeof t !== 'string' || typeof id !== 'string') return undefined
  // Та же проверка, что у курсоров списка: время существует, id — uuid.
  return decodePageCursor(
    encodePageCursor(sortName(sort), { v: t, id }),
    sortName(sort),
    'timestamptz',
  )
}

function encodeCursor(sort: DealSort, position: Cursor): string {
  return isDefaultSort(sort)
    ? Buffer.from(JSON.stringify({ t: position.v, id: position.id })).toString('base64url')
    : encodePageCursor(sortName(sort), position)
}

// ---- Выдача ---------------------------------------------------------------------------------

const isoOrNull = (value: Date | string | null) =>
  value === null ? null : new Date(value).toISOString()

/**
 * Страница сделок по `filters` после курсора `cursor`, `limit` штук, в порядке `sort` (по
 * умолчанию — канбана), с дополнительным условием `extra`.
 */
export async function listDealsPage(
  ctx: DealContext,
  filters: DealFilters,
  {
    cursor,
    limit,
    extra,
    sort = DEFAULT_DEAL_SORT,
  }: { cursor?: Cursor; limit: number; extra?: DealCondition; sort?: DealSort },
): Promise<DealsPage> {
  const key = DEAL_SORT_KEYS[sort.column]
  let query = ctx.db
    .selectFrom('deal')
    .select([
      'deal.id',
      'deal.title',
      'deal.pipeline_id',
      'deal.stage_id',
      'deal.amount',
      'deal.currency',
      'deal.owner_id',
      'deal.status',
      'deal.primary_contact_id',
      'deal.organization_id',
      'deal.lost_reason_id',
      'deal.created_at',
      'deal.won_at',
      'deal.lost_at',
      'deal.archived_at',
    ])
    .select(timeKey('deal.stage_changed_at').text.as('stage_changed_at'))
    .select(key.text.as('sort_value'))
    .where((eb) => dealsWhere(eb, ctx, filters, extra))
    .orderBy(key.order, sort.direction)
    .orderBy('deal.id', sort.direction)
    // Одна лишняя строка — узнать, есть ли следующая страница.
    .limit(limit + 1)
  if (cursor) query = query.where(afterPosition(key, sort.direction, 'deal.id', cursor))
  const rows = await query.execute()
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  const nextCursor =
    rows.length > limit && last ? encodeCursor(sort, { v: last.sort_value, id: last.id }) : null

  const ownerIds = [...new Set(page.flatMap((row) => (row.owner_id ? [row.owner_id] : [])))]
  const owners = new Map(
    ownerIds.length === 0
      ? []
      : (
          await ctx.db
            .selectFrom('user')
            .select(['id', 'name'])
            .where('id', 'in', ownerIds)
            .execute()
        ).map((u) => [u.id, u.name]),
  )
  // Имя контакта — только если пользователь видит сам контакт (охват контактов бывает уже).
  const contactIds = [...new Set(page.map((row) => row.primary_contact_id))]
  const contacts = new Map(
    contactIds.length === 0
      ? []
      : (
          await ctx.db
            .selectFrom('contact')
            .select(['id', 'first_name', 'last_name'])
            .where('id', 'in', contactIds)
            .where((eb) =>
              contactScopePredicate(eb, ctx.permissions.scopes.contacts.read, ctx.viewer),
            )
            .execute()
        ).map((row) => [row.id, [row.first_name, row.last_name].filter(Boolean).join(' ')]),
  )
  // Организации охвата нет; организация в корзине — без имени, как удалённая.
  const organizationIds = [
    ...new Set(page.flatMap((row) => (row.organization_id ? [row.organization_id] : []))),
  ]
  const organizations = new Map(
    organizationIds.length === 0
      ? []
      : (
          await ctx.db
            .selectFrom('organization')
            .select(['id', 'name'])
            .where('id', 'in', organizationIds)
            .where('deleted_at', 'is', null)
            .execute()
        ).map((row) => [row.id, row.name]),
  )

  return {
    items: page.map((row) => ({
      id: row.id,
      title: row.title,
      pipelineId: row.pipeline_id,
      stageId: row.stage_id,
      amount: Number(row.amount),
      currency: row.currency as DealCurrency,
      ownerId: row.owner_id,
      ownerName: row.owner_id === null ? null : (owners.get(row.owner_id) ?? null),
      status: row.status as DealStatus,
      primaryContactId: row.primary_contact_id,
      contactName: contacts.get(row.primary_contact_id) ?? null,
      stageChangedAt: row.stage_changed_at,
      organizationId: row.organization_id,
      organizationName:
        row.organization_id === null ? null : (organizations.get(row.organization_id) ?? null),
      lostReasonId: row.lost_reason_id,
      createdAt: new Date(row.created_at).toISOString(),
      wonAt: isoOrNull(row.won_at),
      lostAt: isoOrNull(row.lost_at),
      archivedAt: isoOrNull(row.archived_at),
    })),
    nextCursor,
  }
}

/** Запрос выдачи: фильтры, сортировка, курсор и размер страницы из параметров. */
export interface DealsQuery {
  filters: DealFilters
  sort: DealSort
  cursor?: Cursor
  limit: number
}

/** Параметры выдачи `GET /v1/deals` (их же читают счётчик и выгрузка). */
export function readDealsQuery(c: Ctx, ctx: DealViewer): Result<DealsQuery> {
  const filters = readFilters(c, ctx)
  if (!filters.ok) return filters
  const limit = readLimit(c.req.query('limit'))
  if (limit === undefined) return invalid('limit')
  const rawSort = c.req.query('sort')
  const sort = rawSort === undefined ? DEFAULT_DEAL_SORT : parseSort('deals', rawSort)
  if (!sort) return invalid('sort')
  const rawCursor = c.req.query('cursor')
  const cursor = rawCursor === undefined ? undefined : decodeCursor(rawCursor, sort)
  if (rawCursor !== undefined && cursor === undefined) return invalid('cursor')
  return ok({ filters: filters.value, sort, limit, ...(cursor ? { cursor } : {}) })
}

/** `GET /v1/deals`. */
export async function listDeals(c: Ctx, ctx: DealContext): Promise<Result<DealsPage>> {
  const query = readDealsQuery(c, ctx)
  if (!query.ok) return query
  const { filters, ...page } = query.value
  return ok(await listDealsPage(ctx, filters, page))
}

/** `GET /v1/deals/count`: число сделок выдачи (до порога точно, выше — оценка). */
export async function countDeals(c: Ctx, ctx: DealContext): Promise<Result<ListCount>> {
  const filters = readFilters(c, ctx)
  if (!filters.ok) return filters
  const query = ctx.db
    .selectFrom('deal')
    .select('deal.id')
    .where((eb) => dealsWhere(eb, ctx, filters.value, undefined))
  return ok(await countRows(ctx.db, query))
}

// ---- Агрегаты -------------------------------------------------------------------------------

/** Число и суммы по валютам по этапам воронки `pipelineId` для `filters` и `extra`. */
export async function pipelineAggregates(
  ctx: DealContext,
  filters: DealFilters,
  extra?: DealCondition,
): Promise<PipelineAggregates> {
  // Суммы — в базе (numeric): без ошибок округления дробей двоичных чисел.
  const rows = await ctx.db
    .selectFrom('deal')
    .select(['deal.stage_id', 'deal.currency'])
    .select(sql<string>`count(*)`.as('count'))
    .select(sql<string>`sum(deal.amount)`.as('sum'))
    .where((eb) => dealsWhere(eb, ctx, filters, extra))
    .groupBy(['deal.stage_id', 'deal.currency'])
    .orderBy('deal.stage_id')
    .orderBy('deal.currency')
    .execute()
  const stages = new Map<string, StageAggregate>()
  for (const row of rows) {
    const stage = stages.get(row.stage_id) ?? { stageId: row.stage_id, count: 0, sums: {} }
    stage.count += Number(row.count)
    stage.sums[row.currency as DealCurrency] = Number(row.sum)
    stages.set(row.stage_id, stage)
  }
  return { stages: [...stages.values()] }
}

/** `GET /v1/pipelines/:id/aggregates`: воронка проекта (иначе 404) и фильтры запроса. */
export async function dealAggregates(
  c: Ctx,
  ctx: DealContext,
  pipelineId: string,
): Promise<Result<PipelineAggregates>> {
  const pipeline = UUID.test(pipelineId)
    ? await ctx.db
        .selectFrom('pipeline')
        .select('id')
        .where('id', '=', pipelineId)
        .executeTakeFirst()
    : undefined
  if (!pipeline) return refuse(404, 'PIPELINE_NOT_FOUND')
  const filters = readFilters(c, ctx)
  if (!filters.ok) return filters
  return ok(await pipelineAggregates(ctx, { ...filters.value, pipelineId: pipeline.id }))
}

// ---- Ответственные --------------------------------------------------------------------------

/**
 * `GET /v1/deals/owners`: действующие участники проекта, чьи сделки пользователь видит по
 * охвату (свои — только он сам, команда — его команда, все — все), по имени.
 */
export async function dealOwners(ctx: DealContext): Promise<DealOwner[]> {
  return ctx.db
    .selectFrom('project_member as m')
    .innerJoin('user as u', 'u.id', 'm.user_id')
    .select(['u.id', 'u.name'])
    .where('m.disabled_at', 'is', null)
    .where(ownerInScope(sql.ref('m.user_id'), ctx.scope.read, ctx.viewer))
    .orderBy('u.name')
    .orderBy('u.id')
    .execute()
}
