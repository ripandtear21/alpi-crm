import type { Database } from '@alpi/db'
import type { InboundReplayRun, InboundReplayStatus } from '@alpi/shared'
import { type Kysely, sql } from 'kysely'

// Ход и итог «провести заново» (тикет crm-intake/07) для экрана «Налаштування → Джерела»:
// `GET /v1/inbound/replay` (маршрут — intake/replay.ts). Отдельного состояния задачи нет:
// запуск пишется в журнал проекта (`inbound.replay_started`), итог — туда же
// (`inbound.replay_finished`) с теми же since и until; итога ещё нет — задача идёт.

/** Поля итога, которые не счётчики. */
const RUN_FIELDS = new Set(['since', 'until'])

/** Последний запуск «провести заново» в проекте `projectId` и его итог, если он есть. */
export async function latestReplay(
  db: Kysely<Database>,
  projectId: string,
): Promise<InboundReplayStatus> {
  const { rows } = await sql<{
    started_at: Date
    started: { since?: unknown; until?: unknown }
    actor_id: string | null
    actor_name: string | null
    finished_at: Date | null
    finished: Record<string, unknown> | null
  }>`
    select s.occurred_at as started_at, s.details as started, s.actor_id, u.name as actor_name,
      f.occurred_at as finished_at, f.details as finished
    from audit_log s
    left join "user" u on u.id = s.actor_id
    left join lateral (
      select occurred_at, details
      from audit_log
      where project_id = s.project_id
        and action = 'inbound.replay_finished'
        and details->>'since' = s.details->>'since'
        and details->>'until' = s.details->>'until'
      order by occurred_at desc, id desc
      limit 1
    ) f on true
    where s.project_id = ${projectId} and s.action = 'inbound.replay_started'
    order by s.occurred_at desc, s.id desc
    limit 1
  `.execute(db)
  const row = rows[0]
  if (!row) return { latest: null }
  const counts =
    row.finished === null
      ? null
      : Object.fromEntries(
          Object.entries(row.finished).filter(
            (entry): entry is [string, number] =>
              !RUN_FIELDS.has(entry[0]) && typeof entry[1] === 'number',
          ),
        )
  const latest: InboundReplayRun = {
    since: String(row.started.since ?? ''),
    until: String(row.started.until ?? ''),
    startedAt: new Date(row.started_at).toISOString(),
    startedBy: row.actor_id === null ? null : { id: row.actor_id, name: row.actor_name ?? '' },
    finishedAt: row.finished_at === null ? null : new Date(row.finished_at).toISOString(),
    counts,
  }
  return { latest }
}
