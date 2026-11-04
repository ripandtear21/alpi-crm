import { type Database, withProject } from '@alpi/db'
import type { Kysely, Transaction } from 'kysely'

// Корзина (тикет crm-deals/04; spec.md, раздел 3.2): удалённые записи лежат в корзине
// (`deleted_at`) 30 дней, потом ежедневная задача (apps/api/src/jobs/jobs.ts) удаляет их
// окончательно. Как удалять запись окончательно, знает её тип: контакт уходит вместе со
// сделками, где он основной, и т. п. Поэтому реестр «тип сущности → функция окончательного
// удаления»; контакты, организации и сделки добавляет тикет 12 эпика crm-deals.
// Задача трогает только корзину и никогда не меняет живые сделки (ADR 0003).

/** Сколько дней запись лежит в корзине до окончательного удаления. */
export const TRASH_RETENTION_DAYS = 30

export interface TrashPurger {
  /**
   * Окончательно удаляет записи своего типа, удалённые раньше `cutoff`; возвращает их число.
   * `trx` — транзакция проекта: RLS показывает только его строки.
   */
  purgeExpired(trx: Transaction<Database>, cutoff: Date): Promise<number>
}

/** Тип сущности → функция окончательного удаления. */
export type TrashRegistry = ReadonlyMap<string, TrashPurger>

/** Типов в корзине пока нет: их добавляет тикет 12 эпика crm-deals. */
export const NO_TRASH_PURGERS: TrashRegistry = new Map()

function cutoffOf(now: Date): Date {
  return new Date(now.getTime() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000)
}

/** Корзина одного проекта, одной транзакцией; результат — сколько удалено по типам. */
export async function purgeProjectTrash(
  db: Kysely<Database>,
  projectId: string,
  registry: TrashRegistry,
  now: Date = new Date(),
): Promise<Record<string, number>> {
  const cutoff = cutoffOf(now)
  return withProject(db, projectId, async (trx) => {
    const deleted: Record<string, number> = {}
    for (const [entityType, purger] of registry) {
      deleted[entityType] = await purger.purgeExpired(trx, cutoff)
    }
    return deleted
  })
}

/**
 * Корзины всех проектов, по одному проекту в своём withProject. Сбой одного проекта не
 * останавливает остальные; после обхода он пробрасывается, и задача повторится.
 */
export async function purgeTrash(
  db: Kysely<Database>,
  registry: TrashRegistry,
  now: Date = new Date(),
): Promise<void> {
  if (registry.size === 0) return
  const projects = await db.selectFrom('project').select('id').orderBy('id').execute()
  const failures: unknown[] = []
  for (const { id } of projects) {
    try {
      await purgeProjectTrash(db, id, registry, now)
    } catch (error) {
      console.error(`корзина проекта ${id} не очищена`, error)
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `корзина не очищена в ${failures.length} проектах`)
  }
}
