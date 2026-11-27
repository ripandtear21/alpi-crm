import type { Database } from '@alpi/db'
import {
  formatPhone,
  type ParsedRegistration,
  type RegistrationAccepted,
  type RegistrationWarning,
} from '@alpi/shared'
import { type Kysely, sql } from 'kysely'
import { type ChangeAuthor, diffFields, recordChanges } from '../change-log/record.ts'
import {
  type ContactRow,
  insertContact,
  lockContactKeys,
  markedDuplicate,
  replaceContactKeys,
} from '../contacts/contacts.ts'
import { findContactMatch, findEmailContact } from '../contacts/match.ts'
import { finishNewDeal, insertDealRow, placement } from '../deals/deals.ts'
import { MAX_TITLE_LENGTH } from '../deals/store.ts'
import { emitEvent } from '../events/emit.ts'
import { inSavepoint, sqlState } from '../roles/roles.ts'
import type { IntakeSource } from './auth.ts'

// Обработка регистрации (тикет crm-intake/06; .scratch/crm-intake/spec.md, «Приём регистраций»;
// ADR 0003) — одна транзакция проекта источника (`trx`), автор всех изменений — источник:
//
// 1. Повтор: пара «источник, event_id» (intake_event) уже есть — те же id, ничего не меняется.
//    Одновременный второй запрос с тем же event_id ждёт первый на первичном ключе intake_event.
// 2. Контакт — findContactMatch, телефон главнее email (пункт 15). Перед поиском — блокировка
//    нормализованных телефона и email (lockContactKeys): одновременные регистрации одного
//    человека не создадут два контакта (решено без владельца — подтвердить).
// 3. Найденный контакт блокируется (FOR UPDATE) и перечитывается: слитый или удалённый за это
//    время — поиск заново. Пустое заполняется, заполненное не перезаписывается.
// 4. Сделка: открытая неархивная сделка контакта в воронке источника (FOR UPDATE), иначе новая
//    на первом этапе воронки. Существующей сделке ничего не меняется (ADR 0003).
// 5. Регистрация, события, история.
// Порядок блокировок — ключи, контакт, сделка (как у слияния контактов, тикет 12).
// Известное ограничение: слияние сделок (merge/deal-registry.ts, строка основного контакта
// слитой — FOR SHARE на контакт после блокировки сделок) и его откат берут сделку, потом
// контакт; приём — контакт (lockLiveContact), потом сделку (lockOpenDeal). Одновременно
// возможна взаимоблокировка (40P01): одна транзакция откатывается, приём отвечает 500 и пишет
// строку журнала, источник может повторить. Единый порядок блокировок — тикет 12.
// Обязательные поля «всегда» приём не проверяет (решено без владельца — подтвердить).

/** Итог обработки: принята, повтор или отказ (откатывает всю обработку). */
export type ProcessResult =
  | {
      ok: true
      status: 200 | 201
      outcome: 'accepted' | 'repeat'
      body: RegistrationAccepted
    }
  | { ok: false; status: 422; code: 'PIPELINE_ARCHIVED' | 'PIPELINE_HAS_NO_STAGES' }

/** Наибольшая длина имени контакта (0009_contacts) и число телефонов или email у контакта. */
const MAX_NAME_LENGTH = 100
const MAX_KEYS = 10
/** Сколько раз искать контакт заново, если найденный слили или удалили до блокировки. */
const MATCH_ATTEMPTS = 5
const UNIQUE_VIOLATION = '23505'

const INTAKE_EVENT_KEY = ['project_id', 'intake_source_id', 'kind', 'event_id'] as const

/** Имя контакта без имени в запросе: телефон в международном виде, без телефона — email. */
function keyName(phone: string | null, email: string | null): string {
  return (phone === null ? (email ?? '') : formatPhone(phone)).slice(0, MAX_NAME_LENGTH)
}

/**
 * Повтор `event_id`: id прежней регистрации. Контакт удалён окончательно (с ним и регистрация) —
 * все id null; удалена только сделка — регистрация и контакт на месте, deal_id null. Любой
 * null — предупреждение RECORDS_DELETED.
 */
async function repeated(
  trx: Kysely<Database>,
  source: IntakeSource,
  eventId: string,
): Promise<ProcessResult> {
  const row = await trx
    .selectFrom('intake_event as e')
    .leftJoin('registration as r', 'r.id', 'e.registration_id')
    .select(['r.id', 'r.contact_id', 'r.deal_id'])
    .where('e.intake_source_id', '=', source.id)
    .where('e.kind', '=', 'registration')
    .where('e.event_id', '=', eventId)
    .executeTakeFirstOrThrow()
  return {
    ok: true,
    status: 200,
    outcome: 'repeat',
    body: {
      registration_id: row.id,
      contact_id: row.contact_id,
      deal_id: row.deal_id,
      deal_created: false,
      contact_created: false,
      warnings: row.id === null || row.deal_id === null ? ['RECORDS_DELETED'] : [],
    },
  }
}

/** Контакт вне корзины и не слитый, заблокированный до конца транзакции; нет — null. */
function lockLiveContact(trx: Kysely<Database>, id: string) {
  return trx
    .selectFrom('contact')
    .selectAll()
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .where('merged_into_id', 'is', null)
    .forUpdate()
    .executeTakeFirst()
}

/** Телефоны и email контакта; основной — первым. */
async function contactKeys(trx: Kysely<Database>, id: string) {
  const phones = await trx
    .selectFrom('contact_phone')
    .select('phone')
    .where('contact_id', '=', id)
    .orderBy('is_primary', 'desc')
    .orderBy('phone')
    .execute()
  const emails = await trx
    .selectFrom('contact_email')
    .select('email')
    .where('contact_id', '=', id)
    .orderBy('is_primary', 'desc')
    .orderBy('email')
    .execute()
  return { phones: phones.map((r) => r.phone), emails: emails.map((r) => r.email) }
}

/**
 * Найденный контакт дополняется (пункт 15): имя — если оно поставлено из телефона или email
 * (такое считается пустым, решено без владельца — подтвердить); email — если его нет ни у кого;
 * email у другого контакта — отметка «возможный дубль» со ссылкой на него (если отметки ещё
 * нет). Изменения — в историю с автором-источником.
 */
async function fillContact(
  author: ChangeAuthor,
  row: ContactRow,
  reg: ParsedRegistration,
): Promise<void> {
  const trx = author.db
  const keys = await contactKeys(trx, row.id)
  const before = {
    firstName: row.first_name,
    possibleDuplicate: row.possible_duplicate,
    emails: keys.emails,
  }
  const named =
    row.last_name !== null ||
    !(
      keys.phones.some((phone) => keyName(phone, null) === row.first_name) ||
      keys.emails.some((email) => keyName(null, email) === row.first_name)
    )
  const name = reg.text.name?.slice(0, MAX_NAME_LENGTH) ?? null
  const firstName = !named && name !== null ? name : row.first_name

  let emails = keys.emails
  let duplicateOf: string | null = null
  if (reg.email !== null && !keys.emails.includes(reg.email)) {
    const other = await findEmailContact(trx, [reg.email], { excludeId: row.id })
    if (other !== null) duplicateOf = other
    else if (keys.emails.length < MAX_KEYS) emails = [...keys.emails, reg.email]
  }
  const mark =
    !row.possible_duplicate && duplicateOf !== null
      ? { possible_duplicate: true, possible_duplicate_of: duplicateOf }
      : {}
  const after = {
    firstName,
    possibleDuplicate: row.possible_duplicate || duplicateOf !== null,
    emails,
  }
  const changes = diffFields(before, after, ['firstName', 'possibleDuplicate', 'emails'])
  if (changes.length === 0) return
  await trx
    .updateTable('contact')
    .set({ first_name: firstName, ...mark, updated_at: sql`now()` })
    .where('id', '=', row.id)
    .execute()
  if (emails !== keys.emails) await replaceContactKeys(author, row.id, { emails })
  await recordChanges(author, { type: 'contact', id: row.id }, changes)
  await markedDuplicate(author, row.id, before.possibleDuplicate, after.possibleDuplicate)
}

/**
 * Контакт регистрации (шаг 2 тикета): найденный — дополняется, иначе новый. Телефон передан и
 * ни у кого не найден, а email — у А: новый контакт с отметкой «возможный дубль» со ссылкой на
 * А (как ручное создание). Телефона нет, email — у А: регистрация в А.
 */
async function resolveContact(
  author: ChangeAuthor,
  reg: ParsedRegistration,
): Promise<{ row: ContactRow; created: boolean }> {
  const phones = reg.phone === null ? [] : [reg.phone]
  const emails = reg.email === null ? [] : [reg.email]
  for (let attempt = 0; attempt < MATCH_ATTEMPTS; attempt++) {
    const match = await findContactMatch(author.db, { phones, emails })
    if (match === null || (match.by === 'email' && reg.phone !== null)) {
      const row = await insertContact(author, {
        firstName: reg.text.name?.slice(0, MAX_NAME_LENGTH) ?? keyName(reg.phone, reg.email),
        phones,
        emails,
        duplicateOf: match?.contactId ?? null,
      })
      return { row, created: true }
    }
    // Слияние и корзина ключей не блокируют: найденный мог уйти до блокировки строки.
    const locked = await lockLiveContact(author.db, match.contactId)
    if (!locked) continue
    await fillContact(author, locked, reg)
    const row = await author.db
      .selectFrom('contact')
      .selectAll()
      .where('id', '=', locked.id)
      .executeTakeFirstOrThrow()
    return { row, created: false }
  }
  throw new Error('контакт регистрации не найден: найденный каждый раз уходил до блокировки')
}

/** Открытая неархивная сделка контакта в воронке, заблокированная до конца транзакции. */
function lockOpenDeal(trx: Kysely<Database>, contactId: string, pipelineId: string) {
  return trx
    .selectFrom('deal')
    .select('id')
    .where('primary_contact_id', '=', contactId)
    .where('pipeline_id', '=', pipelineId)
    .where('status', '=', 'open')
    .where('archived_at', 'is', null)
    .where('deleted_at', 'is', null)
    .where('merged_into_id', 'is', null)
    .forUpdate()
    .executeTakeFirst()
}

/** Действующий участник проекта с email `email` (нижний регистр); нет — null. */
async function memberByEmail(trx: Kysely<Database>, email: string): Promise<string | null> {
  const row = await trx
    .selectFrom('user as u')
    .innerJoin('project_member as m', 'm.user_id', 'u.id')
    .select('u.id')
    .where(sql<string>`lower(u.email)`, '=', email)
    .where('m.disabled_at', 'is', null)
    .executeTakeFirst()
  return row?.id ?? null
}

/** Название новой сделки: «<имя или телефон> · <форма>», без формы — «… · <источник>». */
async function dealTitle(
  trx: Kysely<Database>,
  source: IntakeSource,
  contact: ContactRow,
  form: string | null,
): Promise<string> {
  const who = [contact.first_name, contact.last_name].filter(Boolean).join(' ')
  const what =
    form ??
    (
      await trx
        .selectFrom('intake_source')
        .select('name')
        .where('id', '=', source.id)
        .executeTakeFirstOrThrow()
    ).name
  return `${who} · ${what}`.slice(0, MAX_TITLE_LENGTH)
}

/**
 * Сделка регистрации (шаг 4 тикета): открытая сделка контакта в воронке источника или новая на
 * первом этапе. Ответственный — участник с `owner_email`, только у новой сделки (пункт 5).
 */
async function resolveDeal(
  author: ChangeAuthor,
  source: IntakeSource,
  contact: ContactRow,
  reg: ParsedRegistration,
  warnings: RegistrationWarning[],
): Promise<{ ok: true; id: string; created: boolean } | Extract<ProcessResult, { ok: false }>> {
  const trx = author.db
  const open = await lockOpenDeal(trx, contact.id, source.pipelineId)
  if (open) return { ok: true, id: open.id, created: false }
  const place = await placement(author, source.pipelineId, undefined)
  if (!place.ok) {
    // Воронку источника удалить нельзя (внешний ключ): остаются архив и «нет этапов».
    return {
      ok: false,
      status: 422,
      code:
        place.code === 'PIPELINE_HAS_NO_STAGES' ? 'PIPELINE_HAS_NO_STAGES' : 'PIPELINE_ARCHIVED',
    }
  }
  const ownerId = reg.ownerEmail === null ? null : await memberByEmail(trx, reg.ownerEmail)
  const title = await dealTitle(trx, source, contact, reg.text.form)
  try {
    const { id } = await inSavepoint(trx, () =>
      insertDealRow(author, { title, placement: place.value, contactId: contact.id, ownerId }),
    )
    if (reg.ownerGiven && ownerId === null) warnings.push('OWNER_NOT_FOUND')
    await finishNewDeal(author, id)
    return { ok: true, id, created: true }
  } catch (error) {
    // Открытую сделку контакта в воронке создали одновременно мимо блокировки контакта
    // (например, открыли заново проигранную): регистрация — в неё.
    const constraint = (error as { constraint?: unknown }).constraint
    if (sqlState(error) !== UNIQUE_VIOLATION || constraint !== 'deal_one_open_per_contact') {
      throw error
    }
    const again = await lockOpenDeal(trx, contact.id, source.pipelineId)
    if (!again) throw error
    return { ok: true, id: again.id, created: false }
  }
}

/** Обрабатывает регистрацию `reg` источника `source` транзакцией проекта `trx`. */
export async function processRegistration(
  trx: Kysely<Database>,
  source: IntakeSource,
  reg: ParsedRegistration,
): Promise<ProcessResult> {
  const author: ChangeAuthor = {
    db: trx,
    projectId: source.projectId,
    actorId: null,
    actorIntakeSourceId: source.id,
  }
  const claimed = await trx
    .insertInto('intake_event')
    .values({
      project_id: source.projectId,
      intake_source_id: source.id,
      kind: 'registration',
      event_id: reg.eventId,
    })
    .onConflict((oc) => oc.columns([...INTAKE_EVENT_KEY]).doNothing())
    .returning('event_id')
    .executeTakeFirst()
  if (!claimed) return repeated(trx, source, reg.eventId)

  await lockContactKeys(
    author,
    reg.phone === null ? [] : [reg.phone],
    reg.email === null ? [] : [reg.email],
  )
  const contact = await resolveContact(author, reg)
  const warnings = [...reg.warnings]
  const deal = await resolveDeal(author, source, contact.row, reg, warnings)
  if (!deal.ok) return deal

  const text = reg.text
  const { id } = await trx
    .insertInto('registration')
    .values({
      project_id: source.projectId,
      intake_source_id: source.id,
      event_id: reg.eventId,
      contact_id: contact.row.id,
      deal_id: deal.id,
      name: text.name,
      phone: reg.phone,
      phone_raw: reg.phoneRaw,
      dial_code: text.dial_code,
      email: reg.email ?? reg.emailRaw,
      form: text.form,
      webinar: text.webinar,
      plan_name: text.plan_name,
      page_url: text.page_url,
      referrer: text.referrer,
      utm_source: text.utm_source,
      utm_medium: text.utm_medium,
      utm_campaign: text.utm_campaign,
      utm_term: text.utm_term,
      utm_content: text.utm_content,
      ad_id: text.ad_id,
      gclid: text.gclid,
      gbraid: text.gbraid,
      wbraid: text.wbraid,
      fbclid: text.fbclid,
      fbp: text.fbp,
      fbc: text.fbc,
      registered_at: reg.registeredAt,
      user_agent: text.user_agent,
      extra: JSON.stringify(reg.extra),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  await trx
    .updateTable('intake_event')
    .set({ registration_id: id })
    .where('intake_source_id', '=', source.id)
    .where('kind', '=', 'registration')
    .where('event_id', '=', reg.eventId)
    .execute()
  await emitEvent(author, 'registration.created', {
    registration_id: id,
    contact_id: contact.row.id,
    deal_id: deal.id,
    source_id: source.id,
    form: text.form,
    deal_created: deal.created,
    contact_created: contact.created,
  })
  return {
    ok: true,
    status: 201,
    outcome: 'accepted',
    body: {
      registration_id: id,
      contact_id: contact.row.id,
      deal_id: deal.id,
      deal_created: deal.created,
      contact_created: contact.created,
      warnings,
    },
  }
}
