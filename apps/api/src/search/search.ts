import type { Database } from '@alpi/db'
import { can, normalizePhone, type Scope } from '@alpi/shared'
import { Hono } from 'hono'
import { type Kysely, type RawBuilder, sql } from 'kysely'
import { type Ctx, fail, likePattern, refuse } from '../contacts/http.ts'
import { contactScopePredicate } from '../contacts/scope.ts'
import { dealInScope } from '../deals/scope.ts'
import type { DealStatus } from '../deals/store.ts'
import { problem } from '../http/problem.ts'
import type { PermissionsEnv } from '../middleware/permissions.ts'
import { isoOrNull } from '../pipelines/directory.ts'
import { loadMemberAccess, type MemberAccess } from '../roles/access.ts'
import { PROJECT_TEAMS, resolveViewer, type Viewer } from '../roles/scope.ts'

// Быстрый поиск (тикет crm-deals/08; spec.md MVP, раздел 5.4): `GET /v1/search?q=…` (снаружи —
// /api/v1/search) по сделкам, контактам и организациям текущего проекта. Ничего не меняет и
// событий не отправляет (ADR 0003).
//
// - Вид запроса: с «@» — email контакта; из цифр (хотя бы одной), пробелов, скобок, «+», «-»
//   и «.» — телефон контакта; остальное — название сделки, имя и фамилия контакта, название
//   организации.
// - Телефон, который normalizePhone приводит к E.164, ищется по номеру точно; неполный номер
//   (`067123`) — по его цифрам как подстроке номера в E.164 (решено без владельца —
//   подтвердить; результат тикета crm-deals/08).
// - Текст — подстрока (ILIKE) или похожие слова (оператор <% pg_trgm): находит часть фамилии
//   с опечаткой. Выше — более похожие (word_similarity).
// - Кандидатов выбирают представления *_search (packages/db/migrations/0015_search.ts): только
//   через них триграммный индекс работает под row-level security. Подзапрос с OFFSET 0 —
//   граница для планировщика: иначе он сливает представление с той же таблицей запроса
//   (устранение самосоединения, PostgreSQL 18) и снова читает её под политикой без индекса.
// - Охват — в самом запросе: сделки — охват чтения сделок плюс общая очередь (deals/scope.ts),
//   контакты — охват чтения контактов (contacts/scope.ts), организации — право «смотреть».
//   Скрытое не попадает ни в выдачу, ни в признак «есть ещё»: берётся GROUP_SIZE + 1 строк уже
//   после охвата. Корзина не находится; архивные сделки находятся с отметкой archivedAt.

/** Короче — пустой ответ. */
const MIN_QUERY_LENGTH = 2
/** Длиннее — 400: строка поиска в шапке столько не вводит. */
const MAX_QUERY_LENGTH = 200
/** Сколько результатов в группе. */
const GROUP_SIZE = 10
/**
 * Порог оператора <% (pg_trgm.word_similarity_threshold) на время запроса. Стандартный 0.6
 * не находит часть фамилии с одной опечаткой в середине: «Вигоданенк» к «Вигаданенко» — 0.5,
 * «Ковеленк» к «Коваленко» — 0.55. При 0.4 непохожее остаётся за порогом («Петренко» к
 * «Вигаданенко» — 0.3), а выше в выдаче всё равно стоят более похожие.
 */
const WORD_SIMILARITY_THRESHOLD = 0.4

const PHONE_LIKE = /^\+?[\d\s().-]+$/

/** Группа результатов одного типа. */
export interface SearchGroup<T> {
  items: T[]
  /** Есть ещё результаты этого типа сверх показанных (в охвате пользователя). */
  hasMore: boolean
}

export interface DealHit {
  id: string
  title: string
  status: DealStatus
  /** Отметка архива; null — не в архиве. */
  archivedAt: string | null
}

export interface ContactHit {
  id: string
  firstName: string
  lastName: string | null
}

export interface OrganizationHit {
  id: string
  name: string
}

/** Ответ `GET /v1/search`. */
export interface SearchResponse {
  deals: SearchGroup<DealHit>
  contacts: SearchGroup<ContactHit>
  organizations: SearchGroup<OrganizationHit>
}

/** Что ищем: текст (`q` как есть и подстрока `pattern` для ILIKE), email или телефон. */
type SearchQuery =
  | { kind: 'text'; q: string; pattern: string }
  | { kind: 'email'; pattern: string }
  | { kind: 'phone'; e164: string }
  | { kind: 'phone-digits'; pattern: string }

export function parseQuery(q: string): SearchQuery {
  if (q.includes('@')) return { kind: 'email', pattern: likePattern(q.toLowerCase()) }
  if (PHONE_LIKE.test(q) && /\d/.test(q)) {
    const e164 = normalizePhone(q)
    if (e164 !== null) return { kind: 'phone', e164 }
    return { kind: 'phone-digits', pattern: likePattern(q.replace(/\D/g, '')) }
  }
  return { kind: 'text', q, pattern: likePattern(q) }
}

const empty = <T>(): SearchGroup<T> => ({ items: [], hasMore: false })

function group<T>(rows: T[]): SearchGroup<T> {
  return { items: rows.slice(0, GROUP_SIZE), hasMore: rows.length > GROUP_SIZE }
}

/** Подзапрос id кандидатов из представления `view` (столбцы id, text) по условию `match`. */
function candidates(view: string, match: RawBuilder<unknown>) {
  return sql<string>`(select id from ${sql.table(view)} where ${match} offset 0)`
}

/** Текст похож на запрос: подстрока или похожие слова (индекс gin_trgm_ops). */
function textMatch(query: Extract<SearchQuery, { kind: 'text' }>) {
  return sql`(text ilike ${query.pattern} or ${query.q} <% text)`
}

const CONTACT_NAME = sql`contact.first_name || ' ' || coalesce(contact.last_name, '')`

export function dealsQuery(db: Kysely<Database>, query: SearchQuery, scope: Scope, viewer: Viewer) {
  if (query.kind !== 'text') return null
  return (
    db
      .selectFrom('deal')
      .select(['id', 'title', 'status', 'archived_at'])
      .where('id', 'in', candidates('deal_search', textMatch(query)))
      .where('deleted_at', 'is', null)
      // Слитая сделка скрыта (тикет crm-intake/02).
      .where('merged_into_id', 'is', null)
      .where(dealInScope(sql.ref('deal.owner_id'), scope, viewer))
      .orderBy(sql`word_similarity(${query.q}, title)`, 'desc')
      .orderBy('title')
      .orderBy('id')
      .limit(GROUP_SIZE + 1)
  )
}

export function contactsQuery(
  db: Kysely<Database>,
  query: SearchQuery,
  scope: Scope,
  viewer: Viewer,
) {
  const ids =
    query.kind === 'text'
      ? candidates('contact_search', textMatch(query))
      : query.kind === 'email'
        ? candidates('contact_email_search', sql`text like ${query.pattern}`)
        : query.kind === 'phone-digits'
          ? candidates('contact_phone_search', sql`text like ${query.pattern}`)
          : // Полный номер — точное равенство: обычный индекс contact_phone_search_idx работает
            // и под политикой.
            sql<string>`(select contact_id from contact_phone where phone = ${query.e164})`
  let ordered = db
    .selectFrom('contact')
    .select(['id', 'first_name', 'last_name'])
    .where('id', 'in', ids)
    .where('deleted_at', 'is', null)
    .where((eb) => contactScopePredicate(eb, scope, viewer))
  // Телефон и email совпадают целиком или подстрокой — похожесть имени тут ни при чём.
  if (query.kind === 'text') {
    ordered = ordered.orderBy(sql`word_similarity(${query.q}, ${CONTACT_NAME})`, 'desc')
  }
  return ordered
    .orderBy('first_name')
    .orderBy('last_name')
    .orderBy('id')
    .limit(GROUP_SIZE + 1)
}

export function organizationsQuery(db: Kysely<Database>, query: SearchQuery) {
  if (query.kind !== 'text') return null
  return db
    .selectFrom('organization')
    .select(['id', 'name'])
    .where('id', 'in', candidates('organization_search', textMatch(query)))
    .where('deleted_at', 'is', null)
    .orderBy(sql`word_similarity(${query.q}, name)`, 'desc')
    .orderBy('name')
    .orderBy('id')
    .limit(GROUP_SIZE + 1)
}

async function search(c: Ctx, query: SearchQuery): Promise<SearchResponse | null> {
  const db = c.get('db')
  const userId = c.get('session').user.id
  const access =
    (c.get('access') as MemberAccess | undefined) ?? (await loadMemberAccess(db, userId))
  // projectContext уже проверил участие; пропасть оно могло только в этой же транзакции.
  if (!access) return null
  const { permissions } = access
  const viewer = await resolveViewer(db, userId, PROJECT_TEAMS)
  // Только до конца транзакции запроса (третий аргумент true).
  await sql`select set_config('pg_trgm.word_similarity_threshold', ${String(WORD_SIMILARITY_THRESHOLD)}, true)`.execute(
    db,
  )

  const deals = can(permissions, 'deals', 'view')
    ? dealsQuery(db, query, permissions.scopes.deals.read, viewer)
    : null
  const contacts = can(permissions, 'contacts', 'view')
    ? contactsQuery(db, query, permissions.scopes.contacts.read, viewer)
    : null
  const organizations = can(permissions, 'organizations', 'view')
    ? organizationsQuery(db, query)
    : null

  // Запросы идут по очереди: у транзакции проекта одно соединение.
  const dealRows = deals ? await deals.execute() : []
  const contactRows = contacts ? await contacts.execute() : []
  const organizationRows = organizations ? await organizations.execute() : []
  return {
    deals: group(
      dealRows.map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status as DealStatus,
        archivedAt: isoOrNull(row.archived_at),
      })),
    ),
    contacts: group(
      contactRows.map((row) => ({
        id: row.id,
        firstName: row.first_name,
        lastName: row.last_name,
      })),
    ),
    organizations: group(organizationRows.map((row) => ({ id: row.id, name: row.name }))),
  }
}

/** Маршрут поиска: `/v1/search`. */
export function searchRoutes() {
  return new Hono<PermissionsEnv>().get('/', async (c) => {
    const q = c.req.query('q')?.trim() ?? ''
    if (q.length > MAX_QUERY_LENGTH) return fail(c, refuse(400, 'INVALID_SEARCH', { path: 'q' }))
    if (q.length < MIN_QUERY_LENGTH) {
      return c.json<SearchResponse>({ deals: empty(), contacts: empty(), organizations: empty() })
    }
    const result = await search(c, parseQuery(q))
    if (!result) return problem(c, 403, 'PERMISSION_DENIED')
    return c.json<SearchResponse>(result)
  })
}
