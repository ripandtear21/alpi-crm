import { can } from '@alpi/shared'
import { sql } from 'kysely'
import { purgeFromTrash, recordChanges } from '../change-log/record.ts'
import type { ContactDependents } from '../contacts/dependents.ts'
import { ownerAllowed } from './scope.ts'

// Сделки, где контакт основной, удаляются вместе с ним (ответ владельца, пункт 35): в корзину
// — с той же отметкой deleted_at, что у контакта; восстановление контакта возвращает именно
// их (решено без владельца — подтвердить); окончательное удаление контакта сначала удаляет
// окончательно все его сделки из корзины, вместе с их историей. Сделки, удалённые в корзину
// раньше и отдельно, при восстановлении контакта остаются в корзине.

const iso = (value: Date | string) => new Date(value).toISOString()

export const DEAL_CONTACT_DEPENDENTS: ContactDependents = {
  async pending(actor, contactId) {
    const rows = await actor.db
      .selectFrom('deal')
      .select(['id', 'title', 'owner_id'])
      .where('primary_contact_id', '=', contactId)
      .where('deleted_at', 'is', null)
      .orderBy('created_at')
      .orderBy('id')
      .forUpdate()
      .execute()
    if (rows.length === 0) return { records: [], forbidden: false }
    // Удалить сделки может только тот, кто удалил бы каждую из них сам.
    const forbidden =
      !can(actor.permissions, 'deals', 'delete') ||
      rows.some(
        (r) => !ownerAllowed(r.owner_id, actor.permissions.scopes.deals.write, actor.viewer),
      )
    if (forbidden) return { records: [], forbidden: true }
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
      .select(['id', 'deleted_at'])
      .where('primary_contact_id', '=', contactId)
      .where(
        'deleted_at',
        '=',
        sql<Date>`(select c.deleted_at from contact c where c.id = ${contactId})`,
      )
      .execute()
    if (deals.length === 0) return null
    const ids = deals.map((d) => d.id)
    // Пока сделка лежала в корзине, её этап могли удалить: открытой на нём она не встанет.
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
    const deals = await actor.db
      .selectFrom('deal')
      .select('id')
      .where('primary_contact_id', '=', contactId)
      .execute()
    for (const deal of deals) {
      await purgeFromTrash(actor, { type: 'deal', id: deal.id })
    }
  },
}
