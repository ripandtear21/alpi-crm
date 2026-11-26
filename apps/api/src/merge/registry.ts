import type { RolePermissions } from '@alpi/shared'
import type { ChangeAuthor } from '../change-log/record.ts'
import type { Viewer } from '../roles/scope.ts'

// Реестр того, что переходит при слиянии (тикет crm-intake/01; ADR 0005; по образцу
// contacts/dependents.ts). Каждая связанная с записью таблица — одна строка реестра с тремя
// функциями:
//
// - plan — что перейдёт, ничего не меняя (предпросмотр и само слияние);
// - apply — перенести ровно то, что вернул plan;
// - restore — откат: вернуть ровно то, что записано в merge_moved_item, и сказать, что
//   вернуть нельзя (запись удалена окончательно или изменена после слияния).
//
// Строки общие для контактов и сделок (тикет 02 добавляет реестр сделок): запись слияния
// (merge_record) и перешедшее (merge_moved_item) не знают, что именно слито. Новая сущность,
// связанная с контактом (платёж, задача, звонок), добавляет сюда свою строку — иначе её
// записи останутся у скрытого контакта (ADR 0005, «Последствия»).
//
// Все функции вызываются в транзакции проекта того же запроса (`actor.db`): ошибка откатывает
// всё слияние или весь откат (ответ 500).

/** Тип записей, которые сливаются. */
export type MergeEntity = 'contact' | 'deal'

/** Кто сливает или откатывает: пользователь (только сессия), его права и охват. */
export interface MergeActor extends ChangeAuthor {
  actorId: string
  ip: string | null
  permissions: RolePermissions
  viewer: Viewer
}

/** Пара записей: оставшаяся и слитая (скрытая). */
export interface MergePair {
  survivorId: string
  mergedId: string
}

/**
 * Одно перешедшее: вид (`kind` — строка реестра знает свои виды), id перешедшей записи, поле и
 * значение (у заполненного поля — что поставило слияние; у телефона — сам номер и его отметки).
 */
export interface MovedItem {
  kind: string
  itemId: string | null
  field: string | null
  value: unknown
}

/** Почему перешедшее не вернулось: удалено окончательно или изменено после слияния. */
export type UndoSkipReason = 'gone' | 'changed'

/** Что откат не вернул — показывается в итоге отката. */
export interface UndoSkip extends MovedItem {
  reason: UndoSkipReason
}

export interface MergeRegistryRow {
  /** Виды перешедшего, которые пишет и возвращает эта строка. */
  kinds: readonly string[]
  plan(actor: MergeActor, pair: MergePair): Promise<MovedItem[]>
  apply(actor: MergeActor, pair: MergePair, items: readonly MovedItem[]): Promise<void>
  restore(actor: MergeActor, pair: MergePair, items: readonly MovedItem[]): Promise<UndoSkip[]>
}

/** Реестр: строки по порядку слияния; откат идёт в обратном порядке. */
export type MergeRegistry = readonly MergeRegistryRow[]

/** Перешедшее, отобранное по видам строки. */
export function itemsOf(row: MergeRegistryRow, items: readonly MovedItem[]): MovedItem[] {
  return items.filter((item) => row.kinds.includes(item.kind))
}

export const moved = (
  kind: string,
  item: { itemId?: string | null; field?: string | null; value?: unknown },
): MovedItem => ({
  kind,
  itemId: item.itemId ?? null,
  field: item.field ?? null,
  value: item.value ?? null,
})

export const skipped = (item: MovedItem, reason: UndoSkipReason): UndoSkip => ({ ...item, reason })

/** JSON с ключами по алфавиту: сравнение значений поля, как их хранит jsonb. */
export function canonical(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, v: unknown) =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  )
}

/** Запуск строк реестра: план всех строк до первого изменения. */
export async function planAll(
  registry: MergeRegistry,
  actor: MergeActor,
  pair: MergePair,
): Promise<MovedItem[]> {
  const items: MovedItem[] = []
  for (const row of registry) items.push(...(await row.plan(actor, pair)))
  return items
}

export async function applyAll(
  registry: MergeRegistry,
  actor: MergeActor,
  pair: MergePair,
  items: readonly MovedItem[],
): Promise<void> {
  for (const row of registry) await row.apply(actor, pair, itemsOf(row, items))
}

/** Откат строк в обратном порядке; итог — всё, что не вернулось. */
export async function restoreAll(
  registry: MergeRegistry,
  actor: MergeActor,
  pair: MergePair,
  items: readonly MovedItem[],
): Promise<UndoSkip[]> {
  const skips: UndoSkip[] = []
  for (const row of [...registry].reverse()) {
    skips.push(...(await row.restore(actor, pair, itemsOf(row, items))))
  }
  return skips
}
