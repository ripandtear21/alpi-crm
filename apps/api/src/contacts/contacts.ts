import type { ContactTable, Database } from '@alpi/db'
import {
  type CustomFieldErrorCode,
  normalizeEmail,
  normalizePhone,
  type ResourceScope,
  type RolePermissions,
  type Scope,
} from '@alpi/shared'
import { Hono } from 'hono'
import { type Kysely, type Selectable, sql } from 'kysely'
import { audit } from '../audit/record.ts'
import {
  type ChangeAuthor,
  diffFields,
  type FieldChange,
  purgeFromTrash,
  recordChanges,
} from '../change-log/record.ts'
import type { FieldViewer } from '../fields/access.ts'
import {
  type CustomValues,
  changesCustom,
  customInsert,
  customUpdate,
  finishCustom,
  prepareCustom,
  readCustomInput,
  visibleCustom,
} from '../fields/values.ts'
import { type PermissionsEnv, requirePermission } from '../middleware/permissions.ts'
import { PROJECT_TEAMS, resolveViewer, type Viewer } from '../roles/scope.ts'
import {
  type ContactDependents,
  type DependentRecord,
  type DependentRefusal,
  NO_CONTACT_DEPENDENTS,
} from './dependents.ts'
import {
  type Ctx,
  fail,
  likePattern,
  type Outcome,
  ok,
  optionalText,
  readBody,
  readLimit,
  refuse,
  requiredText,
  UUID,
} from './http.ts'
import { findContactMatch } from './match.ts'
import { contactScopePredicate } from './scope.ts'

// Контакты проекта (тикет crm-deals/03; spec.md, разделы 3.2 и 4): маршруты `/v1/contacts`
// (снаружи — /api/v1/contacts: прокси Vite и Caddy снимают префикс /api).
//
// - Права — часть системы `contacts`; восстановить из корзины — «корзина: изменять»,
//   окончательно удалить — «корзина: удалять».
// - Охват чтения и изменения — contacts/scope.ts. Контакт вне охвата чтения — 404, как
//   несуществующий; в охвате чтения, но не изменения — 403.
// - Телефоны и email: первый в списке — основной. Совпал телефон с другим контактом — 409:
//   с видимым — CONTACT_EXISTS со ссылкой на него, с контактом вне охвата — CONTACT_OUT_OF_SCOPE
//   без каких-либо его данных («чужой клиент»): только имя менеджера его открытой сделки
//   («клиент уже в работе у <менеджер>», spec.md, раздел 4), если такая сделка есть.
//   Совпал только email — контакт пишется с отметкой «возможный дубль» (решено без владельца,
//   подтвердить).
// - Контакт, основной в сделках, уходит в корзину только вместе с ними: первый запрос отвечает
//   409 CONTACT_HAS_DEALS со списком сделок, второй с подтверждением (`?confirm=<id сделок>`)
//   удаляет. Восстановление контакта возвращает сделки, удалённые вместе с ним.
// - Каждое изменение полей пишется в change_log той же транзакцией; окончательное удаление —
//   ещё и в журнал опасных действий (audit_log), а история записи стирается.
// - CRM сама ничего не делает и событий не шлёт (ADR 0003).

export type ContactsErrorCode =
  | 'PERMISSION_DENIED'
  | 'INVALID_CONTACT'
  /** Телефон не разбирается как номер. */
  | 'INVALID_PHONE'
  | 'INVALID_EMAIL'
  | 'CONTACT_NOT_FOUND'
  /** Телефон уже у видимого контакта: `details.contactId`. */
  | 'CONTACT_EXISTS'
  /** Телефон у контакта вне охвата: без его данных, `details.managerName` — если он в работе. */
  | 'CONTACT_OUT_OF_SCOPE'
  /** Контакт основной в сделках: `details.deals` — что уйдёт в корзину вместе с ним. */
  | 'CONTACT_HAS_DEALS'
  /**
   * Восстановление: открытая сделка контакта (`details.dealId`) стоит на удалённом этапе —
   * контакт остаётся в корзине, пока сделку не перенесут.
   */
  | 'STAGE_DELETED'
  | 'ORGANIZATION_NOT_FOUND'
  /** Восстановить или окончательно удалить можно только запись из корзины. */
  | 'NOT_IN_TRASH'
  /** Значения пользовательских полей (`custom`, fields/values.ts). */
  | CustomFieldErrorCode

type Result<T> = Outcome<T, ContactsErrorCode>

export const CONTACT_LANGUAGES = ['uk', 'ru'] as const
export type ContactLanguage = (typeof CONTACT_LANGUAGES)[number]

/** Контакт в ответах API. */
export interface ContactView {
  id: string
  firstName: string
  lastName: string | null
  /** Язык общения; null — не указан. */
  language: ContactLanguage | null
  organizationId: string | null
  possibleDuplicate: boolean
  /** E.164, основной — первым. */
  phones: string[]
  /** В нижнем регистре, основной — первым. */
  emails: string[]
  /** Значения пользовательских полей по коду (fields/values.ts). */
  custom: CustomValues
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

/** Поля, изменения которых пишутся в журнал изменений. */
const LOGGED_FIELDS = [
  'firstName',
  'lastName',
  'language',
  'organizationId',
  'possibleDuplicate',
  'phones',
  'emails',
] as const satisfies readonly (keyof ContactView)[]

const MAX_NAME_LENGTH = 100
/** Наибольшее число телефонов и email у контакта. */
const MAX_KEYS = 10

/** Изменяемые поля контакта; при изменении отсутствующее поле не меняется. */
interface ContactInput {
  firstName?: string
  lastName?: string | null
  language?: ContactLanguage | null
  organizationId?: string | null
  phones?: string[]
  emails?: string[]
  /** Значения пользовательских полей: меняются только переданные коды. */
  custom?: CustomValues
}

const INPUT_FIELDS = new Set([
  'firstName',
  'lastName',
  'language',
  'organizationId',
  'phones',
  'emails',
  'custom',
])

/** Список ключей: строки, не больше MAX_KEYS, нормализованные и без повторов. */
function parseKeys(value: unknown, field: 'phones' | 'emails'): Result<string[]> {
  if (!Array.isArray(value) || value.length > MAX_KEYS) {
    return refuse(400, 'INVALID_CONTACT', { path: field })
  }
  const keys: string[] = []
  for (const [index, raw] of value.entries()) {
    if (typeof raw !== 'string')
      return refuse(400, 'INVALID_CONTACT', { path: `${field}.${index}` })
    const key = field === 'phones' ? normalizePhone(raw) : normalizeEmail(raw)
    if (key === null) {
      return refuse(422, field === 'phones' ? 'INVALID_PHONE' : 'INVALID_EMAIL', {
        path: `${field}.${index}`,
      })
    }
    if (!keys.includes(key)) keys.push(key)
  }
  return ok(keys)
}

/** Тело создания (`create`) или изменения контакта. */
function parseInput(body: Record<string, unknown>, create: boolean): Result<ContactInput> {
  const invalid = (path: string) => refuse(400, 'INVALID_CONTACT', { path })
  for (const key of Object.keys(body)) {
    if (!INPUT_FIELDS.has(key)) return invalid(key)
  }
  const input: ContactInput = {}
  if (create || body.firstName !== undefined) {
    const firstName = requiredText(body.firstName, MAX_NAME_LENGTH)
    if (firstName === undefined) return invalid('firstName')
    input.firstName = firstName
  }
  if (body.lastName !== undefined) {
    const lastName = optionalText(body.lastName, MAX_NAME_LENGTH)
    if (lastName === undefined) return invalid('lastName')
    input.lastName = lastName
  }
  if (body.language !== undefined) {
    const language = body.language
    if (language !== null && !CONTACT_LANGUAGES.some((l) => l === language)) {
      return invalid('language')
    }
    input.language = language as ContactLanguage | null
  }
  if (body.organizationId !== undefined) {
    // Организация одна: ни список, ни второй id сюда не пройдут.
    const id = body.organizationId
    if (id !== null && (typeof id !== 'string' || !UUID.test(id))) return invalid('organizationId')
    input.organizationId = id
  }
  for (const field of ['phones', 'emails'] as const) {
    if (body[field] === undefined) continue
    const keys = parseKeys(body[field], field)
    if (!keys.ok) return keys
    input[field] = keys.value
  }
  const custom = readCustomInput(body.custom)
  if (custom === null) return invalid('custom')
  if (custom !== undefined) input.custom = custom
  if (!create && Object.keys(input).length === 0) return invalid('')
  return ok(input)
}

/** Запрос в контексте проекта: кто меняет, его охват, транзакция. */
export interface ContactContext extends ChangeAuthor {
  actorId: string
  ip: string | null
  scope: ResourceScope
  permissions: RolePermissions
  viewer: Viewer
  dependents: ContactDependents
}

async function contactContext(c: Ctx, dependents: ContactDependents): Promise<ContactContext> {
  const db = c.get('db')
  const userId = c.get('session').user.id
  return {
    db,
    projectId: c.get('projectId'),
    actorId: userId,
    ip: c.get('clientIp'),
    scope: c.get('access').permissions.scopes.contacts,
    permissions: c.get('access').permissions,
    viewer: await resolveViewer(db, userId, PROJECT_TEAMS),
    dependents,
  }
}

type ContactRow = Selectable<ContactTable>

/** Контакт `id` в охвате `scope` (в корзине или нет); `lock` — заблокировать строку. */
function findContact(ctx: ContactContext, id: string, scope: Scope, lock = false) {
  const query = ctx.db
    .selectFrom('contact')
    .selectAll()
    .where('id', '=', id)
    .where((eb) => contactScopePredicate(eb, scope, ctx.viewer))
  return (lock ? query.forUpdate() : query).executeTakeFirst()
}

/**
 * Контакт, который пользователь может менять: вне охвата чтения — 404, вне охвата
 * изменения — 403. Строка блокируется до конца транзакции.
 */
async function writableContact(ctx: ContactContext, id: string): Promise<Result<ContactRow>> {
  if (!UUID.test(id)) return refuse(404, 'CONTACT_NOT_FOUND')
  const row = await findContact(ctx, id, ctx.scope.read, true)
  if (!row) return refuse(404, 'CONTACT_NOT_FOUND')
  if (ctx.scope.write !== ctx.scope.read && !(await findContact(ctx, id, ctx.scope.write))) {
    return refuse(403, 'PERMISSION_DENIED')
  }
  return ok(row)
}

const iso = (value: Date | string) => new Date(value).toISOString()

/** Ответ API для строк контактов: телефоны и email — одним запросом на всех. */
async function contactViews(viewer: FieldViewer, rows: ContactRow[]): Promise<ContactView[]> {
  const { db } = viewer
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.id)
  const phones = await db
    .selectFrom('contact_phone')
    .select(['contact_id', 'phone as key'])
    .where('contact_id', 'in', ids)
    .orderBy('is_primary', 'desc')
    .orderBy('phone')
    .execute()
  const emails = await db
    .selectFrom('contact_email')
    .select(['contact_id', 'email as key'])
    .where('contact_id', 'in', ids)
    .orderBy('is_primary', 'desc')
    .orderBy('email')
    .execute()
  const group = (list: { contact_id: string; key: string }[]) => {
    const byContact = new Map<string, string[]>()
    for (const { contact_id, key } of list) {
      byContact.set(contact_id, [...(byContact.get(contact_id) ?? []), key])
    }
    return byContact
  }
  const phonesOf = group(phones)
  const emailsOf = group(emails)
  const custom = await visibleCustom(
    viewer,
    'contact',
    rows.map((row) => row.custom),
  )
  return rows.map((row, index) => ({
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    language: row.language as ContactLanguage | null,
    organizationId: row.organization_id,
    possibleDuplicate: row.possible_duplicate,
    phones: phonesOf.get(row.id) ?? [],
    emails: emailsOf.get(row.id) ?? [],
    custom: custom[index] ?? {},
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }))
}

async function contactView(viewer: FieldViewer, row: ContactRow): Promise<ContactView> {
  const [view] = await contactViews(viewer, [row])
  if (!view) throw new Error('контакт пропал в той же транзакции')
  return view
}

async function reload(ctx: ContactContext, id: string): Promise<ContactRow> {
  return ctx.db.selectFrom('contact').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}

/** Организация есть в проекте и не в корзине. */
async function organizationExists(db: Kysely<Database>, id: string): Promise<boolean> {
  const row = await db
    .selectFrom('organization')
    .select('id')
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  return row !== undefined
}

/**
 * Одновременные запросы с одним телефоном проверяют совпадение по очереди: блокировка на
 * номер в проекте до конца транзакции. Порядок номеров — один, чтобы не было взаимной
 * блокировки.
 */
async function lockPhones(ctx: ContactContext, phones: readonly string[]): Promise<void> {
  for (const phone of [...phones].sort()) {
    await sql`
      select pg_advisory_xact_lock(hashtextextended(${`contact_phone:${ctx.projectId}:${phone}`}, 0))
    `.execute(ctx.db)
  }
}

/**
 * Менеджер открытой сделки контакта (он основной): «клиент уже в работе у <менеджер>». Сначала
 * неархивная, затем самая новая; сделки общей очереди менеджера не имеют. null — таких нет.
 */
async function openDealManager(db: Kysely<Database>, contactId: string): Promise<string | null> {
  const row = await db
    .selectFrom('deal as d')
    .innerJoin('user as u', 'u.id', 'd.owner_id')
    .select('u.name')
    .where('d.primary_contact_id', '=', contactId)
    .where('d.status', '=', 'open')
    .where('d.deleted_at', 'is', null)
    .orderBy(sql`d.archived_at is null`, 'desc')
    .orderBy('d.created_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  return row?.name ?? null
}

/**
 * Телефон совпал с контактом `contactId`: ссылка на него или «чужой клиент» — без данных
 * контакта и сделки, только имя менеджера, у которого он в работе.
 */
async function phoneTaken(ctx: ContactContext, contactId: string): Promise<Result<never>> {
  const visible = await findContact(ctx, contactId, ctx.scope.read)
  if (visible) return refuse(409, 'CONTACT_EXISTS', { contactId })
  const managerName = await openDealManager(ctx.db, contactId)
  return managerName === null
    ? refuse(409, 'CONTACT_OUT_OF_SCOPE')
    : refuse(409, 'CONTACT_OUT_OF_SCOPE', { managerName })
}

/**
 * Совпадения по новым ключам: телефон — отказ, только email — отметка «возможный дубль».
 * `excludeId` — сам изменяемый контакт.
 */
async function checkKeys(
  ctx: ContactContext,
  phones: readonly string[],
  emails: readonly string[],
  excludeId?: string,
): Promise<Result<{ emailMatched: boolean }>> {
  await lockPhones(ctx, phones)
  const match = await findContactMatch(
    ctx.db,
    { phones, emails },
    excludeId === undefined ? {} : { excludeId },
  )
  if (match?.by === 'phone') return phoneTaken(ctx, match.contactId)
  return ok({ emailMatched: match?.by === 'email' })
}

/** Заменяет телефоны или email контакта; первый — основной. */
async function replaceKeys(ctx: ContactContext, contactId: string, input: ContactInput) {
  if (input.phones !== undefined) {
    await ctx.db.deleteFrom('contact_phone').where('contact_id', '=', contactId).execute()
    if (input.phones.length > 0) {
      await ctx.db
        .insertInto('contact_phone')
        .values(
          input.phones.map((phone, index) => ({
            project_id: ctx.projectId,
            contact_id: contactId,
            phone,
            is_primary: index === 0,
          })),
        )
        .execute()
    }
  }
  if (input.emails !== undefined) {
    await ctx.db.deleteFrom('contact_email').where('contact_id', '=', contactId).execute()
    if (input.emails.length > 0) {
      await ctx.db
        .insertInto('contact_email')
        .values(
          input.emails.map((email, index) => ({
            project_id: ctx.projectId,
            contact_id: contactId,
            email,
            is_primary: index === 0,
          })),
        )
        .execute()
    }
  }
}

async function createContact(
  ctx: ContactContext,
  input: ContactInput,
): Promise<Result<ContactView>> {
  if (input.organizationId && !(await organizationExists(ctx.db, input.organizationId))) {
    return refuse(404, 'ORGANIZATION_NOT_FOUND')
  }
  const custom = await prepareCustom(ctx, 'contact', {}, input.custom ?? {})
  if (!custom.ok) return custom
  const keys = await checkKeys(ctx, input.phones ?? [], input.emails ?? [])
  if (!keys.ok) return keys
  const row = await ctx.db
    .insertInto('contact')
    .values({
      project_id: ctx.projectId,
      first_name: input.firstName ?? '',
      last_name: input.lastName ?? null,
      language: input.language ?? null,
      organization_id: input.organizationId ?? null,
      possible_duplicate: keys.value.emailMatched,
      custom: customInsert(custom.value),
      created_by: ctx.actorId,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
  await replaceKeys(ctx, row.id, input)
  await finishCustom(ctx, { type: 'contact', id: row.id }, custom.value, { history: false })
  return ok(await contactView(ctx, row))
}

async function updateContact(
  ctx: ContactContext,
  id: string,
  input: ContactInput,
): Promise<Result<ContactView>> {
  const found = await writableContact(ctx, id)
  if (!found.ok) return found
  const row = found.value
  if (row.deleted_at !== null) return refuse(404, 'CONTACT_NOT_FOUND')
  if (
    input.organizationId &&
    input.organizationId !== row.organization_id &&
    !(await organizationExists(ctx.db, input.organizationId))
  ) {
    return refuse(404, 'ORGANIZATION_NOT_FOUND')
  }
  const custom = await prepareCustom(ctx, 'contact', row.custom, input.custom ?? {})
  if (!custom.ok) return custom
  const keys = await checkKeys(ctx, input.phones ?? [], input.emails ?? [], id)
  if (!keys.ok) return keys
  const before = await contactView(ctx, row)
  await ctx.db
    .updateTable('contact')
    .set({
      ...(input.firstName === undefined ? {} : { first_name: input.firstName }),
      ...(input.lastName === undefined ? {} : { last_name: input.lastName }),
      ...(input.language === undefined ? {} : { language: input.language }),
      ...(input.organizationId === undefined ? {} : { organization_id: input.organizationId }),
      ...(changesCustom(custom.value) ? { custom: customUpdate(custom.value) } : {}),
      possible_duplicate: row.possible_duplicate || keys.value.emailMatched,
      updated_at: sql`now()`,
    })
    .where('id', '=', id)
    .execute()
  await replaceKeys(ctx, id, input)
  const after = await contactView(ctx, await reload(ctx, id))
  await recordChanges(ctx, { type: 'contact', id }, diffFields(before, after, LOGGED_FIELDS))
  await finishCustom(ctx, { type: 'contact', id }, custom.value, { history: true })
  return ok(after)
}

function deletedAtChange(before: Date | string | null, after: Date | string | null): FieldChange {
  return {
    field: 'deletedAt',
    before: before === null ? null : iso(before),
    after: after === null ? null : iso(after),
  }
}

/** Подтверждение — ровно тот список, что удалится: иначе за время между запросами он сменился. */
function confirmed(records: DependentRecord[], confirm: readonly string[] | null): boolean {
  if (records.length === 0) return true
  if (confirm === null) return false
  const ids = new Set(confirm.map((id) => id.toLowerCase()))
  return ids.size === records.length && records.every((r) => ids.has(r.id))
}

/**
 * В корзину: контакт и то, что удаляется вместе с ним (ContactDependents). Есть зависимые
 * записи — нужен `confirm` с их id; без него — 409 CONTACT_HAS_DEALS со списком, ничего не
 * удаляется. Зависимые, которые пользователь удалить не может, — 403.
 */
async function trashContact(
  ctx: ContactContext,
  id: string,
  confirm: readonly string[] | null,
): Promise<Result<null>> {
  const found = await writableContact(ctx, id)
  if (!found.ok) return found
  if (found.value.deleted_at !== null) return refuse(404, 'CONTACT_NOT_FOUND')
  const pending = await ctx.dependents.pending(ctx, id)
  if (pending.forbidden) return refuse(403, 'PERMISSION_DENIED')
  if (!confirmed(pending.records, confirm)) {
    return refuse(409, 'CONTACT_HAS_DEALS', {
      deals: pending.records.map(({ id: dealId, title }) => ({ id: dealId, title })),
    })
  }
  const { deleted_at } = await ctx.db
    .updateTable('contact')
    .set({ deleted_at: sql`now()`, deleted_by: ctx.actorId })
    .where('id', '=', id)
    .returning('deleted_at')
    .executeTakeFirstOrThrow()
  const deletedAt = new Date(deleted_at ?? Date.now())
  await ctx.dependents.trash(ctx, id, deletedAt)
  await recordChanges(ctx, { type: 'contact', id }, [deletedAtChange(null, deletedAt)])
  return ok(null)
}

/** Отказ зависимых записей — ответ API: без прав на них 403, сделка на удалённом этапе 409. */
function dependentRefusal(refused: DependentRefusal): Result<never> {
  return refused.code === 'PERMISSION_DENIED'
    ? refuse(403, 'PERMISSION_DENIED')
    : refuse(409, refused.code, { dealId: refused.dealId })
}

/**
 * Восстановление из корзины проверяет совпадения по тем же правилам, что создание
 * (checkKeys): пока контакт лежал в корзине, его телефон или email могли появиться у другого
 * контакта. Совпал телефон — 409 (с видимым — CONTACT_EXISTS со ссылкой, вне охвата —
 * CONTACT_OUT_OF_SCOPE без данных), контакт остаётся в корзине; совпал только email —
 * восстанавливается с отметкой «возможный дубль».
 */
async function restoreContact(ctx: ContactContext, id: string): Promise<Result<ContactView>> {
  const found = await writableContact(ctx, id)
  if (!found.ok) return found
  const row = found.value
  const { deleted_at } = row
  if (deleted_at === null) return refuse(409, 'NOT_IN_TRASH')
  const before = await contactView(ctx, row)
  const keys = await checkKeys(ctx, before.phones, before.emails, id)
  if (!keys.ok) return keys
  // Пока контакт в корзине, его отметка deleted_at — та же, что у сделок, удалённых с ним.
  const refused = await ctx.dependents.restore(ctx, id)
  if (refused) return dependentRefusal(refused)
  await ctx.db
    .updateTable('contact')
    .set({
      deleted_at: null,
      deleted_by: null,
      possible_duplicate: row.possible_duplicate || keys.value.emailMatched,
      updated_at: sql`now()`,
    })
    .where('id', '=', id)
    .execute()
  const after = await contactView(ctx, await reload(ctx, id))
  await recordChanges(ctx, { type: 'contact', id }, [
    deletedAtChange(deleted_at, null),
    ...diffFields(before, after, LOGGED_FIELDS),
  ])
  return ok(after)
}

/**
 * Окончательное удаление из корзины: телефоны и email уходят каскадом, история «было →
 * стало» стирается (в ней персональные данные), в журнал опасных действий — только id.
 */
async function purgeContact(ctx: ContactContext, id: string): Promise<Result<null>> {
  const found = await writableContact(ctx, id)
  if (!found.ok) return found
  if (found.value.deleted_at === null) return refuse(409, 'NOT_IN_TRASH')
  const refused = await ctx.dependents.purge(ctx, id)
  if (refused) return dependentRefusal(refused)
  await purgeFromTrash(ctx, { type: 'contact', id })
  await audit.record(ctx.db, ctx.projectId, {
    action: 'contact.purged',
    actorId: ctx.actorId,
    ip: ctx.ip,
    entity: { type: 'contact', id },
  })
  return ok(null)
}

/** Выдача для карточек и выбора: новые сверху, с простыми условиями. Список с фильтрами — тикет 12. */
async function listContacts(ctx: ContactContext, c: Ctx): Promise<Result<ContactView[]>> {
  const limit = readLimit(c.req.query('limit'))
  if (limit === undefined) return refuse(400, 'INVALID_CONTACT', { path: 'limit' })
  let query = ctx.db
    .selectFrom('contact')
    .selectAll()
    .where('deleted_at', 'is', null)
    .where((eb) => contactScopePredicate(eb, ctx.scope.read, ctx.viewer))
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit)
  const q = c.req.query('q')?.trim()
  if (q) {
    query = query.where(sql<boolean>`concat_ws(' ', first_name, last_name) ilike ${likePattern(q)}`)
  }
  const rawPhone = c.req.query('phone')
  if (rawPhone !== undefined) {
    const phone = normalizePhone(rawPhone)
    if (phone === null) return refuse(422, 'INVALID_PHONE', { path: 'phone' })
    query = query.where('id', 'in', (eb) =>
      eb.selectFrom('contact_phone').select('contact_id').where('phone', '=', phone),
    )
  }
  const rawEmail = c.req.query('email')
  if (rawEmail !== undefined) {
    const email = normalizeEmail(rawEmail)
    if (email === null) return refuse(422, 'INVALID_EMAIL', { path: 'email' })
    query = query.where('id', 'in', (eb) =>
      eb.selectFrom('contact_email').select('contact_id').where('email', '=', email),
    )
  }
  const organizationId = c.req.query('organizationId')
  if (organizationId !== undefined) {
    if (!UUID.test(organizationId)) return ok([])
    query = query.where('organization_id', '=', organizationId)
  }
  return ok(await contactViews(ctx, await query.execute()))
}

/**
 * Новый контакт из тела запроса `body` по правилам `POST /v1/contacts` (права проверяет
 * вызывающий): «создать сделку с новым контактом» (deals/deals.ts).
 */
export async function createContactInRequest(
  c: Ctx,
  body: Record<string, unknown>,
): Promise<Result<ContactView>> {
  const input = parseInput(body, true)
  if (!input.ok) return input
  return createContact(await contactContext(c, NO_CONTACT_DEPENDENTS), input.value)
}

/** Маршруты контактов: `/v1/contacts`. `dependents` — что удаляется вместе с контактом. */
export function contactsRoutes({
  dependents = NO_CONTACT_DEPENDENTS,
}: {
  dependents?: ContactDependents
} = {}) {
  const context = (c: Ctx) => contactContext(c, dependents)
  return new Hono<PermissionsEnv>()
    .get('/', requirePermission('contacts', 'view'), async (c) => {
      const outcome = await listContacts(await context(c), c)
      return outcome.ok ? c.json<ContactView[]>(outcome.value) : fail(c, outcome)
    })
    .get('/:id', requirePermission('contacts', 'view'), async (c) => {
      const id = c.req.param('id')
      const ctx = await context(c)
      const row = UUID.test(id) ? await findContact(ctx, id, ctx.scope.read) : undefined
      if (!row || row.deleted_at !== null) return fail(c, refuse(404, 'CONTACT_NOT_FOUND'))
      return c.json<ContactView>(await contactView(ctx, row))
    })
    .post('/', requirePermission('contacts', 'create'), async (c) => {
      const body = await readBody(c)
      if (!body) return fail(c, refuse(400, 'INVALID_CONTACT', { path: '' }))
      const input = parseInput(body, true)
      if (!input.ok) return fail(c, input)
      const outcome = await createContact(await context(c), input.value)
      return outcome.ok ? c.json<ContactView>(outcome.value, 201) : fail(c, outcome)
    })
    .put('/:id', requirePermission('contacts', 'edit'), async (c) => {
      const body = await readBody(c)
      if (!body) return fail(c, refuse(400, 'INVALID_CONTACT', { path: '' }))
      const input = parseInput(body, false)
      if (!input.ok) return fail(c, input)
      const outcome = await updateContact(await context(c), c.req.param('id'), input.value)
      return outcome.ok ? c.json<ContactView>(outcome.value) : fail(c, outcome)
    })
    .delete('/:id', requirePermission('contacts', 'delete'), async (c) => {
      const confirm = c.req.query('confirm')
      const outcome = await trashContact(
        await context(c),
        c.req.param('id'),
        confirm === undefined ? null : confirm.split(',').filter((v) => v !== ''),
      )
      return outcome.ok ? c.body(null, 204) : fail(c, outcome)
    })
    .post('/:id/restore', requirePermission('trash', 'edit'), async (c) => {
      const outcome = await restoreContact(await context(c), c.req.param('id'))
      return outcome.ok ? c.json<ContactView>(outcome.value) : fail(c, outcome)
    })
    .delete('/:id/permanent', requirePermission('trash', 'delete'), async (c) => {
      const outcome = await purgeContact(await context(c), c.req.param('id'))
      return outcome.ok ? c.body(null, 204) : fail(c, outcome)
    })
}
