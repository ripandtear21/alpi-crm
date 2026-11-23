import type { Database } from '@alpi/db'
import { can, hasStandalone } from '@alpi/shared'
import { Hono } from 'hono'
import { sql, type UpdateObject } from 'kysely'
import { recordInRequest } from '../audit/record.ts'
import {
  diffFields,
  type FieldChange,
  purgeFromTrash,
  recordChanges,
} from '../change-log/record.ts'
import { createContactInRequest } from '../contacts/contacts.ts'
import {
  type Ctx,
  fail,
  ok,
  optionalText,
  readBody,
  readLimit,
  refuse,
  requiredText,
  UUID,
} from '../contacts/http.ts'
import { contactScopePredicate } from '../contacts/scope.ts'
import { type PermissionsEnv, requirePermission } from '../middleware/permissions.ts'
import { inSavepoint, sqlState } from '../roles/roles.ts'
import { dealAggregates, dealOwners, listDeals } from './board.ts'
import { addLine, productsTotalChange, removeLine, updateLine } from './lines.ts'
import { ownerAllowed } from './scope.ts'
import { NO_STAGE_REQUIREMENTS, type StageRequirements } from './stage-requirements.ts'
import {
  DEAL_CURRENCIES,
  DEFAULT_CURRENCY,
  type DealContext,
  type DealCurrency,
  type DealRow,
  type DealView,
  dealContext,
  dealView,
  findDeal,
  guardedWrite,
  LOGGED_FIELDS,
  type OpenDealTarget,
  type Result,
  reloadDeal,
  writableDeal,
} from './store.ts'

// Сделки проекта (тикет crm-deals/05; spec.md MVP, разделы 3.2 и 4; ADR 0003): маршруты
// `/v1/deals` (снаружи — /api/v1/deals).
//
// - Права — часть системы `deals`, охват чтения и изменения отдельно (deals/scope.ts): вне
//   охвата чтения — 404, как несуществующая; в охвате чтения, но не изменения — 403. Сделку
//   общей очереди (без ответственного) видит и меняет каждый с правом на сделки.
// - Контакт привязывается к сделке (основным, участником, в допродаже) только из охвата
//   изменения контактов: своя сделка сама делает контакт «своим» (contacts/scope.ts).
// - Ответственный: себя на новую сделку или на сделку очереди («взять в работу») ставит каждый;
//   любая другая смена ответственного (в том числе в очередь) — право «передача сделок»
//   (`transfer_deals`), новый ответственный — в охвате изменения пользователя.
// - Каждое действие меняет ровно названные в нём поля (ADR 0003): смена этапа не выигрывает
//   сделку, выигрыш не двигает этап, сумму никто не пересчитывает, событий нет.
// - «Одна открытая сделка у человека в воронке» держит база (частичный уникальный индекс):
//   любой путь, дающий вторую, получает 409 OPEN_DEAL_EXISTS — store.ts, guardedWrite.
// - Каждое изменение полей и участников пишется в change_log той же транзакцией.

const MAX_TITLE_LENGTH = 200
const MAX_ROLE_LENGTH = 100
/** numeric(14, 2): до триллиона без копейки. */
const MAX_AMOUNT = 999_999_999_999.99
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Что меняет действие: столбцы сделки, значения или выражения SQL (now()). */
type DealSet = UpdateObject<Database, 'deal'>

// ---- Разбор тела ----------------------------------------------------------------------------

const invalid = (path: string) => refuse(400, 'INVALID_DEAL', { path })

function readUuid(value: unknown): string | undefined {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : undefined
}

function readAmount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (value < 0 || value > MAX_AMOUNT) return undefined
  // Не больше двух знаков после запятой.
  return Math.abs(Math.round(value * 100) - value * 100) < 1e-6 ? value : undefined
}

function readDate(value: unknown): string | null | undefined {
  if (value === null) return null
  if (typeof value !== 'string' || !DATE.test(value)) return undefined
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value) ? value : undefined
}

function readCurrency(value: unknown): DealCurrency | undefined {
  return DEAL_CURRENCIES.find((currency) => currency === value)
}

/** Поля сделки, общие для создания и изменения; отсутствующее поле не меняется. */
interface DealFields {
  title?: string
  amount?: number
  currency?: DealCurrency
  organizationId?: string | null
  expectedCloseDate?: string | null
  /** null — в общую очередь. */
  ownerId?: string | null
  primaryContactId?: string
}

const FIELD_KEYS = [
  'title',
  'amount',
  'currency',
  'organizationId',
  'expectedCloseDate',
  'ownerId',
  'primaryContactId',
] as const

function readFields(body: Record<string, unknown>): Result<DealFields> {
  const fields: DealFields = {}
  if (body.title !== undefined) {
    const title = requiredText(body.title, MAX_TITLE_LENGTH)
    if (title === undefined) return invalid('title')
    fields.title = title
  }
  if (body.amount !== undefined) {
    const amount = readAmount(body.amount)
    if (amount === undefined) return invalid('amount')
    fields.amount = amount
  }
  if (body.currency !== undefined) {
    const currency = readCurrency(body.currency)
    if (currency === undefined) return invalid('currency')
    fields.currency = currency
  }
  if (body.organizationId !== undefined) {
    const id = body.organizationId === null ? null : readUuid(body.organizationId)
    if (id === undefined) return invalid('organizationId')
    fields.organizationId = id
  }
  if (body.expectedCloseDate !== undefined) {
    const date = readDate(body.expectedCloseDate)
    if (date === undefined) return invalid('expectedCloseDate')
    fields.expectedCloseDate = date
  }
  if (body.ownerId !== undefined) {
    const owner = body.ownerId
    if (owner !== null && (typeof owner !== 'string' || owner === '' || owner.length > 100)) {
      return invalid('ownerId')
    }
    fields.ownerId = owner
  }
  if (body.primaryContactId !== undefined) {
    const id = readUuid(body.primaryContactId)
    if (id === undefined) return invalid('primaryContactId')
    fields.primaryContactId = id
  }
  return ok(fields)
}

function unknownKey(body: Record<string, unknown>, allowed: readonly string[]): string | null {
  return Object.keys(body).find((key) => !allowed.includes(key)) ?? null
}

// ---- Проверки ссылок ------------------------------------------------------------------------

/** Воронка и этап сделки. */
interface Placement {
  pipelineId: string
  stageId: string
}

/**
 * Куда ставится открытая сделка: действующая воронка проекта и её действующий этап (по
 * умолчанию первый). Этап блокируется FOR SHARE до конца транзакции: удаление этапа подождёт.
 */
async function placement(
  ctx: DealContext,
  pipelineId: string,
  stageId: string | undefined,
): Promise<Result<Placement>> {
  const pipeline = await ctx.db
    .selectFrom('pipeline')
    .select(['id', 'archived_at'])
    .where('id', '=', pipelineId)
    .executeTakeFirst()
  if (!pipeline) return refuse(404, 'PIPELINE_NOT_FOUND')
  if (pipeline.archived_at !== null) return refuse(422, 'PIPELINE_ARCHIVED')
  return liveStage(ctx, pipelineId, stageId)
}

/** Действующий этап воронки (`stageId` или первый), заблокированный FOR SHARE. */
async function liveStage(
  ctx: DealContext,
  pipelineId: string,
  stageId: string | undefined,
): Promise<Result<Placement>> {
  let query = ctx.db
    .selectFrom('stage')
    .select('id')
    .where('pipeline_id', '=', pipelineId)
    .where('deleted_at', 'is', null)
  query =
    stageId === undefined
      ? query.orderBy('position').orderBy('created_at').orderBy('id').limit(1)
      : query.where('id', '=', stageId)
  const stage = await query.forShare().executeTakeFirst()
  if (!stage) {
    return stageId === undefined
      ? refuse(422, 'PIPELINE_HAS_NO_STAGES')
      : refuse(404, 'STAGE_NOT_FOUND')
  }
  return ok({ pipelineId, stageId: stage.id })
}

/**
 * Что нужно от контакта, кроме «не в корзине». `bind` — его привязывают к сделке (основным
 * или участником): он должен быть в охвате изменения контактов пользователя. Привязка к
 * своей сделке сама даёт изменение контакта (охват «свои» по сделкам, contacts/scope.ts),
 * поэтому привязать можно только то, что пользователь и так может менять. `any` — только
 * «не в корзине» (восстановление сделки).
 */
type ContactUse = 'bind' | 'any'

/**
 * Контакт проекта не в корзине; при `bind` — вне охвата чтения контактов 404, в охвате
 * чтения, но не изменения — 403. Строка блокируется FOR SHARE: удаление контакта
 * (FOR UPDATE) подождёт, а сделка не встанет на контакт, который удаляют.
 */
async function liveContact(
  ctx: DealContext,
  id: string,
  use: ContactUse,
): Promise<Result<{ firstName: string; lastName: string | null }>> {
  const scope = ctx.permissions.scopes.contacts
  let query = ctx.db
    .selectFrom('contact')
    .select(['first_name', 'last_name'])
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
  if (use === 'bind') {
    query = query.where((eb) => contactScopePredicate(eb, scope.read, ctx.viewer))
  }
  const row = await query.forShare().executeTakeFirst()
  if (!row) return refuse(404, 'CONTACT_NOT_FOUND')
  if (use === 'bind' && scope.write !== scope.read) {
    const writable = await ctx.db
      .selectFrom('contact')
      .select('id')
      .where('id', '=', id)
      .where((eb) => contactScopePredicate(eb, scope.write, ctx.viewer))
      .executeTakeFirst()
    if (!writable) return refuse(403, 'PERMISSION_DENIED')
  }
  return ok({ firstName: row.first_name, lastName: row.last_name })
}

async function organizationExists(ctx: DealContext, id: string): Promise<boolean> {
  const row = await ctx.db
    .selectFrom('organization')
    .select('id')
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  return row !== undefined
}

/**
 * Новый ответственный `requested` вместо `current` (undefined — сделка создаётся). Себя на
 * новую сделку или вместо пустого — без особого права («взять в работу»); иначе — право
 * «передача сделок» и новый ответственный в охвате изменения (очередь — всегда). Ответственный
 * — действующий участник проекта.
 */
async function resolveOwner(
  ctx: DealContext,
  requested: string | null,
  current: string | null | undefined,
): Promise<Result<string | null>> {
  if (requested === current) return ok(requested)
  const takesForSelf = requested === ctx.actorId && (current === undefined || current === null)
  if (!takesForSelf) {
    if (!hasStandalone(ctx.permissions, 'transfer_deals')) return refuse(403, 'PERMISSION_DENIED')
    if (!ownerAllowed(requested, ctx.scope.write, ctx.viewer)) {
      return refuse(403, 'PERMISSION_DENIED')
    }
  }
  if (requested === null) return ok(null)
  const member = await ctx.db
    .selectFrom('project_member')
    .select('user_id')
    .where('user_id', '=', requested)
    .where('disabled_at', 'is', null)
    .executeTakeFirst()
  return member ? ok(requested) : refuse(422, 'OWNER_NOT_MEMBER')
}

// ---- Изменение и история --------------------------------------------------------------------

/**
 * Меняет сделку `row` на `set` одной записью и пишет «было → стало» по всем изменившимся
 * полям. `target` — воронка и контакт сделки после изменения (для ответа 409).
 */
async function applyChange(
  ctx: DealContext,
  row: DealRow,
  set: DealSet,
): Promise<Result<DealView>> {
  const before = await dealView(ctx.db, row)
  const target: OpenDealTarget = {
    pipelineId: typeof set.pipeline_id === 'string' ? set.pipeline_id : row.pipeline_id,
    contactId:
      typeof set.primary_contact_id === 'string' ? set.primary_contact_id : row.primary_contact_id,
    excludeId: row.id,
  }
  const written = await guardedWrite(ctx, target, () =>
    ctx.db
      .updateTable('deal')
      .set({ ...set, updated_at: sql`now()` })
      .where('id', '=', row.id)
      .execute(),
  )
  if (!written.ok) return written
  const after = await dealView(ctx.db, await reloadDeal(ctx, row.id))
  await recordChanges(ctx, { type: 'deal', id: row.id }, diffFields(before, after, LOGGED_FIELDS))
  return ok(after)
}

/** Действие над сделкой, которую пользователь может менять: `change` решает, что поменять. */
async function changeDeal(
  ctx: DealContext,
  id: string,
  change: (row: DealRow) => Promise<Result<DealSet | null>>,
): Promise<Result<DealView>> {
  const found = await writableDeal(ctx, id)
  if (!found.ok) return found
  const set = await change(found.value)
  if (!set.ok) return set
  // null — менять нечего (сделка уже в нужном состоянии).
  if (set.value === null) return ok(await dealView(ctx.db, found.value))
  return applyChange(ctx, found.value, set.value)
}

// ---- Создание -------------------------------------------------------------------------------

interface NewDeal {
  title: string
  pipelineId: string
  stageId: string | undefined
  contactId: string
  organizationId: string | null
  amount: number
  currency: DealCurrency
  ownerId: string | null
  expectedCloseDate: string | null
}

async function insertDeal(ctx: DealContext, deal: NewDeal): Promise<Result<DealView>> {
  const place = await placement(ctx, deal.pipelineId, deal.stageId)
  if (!place.ok) return place
  const contact = await liveContact(ctx, deal.contactId, 'bind')
  if (!contact.ok) return contact
  if (deal.organizationId !== null && !(await organizationExists(ctx, deal.organizationId))) {
    return refuse(404, 'ORGANIZATION_NOT_FOUND')
  }
  const owner = await resolveOwner(ctx, deal.ownerId, undefined)
  if (!owner.ok) return owner
  const inserted = await guardedWrite(
    ctx,
    { pipelineId: place.value.pipelineId, contactId: deal.contactId },
    () =>
      ctx.db
        .insertInto('deal')
        .values({
          project_id: ctx.projectId,
          title: deal.title,
          pipeline_id: place.value.pipelineId,
          stage_id: place.value.stageId,
          amount: deal.amount,
          currency: deal.currency,
          owner_id: owner.value,
          primary_contact_id: deal.contactId,
          organization_id: deal.organizationId,
          expected_close_date: deal.expectedCloseDate,
          created_by: ctx.actorId,
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
  )
  if (!inserted.ok) return inserted
  return ok(await dealView(ctx.db, await reloadDeal(ctx, inserted.value.id)))
}

const CREATE_KEYS = [...FIELD_KEYS, 'pipelineId', 'stageId', 'contactId', 'contact']

/**
 * Создать сделку с существующим контактом (`contactId`) или новым (`contact` — тело как у
 * `POST /v1/contacts`, нужно право «контакты: создавать»). Ответственный по умолчанию — сам
 * пользователь. Отказ откатывает и созданный для сделки контакт.
 */
async function createDeal(c: Ctx, ctx: DealContext): Promise<Result<DealView>> {
  const body = await readBody(c)
  if (!body) return invalid('')
  const extra = unknownKey(body, CREATE_KEYS)
  if (extra !== null) return invalid(extra)
  const fields = readFields(body)
  if (!fields.ok) return fields
  if (fields.value.title === undefined) return invalid('title')
  if (fields.value.primaryContactId !== undefined) return invalid('primaryContactId')
  const pipelineId = readUuid(body.pipelineId)
  if (pipelineId === undefined) return invalid('pipelineId')
  const stageId = body.stageId === undefined ? undefined : readUuid(body.stageId)
  if (body.stageId !== undefined && stageId === undefined) return invalid('stageId')
  const hasContactId = body.contactId !== undefined
  const newContact = body.contact
  if (hasContactId === (newContact !== undefined)) return invalid('contactId')
  const contactId = hasContactId ? readUuid(body.contactId) : undefined
  if (hasContactId && contactId === undefined) return invalid('contactId')
  if (
    !hasContactId &&
    (typeof newContact !== 'object' || newContact === null || Array.isArray(newContact))
  ) {
    return invalid('contact')
  }
  if (!hasContactId && !can(ctx.permissions, 'contacts', 'create')) {
    return refuse(403, 'PERMISSION_DENIED')
  }
  const title = fields.value.title

  return rollbackOnRefusal(ctx, async () => {
    let id = contactId
    if (id === undefined) {
      const created = await createContactInRequest(c, newContact as Record<string, unknown>)
      if (!created.ok) return created
      id = created.value.id
    }
    return insertDeal(ctx, {
      title,
      pipelineId,
      stageId,
      contactId: id,
      organizationId: fields.value.organizationId ?? null,
      amount: fields.value.amount ?? 0,
      currency: fields.value.currency ?? DEFAULT_CURRENCY,
      ownerId: fields.value.ownerId === undefined ? ctx.actorId : fields.value.ownerId,
      expectedCloseDate: fields.value.expectedCloseDate ?? null,
    })
  })
}

/** Отказ внутри `fn` откатывает всё, что `fn` успела записать (например, новый контакт). */
async function rollbackOnRefusal<T>(
  ctx: DealContext,
  fn: () => Promise<Result<T>>,
): Promise<Result<T>> {
  await sql`savepoint deal_action`.execute(ctx.db)
  const result = await fn()
  await (result.ok
    ? sql`release savepoint deal_action`
    : sql`rollback to savepoint deal_action`
  ).execute(ctx.db)
  return result
}

/**
 * «Створити допродаж» из выигранной сделки: новая открытая сделка с тем же основным контактом
 * и организацией — в воронке допродаж проекта (или выбранной), на её первом этапе (или
 * выбранном); название по умолчанию «Ім'я Прізвище — допродаж» (решено без владельца —
 * подтвердить). Исходная сделка не меняется.
 */
async function createUpsell(c: Ctx, ctx: DealContext, id: string): Promise<Result<DealView>> {
  const body = (await readBody(c)) ?? {}
  const extra = unknownKey(body, ['pipelineId', 'stageId', 'title'])
  if (extra !== null) return invalid(extra)
  const pipelineId = body.pipelineId === undefined ? undefined : readUuid(body.pipelineId)
  if (body.pipelineId !== undefined && pipelineId === undefined) return invalid('pipelineId')
  const stageId = body.stageId === undefined ? undefined : readUuid(body.stageId)
  if (body.stageId !== undefined && stageId === undefined) return invalid('stageId')
  const title = body.title === undefined ? undefined : requiredText(body.title, MAX_TITLE_LENGTH)
  if (body.title !== undefined && title === undefined) return invalid('title')

  // Исходная сделка — в охвате изменения (вне охвата чтения — 404, как несуществующая):
  // допродажа ставит её контакт в новую сделку пользователя, а с ней — в его охват контактов.
  const source = UUID.test(id) ? await findDeal(ctx, id, ctx.scope.read) : undefined
  if (!source || source.deleted_at !== null) return refuse(404, 'DEAL_NOT_FOUND')
  if (!ownerAllowed(source.owner_id, ctx.scope.write, ctx.viewer)) {
    return refuse(403, 'PERMISSION_DENIED')
  }
  if (source.status !== 'won') return refuse(409, 'DEAL_NOT_WON')
  let target = pipelineId
  if (target === undefined) {
    const upsell = await ctx.db
      .selectFrom('pipeline')
      .select('id')
      .where('is_upsell', '=', true)
      .executeTakeFirst()
    if (!upsell) return refuse(422, 'UPSELL_PIPELINE_MISSING')
    target = upsell.id
  }
  // Здесь — только имя для названия; охват контактов проверит insertDeal (привязка).
  const contact = await liveContact(ctx, source.primary_contact_id, 'any')
  if (!contact.ok) return contact
  const name = [contact.value.firstName, contact.value.lastName].filter(Boolean).join(' ')
  return insertDeal(ctx, {
    title: title ?? `${name} — допродаж`.slice(0, MAX_TITLE_LENGTH),
    pipelineId: target,
    stageId,
    contactId: source.primary_contact_id,
    organizationId: source.organization_id,
    amount: 0,
    currency: DEFAULT_CURRENCY,
    ownerId: ctx.actorId,
    expectedCloseDate: null,
  })
}

// ---- Изменение полей ------------------------------------------------------------------------

async function updateDeal(c: Ctx, ctx: DealContext, id: string): Promise<Result<DealView>> {
  const body = await readBody(c)
  if (!body) return invalid('')
  const extra = unknownKey(body, FIELD_KEYS)
  if (extra !== null) return invalid(extra)
  const fields = readFields(body)
  if (!fields.ok) return fields
  const input = fields.value
  if (Object.keys(input).length === 0) return invalid('')
  return changeDeal(ctx, id, async (row) => {
    const set: DealSet = {}
    if (input.title !== undefined) set.title = input.title
    if (input.amount !== undefined) set.amount = input.amount
    if (input.currency !== undefined) set.currency = input.currency
    if (input.expectedCloseDate !== undefined) set.expected_close_date = input.expectedCloseDate
    if (input.organizationId !== undefined && input.organizationId !== row.organization_id) {
      if (input.organizationId !== null && !(await organizationExists(ctx, input.organizationId))) {
        return refuse(404, 'ORGANIZATION_NOT_FOUND')
      }
      set.organization_id = input.organizationId
    }
    if (input.ownerId !== undefined && input.ownerId !== row.owner_id) {
      const owner = await resolveOwner(ctx, input.ownerId, row.owner_id)
      if (!owner.ok) return owner
      set.owner_id = owner.value
    }
    if (input.primaryContactId !== undefined && input.primaryContactId !== row.primary_contact_id) {
      const contact = await liveContact(ctx, input.primaryContactId, 'bind')
      if (!contact.ok) return contact
      const participant = await ctx.db
        .selectFrom('deal_participant')
        .select('id')
        .where('deal_id', '=', row.id)
        .where('contact_id', '=', input.primaryContactId)
        .executeTakeFirst()
      if (participant) return refuse(409, 'CONTACT_IS_PARTICIPANT')
      set.primary_contact_id = input.primaryContactId
    }
    return ok(set)
  })
}

// ---- Этап, статус, архив, перенос -----------------------------------------------------------

/**
 * Смена этапа в своей воронке: только этап и время смены этапа, статус и сумма — нет. Этап
 * может требовать заполненных полей (`requirements`): не заполнены — 422 со списком, сделка
 * остаётся на месте.
 */
async function changeStage(
  c: Ctx,
  ctx: DealContext,
  id: string,
  requirements: StageRequirements,
): Promise<Result<DealView>> {
  const body = await readBody(c)
  const stageId = readUuid(body?.stageId)
  if (!body || stageId === undefined || unknownKey(body, ['stageId']) !== null) {
    return invalid('stageId')
  }
  return changeDeal(ctx, id, async (row) => {
    if (row.stage_id === stageId) return ok(null)
    const stage = await liveStage(ctx, row.pipeline_id, stageId)
    if (!stage.ok) return stage
    const missing = await requirements.missingFields(ctx.db, row, stageId)
    if (missing.length > 0) {
      return refuse(422, 'STAGE_REQUIREMENTS_MISSING', { fields: missing })
    }
    return ok({ stage_id: stageId, stage_changed_at: sql`now()` })
  })
}

/** Выиграть: статус, won_at; причина и lost_at снимаются. Этап не меняется. */
function win(ctx: DealContext, id: string) {
  return changeDeal(ctx, id, async (row) =>
    ok(
      row.status === 'won'
        ? null
        : { status: 'won', won_at: sql`now()`, lost_at: null, lost_reason_id: null },
    ),
  )
}

/**
 * Проиграть с причиной из справочника проекта, не архивной (и не в архивной группе): без
 * причины или с архивной — 422. Этап не меняется. Проигранной сделке можно сменить причину.
 */
async function lose(c: Ctx, ctx: DealContext, id: string): Promise<Result<DealView>> {
  const body = (await readBody(c)) ?? {}
  const extra = unknownKey(body, ['lostReasonId'])
  if (extra !== null) return invalid(extra)
  if (body.lostReasonId === undefined || body.lostReasonId === null) {
    return refuse(422, 'LOST_REASON_REQUIRED', { path: 'lostReasonId' })
  }
  const reasonId = readUuid(body.lostReasonId)
  if (reasonId === undefined) return invalid('lostReasonId')
  return changeDeal(ctx, id, async (row) => {
    if (row.status === 'lost' && row.lost_reason_id === reasonId) return ok(null)
    const reason = await ctx.db
      .selectFrom('lost_reason as r')
      .innerJoin('lost_reason_group as g', 'g.id', 'r.group_id')
      .select(['r.archived_at as reason_archived', 'g.archived_at as group_archived'])
      .where('r.id', '=', reasonId)
      .executeTakeFirst()
    if (!reason) return refuse(422, 'LOST_REASON_NOT_FOUND', { path: 'lostReasonId' })
    if (reason.reason_archived !== null || reason.group_archived !== null) {
      return refuse(422, 'LOST_REASON_ARCHIVED', { path: 'lostReasonId' })
    }
    return ok(
      row.status === 'lost'
        ? { lost_reason_id: reasonId }
        : { status: 'lost', lost_reason_id: reasonId, lost_at: sql`now()`, won_at: null },
    )
  })
}

/**
 * Открыть заново: статус open, причина, won_at и lost_at снимаются (остаются в истории).
 * Сделка остаётся на своём этапе (решено без владельца — подтвердить).
 */
function reopen(ctx: DealContext, id: string) {
  return changeDeal(ctx, id, async (row) =>
    ok(
      row.status === 'open'
        ? null
        : { status: 'open', lost_reason_id: null, won_at: null, lost_at: null },
    ),
  )
}

/** Архив — отметка: в любом статусе, статус и этап не меняются. */
function setArchived(ctx: DealContext, id: string, archived: boolean) {
  return changeDeal(ctx, id, async (row) => {
    if ((row.archived_at !== null) === archived) return ok(null)
    return ok({ archived_at: archived ? sql`now()` : null })
  })
}

/** Перенос в другую воронку своего проекта: выбранный этап новой воронки или её первый. */
async function moveDeal(c: Ctx, ctx: DealContext, id: string): Promise<Result<DealView>> {
  const body = await readBody(c)
  if (!body) return invalid('')
  const extra = unknownKey(body, ['pipelineId', 'stageId'])
  if (extra !== null) return invalid(extra)
  const pipelineId = readUuid(body.pipelineId)
  if (pipelineId === undefined) return invalid('pipelineId')
  const stageId = body.stageId === undefined ? undefined : readUuid(body.stageId)
  if (body.stageId !== undefined && stageId === undefined) return invalid('stageId')
  return changeDeal(ctx, id, async (row) => {
    const place = await placement(ctx, pipelineId, stageId)
    if (!place.ok) return place
    if (place.value.pipelineId === row.pipeline_id && place.value.stageId === row.stage_id) {
      return ok(null)
    }
    return ok({
      pipeline_id: place.value.pipelineId,
      stage_id: place.value.stageId,
      stage_changed_at: sql`now()`,
    })
  })
}

/**
 * «Взять в работу»: ответственный — сам пользователь, только если его ещё нет. Одним условным
 * UPDATE: из двух одновременных запросов второй ждёт строку, не находит пустого
 * ответственного и получает 409.
 */
async function takeDeal(ctx: DealContext, id: string): Promise<Result<DealView>> {
  if (!UUID.test(id)) return refuse(404, 'DEAL_NOT_FOUND')
  const taken = await ctx.db
    .updateTable('deal')
    .set({ owner_id: ctx.actorId, updated_at: sql`now()` })
    .where('id', '=', id)
    .where('owner_id', 'is', null)
    .where('deleted_at', 'is', null)
    .returning('id')
    .executeTakeFirst()
  if (!taken) {
    // Сделку только что взял другой — и она ушла из охвата «свои»: всё равно 409, а не 404,
    // иначе проигравший в гонке решит, что сделки нет. Ответ без данных сделки.
    const row = await ctx.db
      .selectFrom('deal')
      .select('id')
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()
    return row ? refuse(409, 'DEAL_ALREADY_TAKEN') : refuse(404, 'DEAL_NOT_FOUND')
  }
  await recordChanges(ctx, { type: 'deal', id }, [
    { field: 'ownerId', before: null, after: ctx.actorId },
  ])
  return ok(await dealView(ctx.db, await reloadDeal(ctx, id)))
}

// ---- Корзина --------------------------------------------------------------------------------

function deletedAtChange(before: Date | string | null, after: Date | string | null): FieldChange {
  const iso = (value: Date | string | null) =>
    value === null ? null : new Date(value).toISOString()
  return { field: 'deletedAt', before: iso(before), after: iso(after) }
}

async function trashDeal(ctx: DealContext, id: string): Promise<Result<null>> {
  const found = await writableDeal(ctx, id)
  if (!found.ok) return found
  const { deleted_at } = await ctx.db
    .updateTable('deal')
    .set({ deleted_at: sql`now()`, deleted_by: ctx.actorId })
    .where('id', '=', id)
    .returning('deleted_at')
    .executeTakeFirstOrThrow()
  await recordChanges(ctx, { type: 'deal', id }, [deletedAtChange(null, deleted_at)])
  return ok(null)
}

/**
 * Восстановление из корзины: основной контакт не в корзине (иначе 409 CONTACT_IN_TRASH —
 * сначала контакт), этап открытой сделки действует, «одна открытая сделка» — как при создании.
 */
async function restoreDeal(ctx: DealContext, id: string): Promise<Result<DealView>> {
  const found = await writableDeal(ctx, id, { inTrash: true })
  if (!found.ok) return found
  const row = found.value
  if (row.deleted_at === null) return refuse(409, 'NOT_IN_TRASH')
  const contact = await liveContact(ctx, row.primary_contact_id, 'any')
  if (!contact.ok) return refuse(409, 'CONTACT_IN_TRASH')
  const written = await guardedWrite(
    ctx,
    { pipelineId: row.pipeline_id, contactId: row.primary_contact_id, excludeId: row.id },
    () =>
      ctx.db
        .updateTable('deal')
        .set({ deleted_at: null, deleted_by: null, updated_at: sql`now()` })
        .where('id', '=', id)
        .execute(),
  )
  if (!written.ok) return written
  await recordChanges(ctx, { type: 'deal', id }, [deletedAtChange(row.deleted_at, null)])
  return ok(await dealView(ctx.db, await reloadDeal(ctx, id)))
}

/**
 * Окончательное удаление из корзины (тикет 12): сделка уходит вместе с участниками, строками
 * товаров, заметками, файлами и историей; в журнал опасных действий — только id.
 */
async function purgeDeal(ctx: DealContext, id: string): Promise<Result<null>> {
  const found = await writableDeal(ctx, id, { inTrash: true })
  if (!found.ok) return found
  if (found.value.deleted_at === null) return refuse(409, 'NOT_IN_TRASH')
  await purgeFromTrash(ctx, { type: 'deal', id })
  return ok(null)
}

// ---- Участники ------------------------------------------------------------------------------

function readRole(value: unknown): string | null | undefined {
  return value === undefined ? null : optionalText(value, MAX_ROLE_LENGTH)
}

/** Изменение участников сделки: «было → стало» всем списком (поле participants). */
async function changeParticipants(
  ctx: DealContext,
  id: string,
  change: (row: DealRow) => Promise<Result<unknown>>,
): Promise<Result<DealView>> {
  const found = await writableDeal(ctx, id)
  if (!found.ok) return found
  const before = await dealView(ctx.db, found.value)
  const changed = await change(found.value)
  if (!changed.ok) return changed
  const after = await dealView(ctx.db, found.value)
  await recordChanges(ctx, { type: 'deal', id }, diffFields(before, after, ['participants']))
  return ok(after)
}

async function addParticipant(c: Ctx, ctx: DealContext, id: string): Promise<Result<DealView>> {
  const body = await readBody(c)
  if (!body) return invalid('')
  const extra = unknownKey(body, ['contactId', 'role'])
  if (extra !== null) return invalid(extra)
  const contactId = readUuid(body.contactId)
  if (contactId === undefined) return invalid('contactId')
  const role = readRole(body.role)
  if (role === undefined) return invalid('role')
  return changeParticipants(ctx, id, async (row) => {
    if (row.primary_contact_id === contactId) return refuse(409, 'CONTACT_IS_PRIMARY')
    const contact = await liveContact(ctx, contactId, 'bind')
    if (!contact.ok) return contact
    try {
      await inSavepoint(ctx.db, () =>
        ctx.db
          .insertInto('deal_participant')
          .values({
            project_id: ctx.projectId,
            deal_id: row.id,
            contact_id: contactId,
            role,
            created_by: ctx.actorId,
          })
          .execute(),
      )
    } catch (error) {
      if (sqlState(error) === '23505') return refuse(409, 'PARTICIPANT_EXISTS')
      throw error
    }
    return ok(null)
  })
}

async function updateParticipant(
  c: Ctx,
  ctx: DealContext,
  id: string,
  contactId: string,
): Promise<Result<DealView>> {
  const body = await readBody(c)
  if (!body || body.role === undefined || unknownKey(body, ['role']) !== null) {
    return invalid('role')
  }
  const role = readRole(body.role)
  if (role === undefined) return invalid('role')
  return changeParticipants(ctx, id, async (row) => {
    const updated = UUID.test(contactId)
      ? await ctx.db
          .updateTable('deal_participant')
          .set({ role })
          .where('deal_id', '=', row.id)
          .where('contact_id', '=', contactId)
          .executeTakeFirst()
      : undefined
    return updated && updated.numUpdatedRows > 0n ? ok(null) : refuse(404, 'PARTICIPANT_NOT_FOUND')
  })
}

async function removeParticipant(
  ctx: DealContext,
  id: string,
  contactId: string,
): Promise<Result<DealView>> {
  return changeParticipants(ctx, id, async (row) => {
    const removed = UUID.test(contactId)
      ? await ctx.db
          .deleteFrom('deal_participant')
          .where('deal_id', '=', row.id)
          .where('contact_id', '=', contactId)
          .executeTakeFirst()
      : undefined
    return removed && removed.numDeletedRows > 0n ? ok(null) : refuse(404, 'PARTICIPANT_NOT_FOUND')
  })
}

// ---- Чтение ---------------------------------------------------------------------------------

/** Запись истории сделки «было → стало». */
export interface DealHistoryEntry {
  id: string
  occurredAt: string
  /** Кто изменил; null — система. */
  actorId: string | null
  actorName: string | null
  field: string
  before: unknown
  after: unknown
}

async function visibleDeal(ctx: DealContext, id: string): Promise<DealRow | undefined> {
  const row = UUID.test(id) ? await findDeal(ctx, id, ctx.scope.read) : undefined
  return row && row.deleted_at === null ? row : undefined
}

/** История сделки: новые сверху, `?limit=` — 1…200, по умолчанию 50. */
async function dealHistory(c: Ctx, ctx: DealContext, id: string) {
  const limit = readLimit(c.req.query('limit'))
  if (limit === undefined) return invalid('limit')
  if (!(await visibleDeal(ctx, id))) return refuse(404, 'DEAL_NOT_FOUND')
  const rows = await ctx.db
    .selectFrom('change_log as l')
    .leftJoin('user as u', 'u.id', 'l.actor_id')
    .select(['l.id', 'l.occurred_at', 'l.actor_id', 'u.name', 'l.field', 'l.before', 'l.after'])
    .where('l.entity_type', '=', 'deal')
    .where('l.entity_id', '=', id)
    .orderBy('l.occurred_at', 'desc')
    .orderBy('l.id', 'desc')
    .limit(limit)
    .execute()
  return ok(
    rows.map(
      (r): DealHistoryEntry => ({
        id: r.id,
        occurredAt: new Date(r.occurred_at).toISOString(),
        actorId: r.actor_id,
        actorName: r.name,
        field: r.field,
        before: r.before,
        after: r.after,
      }),
    ),
  )
}

// ---- Маршруты -------------------------------------------------------------------------------

const respond = <T>(c: Ctx, outcome: Result<T>, status: 200 | 201 = 200) =>
  outcome.ok ? c.json(outcome.value as object, status) : fail(c, outcome)

/**
 * Маршруты сделок: `/v1/deals`. `stageRequirements` — какие поля требует этап при смене этапа
 * (по умолчанию — никаких).
 */
export function dealsRoutes({
  stageRequirements = NO_STAGE_REQUIREMENTS,
}: {
  stageRequirements?: StageRequirements
} = {}) {
  const edit = requirePermission('deals', 'edit')
  const view = requirePermission('deals', 'view')
  return (
    new Hono<PermissionsEnv>()
      // Канбан и списки (тикет 11): до `/:id`, иначе `owners` разберётся как id сделки.
      .get('/', view, async (c) => respond(c, await listDeals(c, await dealContext(c))))
      .get('/owners', view, async (c) => respond(c, ok(await dealOwners(await dealContext(c)))))
      .get('/:id', requirePermission('deals', 'view'), async (c) => {
        const ctx = await dealContext(c)
        const row = await visibleDeal(ctx, c.req.param('id'))
        if (!row) return fail(c, refuse(404, 'DEAL_NOT_FOUND'))
        return c.json<DealView>(await dealView(ctx.db, row))
      })
      .get('/:id/history', requirePermission('deals', 'view'), async (c) =>
        respond(c, await dealHistory(c, await dealContext(c), c.req.param('id'))),
      )
      .post('/', requirePermission('deals', 'create'), async (c) =>
        respond(c, await createDeal(c, await dealContext(c)), 201),
      )
      .put('/:id', edit, async (c) =>
        respond(c, await updateDeal(c, await dealContext(c), c.req.param('id'))),
      )
      .post('/:id/stage', edit, async (c) =>
        respond(
          c,
          await changeStage(c, await dealContext(c), c.req.param('id'), stageRequirements),
        ),
      )
      .post('/:id/win', edit, async (c) =>
        respond(c, await win(await dealContext(c), c.req.param('id'))),
      )
      .post('/:id/lose', edit, async (c) =>
        respond(c, await lose(c, await dealContext(c), c.req.param('id'))),
      )
      .post('/:id/reopen', edit, async (c) =>
        respond(c, await reopen(await dealContext(c), c.req.param('id'))),
      )
      .post('/:id/archive', edit, async (c) =>
        respond(c, await setArchived(await dealContext(c), c.req.param('id'), true)),
      )
      .post('/:id/unarchive', edit, async (c) =>
        respond(c, await setArchived(await dealContext(c), c.req.param('id'), false)),
      )
      .post('/:id/move', edit, async (c) =>
        respond(c, await moveDeal(c, await dealContext(c), c.req.param('id'))),
      )
      .post('/:id/take', edit, async (c) =>
        respond(c, await takeDeal(await dealContext(c), c.req.param('id'))),
      )
      .post('/:id/upsell', requirePermission('deals', 'create'), async (c) =>
        respond(c, await createUpsell(c, await dealContext(c), c.req.param('id')), 201),
      )
      .delete('/:id', requirePermission('deals', 'delete'), async (c) => {
        const outcome = await trashDeal(await dealContext(c), c.req.param('id'))
        return outcome.ok ? c.body(null, 204) : fail(c, outcome)
      })
      .post('/:id/restore', requirePermission('trash', 'edit'), async (c) =>
        respond(c, await restoreDeal(await dealContext(c), c.req.param('id'))),
      )
      .delete('/:id/permanent', requirePermission('trash', 'delete'), async (c) => {
        const id = c.req.param('id')
        const outcome = await purgeDeal(await dealContext(c), id)
        if (!outcome.ok) return fail(c, outcome)
        await recordInRequest(c, { action: 'deal.purged', entity: { type: 'deal', id } })
        return c.body(null, 204)
      })
      .post('/:id/participants', edit, async (c) =>
        respond(c, await addParticipant(c, await dealContext(c), c.req.param('id')), 201),
      )
      .put('/:id/participants/:contactId', edit, async (c) =>
        respond(
          c,
          await updateParticipant(
            c,
            await dealContext(c),
            c.req.param('id'),
            c.req.param('contactId'),
          ),
        ),
      )
      .delete('/:id/participants/:contactId', edit, async (c) => {
        const outcome = await removeParticipant(
          await dealContext(c),
          c.req.param('id'),
          c.req.param('contactId'),
        )
        return outcome.ok ? c.body(null, 204) : fail(c, outcome)
      })
      .post('/:id/products', edit, async (c) =>
        respond(c, await addLine(c, await dealContext(c), c.req.param('id')), 201),
      )
      .put('/:id/products/:lineId', edit, async (c) =>
        respond(
          c,
          await updateLine(c, await dealContext(c), c.req.param('id'), c.req.param('lineId')),
        ),
      )
      .delete('/:id/products/:lineId', edit, async (c) => {
        const outcome = await removeLine(
          await dealContext(c),
          c.req.param('id'),
          c.req.param('lineId'),
        )
        return outcome.ok ? c.body(null, 204) : fail(c, outcome)
      })
      .post('/:id/apply-products-total', edit, async (c) => {
        const ctx = await dealContext(c)
        return respond(
          c,
          await changeDeal(ctx, c.req.param('id'), (row) => productsTotalChange(ctx, row)),
        )
      })
  )
}

/** Агрегаты колонок канбана: `/v1/pipelines/:id/aggregates` (монтируется рядом с воронками). */
export function pipelineAggregatesRoutes() {
  return new Hono<PermissionsEnv>().get(
    '/:id/aggregates',
    requirePermission('deals', 'view'),
    async (c) => respond(c, await dealAggregates(c, await dealContext(c), c.req.param('id'))),
  )
}
