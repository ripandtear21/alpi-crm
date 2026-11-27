import type { DuplicateReason } from './finder.ts'

// Группы похожих записей экрана «Дублі» (тикет crm-intake/05; решено без владельца —
// подтвердить): записи, связанные хотя бы одной парой, — связные компоненты пар. Считаются в
// коде из пар проекта (routes.ts читает не больше MAX_PAIRS пар).

/** Строка duplicate_pair: одна причина пары. */
export interface PairRow {
  a_id: string
  b_id: string
  reason: string
  found_at: Date | string
}

/** Пара записей группы со всеми её причинами. */
export interface GroupPair {
  aId: string
  bId: string
  reasons: DuplicateReason[]
}

/** Группа: id — наименьший id записи группы; foundAt — самая новая находка пары группы. */
export interface DuplicateGroup {
  id: string
  recordIds: string[]
  reasons: DuplicateReason[]
  pairs: GroupPair[]
  foundAt: string
}

/** Группы из пар: новые находки сверху, при равенстве — по id группы. */
export function buildGroups(rows: readonly PairRow[]): DuplicateGroup[] {
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root) ?? root
    // Сжатие пути: следующие поиски — за один шаг.
    let node = id
    while (node !== root) {
      const next = parent.get(node) ?? root
      parent.set(node, root)
      node = next
    }
    return root
  }
  const pairs = new Map<string, GroupPair & { foundAt: number }>()
  for (const row of rows) {
    for (const id of [row.a_id, row.b_id]) if (!parent.has(id)) parent.set(id, id)
    const a = find(row.a_id)
    const b = find(row.b_id)
    if (a !== b) {
      const [low, high] = a < b ? [a, b] : [b, a]
      parent.set(high, low)
    }
    const key = `${row.a_id}:${row.b_id}`
    const at = new Date(row.found_at).getTime()
    const pair = pairs.get(key) ?? { aId: row.a_id, bId: row.b_id, reasons: [], foundAt: at }
    const reason = row.reason as DuplicateReason
    if (!pair.reasons.includes(reason)) pair.reasons.push(reason)
    pair.foundAt = Math.max(pair.foundAt, at)
    pairs.set(key, pair)
  }
  const groups = new Map<string, DuplicateGroup & { at: number; ids: Set<string> }>()
  for (const { foundAt, ...pair } of pairs.values()) {
    const root = find(pair.aId)
    const group = groups.get(root) ?? {
      id: root,
      recordIds: [],
      reasons: [],
      pairs: [],
      foundAt: '',
      at: 0,
      ids: new Set<string>(),
    }
    pair.reasons.sort()
    group.pairs.push(pair)
    group.ids.add(pair.aId).add(pair.bId)
    for (const reason of pair.reasons)
      if (!group.reasons.includes(reason)) group.reasons.push(reason)
    group.at = Math.max(group.at, foundAt)
    groups.set(root, group)
  }
  return [...groups.values()]
    .map(({ at, ids, ...group }) => ({
      ...group,
      // Корень — наименьший id: объединение всегда вешает больший корень на меньший.
      id: [...ids].sort()[0] ?? group.id,
      recordIds: [...ids].sort(),
      reasons: group.reasons.sort(),
      pairs: group.pairs.sort((x, y) => (x.aId + x.bId < y.aId + y.bId ? -1 : 1)),
      foundAt: new Date(at).toISOString(),
    }))
    .sort((x, y) =>
      x.foundAt === y.foundAt ? (x.id < y.id ? -1 : 1) : x.foundAt < y.foundAt ? 1 : -1,
    )
}
