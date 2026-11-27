import { type Database, withProject } from '@alpi/db'
import {
  INBOUND_RETENTION_DAYS,
  type InboundErrorCode,
  type InboundOutcome,
  type InboundReplayQueued,
} from '@alpi/shared'
import { Hono } from 'hono'
import { type Kysely, sql, type Transaction } from 'kysely'
import { audit, recordInRequest } from '../audit/record.ts'
import { fail, readBody, refuse } from '../contacts/http.ts'
import { type PermissionsEnv, requestAccess } from '../middleware/permissions.ts'
import { handleRegistration, REGISTRATION_CHANNEL } from './journal.ts'

// «Провести заново входящие с момента T» (тикет crm-intake/06; пункт 38, ADR 0006): после
// восстановления базы из копии администратор проводит запросы журнала входящих ещё раз.
//
// - `POST /v1/inbound/replay` с `{ since }` — только по сессии (ключу API — 403
//   API_KEY_NOT_ALLOWED: маршрут без отметки apiKeyRoute) и только администратору проекта
//   (`is_admin`); T не старше 30 дней — иначе 422 REPLAY_TOO_OLD. Ставит фоновую задачу pg-boss
//   той же транзакцией, что пишет запуск в журнал проекта (`inbound.replay_started`); 202.
// - Задача (replayInbound) берёт строки журнала проекта всех источников канала регистраций с T
//   до момента запуска по времени прихода, кроме строк самих повторных проведений, и проводит
//   каждую той же функцией, что запрос источника (intake/journal.ts, handleRegistration):
//   повтор безопасен по event_id. Каждая проведённая строка даёт новую строку журнала с
//   `replay_of`. Источник берётся по id: отключённый после приёма запроса не мешает (решено
//   без владельца — подтвердить). Итог (принято, повторов, ошибок) — в журнал проекта
//   (`inbound.replay_finished`), автор — запустивший.

/** Задача «провести заново». */
export interface InboundReplayMessage {
  projectId: string
  /** Кто запустил: автор строк журнала проекта. */
  initiatorId: string
  /** ISO 8601: входящие с этого момента… */
  since: string
  /** …до этого (момент запуска). */
  until: string
}

/** Очередь «провести заново»: в API — pg-boss (apps/api/src/jobs/jobs.ts). */
export interface InboundDeps {
  /** Ставит задачу той же транзакцией проекта, что пишет запуск в журнал. */
  enqueueReplay(trx: Transaction<Database>, message: InboundReplayMessage): Promise<void>
}

/** Без очереди: запуск — ошибка 500 (в API очередь подключена всегда, apps/api/src/index.ts). */
export const NO_INBOUND: InboundDeps = {
  enqueueReplay: async () => {
    throw new Error('очередь фоновых задач не подключена')
  },
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Маршруты журнала входящих проекта: `/v1/inbound`. */
export function inboundRoutes(deps: InboundDeps) {
  return new Hono<PermissionsEnv>().post('/replay', async (c) => {
    const access = await requestAccess(c)
    if (!access?.isAdmin) return fail(c, refuse(403, 'PERMISSION_DENIED' as InboundErrorCode))
    const body = await readBody(c)
    const raw = body?.since
    const time = typeof raw === 'string' ? Date.parse(raw) : Number.NaN
    if (!body || Object.keys(body).length !== 1 || Number.isNaN(time)) {
      return fail(c, refuse(400, 'INVALID_REPLAY' as InboundErrorCode, { path: 'since' }))
    }
    const db = c.get('db')
    // Время базы: по нему пишется время прихода строк журнала.
    const { rows } = await sql<{ now: Date }>`select clock_timestamp() as now`.execute(db)
    const now = rows[0]?.now ?? new Date()
    if (time < now.getTime() - INBOUND_RETENTION_DAYS * DAY_MS) {
      return fail(c, refuse(422, 'REPLAY_TOO_OLD' as InboundErrorCode))
    }
    const since = new Date(time).toISOString()
    const until = new Date(now).toISOString()
    await deps.enqueueReplay(db, {
      projectId: c.get('projectId'),
      initiatorId: c.get('session').user.id,
      since,
      until,
    })
    await recordInRequest(c, { action: 'inbound.replay_started', details: { since, until } })
    return c.json<InboundReplayQueued>({ since, until }, 202)
  })
}

/** Строк журнала в порции задачи. */
const REPLAY_BATCH = 100

/** Строка журнала для повторного проведения и её источник. */
interface ReplayRow {
  id: string
  body: string
  source_id: string
  project_id: string
  pipeline_id: string
  /** Время прихода с микросекундами (курсор). */
  at: string
}

/** Сколько строк проведено заново с каким итогом. */
export type ReplayCounts = Record<InboundOutcome, number>

/** Порция строк журнала после позиции `after` (по времени прихода и id). */
function replayBatch(
  db: Kysely<Database>,
  message: InboundReplayMessage,
  after: ReplayRow | null,
): Promise<ReplayRow[]> {
  return withProject(db, message.projectId, async (trx) => {
    const { rows } = await sql<ReplayRow>`
      select r.id, r.body, s.id as source_id, s.project_id, s.pipeline_id,
        to_char(r.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at
      from inbound_request r
      join intake_source s on s.id = r.intake_source_id and s.project_id = r.project_id
      where r.channel = ${REGISTRATION_CHANNEL}
        and r.replay_of is null
        and r.received_at >= ${message.since}::timestamptz
        and r.received_at < ${message.until}::timestamptz
        and ${
          after
            ? sql`(r.received_at, r.id) > (${after.at}::timestamptz, ${after.id}::uuid)`
            : sql`true`
        }
      order by r.received_at, r.id
      limit ${REPLAY_BATCH}
    `.execute(trx)
    return rows
  })
}

/**
 * Проводит заново входящие регистрации проекта из `message` — по одной, каждую своей
 * транзакцией (handleRegistration); итог — в журнал проекта. Повтор задачи после сбоя
 * безопасен: уже проведённое отвечает повтором.
 */
export async function replayInbound(
  db: Kysely<Database>,
  message: InboundReplayMessage,
): Promise<ReplayCounts> {
  const counts: ReplayCounts = { accepted: 0, repeat: 0, error: 0 }
  let last: ReplayRow | null = null
  for (;;) {
    const rows = await replayBatch(db, message, last)
    for (const row of rows) {
      const answer = await handleRegistration(
        db,
        { id: row.source_id, projectId: row.project_id, pipelineId: row.pipeline_id },
        row.body,
        { replayOf: row.id },
      )
      counts[answer.outcome]++
    }
    last = rows.at(-1) ?? null
    if (last === null || rows.length < REPLAY_BATCH) break
  }
  await withProject(db, message.projectId, (trx) =>
    audit.record(trx, message.projectId, {
      action: 'inbound.replay_finished',
      actorId: message.initiatorId,
      ip: null,
      details: {
        since: message.since,
        until: message.until,
        accepted: counts.accepted,
        repeats: counts.repeat,
        errors: counts.error,
      },
    }),
  )
  return counts
}
