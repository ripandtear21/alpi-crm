import type { Database } from '@alpi/db'
import { can, type Page, type Scope } from '@alpi/shared'
import type { z } from '@hono/zod-openapi'
import { OpenAPIHono } from '@hono/zod-openapi'
import { type Kysely, type SqlBool, sql } from 'kysely'
import {
  type Ctx,
  fail,
  type Outcome,
  ok,
  readLimit,
  refuse,
  typed,
  UUID,
} from '../contacts/http.ts'
import { contactScopePredicate } from '../contacts/scope.ts'
import { dealInScope } from '../deals/scope.ts'
import { decodePageCursor, encodePageCursor, isoMicros } from '../filters/page.ts'
import type { PermissionsEnv } from '../middleware/permissions.ts'
import { validationHook } from '../openapi/openapi.ts'
import { requestViewer, type Viewer } from '../roles/scope.ts'
import { type EntityErrorCode, entityFor } from '../timeline/entity.ts'
import {
  contactRegistrationsRoute,
  dealRegistrationsRoute,
  getRegistrationRoute,
  type RegistrationSchema,
} from './openapi.ts'

// Чтение регистраций (тикет crm-intake/09): `/v1/registrations/:id`, `/v1/deals/:id/registrations`
// и `/v1/contacts/:id/registrations`; открыты ключу API и карточкам apps/web.
//
// - Регистрация видна тому, кто видит её сделку: право «сделки: смотреть» (на маршруте) и сделка
//   в охвате чтения, не в корзине и не слитая; иначе 404, как несуществующая (решено без
//   владельца — подтвердить). Регистрация без сделки (сделку удалили окончательно, тикет 06)
//   видна только с охватом сделок «все» (решено без владельца — подтвердить).
// - Регистрации слитой сделки слияние переносит к оставшейся (merge/deal-registry.ts), поэтому
//   отдельной логики для слитых здесь нет: слитая сделка отвечает 404 (entityFor).
// - Имя, телефон и email — null, если контакт регистрации вне охвата чтения контактов или у роли
//   нет права «контакты: смотреть»: так же карточки сделок не показывают имя контакта вне
//   охвата (deals/board.ts; решено без владельца — подтвердить).
// - Чужой проект: запросы идут в транзакции проекта, RLS отдаёт только его строки.

export type RegistrationView = z.infer<typeof RegistrationSchema>

type RegistrationsErrorCode = EntityErrorCode | 'REGISTRATION_NOT_FOUND' | 'INVALID_INPUT'
type Result<T> = Outcome<T, RegistrationsErrorCode>

/** Сортировка выдачи: новые сверху (время прихода в CRM, затем id). */
const REGISTRATIONS_SORT = 'createdAt:desc'

interface Reader {
  db: Kysely<Database>
  viewer: Viewer
  dealScope: Scope
  /** Охват чтения контактов; null — у роли нет права «контакты: смотреть». */
  contactScope: Scope | null
}

async function readerOf(c: Ctx): Promise<Reader> {
  const db = c.get('db')
  const { permissions } = c.get('access')
  return {
    db,
    viewer: await requestViewer(db, c.get('actor')),
    dealScope: permissions.scopes.deals.read,
    contactScope: can(permissions, 'contacts', 'view') ? permissions.scopes.contacts.read : null,
  }
}

/** Строки регистраций, видимые читателю, с названием источника и сделки. */
function selectVisible({ db, dealScope, viewer }: Reader) {
  return db
    .selectFrom('registration as r')
    .innerJoin('intake_source as s', 's.id', 'r.intake_source_id')
    .leftJoin('deal as d', 'd.id', 'r.deal_id')
    .selectAll('r')
    .select(['s.name as source_name', 'd.title as deal_title'])
    .select(isoMicros('r.created_at').as('cursor_at'))
    .where(
      sql<SqlBool>`case when r.deal_id is null then ${dealScope === 'all' ? sql`true` : sql`false`}
        else d.deleted_at is null and d.merged_into_id is null
          and ${dealInScope(sql.ref('d.owner_id'), dealScope, viewer)} end`,
    )
}

type Row = Awaited<ReturnType<ReturnType<typeof selectVisible>['executeTakeFirstOrThrow']>>

/** Контакты из `ids`, которые читатель видит: им — имя, телефон и email регистрации. */
async function visibleContacts(reader: Reader, ids: string[]): Promise<Set<string>> {
  const { contactScope } = reader
  if (contactScope === null || ids.length === 0) return new Set()
  const rows = await reader.db
    .selectFrom('contact')
    .select('id')
    .where('id', 'in', [...new Set(ids)])
    .where((eb) => contactScopePredicate(eb, contactScope, reader.viewer))
    .execute()
  return new Set(rows.map((row) => row.id))
}

const iso = (value: Date | null) => (value === null ? null : new Date(value).toISOString())

function toView(row: Row, contactVisible: boolean): RegistrationView {
  const person = <T>(value: T) => (contactVisible ? value : null)
  return {
    id: row.id,
    sourceId: row.intake_source_id,
    sourceName: row.source_name,
    contactId: row.contact_id,
    dealId: row.deal_id,
    dealTitle: row.deal_id === null ? null : row.deal_title,
    eventId: row.event_id,
    createdAt: new Date(row.created_at).toISOString(),
    registeredAt: iso(row.registered_at),
    name: person(row.name),
    phone: person(row.phone),
    phoneRaw: person(row.phone_raw),
    dialCode: person(row.dial_code),
    email: person(row.email),
    form: row.form,
    webinar: row.webinar,
    planName: row.plan_name,
    pageUrl: row.page_url,
    referrer: row.referrer,
    utmSource: row.utm_source,
    utmMedium: row.utm_medium,
    utmCampaign: row.utm_campaign,
    utmTerm: row.utm_term,
    utmContent: row.utm_content,
    adId: row.ad_id,
    gclid: row.gclid,
    gbraid: row.gbraid,
    wbraid: row.wbraid,
    fbclid: row.fbclid,
    fbp: row.fbp,
    fbc: row.fbc,
    userAgent: row.user_agent,
    extra: row.extra,
    // shortcut: просмотр вебинара всегда null — столбцы view_* добавляет миграция 0030 тикета
    // crm-intake/08, её ещё нет в main; подключить (view_started_at, view_finished_at,
    // view_minutes, view_extra, view_updated_at; null view_updated_at — просмотра не было),
    // когда тикет 08 сольётся.
    view: null,
  }
}

async function toViews(reader: Reader, rows: Row[]): Promise<RegistrationView[]> {
  const contacts = await visibleContacts(
    reader,
    rows.map((row) => row.contact_id),
  )
  return rows.map((row) => toView(row, contacts.has(row.contact_id)))
}

async function getRegistration(c: Ctx, id: string): Promise<Result<RegistrationView>> {
  if (!UUID.test(id)) return refuse(404, 'REGISTRATION_NOT_FOUND')
  const reader = await readerOf(c)
  const row = await selectVisible(reader).where('r.id', '=', id.toLowerCase()).executeTakeFirst()
  if (!row) return refuse(404, 'REGISTRATION_NOT_FOUND')
  const [view] = await toViews(reader, [row])
  return view ? ok(view) : refuse(404, 'REGISTRATION_NOT_FOUND')
}

/**
 * Страница регистраций записи `type` с id `id` (сделка или контакт в охвате чтения), новые
 * сверху.
 */
async function recordRegistrations(
  c: Ctx,
  type: 'deal' | 'contact',
  id: string,
): Promise<Result<Page<RegistrationView>>> {
  // Форму `limit` уже проверила схема маршрута (PageQuerySchema); курсор разбирается здесь.
  const limit = readLimit(c.req.query('limit'))
  if (limit === undefined) return refuse(400, 'INVALID_INPUT', { path: 'limit' })
  const rawCursor = c.req.query('cursor')
  const cursor =
    rawCursor === undefined
      ? undefined
      : decodePageCursor(rawCursor, REGISTRATIONS_SORT, 'timestamptz')
  if (rawCursor !== undefined && !cursor) return refuse(400, 'INVALID_INPUT', { path: 'cursor' })
  const entity = await entityFor(c, type, id, 'read')
  if (!entity.ok) return entity
  const reader = await readerOf(c)
  let query = selectVisible(reader)
    .where(type === 'deal' ? 'r.deal_id' : 'r.contact_id', '=', entity.value.id)
    .orderBy('r.created_at', 'desc')
    .orderBy('r.id', 'desc')
    .limit(limit + 1)
  if (cursor) {
    query = query.where(
      sql<SqlBool>`(r.created_at, r.id) < (${cursor.v}::timestamptz, ${cursor.id}::uuid)`,
    )
  }
  const rows = await query.execute()
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return ok({
    data: await toViews(reader, page),
    next_cursor:
      rows.length > limit && last
        ? encodePageCursor(REGISTRATIONS_SORT, { v: last.cursor_at, id: last.id })
        : null,
  })
}

/** Маршруты регистраций; монтируются на `/v1` (пути — полные: `/registrations/{id}`, …). */
export function registrationsRoutes() {
  const respond = <T>(c: Ctx, outcome: Result<T>) =>
    typed(outcome.ok ? c.json(outcome.value as object, 200) : fail(c, outcome))
  const app = new OpenAPIHono<PermissionsEnv>()
  app.openapi(
    getRegistrationRoute,
    async (c) => respond(c, await getRegistration(c, c.req.param('id') ?? '')),
    validationHook,
  )
  app.openapi(
    dealRegistrationsRoute,
    async (c) => respond(c, await recordRegistrations(c, 'deal', c.req.param('id') ?? '')),
    validationHook,
  )
  app.openapi(
    contactRegistrationsRoute,
    async (c) => respond(c, await recordRegistrations(c, 'contact', c.req.param('id') ?? '')),
    validationHook,
  )
  return app
}
