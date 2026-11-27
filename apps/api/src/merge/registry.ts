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

// ---- Строки, общие для реестров контактов и сделок (тикет crm-intake/12) ----------------------

/**
 * Заполняемое поле организации (`organizationId`) убирается из `items`, если организация в
 * корзине: живую запись к ней не привязать.
 */
export async function dropTrashedOrganization(actor: ChangeAuthor, items: MovedItem[]) {
  const organization = items.find((item) => item.field === 'organizationId')
  if (!organization) return
  const live = await actor.db
    .selectFrom('organization')
    .select('id')
    .where('id', '=', organization.value as string)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  if (!live) items.splice(items.indexOf(organization), 1)
}

/**
 * Пользовательские поля, которые заполнятся у оставшейся записи вида `entity`: пустые у неё и
 * заполненные у слитой, только действующие (не в архиве, не удаляются, тип не меняется; FOR KEY
 * SHARE — определение поля не удалят, пока идёт слияние).
 */
export async function customFieldItems(
  actor: ChangeAuthor,
  entity: MergeEntity,
  survivor: Record<string, unknown>,
  merged: Record<string, unknown>,
): Promise<MovedItem[]> {
  const codes = Object.keys(merged).filter(
    (code) => survivor[code] === undefined && merged[code] !== null,
  )
  if (codes.length === 0) return []
  const live = await actor.db
    .selectFrom('field_definition')
    .select('code')
    .where('entity', '=', entity)
    .where('code', 'in', codes)
    .where('archived_at', 'is', null)
    .where('purge_requested_at', 'is', null)
    .where('converting_to', 'is', null)
    .orderBy('code')
    .forKeyShare()
    .execute()
  return live.map(({ code }) => moved('field', { field: `custom.${code}`, value: merged[code] }))
}

/** Записи, привязанные к контакту или сделке столбцом `contact_id` или `deal_id`. */
type AttachedKind = 'note' | 'file' | 'registration'

/**
 * Строка реестра для заметок, файлов и регистраций (тикет crm-intake/06) записи: переходят к
 * оставшейся по столбцу `column` и возвращаются, если ещё у неё.
 */
export function attachedRow(
  kind: AttachedKind,
  column: 'contact_id' | 'deal_id',
): MergeRegistryRow {
  const owner = (id: string) => (column === 'contact_id' ? { contact_id: id } : { deal_id: id })
  const ids = (items: readonly MovedItem[]) => items.map((item) => item.itemId ?? '')
  return {
    kinds: [kind],
    async plan(actor, pair) {
      const rows = await actor.db
        .selectFrom(kind)
        .select('id')
        .where(column, '=', pair.mergedId)
        .orderBy('id')
        .execute()
      return rows.map((row) => moved(kind, { itemId: row.id }))
    },
    async apply(actor, pair, items) {
      if (items.length === 0) return
      await actor.db
        .updateTable(kind)
        .set(owner(pair.survivorId))
        .where('id', 'in', ids(items))
        .where(column, '=', pair.mergedId)
        .execute()
    },
    async restore(actor, pair, items) {
      if (items.length === 0) return []
      const back = await actor.db
        .updateTable(kind)
        .set(owner(pair.mergedId))
        .where('id', 'in', ids(items))
        .where(column, '=', pair.survivorId)
        .returning('id')
        .execute()
      const returned = new Set(back.map((row) => row.id))
      const missing = items.filter((item) => !returned.has(item.itemId ?? ''))
      if (missing.length === 0) return []
      const exists = await actor.db
        .selectFrom(kind)
        .select('id')
        .where('id', 'in', ids(missing))
        .execute()
      const alive = new Set(exists.map((row) => row.id))
      return missing.map((item) => skipped(item, alive.has(item.itemId ?? '') ? 'changed' : 'gone'))
    },
  }
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
