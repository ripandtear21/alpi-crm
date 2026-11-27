import type { Database } from '@alpi/db'
import { can } from '@alpi/shared'
import { type Kysely, sql } from 'kysely'
import { recordChanges } from '../change-log/record.ts'
import type { ContactDependents, DependentsActor } from '../contacts/dependents.ts'
import { ownerAllowed } from './scope.ts'

// Сделки, где контакт основной, удаляются вместе с ним (ответ владельца, пункт 35): в корзину
// — с той же отметкой deleted_at, что у контакта; восстановление контакта возвращает именно
// их (решено без владельца — подтвердить). Сделки, удалённые в корзину раньше и отдельно, при
// восстановлении контакта остаются в корзине.
//
// С каждой сделкой пользователь делает то же, что сделал бы с ней сам, иначе отказ без
// изменений (контакт остаётся, где был): удалить в корзину и окончательно — право «сделки:
// удалять» и сделка в охвате изменения; восстановить — сделка в охвате изменения (право
// «корзина: изменять» проверил маршрут контакта).
//
// Окончательное удаление контакта удаляет окончательно все сделки, где он основной (без
// основного контакта сделки не бывает), — и удалённые вместе с ним, и удалённые раньше
// отдельно, вместе с их историей. Из сделок, где он участник, он убирается с записью в их
// историю (иначе его убрал бы каскад внешнего ключа без следа).
//
// Сделки, слитые с другими (тикет crm-intake/02), скрыты: в корзину с контактом не уходят и
// из неё не возвращаются. Окончательное удаление контакта стирает и их (без основного контакта
// сделки не бывает) — вместе с записями их слияний, так что откатить такое слияние уже нельзя.

const iso = (value: Date | string) => new Date(value).toISOString()

/**
 * Окончательно удаляет сделки `ids` по порядку (purge_from_trash), пропуская те, что уже ушли:
 * каждая уносит и слитые в неё. Общее для окончательного удаления контакта вручную (ниже) и
 * фоновой очистки корзины (trash/purgers.ts, CONTACT_PURGER; тикет crm-intake/12). Сделки уже
 * заблокированы вызывающим.
 */
export async function purgeDealsLeft(db: Kysely<Database>, ids: readonly string[]) {
  for (const id of ids) {
    const left = await db.selectFrom('deal').select('id').where('id', '=', id).executeTakeFirst()
    if (left) await sql`select purge_from_trash('deal', ${id}::uuid)`.execute(db)
  }
}

/** Сделку пользователь меняет сам: ответственный в охвате чтения и изменения (или очередь). */
function writable(actor: DependentsActor, ownerId: string | null): boolean {
  const { read, write } = actor.permissions.scopes.deals
  return ownerAllowed(ownerId, read, actor.viewer) && ownerAllowed(ownerId, write, actor.viewer)
}

/** Пользователь сам удалил бы каждую из сделок: право «сделки: удалять» и охват изменения. */
function deletable(actor: DependentsActor, deals: readonly { owner_id: string | null }[]) {
  return (
    can(actor.permissions, 'deals', 'delete') && deals.every((d) => writable(actor, d.owner_id))
  )
}

/** Участники сделки — как в ответе API (store.ts, dealViews): для истории «было → стало». */
async function participantsOf(actor: DependentsActor, dealId: string) {
  const rows = await actor.db
    .selectFrom('deal_participant')
    .select(['contact_id', 'role'])
    .where('deal_id', '=', dealId)
    .orderBy('created_at')
    .orderBy('contact_id')
    .execute()
  return rows.map((p) => ({ contactId: p.contact_id, role: p.role }))
}

export const DEAL_CONTACT_DEPENDENTS: ContactDependents = {
  async pending(actor, contactId) {
    // Сделки блокируются по id — как на всех путях, что блокируют несколько сделок (restore,
    // purge): в другом порядке одновременное «стереть» контакта-участника этих сделок дало бы
    // взаимоблокировку. Список для ответа 409 — по времени создания, следующим запросом.
    await actor.db
      .selectFrom('deal')
      .select('id')
      .where('primary_contact_id', '=', contactId)
      .where('deleted_at', 'is', null)
      .where('merged_into_id', 'is', null)
      .orderBy('id')
      .forUpdate()
      .execute()
    const rows = await actor.db
      .selectFrom('deal')
      .select(['id', 'title', 'owner_id'])
      .where('primary_contact_id', '=', contactId)
      .where('deleted_at', 'is', null)
      .where('merged_into_id', 'is', null)
      .orderBy('created_at')
      .orderBy('id')
      .execute()
    if (rows.length === 0) return { records: [], forbidden: false }
    if (!deletable(actor, rows)) return { records: [], forbidden: true }
    return {
      records: rows.map((r) => ({ type: 'deal' as const, id: r.id, title: r.title })),
      forbidden: false,
    }
  },

  async trash(actor, contactId) {
    const trashed = await actor.db
      .updateTable('deal')
      .set({
        deleted_at: sql`(select c.deleted_at from contact c where c.id = ${contactId})`,
        deleted_by: actor.actorId,
      })
      .where('primary_contact_id', '=', contactId)
      .where('deleted_at', 'is', null)
      .where('merged_into_id', 'is', null)
      .returning(['id', 'deleted_at'])
      .execute()
    for (const deal of trashed) {
      await recordChanges(actor, { type: 'deal', id: deal.id }, [
        { field: 'deletedAt', before: null, after: deal.deleted_at && iso(deal.deleted_at) },
      ])
    }
  },

  async restore(actor, contactId) {
    const deals = await actor.db
      .selectFrom('deal')
      .select(['id', 'deleted_at', 'owner_id'])
      .where('primary_contact_id', '=', contactId)
      .where('merged_into_id', 'is', null)
      .where(
        'deleted_at',
        '=',
        sql<Date>`(select c.deleted_at from contact c where c.id = ${contactId})`,
      )
      .orderBy('id')
      .forUpdate()
      .execute()
    if (deals.length === 0) return null
    if (!deals.every((d) => writable(actor, d.owner_id))) return { code: 'PERMISSION_DENIED' }
    const ids = deals.map((d) => d.id)
    // Открытая сделка в корзине держит свой этап (pipelines/stage-deals.ts), так что этот
    // отказ — на случай данных, записанных в обход API: открытой на удалённом этапе сделка
    // не встанет (триггер deal_stage_live), и лучше 409, чем 500.
    const blocked = await actor.db
      .selectFrom('deal as d')
      .innerJoin('stage as s', 's.id', 'd.stage_id')
      .select('d.id')
      .where('d.id', 'in', ids)
      .where('d.status', '=', 'open')
      .where('s.deleted_at', 'is not', null)
      .orderBy('d.id')
      .limit(1)
      .executeTakeFirst()
    if (blocked) return { code: 'STAGE_DELETED', dealId: blocked.id }
    await actor.db
      .updateTable('deal')
      .set({ deleted_at: null, deleted_by: null, updated_at: sql`now()` })
      .where('id', 'in', ids)
      .execute()
    for (const deal of deals) {
      await recordChanges(actor, { type: 'deal', id: deal.id }, [
        { field: 'deletedAt', before: deal.deleted_at && iso(deal.deleted_at), after: null },
      ])
    }
    return null
  },

  async purge(actor, contactId) {
    // Все сделки контакта — где он основной и где участник — блокируются одним запросом по id,
    // до первого изменения: двумя заходами (сначала где основной, потом где участник) два
    // одновременных «стереть» контактов, участников сделок друг друга, взяли бы сделки в
    // разном порядке — взаимоблокировка.
    await actor.db
      .selectFrom('deal')
      .select('id')
      .where((eb) =>
        eb.or([
          eb('primary_contact_id', '=', contactId),
          eb.exists(
            eb
              .selectFrom('deal_participant as p')
              .select('p.id')
              .whereRef('p.deal_id', '=', 'deal.id')
              .where('p.contact_id', '=', contactId),
          ),
        ]),
      )
      .orderBy('id')
      .forUpdate()
      .execute()
    const deals = await actor.db
      .selectFrom('deal')
      .select(['id', 'owner_id', 'merged_into_id'])
      .where('primary_contact_id', '=', contactId)
      .orderBy('id')
      .forUpdate()
      .execute()
    if (deals.length > 0 && !deletable(actor, deals)) return { code: 'PERMISSION_DENIED' }
    // Сначала сделки в корзине: каждая уносит и слитые в неё. Потом скрытые сделки контакта,
    // слитые в чужие сделки, — те, что ещё остались.
    await purgeDealsLeft(actor.db, [
      ...deals.filter((deal) => deal.merged_into_id === null).map((deal) => deal.id),
      ...deals.filter((deal) => deal.merged_into_id !== null).map((deal) => deal.id),
    ])
    // Сделки, где контакт участник: строки сделок блокируются (как при изменении участников в
    // deals.ts), чтобы «было» в истории не устарело до записи.
    const involved = await actor.db
      .selectFrom('deal')
      .select('id')
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('deal_participant as p')
            .select('p.id')
            .whereRef('p.deal_id', '=', 'deal.id')
            .where('p.contact_id', '=', contactId),
        ),
      )
      .orderBy('id')
      .forUpdate()
      .execute()
    for (const { id } of involved) {
      const before = await participantsOf(actor, id)
      await actor.db
        .deleteFrom('deal_participant')
        .where('deal_id', '=', id)
        .where('contact_id', '=', contactId)
        .execute()
      const after = await participantsOf(actor, id)
      await recordChanges(actor, { type: 'deal', id }, [{ field: 'participants', before, after }])
    }
    return null
  },
}
