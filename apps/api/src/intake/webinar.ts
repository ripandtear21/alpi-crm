import { type Database, withProject } from '@alpi/db'
import {
  type InboundChannel,
  type InboundOutcome,
  type ParsedWebinarView,
  type ProblemDetails,
  parseWebinarView,
  registrationEventId,
  type WebinarViewAccepted,
  type WebinarViewErrorCode,
} from '@alpi/shared'
import { type Kysely, sql } from 'kysely'
import { type ChangeAuthor, diffFields, recordChanges } from '../change-log/record.ts'
import { findContactMatch } from '../contacts/match.ts'
import { problemBody } from '../http/problem.ts'
import type { IntakeSource } from './auth.ts'
import { parseJson, writeInbound } from './journal.ts'

// Просмотры вебинара (тикет crm-intake/08; .scratch/crm-intake/spec.md, «Просмотры вебинара»;
// GLOSSARY.md, «Просмотр вебинара»): `POST /api/intake/webinar-views` тем же ключом источника,
// с тем же журналом входящих и «провести заново», что регистрации (journal.ts, replay.ts).
//
// Просмотр ничего не создаёт — ни контакта, ни регистрации, ни сделки (пункты 7 и 17; ADR 0003):
// 1. Повтор: пара «источник, event_id» (intake_event, kind 'webinar_view') уже есть — тот же
//    ответ, ничего не меняется. «Провести заново» поэтому не вернёт старые значения просмотра
//    поверх новых.
// 2. Контакт — findContactMatch (телефон, затем email). Найденный блокируется FOR SHARE и
//    перечитывается: слияние не перенесёт его регистрации, пока просмотр пишется; слитый или
//    удалённый за это время — поиск заново. Порядок блокировок — контакт, регистрация, как у
//    слияния (тикет 12).
// 3. Регистрация — последняя по времени создания регистрация контакта с тем же `webinar`
//    (совпадение строки целиком, решено без владельца — подтвердить), FOR UPDATE.
// 4. Найдена: «начал смотреть», «вышел», «минут просмотрено» и `view_extra` заменяются
//    значениями запроса, даже пустыми (последние значения заменяют прежние, пункт 17); история —
//    в change_log регистрации с автором-источником. Не найдены контакт или регистрация: ничего
//    не записано, строка журнала с итогом 'unmatched', ответ 200 с `matched: false`.
// Событий о просмотре нет: в решении владельца их нет (открытый вопрос эпика).

/** Канал журнала для просмотров вебинара. */
export const WEBINAR_VIEW_CHANNEL: InboundChannel = 'intake.webinar_view'

/** Сколько раз искать контакт заново, если найденный слили или удалили до блокировки. */
const MATCH_ATTEMPTS = 5

const INTAKE_EVENT_KEY = ['project_id', 'intake_source_id', 'kind', 'event_id'] as const

/** Поля истории регистрации (change_log.field) и их столбцы. */
const VIEW_HISTORY = {
  viewStartedAt: 'view_started_at',
  viewFinishedAt: 'view_finished_at',
  viewMinutes: 'view_minutes',
  viewExtra: 'view_extra',
} as const

type ViewHistoryField = keyof typeof VIEW_HISTORY

/** Итог обработки просмотра: записан, повтор или без регистрации. */
interface ViewResult {
  outcome: Extract<InboundOutcome, 'accepted' | 'repeat' | 'unmatched'>
  body: WebinarViewAccepted
}

/** Ответ на входящий просмотр: код, тело и строка журнала. */
export interface WebinarViewAnswer {
  status: number
  outcome: InboundOutcome
  body: WebinarViewAccepted | ProblemDetails
  journalId: string
}

const UNMATCHED: ViewResult = {
  outcome: 'unmatched',
  body: { registration_id: null, matched: false },
}

/**
 * Повтор `event_id`: тот же ответ по регистрации из intake_event.
 * shortcut: регистрацию с этим просмотром удалили окончательно (с контактом) — повтор отвечает
 * `matched: false`, хотя первый раз был `true`; переделать, если источнику понадобится отличать
 * такой повтор (тогда — признак в intake_event или предупреждение, как RECORDS_DELETED).
 */
async function repeated(
  trx: Kysely<Database>,
  source: IntakeSource,
  eventId: string,
): Promise<ViewResult> {
  const row = await trx
    .selectFrom('intake_event')
    .select('registration_id')
    .where('intake_source_id', '=', source.id)
    .where('kind', '=', 'webinar_view')
    .where('event_id', '=', eventId)
    .executeTakeFirstOrThrow()
  return {
    outcome: 'repeat',
    body: { registration_id: row.registration_id, matched: row.registration_id !== null },
  }
}

/** Последняя регистрация контакта на вебинар `webinar`, заблокированная до конца транзакции. */
function lockLatestRegistration(trx: Kysely<Database>, contactId: string, webinar: string) {
  return trx
    .selectFrom('registration')
    .select(['id', ...Object.values(VIEW_HISTORY)])
    .where('contact_id', '=', contactId)
    .where('webinar', '=', webinar)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .forUpdate()
    .executeTakeFirst()
}

/** Регистрация просмотра (шаги 2 и 3): заблокированная, или null — контакта или её нет. */
async function findRegistration(trx: Kysely<Database>, view: ParsedWebinarView) {
  const keys = {
    phones: view.phone === null ? [] : [view.phone],
    emails: view.email === null ? [] : [view.email],
  }
  for (let attempt = 0; attempt < MATCH_ATTEMPTS; attempt++) {
    const match = await findContactMatch(trx, keys)
    if (match === null) return null
    // Слияние и корзина ключей не блокируют: найденный мог уйти до блокировки строки.
    const live = await trx
      .selectFrom('contact')
      .select('id')
      .where('id', '=', match.contactId)
      .where('deleted_at', 'is', null)
      .where('merged_into_id', 'is', null)
      .forShare()
      .executeTakeFirst()
    if (!live) continue
    return (await lockLatestRegistration(trx, live.id, view.webinar)) ?? null
  }
  throw new Error('контакт просмотра не найден: найденный каждый раз уходил до блокировки')
}

/** Значения истории из строки регистрации: время — ISO 8601, как в ответах API. */
function historyOf(row: {
  view_started_at: Date | null
  view_finished_at: Date | null
  view_minutes: number | null
  view_extra: Record<string, unknown> | null
}): Record<ViewHistoryField, unknown> {
  return {
    viewStartedAt: row.view_started_at?.toISOString() ?? null,
    viewFinishedAt: row.view_finished_at?.toISOString() ?? null,
    viewMinutes: row.view_minutes,
    viewExtra: row.view_extra,
  }
}

/** Обрабатывает просмотр `view` источника `source` транзакцией проекта `trx`. */
export async function processWebinarView(
  trx: Kysely<Database>,
  source: IntakeSource,
  view: ParsedWebinarView,
): Promise<ViewResult> {
  const author: ChangeAuthor = {
    db: trx,
    projectId: source.projectId,
    actorId: null,
    actorIntakeSourceId: source.id,
  }
  const claimed = await trx
    .insertInto('intake_event')
    .values({
      project_id: source.projectId,
      intake_source_id: source.id,
      kind: 'webinar_view',
      event_id: view.eventId,
    })
    .onConflict((oc) => oc.columns([...INTAKE_EVENT_KEY]).doNothing())
    .returning('event_id')
    .executeTakeFirst()
  if (!claimed) return repeated(trx, source, view.eventId)

  const registration = await findRegistration(trx, view)
  if (!registration) return UNMATCHED

  const after = await trx
    .updateTable('registration')
    .set({
      view_started_at: view.startedAt,
      view_finished_at: view.finishedAt,
      view_minutes: view.minutes,
      view_extra: JSON.stringify(view.extra),
      view_updated_at: sql`now()`,
    })
    .where('id', '=', registration.id)
    .returning(Object.values(VIEW_HISTORY))
    .executeTakeFirstOrThrow()
  // Обе стороны — из базы: jsonb хранит ключи в своём порядке, сравнение по JSON не ошибётся.
  const changes = diffFields(
    historyOf(registration),
    historyOf(after),
    Object.keys(VIEW_HISTORY) as ViewHistoryField[],
  )
  await recordChanges(author, { type: 'registration', id: registration.id }, changes)
  await trx
    .updateTable('intake_event')
    .set({ registration_id: registration.id })
    .where('intake_source_id', '=', source.id)
    .where('kind', '=', 'webinar_view')
    .where('event_id', '=', view.eventId)
    .execute()
  return { outcome: 'accepted', body: { registration_id: registration.id, matched: true } }
}

/**
 * Просмотр от источника `source` с сырым телом `raw`: разбор, обработка, строка журнала — как
 * handleRegistration (journal.ts). Ответ — 200 всегда, кроме ошибок. `replayOf` — строка
 * журнала, которую проводят заново.
 */
export async function handleWebinarView(
  db: Kysely<Database>,
  source: IntakeSource,
  raw: string,
  options: { replayOf?: string } = {},
): Promise<WebinarViewAnswer> {
  const body = parseJson(raw)
  const entry = {
    channel: WEBINAR_VIEW_CHANNEL,
    sourceId: source.id,
    eventId: registrationEventId(body),
    body: raw,
    replayOf: options.replayOf ?? null,
  }
  const failed = async (status: number, code: WebinarViewErrorCode) => {
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
    return { status, outcome: 'error' as const, body: problemBody(status, code), journalId }
  }

  const parsed = parseWebinarView(body)
  if (!parsed.ok) return failed(400, parsed.code)
  try {
    return await withProject(db, source.projectId, async (trx) => {
      const result = await processWebinarView(trx, source, parsed.value)
      const journalId = await writeInbound(trx, source.projectId, {
        ...entry,
        statusCode: 200,
        outcome: result.outcome,
        errorCode: null,
        result: { ...result.body },
        warnings: [],
      })
      return { status: 200, outcome: result.outcome, body: result.body, journalId }
    })
  } catch (error) {
    console.error(`приём просмотра вебинара источника ${source.id}: сбой обработки`, error)
    return failed(500, 'INTERNAL')
  }
}
