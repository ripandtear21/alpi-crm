import type { Database } from '@alpi/db'
import { sql, type Transaction } from 'kysely'
import { recordChanges } from '../change-log/record.ts'
import type { TrashPurger, TrashRegistry } from './purge.ts'

// Окончательное удаление сделок, контактов и организаций из корзины через 30 дней (тикет
// crm-deals/12, реестр тикета 04 — purge.ts). Удаляет функция базы purge_from_trash вместе с
// историей записи «было → стало»: у роли приложения нет DELETE на эти таблицы. Порядок в
// реестре важен: сначала сделки (они ссылаются на контакт), потом контакты, потом
// организации. Ни одна живая запись не меняется (ADR 0003), кроме связи контакта с
// окончательно удалённой организацией — её обнуляет внешний ключ, а здесь она пишется в
// историю контакта, как при удалении из корзины вручную.

async function purgeEach(
  trx: Transaction<Database>,
  type: 'deal' | 'contact' | 'organization',
  ids: readonly string[],
): Promise<number> {
  for (const id of ids) {
    await sql`select purge_from_trash(${type}, ${id}::uuid)`.execute(trx)
  }
  return ids.length
}

export const DEAL_PURGER: TrashPurger = {
  async purgeExpired(trx, cutoff) {
    const rows = await trx
      .selectFrom('deal')
      .select('id')
      .where('deleted_at', '<', cutoff)
      // Скрытые сделки уходят вместе с оставшейся (purge_from_trash, migrations/0026_merge.ts).
      .where('merged_into_id', 'is', null)
      .orderBy('id')
      .execute()
    return purgeEach(
      trx,
      'deal',
      rows.map((row) => row.id),
    )
  },
}

export const CONTACT_PURGER: TrashPurger = {
  async purgeExpired(trx, cutoff) {
    // Контакт, на который ещё ссылается сделка как на основной (сделку удалили позже или
    // восстановили), ждёт: сделка без основного контакта невозможна. Скрытые сделки контакта
    // (слитые в другие, тикет crm-intake/02) не ждут: из корзины они не возвращаются и
    // стираются вместе с контактом, как при окончательном удалении вручную
    // (deals/dependents.ts), — иначе такой контакт лежал бы в корзине вечно.
    const rows = await trx
      .selectFrom('contact')
      .select('contact.id')
      .where('contact.deleted_at', '<', cutoff)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('deal')
              .select('deal.id')
              .whereRef('deal.primary_contact_id', '=', 'contact.id')
              .where('deal.merged_into_id', 'is', null),
          ),
        ),
      )
      .orderBy('contact.id')
      .execute()
    const ids = rows.map((row) => row.id)
    if (ids.length === 0) return 0
    // Скрытые сделки блокируются по id, как в deals/dependents.ts; каждая уносит и слитые в
    // неё, так что сделку, которую уже унесла другая, второй раз не стирать.
    const hidden = await trx
      .selectFrom('deal')
      .select('id')
      .where('primary_contact_id', 'in', ids)
      .where('merged_into_id', 'is not', null)
      .orderBy('id')
      .forUpdate()
      .execute()
    for (const { id } of hidden) {
      const left = await trx.selectFrom('deal').select('id').where('id', '=', id).executeTakeFirst()
      if (left) await sql`select purge_from_trash('deal', ${id}::uuid)`.execute(trx)
    }
    return purgeEach(trx, 'contact', ids)
  },
}

export const ORGANIZATION_PURGER: TrashPurger = {
  async purgeExpired(trx, cutoff) {
    const rows = await trx
      .selectFrom('organization')
      .select(['id', 'project_id'])
      .where('deleted_at', '<', cutoff)
      .orderBy('id')
      .execute()
    for (const organization of rows) {
      const linked = await trx
        .selectFrom('contact')
        .select('id')
        .where('organization_id', '=', organization.id)
        .forUpdate()
        .execute()
      for (const contact of linked) {
        await recordChanges(
          { db: trx, projectId: organization.project_id, actorId: null },
          { type: 'contact', id: contact.id },
          [{ field: 'organizationId', before: organization.id, after: null }],
        )
      }
    }
    return purgeEach(
      trx,
      'organization',
      rows.map((row) => row.id),
    )
  },
}

/** Реестр корзины API: сделки, контакты, организации — в этом порядке. */
export const TRASH_PURGERS: TrashRegistry = new Map([
  ['deal', DEAL_PURGER],
  ['contact', CONTACT_PURGER],
  ['organization', ORGANIZATION_PURGER],
])
