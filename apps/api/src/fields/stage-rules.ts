import type { Database } from '@alpi/db'
import { type Kysely, sql } from 'kysely'

// Правила «обязательно с этапа X» при удалении этапа (тикет crm-fields/01; решено без владельца,
// подтвердить): правило переходит на следующий действующий этап той же воронки, а с последнего
// этапа — на «выигрыш» (stage_id null). Зовёт удаление этапа (pipelines/pipelines.ts) до
// отметки deleted_at, в той же транзакции и с заблокированными воронкой и этапом: база не даёт
// удалить этап, на который ссылается правило (триггер stage_keep_required_rules,
// migrations/0016_fields.ts).

/** Переводит правила с этапа `stageId` на следующий; возвращает, сколько правил переведено. */
export async function moveRulesOffStage(
  db: Kysely<Database>,
  pipelineId: string,
  stageId: string,
): Promise<number> {
  const { rows } = await sql<{ id: string }>`
    select s.id from stage s, stage deleted
    where deleted.id = ${stageId}
      and s.pipeline_id = ${pipelineId}
      and s.deleted_at is null
      and s.id <> deleted.id
      and (s.position, s.created_at, s.id) > (deleted.position, deleted.created_at, deleted.id)
    order by s.position, s.created_at, s.id
    limit 1
  `.execute(db)
  const next = rows[0]?.id ?? null
  const moved = await db
    .updateTable('field_required_stage')
    .set({ stage_id: next })
    .where('stage_id', '=', stageId)
    .executeTakeFirst()
  return Number(moved.numUpdatedRows)
}
