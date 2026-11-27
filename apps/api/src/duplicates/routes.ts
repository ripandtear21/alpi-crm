import type { Database } from '@alpi/db'
import {
  can,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  type Page,
  type ResourceScope,
  type Scope,
} from '@alpi/shared'
import { Hono } from 'hono'
import { type Kysely, sql } from 'kysely'
import { requestAuthor } from '../api-keys/actor.ts'
import { type FieldChange, recordChanges } from '../change-log/record.ts'
import { type Ctx, fail, type Outcome, ok, readBody, refuse, UUID } from '../contacts/http.ts'
import { contactScopePredicate } from '../contacts/scope.ts'
import { dealInScope } from '../deals/scope.ts'
import { type PermissionsEnv, requestAccess } from '../middleware/permissions.ts'
import { requestViewer, type Viewer } from '../roles/scope.ts'
import type { DuplicateEntity } from './finder.ts'
import { buildGroups, type DuplicateGroup, type PairRow } from './groups.ts'

// Экран «Дублі» (тикет crm-intake/05; пункт 33): `/v1/duplicates` (снаружи — /api/v1/duplicates).
//
// - GET /?type=contact|deal&cursor=&limit= — группы похожих записей (groups.ts) с причинами и
//   записями; новые находки сверху. GET /count — число групп каждого типа: счётчик в шапке.
// - POST /not-duplicate { type, a_id, b_id } — отметка «не дубль»: пара пропадает и больше не
//   предлагается ни по одной причине; отметка «возможный дубль», связывающая эти два контакта,
//   снимается (решено без владельца — подтвердить). Отметка пишется в историю обеих записей.
// - Объединяет экран существующими запросами слияния (merge/): здесь слияния нет.
// - Права: «контакты: изменять» — группы контактов, «сделки: изменять» — группы сделок (решено
//   без владельца — подтвердить, как разделить «изменять» на два раздела). Группа видна, только
//   если все её записи в охвате изменения пользователя: иначе он не смог бы их объединить, а
//   группа выдала бы запись, которой ему не видно.
// - Только по сессии: маршрутов с отметкой apiKeyRoute здесь нет, ключ API получает 403
//   API_KEY_NOT_ALLOWED (middleware/api-key.ts).
//
// shortcut: группы считаются в коде из не больше MAX_PAIRS самых новых пар проекта на запрос;
// при большем числе пар старые не видны, пока не разобраны новые. Лимит срезает пары до
// построения групп и до проверки охвата, поэтому за ним: группа может распасться на части;
// группа, у которой запись вне охвата связана только отрезанной парой, покажется урезанной —
// без этой записи и её данных, но вопреки правилу «все записи группы в охвате»; счётчик в шапке
// занижен. Перенести в SQL (рекурсивный запрос по парам), если пар в проекте станет больше.

export const MAX_PAIRS = 20_000

export type DuplicatesErrorCode =
  | 'PERMISSION_DENIED'
  /** Неверный запрос: `details.path` — поле. */
  | 'INVALID_DUPLICATES'
  /** Записи пары нет (удалена, слита) или она вне охвата чтения. */
  | 'RECORD_NOT_FOUND'

type Result<T> = Outcome<T, DuplicatesErrorCode>

const RESOURCE = { contact: 'contacts', deal: 'deals' } as const

/** Контакт группы. */
export interface DuplicateContactRecord {
  id: string
  firstName: string
  lastName: string | null
  phones: string[]
  emails: string[]
  createdAt: string
}

/** Сделка группы. */
export interface DuplicateDealRecord {
  id: string
  title: string
  pipelineName: string
  stageName: string
  archived: boolean
  amount: string
  currency: string
  ownerName: string | null
  /** Имя основного контакта; null — контакт вне охвата чтения контактов пользователя. */
  contactName: string | null
  createdAt: string
}

export type DuplicateGroupView = DuplicateGroup & {
  type: DuplicateEntity
  records: (DuplicateContactRecord | DuplicateDealRecord)[]
}

interface Reader {
  db: Kysely<Database>
  scope: ResourceScope
  viewer: Viewer
}

const iso = (value: Date | string) => new Date(value).toISOString()

/**
 * Пары типа `type` между живыми записями — не больше MAX_PAIRS самых новых. Пара сделок — только
 * между открытыми сделками одного основного контакта в одной воронке: закрытие, перенос в другую
 * воронку и смена основного контакта задачи поиска не ставят, строку пары уберёт ночной проход,
 * а экран не показывает её уже сейчас.
 */
async function livePairs(db: Kysely<Database>, type: DuplicateEntity): Promise<PairRow[]> {
  const live =
    type === 'contact'
      ? sql`
          exists (select 1 from contact r where r.id = p.a_id
                  and r.merged_into_id is null and r.deleted_at is null)
          and exists (select 1 from contact r where r.id = p.b_id
                      and r.merged_into_id is null and r.deleted_at is null)`
      : sql`
          exists (
            select 1 from deal x join deal y on y.id = p.b_id
            where x.id = p.a_id
              and x.merged_into_id is null and x.deleted_at is null and x.status = 'open'
              and y.merged_into_id is null and y.deleted_at is null and y.status = 'open'
              and x.primary_contact_id = y.primary_contact_id
              and x.pipeline_id = y.pipeline_id
          )`
  const { rows } = await sql<PairRow>`
    select p.a_id, p.b_id, p.reason, p.found_at
    from duplicate_pair p
    where p.entity_type = ${type} and ${live}
    order by p.found_at desc, p.a_id, p.b_id
    limit ${MAX_PAIRS}
  `.execute(db)
  return rows
}

/** Какие из `ids` в охвате `scope` пользователя. */
async function idsInScope(
  reader: Reader,
  type: DuplicateEntity,
  ids: readonly string[],
  scope: Scope,
): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const rows =
    type === 'contact'
      ? await reader.db
          .selectFrom('contact')
          .select('id')
          .where('id', '=', sql<string>`any(${sql.val(ids)}::uuid[])`)
          .where((eb) => contactScopePredicate(eb, scope, reader.viewer))
          .execute()
      : await reader.db
          .selectFrom('deal')
          .select('id')
          .where('id', '=', sql<string>`any(${sql.val(ids)}::uuid[])`)
          .where(dealInScope(sql.ref('deal.owner_id'), scope, reader.viewer))
          .execute()
  return new Set(rows.map((row) => row.id))
}

/** Группы типа `type`, все записи которых в охвате изменения пользователя. */
async function visibleGroups(reader: Reader, type: DuplicateEntity): Promise<DuplicateGroup[]> {
  const groups = buildGroups(await livePairs(reader.db, type))
  const ids = groups.flatMap((group) => group.recordIds)
  const writable = await idsInScope(reader, type, ids, reader.scope.write)
  return groups.filter((group) => group.recordIds.every((id) => writable.has(id)))
}

async function contactRecords(
  db: Kysely<Database>,
  ids: readonly string[],
): Promise<DuplicateContactRecord[]> {
  const rows = await db
    .selectFrom('contact')
    .select(['id', 'first_name', 'last_name', 'created_at'])
    .where('id', 'in', ids)
    .execute()
  const phones = await db
    .selectFrom('contact_phone')
    .select(['contact_id', 'phone'])
    .where('contact_id', 'in', ids)
    .orderBy('is_primary', 'desc')
    .orderBy('created_at')
    .execute()
  const emails = await db
    .selectFrom('contact_email')
    .select(['contact_id', 'email'])
    .where('contact_id', 'in', ids)
    .orderBy('is_primary', 'desc')
    .orderBy('created_at')
    .execute()
  return rows.map((row) => ({
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    phones: phones.filter((p) => p.contact_id === row.id).map((p) => p.phone),
    emails: emails.filter((e) => e.contact_id === row.id).map((e) => e.email),
    createdAt: iso(row.created_at),
  }))
}

/**
 * Сделки группы. Имя основного контакта — только если контакт в охвате чтения контактов
 * пользователя (`contactsRead`; охват контактов бывает уже охвата сделок), иначе null — как
 * на доске сделок (deals/board.ts).
 */
async function dealRecords(
  db: Kysely<Database>,
  ids: readonly string[],
  contactsRead: Scope,
  viewer: Viewer,
): Promise<DuplicateDealRecord[]> {
  const rows = await db
    .selectFrom('deal as d')
    .innerJoin('pipeline as p', 'p.id', 'd.pipeline_id')
    .innerJoin('stage as s', 's.id', 'd.stage_id')
    .leftJoin('user as u', 'u.id', 'd.owner_id')
    .select([
      'd.id',
      'd.title',
      'p.name as pipeline_name',
      's.name as stage_name',
      'd.archived_at',
      'd.amount',
      'd.currency',
      'u.name as owner_name',
      'd.primary_contact_id',
      'd.created_at',
    ])
    .where('d.id', 'in', ids)
    .execute()
  const contactIds = [...new Set(rows.map((row) => row.primary_contact_id))]
  const contacts = new Map(
    (
      await db
        .selectFrom('contact')
        .select(['id', 'first_name', 'last_name'])
        .where('id', 'in', contactIds)
        .where((eb) => contactScopePredicate(eb, contactsRead, viewer))
        .execute()
    ).map((row) => [row.id, [row.first_name, row.last_name].filter(Boolean).join(' ')]),
  )
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    pipelineName: row.pipeline_name,
    stageName: row.stage_name,
    archived: row.archived_at !== null,
    amount: String(row.amount),
    currency: row.currency,
    ownerName: row.owner_name,
    contactName: contacts.get(row.primary_contact_id) ?? null,
    createdAt: iso(row.created_at),
  }))
}

// ---- Курсор ----------------------------------------------------------------------------------

interface Cursor {
  foundAt: string
  id: string
}

function encodeCursor(group: DuplicateGroup): string {
  return Buffer.from(JSON.stringify({ f: group.foundAt, id: group.id })).toString('base64url')
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const { f, id } = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
    if (typeof f !== 'string' || Number.isNaN(Date.parse(f))) return null
    if (typeof id !== 'string' || !UUID.test(id)) return null
    return { foundAt: new Date(f).toISOString(), id: id.toLowerCase() }
  } catch {
    return null
  }
}

/** Группа после курсора в порядке buildGroups: новые сверху, затем по id. */
const after = (group: DuplicateGroup, cursor: Cursor) =>
  group.foundAt < cursor.foundAt || (group.foundAt === cursor.foundAt && group.id > cursor.id)

// ---- Запросы ---------------------------------------------------------------------------------

function readType(value: unknown): DuplicateEntity | null {
  return value === 'contact' || value === 'deal' ? value : null
}

async function reader(c: Ctx, type: DuplicateEntity): Promise<Reader> {
  const db = c.get('db')
  return {
    db,
    scope: c.get('access').permissions.scopes[RESOURCE[type]],
    viewer: await requestViewer(db, c.get('actor')),
  }
}

/** Права запроса на тип `type`: «изменять» его раздел. */
async function allowed(c: Ctx, type: DuplicateEntity): Promise<boolean> {
  const access = await requestAccess(c)
  return access !== null && can(access.permissions, RESOURCE[type], 'edit')
}

async function listGroups(c: Ctx): Promise<Result<Page<DuplicateGroupView>>> {
  const type = readType(c.req.query('type'))
  if (type === null) return refuse(400, 'INVALID_DUPLICATES', { path: 'type' })
  const rawLimit = c.req.query('limit')
  const limit = rawLimit === undefined ? PAGE_LIMIT_DEFAULT : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT_MAX) {
    return refuse(400, 'INVALID_DUPLICATES', { path: 'limit' })
  }
  const rawCursor = c.req.query('cursor')
  const cursor = rawCursor === undefined ? null : decodeCursor(rawCursor)
  if (rawCursor !== undefined && cursor === null) {
    return refuse(400, 'INVALID_DUPLICATES', { path: 'cursor' })
  }
  if (!(await allowed(c, type))) return refuse(403, 'PERMISSION_DENIED')
  const r = await reader(c, type)
  const groups = await visibleGroups(r, type)
  const rest = cursor === null ? groups : groups.filter((group) => after(group, cursor))
  const page = rest.slice(0, limit)
  const ids = page.flatMap((group) => group.recordIds)
  const records =
    ids.length === 0
      ? []
      : type === 'contact'
        ? await contactRecords(r.db, ids)
        : await dealRecords(r.db, ids, c.get('access').permissions.scopes.contacts.read, r.viewer)
  const byId = new Map(records.map((record) => [record.id, record]))
  const last = page.at(-1)
  return ok({
    data: page.map((group) => ({
      ...group,
      type,
      records: group.recordIds.flatMap((id) => byId.get(id) ?? []),
    })),
    next_cursor: rest.length > limit && last ? encodeCursor(last) : null,
  })
}

/** Число групп каждого типа, видимых пользователю; null — нет права на тип. */
async function countGroups(c: Ctx): Promise<Result<Record<DuplicateEntity, number | null>>> {
  const counts: Record<DuplicateEntity, number | null> = { contact: null, deal: null }
  for (const type of ['contact', 'deal'] as const) {
    if (await allowed(c, type))
      counts[type] = (await visibleGroups(await reader(c, type), type)).length
  }
  if (counts.contact === null && counts.deal === null) return refuse(403, 'PERMISSION_DENIED')
  return ok(counts)
}

/** Отметка «не дубль» в ответе API. */
export interface NotDuplicateView {
  type: DuplicateEntity
  aId: string
  bId: string
  markedAt: string
}

async function markNotDuplicate(c: Ctx): Promise<Result<NotDuplicateView>> {
  const body = await readBody(c)
  if (body === null) return refuse(400, 'INVALID_DUPLICATES', { path: '' })
  for (const key of Object.keys(body)) {
    if (!['type', 'a_id', 'b_id'].includes(key)) {
      return refuse(400, 'INVALID_DUPLICATES', { path: key })
    }
  }
  const type = readType(body.type)
  if (type === null) return refuse(400, 'INVALID_DUPLICATES', { path: 'type' })
  for (const field of ['a_id', 'b_id'] as const) {
    const value = body[field]
    if (typeof value !== 'string' || !UUID.test(value)) {
      return refuse(400, 'INVALID_DUPLICATES', { path: field })
    }
  }
  const [aId, bId] = [String(body.a_id).toLowerCase(), String(body.b_id).toLowerCase()].sort() as [
    string,
    string,
  ]
  if (aId === bId) return refuse(400, 'INVALID_DUPLICATES', { path: 'b_id' })
  if (!(await allowed(c, type))) return refuse(403, 'PERMISSION_DENIED')
  const r = await reader(c, type)
  const { actorId } = requestAuthor(c.get('actor'))
  // Маршрут — только сессия: автор всегда пользователь.
  if (actorId === null) throw new Error('отметка «не дубль» без пользователя')

  // Строки записей — под блокировкой, по порядку id: одновременное слияние этой же пары ждёт.
  const table = type === 'contact' ? 'contact' : 'deal'
  const rows = await r.db
    .selectFrom(table)
    .select(['id', 'merged_into_id', 'deleted_at'])
    .where('id', 'in', [aId, bId])
    .orderBy('id')
    .forUpdate()
    .execute()
  const live = rows.filter((row) => row.merged_into_id === null && row.deleted_at === null)
  if (live.length !== 2) return refuse(404, 'RECORD_NOT_FOUND')
  if ((await idsInScope(r, type, [aId, bId], r.scope.read)).size !== 2) {
    return refuse(404, 'RECORD_NOT_FOUND')
  }
  if ((await idsInScope(r, type, [aId, bId], r.scope.write)).size !== 2) {
    return refuse(403, 'PERMISSION_DENIED')
  }

  const projectId = c.get('projectId')
  const inserted = await r.db
    .insertInto('not_duplicate')
    .values({ project_id: projectId, entity_type: type, a_id: aId, b_id: bId, marked_by: actorId })
    .onConflict((oc) => oc.doNothing())
    .returning('marked_at')
    .executeTakeFirst()
  const marked =
    inserted ??
    (await r.db
      .selectFrom('not_duplicate')
      .select('marked_at')
      .where('entity_type', '=', type)
      .where('a_id', '=', aId)
      .where('b_id', '=', bId)
      .executeTakeFirstOrThrow())
  await r.db
    .deleteFrom('duplicate_pair')
    .where('entity_type', '=', type)
    .where('a_id', '=', aId)
    .where('b_id', '=', bId)
    .execute()
  if (inserted) {
    const author = { db: r.db, projectId, actorId, actorApiKeyId: null }
    for (const [id, other] of [
      [aId, bId],
      [bId, aId],
    ] as const) {
      const changes: FieldChange[] = [{ field: 'notDuplicateOf', before: null, after: other }]
      if (type === 'contact') {
        // Отметка «возможный дубль», которая связывает эту пару, снимается.
        const cleared = await r.db
          .updateTable('contact')
          .set({ possible_duplicate: false, possible_duplicate_of: null, updated_at: sql`now()` })
          .where('id', '=', id)
          .where('possible_duplicate', '=', true)
          .where('possible_duplicate_of', '=', other)
          .executeTakeFirst()
        if (cleared.numUpdatedRows > 0n) {
          changes.unshift({ field: 'possibleDuplicate', before: true, after: false })
        }
      }
      await recordChanges(author, { type, id }, changes)
    }
  }
  return ok({ type, aId, bId, markedAt: iso(marked.marked_at) })
}

function respond<T>(c: Ctx, outcome: Result<T>) {
  return outcome.ok ? c.json(outcome.value as object) : fail(c, outcome)
}

/** Маршруты `/v1/duplicates` (только сессия). */
export function duplicatesRoutes() {
  return new Hono<PermissionsEnv>()
    .get('/', async (c) => respond(c, await listGroups(c)))
    .get('/count', async (c) => respond(c, await countGroups(c)))
    .post('/not-duplicate', async (c) => respond(c, await markNotDuplicate(c)))
}
