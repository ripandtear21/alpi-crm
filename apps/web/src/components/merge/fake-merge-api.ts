import { MergeApiError, type MergeRecord, type UndoSkip } from './merge-api.tsx'

// Общее у подставных клиентов слияния контактов (routes/contacts/merge/fake-merges-api.ts) и
// сделок (routes/deals/$dealId/merge/fake-deal-merges-api.ts) — тикет crm-intake/12: id слияний,
// образец записи, отказ на следующий вызов, список слияний в запись и откат в памяти.

/** Состояние подставного клиента: слияния в памяти, итог отката, отказ, записи вызовов. */
export interface FakeMergeState<Item extends MergeRecord> {
  merges: Item[]
  /** Что пропустит откат (итог отката). */
  skipped: UndoSkip[]
  /** Отказ на следующий вызов слияния или отката. */
  fail: MergeApiError | null
  calls: string[]
}

/** Id слияний подставного клиента: своя серия `series` у контактов и у сделок. */
export function fakeMergeIds(series: string): () => string {
  let counter = 0
  return () => `00000000-0000-4000-${series}-${String(++counter).padStart(12, '0')}`
}

/** Образец слияния вида `entityType` без участников: их подставляет вызывающий. */
export const sampleMergeRecord = (
  entityType: MergeRecord['entityType'],
  id: string,
  undoUntil: string,
): MergeRecord => ({
  id,
  entityType,
  survivorId: '',
  mergedId: '',
  parentId: null,
  mergedBy: { id: 'user-1', name: 'Власник' },
  mergedAt: '2026-11-20T10:00:00.000Z',
  undoUntil,
  undoneAt: null,
})

/** Бросает отказ, заданный на следующий вызов, и снимает его. */
export function takeFailure(state: { fail: MergeApiError | null }) {
  const failure = state.fail
  state.fail = null
  if (failure) throw failure
}

/** Запись слияния без имени слитой записи — как её отдаёт API. */
export const mergeRecordOf = (item: MergeRecord): MergeRecord => ({
  id: item.id,
  entityType: item.entityType,
  survivorId: item.survivorId,
  mergedId: item.mergedId,
  parentId: item.parentId,
  mergedBy: item.mergedBy === null ? null : { ...item.mergedBy },
  mergedAt: item.mergedAt,
  undoUntil: item.undoUntil,
  undoneAt: item.undoneAt,
})

/** Слияния в запись `survivorId`, которые ещё не откатили. */
export const survivorMerges = <Item extends MergeRecord>(
  state: FakeMergeState<Item>,
  survivorId: string,
): Item[] => structuredClone(state.merges.filter((m) => m.survivorId === survivorId && !m.undoneAt))

/** Откат слияния `mergeId` в памяти: отказ на вызов, 404 MERGE_NOT_FOUND, отметка отката. */
export function undoneMerge<Item extends MergeRecord>(
  state: FakeMergeState<Item>,
  mergeId: string,
): Item {
  state.calls.push(`undo ${mergeId}`)
  takeFailure(state)
  const item = state.merges.find((m) => m.id === mergeId)
  if (!item) throw new MergeApiError(404, 'MERGE_NOT_FOUND')
  item.undoneAt = '2026-11-21T10:00:00.000Z'
  return item
}
