import type { ContactTable, Database } from '@alpi/db'
import {
  type CustomFieldErrorCode,
  normalizeEmail,
  normalizePhone,
  PAGE_LIMIT_MAX,
  type Page,
  type ResourceScope,
  type RolePermissions,
  type Scope,
} from '@alpi/shared'
import { OpenAPIHono } from '@hono/zod-openapi'
import { type Kysely, type Selectable, sql } from 'kysely'
import { requestAuthor } from '../api-keys/actor.ts'
import { audit } from '../audit/record.ts'
import {
  type ChangeAuthor,
  diffFields,
  type FieldChange,
  purgeFromTrash,
  recordChanges,
} from '../change-log/record.ts'
import { emitEvent } from '../events/emit.ts'
import type { FieldViewer } from '../fields/access.ts'
import { clearedRequired, missingRequired, requiredFieldsOutcome } from '../fields/requirements.ts'
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
import { requestViewer, type Viewer } from '../roles/scope.ts'
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
  refusalHook,
  refuse,
  requiredText,
  typed,
  UUID,
} from './http.ts'
import { findContactMatch } from './match.ts'
import { mergedContactRefusal } from './merged.ts'
import {
  createContactRoute,
  getContactRoute,
  patchContactRoute,
  searchContactsRoute,
} from './openapi.ts'
import { contactScopePredicate } from './scope.ts'

// Контакты проекта (тикет crm-deals/03; spec.md, разделы 3.2 и 4): маршруты `/v1/contacts`
// (снаружи — /api/v1/contacts: прокси Vite и Caddy снимают префикс /api).
//
// - События (тикет crm-api/05): contact.created при создании, contact.possible_duplicate — когда
//   контакт получает отметку «возможный дубль» (создание, правка, восстановление); той же
//   транзакцией, сразу после записи — markedDuplicate ниже.
// - Права — часть системы `contacts`; восстановить из корзины — «корзина: изменять»,
//   окончательно удалить — «корзина: удалять».
// - Охват чтения и изменения — contacts/scope.ts. Контакт вне охвата чтения — 404, как
//   несуществующий; в охвате чтения, но не изменения — 403.
// - Телефоны и email: первый в списке — основной. Совпал телефон с другим контактом — 409:
//   с видимым — CONTACT_EXISTS со ссылкой на него, с контактом вне охвата — CONTACT_OUT_OF_SCOPE
//   без каких-либо его данных («чужой клиент»): только имя менеджера его открытой сделки
//   («клиент уже в работе у <менеджер>», spec.md, раздел 4), если такая сделка есть.
//   Совпал только email — контакт пишется с отметкой «возможный дубль» (решено без владельца,
//   подтвердить) и ссылкой на найденный контакт (`possibleDuplicateOf`, тикет crm-intake/01).
// - Контакт, слитый с другим (тикет crm-intake/01, merge/), скрыт: любой запрос к нему по id —
//   404 CONTACT_MERGED с id оставшегося (contacts/merged.ts).
// - Контакт, основной в сделках, уходит в корзину только вместе с ними: первый запрос отвечает
//   409 CONTACT_HAS_DEALS со списком сделок, второй с подтверждением (`?confirm=<id сделок>`)
//   удаляет. Восстановление контакта возвращает сделки, удалённые вместе с ним.
// - Каждое изменение полей пишется в change_log той же транзакцией; окончательное удаление —
//   ещё и в журнал опасных действий (audit_log), а история записи стирается.
// - CRM сама ничего не делает и событий не шлёт (ADR 0003).
// - Ключ API (тикет crm-api/04) проходит на поиск по телефону и email, чтение, создание и PATCH
//   (contacts/openapi.ts); удаление, восстановление и PUT — только сессия. «Свои» контакты
//   ключа — созданные им (contacts/scope.ts).

export type ContactsErrorCode =
  | 'PERMISSION_DENIED'
  | 'INVALID_CONTACT'
  /** Телефон не разбирается как номер. */
  | 'INVALID_PHONE'
  | 'INVALID_EMAIL'
  | 'CONTACT_NOT_FOUND'
  /** Контакт слит с другим: `details.merged_into_id` — оставшийся (contacts/merged.ts). */
  | 'CONTACT_MERGED'
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
  /** С каким контактом совпал email при отметке «возможный дубль»; null — не известно. */
  possibleDuplicateOf: string | null
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
export const LOGGED_FIELDS = [
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
  ip: string | null
  scope: ResourceScope
  permissions: RolePermissions
  viewer: Viewer
  dependents: ContactDependents
}

async function contactContext(c: Ctx, dependents: ContactDependents): Promise<ContactContext> {
  const db = c.get('db')
  // Автор — участник или ключ API (тикет crm-api/03): сделка с новым контактом по ключу пишет
  // contact.created и историю от имени ключа; сессии у такого запроса нет.
  const actor = c.get('actor')
  return {
    db,
    projectId: c.get('projectId'),
    ...requestAuthor(actor),
    ip: c.get('clientIp'),
    scope: c.get('access').permissions.scopes.contacts,
    permissions: c.get('access').permissions,
    viewer: await requestViewer(db, actor),
    dependents,
  }
}

export type ContactRow = Selectable<ContactTable>

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
  if (!row) return notFound(ctx, id)
  if (ctx.scope.write !== ctx.scope.read && !(await findContact(ctx, id, ctx.scope.write))) {
    return refuse(403, 'PERMISSION_DENIED')
  }
  return ok(row)
}

/** Контакта нет для пользователя: слитый — 404 CONTACT_MERGED, иначе CONTACT_NOT_FOUND. */
async function notFound(ctx: ContactContext, id: string): Promise<Result<never>> {
  return (
    (await mergedContactRefusal(ctx.db, id, ctx.scope.read, ctx.viewer)) ??
    refuse(404, 'CONTACT_NOT_FOUND')
  )
}

const iso = (value: Date | string) => new Date(value).toISOString()

/**
 * Ответ API для строк контактов: телефоны и email — одним запросом на всех. Ссылка «возможный
 * дубль с» — только на контакт в охвате чтения `viewer.viewer` («чужой клиент» не выдаёт ни
 * id, ни данных); без охвата — null.
 */
export async function contactViews(
  viewer: FieldViewer & { viewer?: Viewer },
  rows: ContactRow[],
): Promise<ContactView[]> {
  const { db } = viewer
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.id)
  const duplicateIds = [
    ...new Set(
      rows.flatMap((row) =>
        row.possible_duplicate && row.possible_duplicate_of ? [row.possible_duplicate_of] : [],
      ),
    ),
  ]
  const scope = viewer.viewer
  const visibleDuplicates =
    duplicateIds.length === 0 || scope === undefined
      ? new Set<string>()
      : new Set(
          (
            await db
              .selectFrom('contact')
              .select('id')
              .where('id', 'in', duplicateIds)
              .where((eb) =>
                contactScopePredicate(eb, viewer.permissions.scopes.contacts.read, scope),
              )
              .execute()
          ).map((row) => row.id),
        )
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
    possibleDuplicateOf:
      row.possible_duplicate_of !== null && visibleDuplicates.has(row.possible_duplicate_of)
        ? row.possible_duplicate_of
        : null,
    phones: phonesOf.get(row.id) ?? [],
    emails: emailsOf.get(row.id) ?? [],
    custom: custom[index] ?? {},
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }))
}

export async function contactView(
  viewer: FieldViewer & { viewer?: Viewer },
  row: ContactRow,
): Promise<ContactView> {
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

// ---- Общие функции записи контакта ----------------------------------------------------------
// Ими пишут и ручные пути (создание, правка, восстановление), и приём регистраций (тикет
// crm-intake/06, intake/process.ts): на них же надсмотрщик за дублями (тикет 05) ставит свою
// задачу после создания контакта и смены телефонов или email.

/**
 * Одновременные запросы с одним телефоном или email проверяют совпадение по очереди:
 * блокировка на нормализованный ключ в проекте до конца транзакции. Ключи — одним
 * отсортированным списком (телефоны и email вместе), чтобы не было взаимной блокировки.
 * Порядок с блокировками строк: сначала ключи, потом строка контакта, потом сделки.
 */
export async function lockContactKeys(
  author: Pick<ChangeAuthor, 'db' | 'projectId'>,
  phones: readonly string[],
  emails: readonly string[],
): Promise<void> {
  const keys = [
    ...phones.map((phone) => `contact_phone:${author.projectId}:${phone}`),
    ...emails.map((email) => `contact_email:${author.projectId}:${email}`),
  ].sort()
  for (const key of keys) {
    await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(author.db)
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
    .where('d.merged_into_id', 'is', null)
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
 * Совпадения по новым ключам: телефон — отказ, только email — отметка «возможный дубль» со
 * ссылкой на найденный контакт (`duplicateOf`). `excludeId` — сам изменяемый контакт.
 */
async function checkKeys(
  ctx: ContactContext,
  phones: readonly string[],
  emails: readonly string[],
  excludeId?: string,
): Promise<Result<{ duplicateOf: string | null }>> {
  await lockContactKeys(ctx, phones, emails)
  const match = await findContactMatch(
    ctx.db,
    { phones, emails },
    excludeId === undefined ? {} : { excludeId },
  )
  if (match?.by === 'phone') return phoneTaken(ctx, match.contactId)
  return ok({ duplicateOf: match?.by === 'email' ? match.contactId : null })
}

/** Отметка «возможный дубль» после записи: уже стоящая не меняется, новая — со ссылкой. */
function duplicateMark(row: ContactRow, duplicateOf: string | null) {
  if (row.possible_duplicate) {
    return { possible_duplicate: true, possible_duplicate_of: row.possible_duplicate_of }
  }
  return { possible_duplicate: duplicateOf !== null, possible_duplicate_of: duplicateOf }
}

/** Заменяет телефоны или email контакта (что передано); первый — основной. */
export async function replaceContactKeys(
  ctx: ChangeAuthor,
  contactId: string,
  input: { phones?: readonly string[]; emails?: readonly string[] },
) {
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

/** Контакт получил отметку «возможный дубль» — событие contact.possible_duplicate. */
export async function markedDuplicate(
  ctx: ChangeAuthor,
  id: string,
  before: boolean,
  after: boolean,
) {
  if (!before && after) await emitEvent(ctx, 'contact.possible_duplicate', { contact_id: id })
}

/** Новый контакт: что пишет insertContact. */
export interface NewContact {
  firstName: string
  lastName?: string | null
  language?: ContactLanguage | null
  organizationId?: string | null
  phones: readonly string[]
  emails: readonly string[]
  /** С каким контактом совпал email: отметка «возможный дубль» со ссылкой; null — нет. */
  duplicateOf: string | null
  /** Колонка `custom` (customInsert); по умолчанию — пусто. */
  custom?: string
}

/**
 * Пишет новый контакт с телефонами и email, затем `beforeEvents` (значения пользовательских
 * полей ручного создания), затем события contact.created и, при отметке, contact.possible_duplicate.
 * Совпадения проверяет вызывающий — под lockContactKeys.
 */
export async function insertContact(
  author: ChangeAuthor,
  contact: NewContact,
  beforeEvents?: (row: ContactRow) => Promise<void>,
): Promise<ContactRow> {
  const row = await author.db
    .insertInto('contact')
    .values({
      project_id: author.projectId,
      first_name: contact.firstName,
      last_name: contact.lastName ?? null,
      language: contact.language ?? null,
      organization_id: contact.organizationId ?? null,
      possible_duplicate: contact.duplicateOf !== null,
      possible_duplicate_of: contact.duplicateOf,
      ...(contact.custom === undefined ? {} : { custom: contact.custom }),
      created_by: author.actorId,
      created_by_api_key_id: author.actorApiKeyId ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
  await replaceContactKeys(author, row.id, { phones: contact.phones, emails: contact.emails })
  await beforeEvents?.(row)
  await emitEvent(author, 'contact.created', { contact_id: row.id })
  await markedDuplicate(author, row.id, false, row.possible_duplicate)
  return row
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
  // Поля «всегда» (тикет crm-fields/04): без значения контакт не создаётся.
  const required = requiredFieldsOutcome(
    await missingRequired(ctx, { entity: 'contact' }, custom.value.set),
  )
  if (!required.ok) return required
  const keys = await checkKeys(ctx, input.phones ?? [], input.emails ?? [])
  if (!keys.ok) return keys
  const row = await insertContact(
    ctx,
    {
      firstName: input.firstName ?? '',
      lastName: input.lastName ?? null,
      language: input.language ?? null,
      organizationId: input.organizationId ?? null,
      phones: input.phones ?? [],
      emails: input.emails ?? [],
      duplicateOf: keys.value.duplicateOf,
      custom: customInsert(custom.value),
    },
    (inserted) =>
      finishCustom(ctx, { type: 'contact', id: inserted.id }, custom.value, { history: false }),
  )
  return ok(await contactView(ctx, row))
}

async function updateContact(
  ctx: ContactContext,
  id: string,
  input: ContactInput,
): Promise<Result<ContactView>> {
  // Ключи — до строки контакта: тот же порядок блокировок, что у приёма регистраций.
  await lockContactKeys(ctx, input.phones ?? [], input.emails ?? [])
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
  // Поле «всегда» не очищается; правка других полей старого контакта с пустым полем проходит.
  const cleared = requiredFieldsOutcome(await clearedRequired(ctx, 'contact', null, custom.value))
  if (!cleared.ok) return cleared
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
      ...duplicateMark(row, keys.value.duplicateOf),
      updated_at: sql`now()`,
    })
    .where('id', '=', id)
    .execute()
  await replaceContactKeys(ctx, id, input)
  const after = await contactView(ctx, await reload(ctx, id))
  await recordChanges(ctx, { type: 'contact', id }, diffFields(before, after, LOGGED_FIELDS))
  await finishCustom(ctx, { type: 'contact', id }, custom.value, { history: true })
  await markedDuplicate(ctx, id, before.possibleDuplicate, after.possibleDuplicate)
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
      ...duplicateMark(row, keys.value.duplicateOf),
      updated_at: sql`now()`,
    })
    .where('id', '=', id)
    .execute()
  const after = await contactView(ctx, await reload(ctx, id))
  await recordChanges(ctx, { type: 'contact', id }, [
    deletedAtChange(deleted_at, null),
    ...diffFields(before, after, LOGGED_FIELDS),
  ])
  await markedDuplicate(ctx, id, before.possibleDuplicate, after.possibleDuplicate)
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

/**
 * Выдача для карточек и выбора (только сессия): новые сверху, с простыми условиями. Список с
 * фильтрами — тикет 12, поиск по телефону и email — searchContacts.
 */
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
  const organizationId = c.req.query('organizationId')
  if (organizationId !== undefined) {
    if (!UUID.test(organizationId)) return ok([])
    query = query.where('organization_id', '=', organizationId)
  }
  return ok(await contactViews(ctx, await query.execute()))
}

/** Ответ поиска контакта по телефону или email (`GET /v1/contacts?phone=…&email=…`). */
export interface ContactSearchPage extends Page<ContactView> {
  /**
   * «Чужой клиент»: совпал контакт вне охвата чтения — без его id, имени, телефонов и email,
   * только менеджер его открытой сделки (spec.md MVP, раздел 4); null — таких совпадений нет.
   */
  outOfScope: { managerName: string | null } | null
}

/**
 * Поиск по точному телефону (любая запись номера, normalizePhone) и email (normalizeEmail, без
 * учёта регистра) среди контактов проекта вне корзины: видимые — в `data`, совпадение вне
 * охвата — `outOfScope` без данных контакта. Контакты другого проекта не видны вовсе
 * (row-level security).
 */
async function searchContacts(
  ctx: ContactContext,
  rawPhone: string | undefined,
  rawEmail: string | undefined,
): Promise<Result<ContactSearchPage>> {
  let query = ctx.db
    .selectFrom('contact')
    .select('id')
    .where('deleted_at', 'is', null)
    .where('merged_into_id', 'is', null)
    .orderBy('created_at')
    .orderBy('id')
    // shortcut: одна страница без курсора, больше PAGE_LIMIT_MAX совпадений не отдаёт; нужен
    // курсор, если один телефон или email окажется у сотен контактов проекта.
    .limit(PAGE_LIMIT_MAX)
  if (rawPhone !== undefined) {
    const phone = normalizePhone(rawPhone)
    if (phone === null) return refuse(422, 'INVALID_PHONE', { path: 'phone' })
    query = query.where('id', 'in', (eb) =>
      eb.selectFrom('contact_phone').select('contact_id').where('phone', '=', phone),
    )
  }
  if (rawEmail !== undefined) {
    const email = normalizeEmail(rawEmail)
    if (email === null) return refuse(422, 'INVALID_EMAIL', { path: 'email' })
    query = query.where('id', 'in', (eb) =>
      eb.selectFrom('contact_email').select('contact_id').where('email', '=', email),
    )
  }
  const matched = (await query.execute()).map((row) => row.id)
  const visible =
    matched.length === 0
      ? []
      : await ctx.db
          .selectFrom('contact')
          .selectAll()
          .where('id', 'in', matched)
          .where((eb) => contactScopePredicate(eb, ctx.scope.read, ctx.viewer))
          .orderBy('created_at')
          .orderBy('id')
          .execute()
  const visibleIds = new Set(visible.map((row) => row.id))
  const hidden = matched.find((id) => !visibleIds.has(id))
  return ok({
    data: await contactViews(ctx, visible),
    next_cursor: null,
    outOfScope:
      hidden === undefined ? null : { managerName: await openDealManager(ctx.db, hidden) },
  })
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
  const hook = refusalHook('INVALID_CONTACT')
  const respond = <T>(c: Ctx, outcome: Result<T>, status: 200 | 201 = 200) =>
    typed(outcome.ok ? c.json(outcome.value as object, status) : fail(c, outcome))
  const update = async (c: Ctx) => {
    const body = await readBody(c)
    if (!body) return fail(c, refuse(400, 'INVALID_CONTACT', { path: '' }))
    const input = parseInput(body, false)
    if (!input.ok) return fail(c, input)
    const outcome = await updateContact(await context(c), c.req.param('id') ?? '', input.value)
    return outcome.ok ? c.json<ContactView>(outcome.value) : fail(c, outcome)
  }
  // Маршруты, открытые ключу API, — `openapi()` с keyRoute (contacts/openapi.ts); остальные —
  // только сессия: ключ получает 403 API_KEY_NOT_ALLOWED.
  const app = new OpenAPIHono<PermissionsEnv>()
  // С `phone` или `email` — поиск (страница и «чужой клиент»); без них — прежняя выдача
  // карточек и подсказок apps/web (массив), ключу она не открыта.
  app.openapi(
    searchContactsRoute,
    async (c) => {
      const phone = c.req.query('phone')
      const email = c.req.query('email')
      const ctx = await context(c)
      if (phone !== undefined || email !== undefined) {
        return respond(c, await searchContacts(ctx, phone, email))
      }
      if (c.get('apiKey')) return respond(c, refuse(400, 'INVALID_CONTACT', { path: 'phone' }))
      return respond(c, await listContacts(ctx, c))
    },
    hook,
  )
  app.openapi(
    getContactRoute,
    async (c) => {
      const id = c.req.param('id') ?? ''
      const ctx = await context(c)
      const row = UUID.test(id) ? await findContact(ctx, id, ctx.scope.read) : undefined
      if (!row && UUID.test(id)) return respond(c, await notFound(ctx, id))
      if (!row || row.deleted_at !== null) return respond(c, refuse(404, 'CONTACT_NOT_FOUND'))
      return respond(c, ok(await contactView(ctx, row)))
    },
    hook,
  )
  app.openapi(
    createContactRoute,
    async (c) => {
      const body = await readBody(c)
      if (!body) return respond(c, refuse(400, 'INVALID_CONTACT', { path: '' }))
      const input = parseInput(body, true)
      if (!input.ok) return respond(c, input)
      return respond(c, await createContact(await context(c), input.value), 201)
    },
    hook,
  )
  app.openapi(patchContactRoute, async (c) => typed(await update(c)), hook)
  // Карточка контакта apps/web — PUT с теми же правилами, что PATCH; ключу закрыт.
  return app
    .put('/:id', requirePermission('contacts', 'edit'), update)
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
