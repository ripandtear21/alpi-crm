import type { Database } from '@alpi/db'
import type { ResourceScope, RolePermissions, Scope } from '@alpi/shared'
import { type Kysely, sql } from 'kysely'
import { requestAuthor } from '../api-keys/actor.ts'
import type { ChangeAuthor } from '../change-log/record.ts'
import type { ContactsErrorCode } from '../contacts/contacts.ts'
import { type Ctx, type Outcome, ok, refuse } from '../contacts/http.ts'
import type { FieldViewer } from '../fields/access.ts'
import { type CustomValues, visibleCustom } from '../fields/values.ts'
import { inSavepoint, sqlState } from '../roles/roles.ts'
import { requestViewer, type Viewer } from '../roles/scope.ts'
import { dealInScope, ownerAllowed } from './scope.ts'

// Сделки в базе (тикет crm-deals/05): чтение строки в охвате, ответ API, запись с переводом
// отказов базы в ответы 409/422. Маршруты и правила действий — deals.ts.

export const DEAL_STATUSES = ['open', 'won', 'lost'] as const
export type DealStatus = (typeof DEAL_STATUSES)[number]

export const DEAL_CURRENCIES = ['EUR', 'UAH', 'USD'] as const
export type DealCurrency = (typeof DEAL_CURRENCIES)[number]

/** Валюта новой сделки, если не указана (как в Pipedrive; решено без владельца — подтвердить). */
export const DEFAULT_CURRENCY: DealCurrency = 'EUR'

export const MAX_TITLE_LENGTH = 200
/** numeric(14, 2): до триллиона без копейки. */
export const MAX_AMOUNT = 999_999_999_999.99
/** Ожидаемая дата закрытия: YYYY-MM-DD (существующий день проверяет разбор тела). */
export const DATE = /^\d{4}-\d{2}-\d{2}$/

export type DealsErrorCode =
  | 'PERMISSION_DENIED'
  /** Тело запроса не той формы: `details.path` — какое поле. */
  | 'INVALID_DEAL'
  | 'DEAL_NOT_FOUND'
  /**
   * Сделка слита с другой и скрыта (тикет crm-intake/02): `details.merged_into_id` — последняя
   * оставшаяся в цепочке слияний, `merge_id` и `undo_until` — слияние, которое её скрыло.
   */
  | 'DEAL_MERGED'
  | 'PIPELINE_NOT_FOUND'
  /** В архивную воронку новые сделки не ставятся. */
  | 'PIPELINE_ARCHIVED'
  | 'PIPELINE_HAS_NO_STAGES'
  /** В проекте нет воронки допродаж, а другая не выбрана. */
  | 'UPSELL_PIPELINE_MISSING'
  | 'STAGE_NOT_FOUND'
  /** Этап сделки удалён: открытой на нём она быть не может — сначала сменить этап. */
  | 'STAGE_DELETED'
  | 'CONTACT_NOT_FOUND'
  /** Основной контакт сделки в корзине: сделку не восстановить, пока его не восстановят. */
  | 'CONTACT_IN_TRASH'
  | 'ORGANIZATION_NOT_FOUND'
  /** Ответственный — не действующий участник проекта. */
  | 'OWNER_NOT_MEMBER'
  | 'LOST_REASON_REQUIRED'
  | 'LOST_REASON_NOT_FOUND'
  | 'LOST_REASON_ARCHIVED'
  /**
   * У основного контакта уже есть открытая сделка в этой воронке: `details.dealId` — если она
   * видна пользователю, иначе только `details.managerName` («клиент уже в работе у …»).
   */
  | 'OPEN_DEAL_EXISTS'
  /** «Взять в работу»: у сделки уже есть ответственный. */
  | 'DEAL_ALREADY_TAKEN'
  /** Допродажа — только из выигранной сделки. */
  | 'DEAL_NOT_WON'
  | 'NOT_IN_TRASH'
  | 'PARTICIPANT_EXISTS'
  | 'PARTICIPANT_NOT_FOUND'
  /** Основной контакт не может быть ещё и участником той же сделки. */
  | 'CONTACT_IS_PRIMARY'
  | 'CONTACT_IS_PARTICIPANT'
  /** Товара нет в каталоге проекта. */
  | 'PRODUCT_NOT_FOUND'
  /** Архивный товар в новую строку не ставится; старые строки с ним остаются. */
  | 'PRODUCT_ARCHIVED'
  /** У товара нет цены в валюте сделки, а цена за единицу не введена. */
  | 'PRICE_REQUIRED'
  | 'LINE_NOT_FOUND'
  /** «Підставити»: строк товаров нет — сумму сделки нечем заменить. */
  | 'DEAL_HAS_NO_PRODUCTS'
  /** «Підставити»: сумма строк больше наибольшей суммы сделки. */
  | 'PRODUCTS_TOTAL_TOO_LARGE'
  /**
   * Создание, смена этапа, перенос или выигрыш: не заполнены поля, которых требует этап
   * (deals/stage-requirements.ts); `details` — RequiredFieldsMissing (packages/shared): коды и
   * названия видимых роли полей и число скрытых. Сделка остаётся на месте.
   */
  | 'STAGE_REQUIREMENTS_MISSING'

export type Result<T> = Outcome<T, DealsErrorCode | ContactsErrorCode>

/** Запрос в контексте проекта: кто действует, его права, охват и транзакция. */
export interface DealContext extends ChangeAuthor {
  /** null — запрос по ключу API (тогда заполнен `actorApiKeyId`). */
  actorId: string | null
  permissions: RolePermissions
  /** Охват сделок. */
  scope: ResourceScope
  viewer: Viewer
}

export async function dealContext(c: Ctx): Promise<DealContext> {
  const db = c.get('db')
  const actor = c.get('actor')
  const { permissions } = c.get('access')
  return {
    db,
    projectId: c.get('projectId'),
    ...requestAuthor(actor),
    permissions,
    scope: permissions.scopes.deals,
    viewer: await requestViewer(db, actor),
  }
}

/** Участник сделки в ответах API. */
export interface DealParticipantView {
  contactId: string
  role: string | null
}

/** Строка товара в сделке в ответах API; цены — в валюте сделки. */
export interface DealProductView {
  id: string
  productId: string
  /** Название товара в каталоге сейчас. */
  name: string
  quantity: number
  unitPrice: number
  /** Количество × цена за единицу. */
  total: number
}

/** Сделка в ответах API. */
export interface DealView {
  id: string
  title: string
  pipelineId: string
  stageId: string
  status: DealStatus
  lostReasonId: string | null
  /** Сумма с копейками; не меньше нуля. */
  amount: number
  currency: DealCurrency
  /** Ответственный (`user.id`); null — сделка в общей очереди. */
  ownerId: string | null
  primaryContactId: string
  organizationId: string | null
  wonAt: string | null
  lostAt: string | null
  stageChangedAt: string
  /** YYYY-MM-DD. */
  expectedCloseDate: string | null
  /** Отметка архива; null — не в архиве. */
  archivedAt: string | null
  /** В корзине с этого времени; в обычных ответах всегда null. */
  deletedAt: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
  /** Участники, кроме основного контакта, в порядке добавления. */
  participants: DealParticipantView[]
  /** Строки товаров в порядке добавления; сумму сделки не меняют (ответ владельца 13.0.4). */
  products: DealProductView[]
  /** «Сума по товарах» — сумма строк в валюте сделки; 0 — строк нет. */
  productsTotal: number
  /** Значения пользовательских полей по коду (fields/values.ts). */
  custom: CustomValues
}

/** Поля, изменения которых пишутся в историю сделки (change_log). */
export const LOGGED_FIELDS = [
  'title',
  'pipelineId',
  'stageId',
  'status',
  'lostReasonId',
  'amount',
  'currency',
  'ownerId',
  'primaryContactId',
  'organizationId',
  'wonAt',
  'lostAt',
  'expectedCloseDate',
  'archivedAt',
  'deletedAt',
  'participants',
] as const satisfies readonly (keyof DealView)[]

/** Строка сделки: дата закрытия — текстом, чтобы драйвер не сдвинул её часовым поясом. */
function selectDeals(db: Kysely<Database>) {
  return db
    .selectFrom('deal')
    .select([
      'id',
      'title',
      'pipeline_id',
      'stage_id',
      'status',
      'lost_reason_id',
      'amount',
      'currency',
      'owner_id',
      'primary_contact_id',
      'organization_id',
      'won_at',
      'lost_at',
      'stage_changed_at',
      'archived_at',
      'created_by',
      'created_at',
      'updated_at',
      'deleted_at',
      'custom',
      'merged_into_id',
    ])
    .select(
      sql<string | null>`to_char(expected_close_date, 'YYYY-MM-DD')`.as('expected_close_date'),
    )
}

export type DealRow = Awaited<ReturnType<ReturnType<typeof selectDeals>['executeTakeFirstOrThrow']>>

/**
 * Сделка `id` в охвате `scope` (в корзине или нет; слитая — нет); `lock` — заблокировать строку.
 * Блокировка ждёт одновременное слияние (оно блокирует обе сделки) и после него перечитывает
 * условие: сделку, которую только что слили, действие не найдёт — ничего не добавится к скрытой.
 */
export function findDeal(ctx: DealContext, id: string, scope: Scope, lock = false) {
  const query = selectDeals(ctx.db)
    .where('id', '=', id)
    .where('merged_into_id', 'is', null)
    .where(dealInScope(sql.ref('deal.owner_id'), scope, ctx.viewer))
  return (lock ? query.forUpdate() : query).executeTakeFirst()
}

/**
 * Сделки `ids` под блокировкой до конца транзакции, в одном порядке (по id): одновременные
 * слияния и откаты не сцепятся. Без охвата, в том числе слитые и в корзине: проверяет вызывающий.
 *
 * Порядок блокировок (тикет crm-intake/12) — контакт, потом сделка: сначала FOR SHARE основных
 * контактов этих сделок (lockDealContacts), потом сделки. Слияние и откат контактов держат
 * контакты FOR UPDATE и потом пишут в их сделки — путь «сделка, потом контакт» сцепился бы с
 * ними (40P01).
 */
export async function lockDeals(db: Kysely<Database>, ids: readonly string[]): Promise<DealRow[]> {
  if (ids.length === 0) return []
  const shared = await lockDealContacts(db, ids)
  const rows = await selectDeals(db)
    .where('id', 'in', [...ids])
    .orderBy('id')
    .forUpdate()
    .execute()
  // Основной контакт сменился, пока ждали контакты (сделки перенесло слияние контактов): его
  // блокировка — уже после сделки. shortcut: порядок здесь не соблюдён. Взаимоблокировку с ещё
  // одним слиянием этого контакта слияние и откат превращают в 409 MERGE_RETRY
  // (merge/store.ts, deadlockRefusal); окончательное удаление сделки (deals/deals.ts, purgeDeal)
  // и фоновая очистка корзины (trash/purgers.ts) не обёрнуты — там это 500 или повтор задачи.
  // Переделать, если такие отказы станут заметны в журнале.
  await shareContacts(
    db,
    rows.map((row) => row.primary_contact_id).filter((id) => !shared.includes(id)),
  )
  return rows
}

/**
 * Сделки `ids` и все слитые в них (по цепочке) — одним списком (lockDeals): окончательное
 * удаление стирает цепочку вместе со строками её слияний (purge_from_trash), и блокировки в том
 * же порядке, что у слияния и отката, не сцепятся с ними (тикет crm-intake/12).
 */
export async function lockDealChains(db: Kysely<Database>, ids: readonly string[]) {
  const chain = [...ids]
  for (const id of ids) chain.push(...(await mergedDealIds(db, id)))
  return lockDeals(db, chain)
}

/**
 * Блокирует FOR SHARE контакты `ids` в одном порядке (по id), без проверок: перед блокировкой
 * сделки, к которой их привязывают (тикет crm-intake/12, порядок «контакт, потом сделка»).
 * Строку с проверками читает вызывающий; эта блокировка — та же, его FOR SHARE пройдёт сразу.
 */
export async function shareContacts(db: Kysely<Database>, ids: readonly string[]): Promise<void> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return
  await db
    .selectFrom('contact')
    .select('id')
    .where('id', 'in', unique)
    .orderBy('id')
    .forShare()
    .execute()
}

/**
 * Блокирует FOR SHARE основные контакты сделок `ids` (их читают без блокировки) — до
 * блокировки самих сделок. Возвращает id заблокированных контактов: после блокировки сделки
 * вызывающий сверяет её основной контакт.
 */
export async function lockDealContacts(
  db: Kysely<Database>,
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) return []
  const rows = await db
    .selectFrom('deal')
    .select('primary_contact_id')
    .where('id', 'in', [...ids])
    .execute()
  const contactIds = [...new Set(rows.map((row) => row.primary_contact_id))]
  await shareContacts(db, contactIds)
  return contactIds
}

/**
 * Сделки, слитые в сделку `id` (по всей цепочке) и ещё не откаченные: их история показывается
 * в ленте и истории оставшейся с пометкой «зі злитої угоди» (строки change_log не переносятся —
 * таблица только добавляется, ADR 0003).
 */
export async function mergedDealIds(db: Kysely<Database>, id: string): Promise<string[]> {
  const { rows } = await sql<{ id: string }>`
    with recursive chain(id) as (
      select d.id from deal d where d.merged_into_id = ${id}
      union
      select d.id from deal d join chain on d.merged_into_id = chain.id
    )
    select id from chain order by id
  `.execute(db)
  return rows.map((row) => row.id)
}

export async function reloadDeal(ctx: Pick<DealContext, 'db'>, id: string): Promise<DealRow> {
  return selectDeals(ctx.db).where('id', '=', id).executeTakeFirstOrThrow()
}

/** Сделка видна пользователю: ответственный в охвате чтения или сделка в общей очереди. */
export function visibleTo(ctx: DealContext, ownerId: string | null): boolean {
  return ownerAllowed(ownerId, ctx.scope.read, ctx.viewer)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Сделка, которую пользователь может менять, заблокированная до конца транзакции: вне охвата
 * чтения — 404, вне охвата изменения — 403. В корзине — 404, если не `inTrash`.
 */
export async function writableDeal(
  ctx: DealContext,
  id: string,
  { inTrash = false }: { inTrash?: boolean } = {},
): Promise<Result<DealRow>> {
  if (!UUID.test(id)) return refuse(404, 'DEAL_NOT_FOUND')
  const row = await findDeal(ctx, id, ctx.scope.read, true)
  if (!row || (row.deleted_at !== null && !inTrash)) return refuse(404, 'DEAL_NOT_FOUND')
  if (!ownerAllowed(row.owner_id, ctx.scope.write, ctx.viewer)) {
    return refuse(403, 'PERMISSION_DENIED')
  }
  return ok(row)
}

const iso = (value: Date | string) => new Date(value).toISOString()
const isoOrNull = (value: Date | string | null) => (value === null ? null : iso(value))

/** Ответ API для строк сделок: участники и строки товаров — одним запросом на всех. */
export async function dealViews(viewer: FieldViewer, rows: DealRow[]): Promise<DealView[]> {
  if (rows.length === 0) return []
  const { db } = viewer
  const ids = rows.map((row) => row.id)
  const participants = await db
    .selectFrom('deal_participant')
    .select(['deal_id', 'contact_id', 'role'])
    .where('deal_id', 'in', ids)
    .orderBy('created_at')
    .orderBy('contact_id')
    .execute()
  const byDeal = new Map<string, DealParticipantView[]>()
  for (const p of participants) {
    byDeal.set(p.deal_id, [
      ...(byDeal.get(p.deal_id) ?? []),
      { contactId: p.contact_id, role: p.role },
    ])
  }
  // Суммы — в базе (numeric): без ошибок округления дробей двоичных чисел.
  const lines = await db
    .selectFrom('deal_product as l')
    .innerJoin('product as p', 'p.id', 'l.product_id')
    .select(['l.id', 'l.deal_id', 'l.product_id', 'p.name', 'l.quantity', 'l.unit_price'])
    .select(sql<string>`l.quantity * l.unit_price`.as('total'))
    .select(sql<string>`sum(l.quantity * l.unit_price) over (partition by l.deal_id)`.as('sum'))
    .where('l.deal_id', 'in', ids)
    .orderBy('l.created_at')
    .orderBy('l.id')
    .execute()
  const linesByDeal = new Map<string, DealProductView[]>()
  const totals = new Map<string, number>()
  for (const line of lines) {
    linesByDeal.set(line.deal_id, [
      ...(linesByDeal.get(line.deal_id) ?? []),
      {
        id: line.id,
        productId: line.product_id,
        name: line.name,
        quantity: line.quantity,
        unitPrice: Number(line.unit_price),
        total: Number(line.total),
      },
    ])
    totals.set(line.deal_id, Number(line.sum))
  }
  const custom = await visibleCustom(
    viewer,
    'deal',
    rows.map((row) => row.custom),
  )
  return rows.map((row, index) => ({
    id: row.id,
    title: row.title,
    pipelineId: row.pipeline_id,
    stageId: row.stage_id,
    status: row.status as DealStatus,
    lostReasonId: row.lost_reason_id,
    amount: Number(row.amount),
    currency: row.currency as DealCurrency,
    ownerId: row.owner_id,
    primaryContactId: row.primary_contact_id,
    organizationId: row.organization_id,
    wonAt: isoOrNull(row.won_at),
    lostAt: isoOrNull(row.lost_at),
    stageChangedAt: iso(row.stage_changed_at),
    expectedCloseDate: row.expected_close_date,
    archivedAt: isoOrNull(row.archived_at),
    deletedAt: isoOrNull(row.deleted_at),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    participants: byDeal.get(row.id) ?? [],
    products: linesByDeal.get(row.id) ?? [],
    productsTotal: totals.get(row.id) ?? 0,
    custom: custom[index] ?? {},
  }))
}

export async function dealView(viewer: FieldViewer, row: DealRow): Promise<DealView> {
  const [view] = await dealViews(viewer, [row])
  if (!view) throw new Error('сделка пропала в той же транзакции')
  return view
}

/** Чья открытая сделка помешала: та, что стоит у основного контакта в воронке. */
export interface OpenDealTarget {
  pipelineId: string
  contactId: string
  /** Сама изменяемая сделка: она себе не помеха. */
  excludeId?: string
}

/**
 * 409 OPEN_DEAL_EXISTS: id мешающей сделки — если она видна пользователю; если нет — только
 * имя её менеджера, без данных сделки («чужой клиент»).
 */
async function openDealExists(ctx: DealContext, target: OpenDealTarget): Promise<Result<never>> {
  let query = ctx.db
    .selectFrom('deal as d')
    .leftJoin('user as u', 'u.id', 'd.owner_id')
    .select(['d.id', 'd.owner_id', 'u.name'])
    .where('d.pipeline_id', '=', target.pipelineId)
    .where('d.primary_contact_id', '=', target.contactId)
    .where('d.status', '=', 'open')
    .where('d.archived_at', 'is', null)
    .where('d.deleted_at', 'is', null)
    .where('d.merged_into_id', 'is', null)
  if (target.excludeId !== undefined) query = query.where('d.id', '<>', target.excludeId)
  const conflict = await query.executeTakeFirst()
  if (!conflict) return refuse(409, 'OPEN_DEAL_EXISTS')
  return visibleTo(ctx, conflict.owner_id)
    ? refuse(409, 'OPEN_DEAL_EXISTS', { dealId: conflict.id })
    : refuse(409, 'OPEN_DEAL_EXISTS', { managerName: conflict.name })
}

const UNIQUE_VIOLATION = '23505'
/** SQLSTATE триггеров migrations/0010_deals.ts. */
const STAGE_DELETED = 'DL001'
const LOST_REASON_ARCHIVED = 'DL002'

/**
 * Запись сделки в точке сохранения: отказ базы откатывает только её и становится ответом.
 * «Одна открытая сделка» (частичный уникальный индекс) — 409 OPEN_DEAL_EXISTS про `target`;
 * этап удалён — 409; причина проигрыша в архиве — 422. Индекс и триггеры — последняя линия на
 * случай одновременных запросов: API проверяет то же раньше и отвечает теми же кодами.
 */
export async function guardedWrite<T>(
  ctx: DealContext,
  target: OpenDealTarget,
  write: () => Promise<T>,
): Promise<Result<T>> {
  try {
    return ok(await inSavepoint(ctx.db, write))
  } catch (error) {
    switch (sqlState(error)) {
      case UNIQUE_VIOLATION:
        if ((error as { constraint?: unknown }).constraint === 'deal_one_open_per_contact') {
          return openDealExists(ctx, target)
        }
        break
      case STAGE_DELETED:
        return refuse(409, 'STAGE_DELETED')
      case LOST_REASON_ARCHIVED:
        return refuse(422, 'LOST_REASON_ARCHIVED')
    }
    throw error
  }
}
