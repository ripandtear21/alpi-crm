import { type Database, withProject } from '@alpi/db'
import { type Kysely, type RawBuilder, sql } from 'kysely'
import type { DuplicateScanMessage } from './queue.ts'

// Поиск дублей (тикет crm-intake/05; пункты 32 и 34; GLOSSARY.md, «Дубль»). Надсмотрщик только
// находит пары и показывает их людям: пишет и удаляет строки duplicate_pair и ничего больше —
// ни контактов, ни сделок, ни истории, ни событий (ADR 0003). Объединяет человек кнопкой на
// экране «Дублі» через слияние с откатом (ADR 0005).
//
// Правила пары — между живыми записями: слитые (merged_into_id) и в корзине (deleted_at) не
// считаются.
// - Контакты:
//   - phone — общий телефон (в базе уже E.164, normalizePhone: `067 123 45 67` и
//     `+380671234567` — один номер);
//   - email — общий email (в базе в нижнем регистре, normalizeEmail);
//   - mark — отметка «возможный дубль» одного контакта ссылается на другой
//     (possible_duplicate_of, тикет 01);
//   - name_phone — одинаковые имя и фамилия (без учёта регистра и пробелов по краям; нет
//     фамилии у обоих — тоже одинаковые) и одинаковые последние 9 цифр разных телефонов
//     (одинаковый целиком телефон — уже причина phone).
// - Сделки: open_deals — больше одной открытой сделки контакта в одной воронке, архивные
//   открытые тоже (две открытые неархивные база не допускает: deal_one_open_per_contact;
//   решено без владельца — подтвердить). Закрытые не считаются.
// Пара с отметкой «не дубль» (not_duplicate) не предлагается ни по одной причине.
//
// Пересчёт пар — одной записью SQL: найденные пары добавляются (время находки старой пары не
// меняется), пары, которые больше не совпадают, удаляются. Две области:
// - контакт (задача очереди duplicate-scan): пары контакта и пары его сделок;
// - весь проект (ночной проход): все пары; так уходят и пары записей, удалённых окончательно,
//   и пары сделок, сменивших основной контакт.
// Изоляция — row-level security транзакции проекта (withProject): записи других проектов
// запросу не видны, одинаковый телефон в двух проектах — не пара.

export type DuplicateEntity = DuplicateScanMessage['entity']

export const DUPLICATE_REASONS = ['phone', 'email', 'mark', 'name_phone', 'open_deals'] as const
export type DuplicateReason = (typeof DUPLICATE_REASONS)[number]

/** Итог пересчёта: сколько пар добавлено и удалено. */
export interface ScanResult {
  added: number
  removed: number
}

const LIVE = (alias: string) =>
  sql`${sql.ref(`${alias}.merged_into_id`)} is null and ${sql.ref(`${alias}.deleted_at`)} is null`

const NAME = (alias: string) =>
  sql`lower(btrim(${sql.ref(`${alias}.first_name`)})), lower(btrim(coalesce(${sql.ref(`${alias}.last_name`)}, '')))`

/**
 * Пары-кандидаты (entity_type, a_id, b_id, reason) — по всем правилам. `contactId` — только
 * пары этого контакта и его сделок; null — все пары проекта.
 */
function candidates(contactId: string | null): RawBuilder<unknown> {
  // Пары ключей: в области контакта — его ключи с чужими, в проекте — каждая пара один раз.
  const keyPair = (left: string, right: string) =>
    contactId === null
      ? sql`${sql.ref(`${left}.contact_id`)} < ${sql.ref(`${right}.contact_id`)}`
      : sql`${sql.ref(`${left}.contact_id`)} = ${contactId} and ${sql.ref(`${right}.contact_id`)} <> ${contactId}`
  const keyRule = (table: 'contact_phone' | 'contact_email', column: 'phone' | 'email') => sql`
    select 'contact'::text as entity_type,
      least(k1.contact_id, k2.contact_id) as a_id,
      greatest(k1.contact_id, k2.contact_id) as b_id,
      ${column}::text as reason
    from ${sql.table(table)} k1
    join ${sql.table(table)} k2
      on k2.project_id = k1.project_id and ${sql.ref(`k2.${column}`)} = ${sql.ref(`k1.${column}`)}
    join contact c1 on c1.id = k1.contact_id and ${LIVE('c1')}
    join contact c2 on c2.id = k2.contact_id and ${LIVE('c2')}
    where ${keyPair('k1', 'k2')}
  `
  const markScope =
    contactId === null ? sql`true` : sql`(c.id = ${contactId} or o.id = ${contactId})`
  const dealScope = contactId === null ? sql`true` : sql`d1.primary_contact_id = ${contactId}`
  return sql`
    ${keyRule('contact_phone', 'phone')}
    union all
    ${keyRule('contact_email', 'email')}
    union all
    select 'contact'::text, least(c.id, o.id), greatest(c.id, o.id), 'mark'::text
    from contact c
    join contact o on o.id = c.possible_duplicate_of and o.id <> c.id and ${LIVE('o')}
    where c.possible_duplicate and ${LIVE('c')} and ${markScope}
    union all
    select 'contact'::text, least(k1.contact_id, k2.contact_id),
      greatest(k1.contact_id, k2.contact_id), 'name_phone'::text
    from contact_phone k1
    join contact_phone k2
      on k2.project_id = k1.project_id and right(k2.phone, 9) = right(k1.phone, 9)
        and k2.phone <> k1.phone
    join contact c1 on c1.id = k1.contact_id and ${LIVE('c1')}
    join contact c2 on c2.id = k2.contact_id and ${LIVE('c2')}
      and (${NAME('c2')}) = (${NAME('c1')})
    where ${keyPair('k1', 'k2')}
    union all
    select 'deal'::text, d1.id, d2.id, 'open_deals'::text
    from deal d1
    join deal d2
      on d2.project_id = d1.project_id and d2.primary_contact_id = d1.primary_contact_id
        and d2.pipeline_id = d1.pipeline_id and d2.id > d1.id
        and d2.status = 'open' and ${LIVE('d2')}
    join contact c on c.id = d1.primary_contact_id and ${LIVE('c')}
    where d1.status = 'open' and ${LIVE('d1')} and ${dealScope}
  `
}

/** Пары, которые пересчёт заменяет: пары контакта и его сделок или все пары проекта. */
function pairScope(contactId: string | null): RawBuilder<unknown> {
  if (contactId === null) return sql`true`
  return sql`(
    (p.entity_type = 'contact' and (p.a_id = ${contactId} or p.b_id = ${contactId}))
    or (p.entity_type = 'deal' and exists (
      select 1 from deal d
      where d.primary_contact_id = ${contactId} and (d.id = p.a_id or d.id = p.b_id)
    ))
  )`
}

/**
 * Пересчитывает пары в транзакции проекта `trx` (withProject): контакта `contactId` и его
 * сделок или, при null, всего проекта. Пишет только duplicate_pair.
 */
export async function syncDuplicatePairs(
  trx: Kysely<Database>,
  projectId: string,
  contactId: string | null,
): Promise<ScanResult> {
  const { rows } = await sql<{ added: number; removed: number }>`
    with candidate as (${candidates(contactId)}),
    fresh as (
      select distinct c.entity_type, c.a_id, c.b_id, c.reason
      from candidate c
      where not exists (
        select 1 from not_duplicate n
        where n.entity_type = c.entity_type and n.a_id = c.a_id and n.b_id = c.b_id
      )
    ),
    removed as (
      delete from duplicate_pair p
      where ${pairScope(contactId)}
        and not exists (
          select 1 from fresh f
          where f.entity_type = p.entity_type and f.a_id = p.a_id and f.b_id = p.b_id
            and f.reason = p.reason
        )
      returning 1
    ),
    added as (
      insert into duplicate_pair (project_id, entity_type, a_id, b_id, reason)
      select ${projectId}::uuid, entity_type, a_id, b_id, reason from fresh
      on conflict do nothing
      returning 1
    )
    select (select count(*) from added)::int as added, (select count(*) from removed)::int as removed
  `.execute(trx)
  return rows[0] ?? { added: 0, removed: 0 }
}

/**
 * Задача очереди duplicate-scan: пары записи из сообщения. Сделка — через свой основной
 * контакт (пары сделок — между сделками одного контакта); сделки уже нет — нечего считать, её
 * пары уберёт ночной проход.
 */
export async function scanDuplicates(
  db: Kysely<Database>,
  message: DuplicateScanMessage,
): Promise<ScanResult> {
  return withProject(db, message.projectId, async (trx) => {
    let contactId: string | null = message.id
    if (message.entity === 'deal') {
      const deal = await trx
        .selectFrom('deal')
        .select('primary_contact_id')
        .where('id', '=', message.id)
        .executeTakeFirst()
      contactId = deal?.primary_contact_id ?? null
    }
    if (contactId === null) return { added: 0, removed: 0 }
    return syncDuplicatePairs(trx, message.projectId, contactId)
  })
}

/**
 * Ночной проход: все пары каждого проекта заново. Проекты — по одному, каждый в своём
 * withProject; сбой одного проекта не останавливает остальные, после обхода пробрасывается, и
 * задача повторится (как jobs/webhook-purge.ts).
 */
export async function scanAllDuplicates(db: Kysely<Database>): Promise<ScanResult> {
  const projects = await db.selectFrom('project').select('id').orderBy('id').execute()
  const failures: unknown[] = []
  const total: ScanResult = { added: 0, removed: 0 }
  for (const { id } of projects) {
    try {
      const result = await withProject(db, id, (trx) => syncDuplicatePairs(trx, id, null))
      total.added += result.added
      total.removed += result.removed
    } catch (error) {
      console.error(`дубли проекта ${id} не пересчитаны`, error)
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `дубли не пересчитаны в ${failures.length} проектах`)
  }
  return total
}
