import { type Database, withProject } from '@alpi/db'
import {
  INBOUND_OUTCOMES,
  type InboundChannel,
  type InboundOutcome,
  type InboundRequestView,
  type Page,
  type ProblemDetails,
  parseRegistration,
  type RegistrationAccepted,
  type RegistrationErrorCode,
} from '@alpi/shared'
import { type Kysely, sql } from 'kysely'
import { decodePageCursor, encodePageCursor } from '../filters/page.ts'
import { problemBody } from '../http/problem.ts'
import type { IntakeSource } from './auth.ts'
import { type ProcessResult, processRegistration } from './process.ts'

// Журнал входящих (тикет crm-intake/06; пункт 38, ADR 0006): каждый входящий запрос приёма с
// сырым телом и итогом — 30 дней (ночная очистка — jobs/inbound-purge.ts). 401 (ключ) и 429
// (лимит) сюда не пишутся: до проекта запрос не дошёл или источник сам превысил лимит
// (решено без владельца — подтвердить).
//
// - Принятый запрос и повтор пишутся той же транзакцией, что обработка: строка журнала есть
//   ровно тогда, когда есть их данные.
// - Ошибка обработки (отказ или сбой) откатывает транзакцию обработки целиком; строка с ошибкой
//   и сырым телом пишется отдельной транзакцией после отката — данных нет, строка есть.
// - «Провести заново» (intake/replay.ts) зовёт ту же handleRegistration с `replayOf`.

/** Канал журнала для регистраций. */
export const REGISTRATION_CHANNEL: InboundChannel = 'intake.registration'

/** Строка журнала для записи. */
interface InboundEntry {
  channel: InboundChannel
  sourceId: string
  statusCode: number
  outcome: InboundOutcome
  errorCode: string | null
  eventId: string | null
  body: string
  result: Record<string, unknown> | null
  warnings: readonly string[]
  replayOf: string | null
}

/** Символ NUL: в text PostgreSQL его не сохранить — в журнале он заменяется на U+FFFD. */
const NUL = String.fromCharCode(0)
const REPLACEMENT = String.fromCharCode(0xfffd)

async function writeInbound(
  trx: Kysely<Database>,
  projectId: string,
  entry: InboundEntry,
): Promise<string> {
  const { id } = await trx
    .insertInto('inbound_request')
    .values({
      project_id: projectId,
      channel: entry.channel,
      intake_source_id: entry.sourceId,
      status_code: entry.statusCode,
      outcome: entry.outcome,
      error_code: entry.errorCode,
      event_id: entry.eventId,
      body: entry.body.replaceAll(NUL, REPLACEMENT),
      result: entry.result === null ? null : JSON.stringify(entry.result),
      warnings: [...entry.warnings],
      replay_of: entry.replayOf,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return id
}

/** Ответ на входящую регистрацию: код, тело и строка журнала. */
export interface IntakeAnswer {
  status: number
  outcome: InboundOutcome
  body: RegistrationAccepted | ProblemDetails
  journalId: string
}

/** Отказ обработки: бросается из транзакции, чтобы откатить всё, что она успела записать. */
class ProcessingRefusal extends Error {
  readonly refusal: Extract<ProcessResult, { ok: false }>

  constructor(refusal: Extract<ProcessResult, { ok: false }>) {
    super(refusal.code)
    this.refusal = refusal
  }
}

/** `event_id` тела для журнала (строка или число до 255 символов), не разбирая остального. */
function eventIdOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const value = (body as Record<string, unknown>).event_id
  const text =
    typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : null
  return text !== null && text !== '' && text.length <= 255 ? text.replaceAll(NUL, '') : null
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

/**
 * Регистрация от источника `source` с сырым телом `raw`: разбор, обработка, строка журнала.
 * `replayOf` — строка журнала, которую проводят заново.
 */
export async function handleRegistration(
  db: Kysely<Database>,
  source: IntakeSource,
  raw: string,
  options: { replayOf?: string } = {},
): Promise<IntakeAnswer> {
  const body = parseJson(raw)
  const entry = {
    channel: REGISTRATION_CHANNEL,
    sourceId: source.id,
    eventId: eventIdOf(body),
    body: raw,
    replayOf: options.replayOf ?? null,
  }
  const failed = async (status: number, code: RegistrationErrorCode): Promise<IntakeAnswer> => {
    const journalId = await withProject(db, source.projectId, (trx) =>
      writeInbound(trx, source.projectId, {
        ...entry,
        statusCode: status,
        outcome: 'error',
        errorCode: code,
        result: null,
        warnings: [],
      }),
    )
    return { status, outcome: 'error', body: problemBody(status, code), journalId }
  }

  const parsed = parseRegistration(body)
  if (!parsed.ok) return failed(400, parsed.code)
  try {
    return await withProject(db, source.projectId, async (trx) => {
      const result = await processRegistration(trx, source, parsed.value)
      if (!result.ok) throw new ProcessingRefusal(result)
      const journalId = await writeInbound(trx, source.projectId, {
        ...entry,
        statusCode: result.status,
        outcome: result.outcome,
        errorCode: null,
        result: {
          registration_id: result.body.registration_id,
          contact_id: result.body.contact_id,
          deal_id: result.body.deal_id,
        },
        warnings: result.body.warnings,
      })
      return { status: result.status, outcome: result.outcome, body: result.body, journalId }
    })
  } catch (error) {
    if (error instanceof ProcessingRefusal) {
      return failed(error.refusal.status, error.refusal.code)
    }
    console.error(`приём регистрации источника ${source.id}: сбой обработки`, error)
    return failed(500, 'INTERNAL')
  }
}

// ---- Чтение журнала --------------------------------------------------------------------------

/** Сортировка журнала источника: новые сверху. */
const INBOUND_SORT = 'receivedAt:desc'

/** Курсор, фильтр итога и размер страницы журнала источника. */
export interface InboundQuery {
  limit: number
  cursor?: string
  outcome?: string
}

/**
 * Страница журнала входящих источника `sourceId` (новые сверху), с телом запроса; null —
 * неверный фильтр итога или курсор. Транзакция проекта: RLS отдаёт только свои строки.
 */
export async function inboundPage(
  db: Kysely<Database>,
  sourceId: string,
  query: InboundQuery,
): Promise<Page<InboundRequestView> | null> {
  const outcome = query.outcome
  if (outcome !== undefined && !INBOUND_OUTCOMES.some((value) => value === outcome)) return null
  const cursor =
    query.cursor === undefined
      ? undefined
      : decodePageCursor(query.cursor, INBOUND_SORT, 'timestamptz')
  if (query.cursor !== undefined && cursor === undefined) return null
  const { rows } = await sql<{
    id: string
    channel: InboundChannel
    intake_source_id: string | null
    received_at: Date
    status_code: number
    outcome: InboundOutcome
    error_code: string | null
    event_id: string | null
    body: string
    result: Record<string, unknown> | null
    warnings: string[]
    replay_of: string | null
    cursor_at: string
  }>`
    select id, channel, intake_source_id, received_at, status_code, outcome, error_code,
      event_id, body, result, warnings, replay_of,
      to_char(received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at
    from inbound_request
    where intake_source_id = ${sourceId}
      and ${outcome === undefined ? sql`true` : sql`outcome = ${outcome}`}
      and ${
        cursor ? sql`(received_at, id) < (${cursor.v}::timestamptz, ${cursor.id}::uuid)` : sql`true`
      }
    order by received_at desc, id desc
    limit ${query.limit + 1}
  `.execute(db)
  const page = rows.slice(0, query.limit)
  const last = page.at(-1)
  return {
    data: page.map((row) => ({
      id: row.id,
      channel: row.channel,
      sourceId: row.intake_source_id,
      receivedAt: new Date(row.received_at).toISOString(),
      statusCode: row.status_code,
      outcome: row.outcome,
      errorCode: row.error_code,
      eventId: row.event_id,
      body: row.body,
      result: row.result,
      warnings: row.warnings,
      replayOf: row.replay_of,
    })),
    next_cursor:
      rows.length > query.limit && last
        ? encodePageCursor(INBOUND_SORT, { v: last.cursor_at, id: last.id })
        : null,
  }
}
