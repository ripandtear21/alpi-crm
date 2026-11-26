import { type Database, withProject } from '@alpi/db'
import {
  WEBHOOK_FAILING_DAYS,
  type WebhookAttemptError,
  type WebhookDisabledReason,
} from '@alpi/shared'
import { type Kysely, sql } from 'kysely'
import { audit } from '../audit/record.ts'
import type { DeliveryMessage } from './queue.ts'
import { decryptWebhookSecret } from './secret.ts'
import { type SendResult, sendWebhook } from './send.ts'
import { webhookHeaders } from './sign.ts'
import { checkWebhookUrl, type HostLookup } from './ssrf.ts'

// Доставка события на адрес (тикет crm-api/06): обработчик очереди `webhook-deliver`. Доставка
// «хотя бы один раз», порядок не обещается: одно событие может прийти больше одного раза,
// приёмник отбрасывает повтор по `webhook-id`.
//
// 1. В транзакции проекта (withProject из задачи — чужая доставка не находится): доставка ещё
//    pending? Адрес отключён — доставка cancelled, без ошибки.
// 2. Вне транзакции: адрес проверяется на SSRF заново (имя могло начать разрешаться во
//    внутреннюю сеть), тело подписывается (Standard Webhooks, sign.ts) и уходит на проверенный IP
//    (send.ts). Транзакция не держится открытой, пока идёт запрос.
// 3. В транзакции проекта: попытка в журнал и итог.
//    - 2xx — succeeded, у адреса — время последнего успеха.
//    - 410 — адрес отключается сразу (gone_410), его ожидающие доставки — cancelled.
//    - Любое другое (3xx, 429, 5xx, таймаут, ошибка сети, адрес запрещён) — неудача. Если у
//      адреса неудачи идут 5 суток подряд (от первой неудачи после последнего успеха или
//      включения) — отключается (failing_5_days). Иначе последняя попытка — доставка failed; не последняя — обработчик
//      бросает ошибку, и pg-boss ставит повтор (настройки — queue.ts).
// Отключение системой пишет журнал проекта (без автора) — по нему же предупреждение в шапке.
//
// Остановка API (jobs/shutdown.ts): pg-boss дожидается текущих доставок (таймаут попытки 15 с
// меньше срока остановки); по сигналу остановки попытка обрывается и повторится после запуска.

export interface WebhookDeliveryOptions {
  /** Ключ шифрования секретов (config.ts, WEBHOOK_SECRET_KEY); null — доставка невозможна. */
  secretKey: Buffer | null
  /** http:// и loopback — только автотесты (WEBHOOK_ALLOW_INSECURE_URLS). */
  allowInsecureUrls: boolean
  lookup?: HostLookup
  /** Таймаут попытки, мс; по умолчанию 15 с. */
  timeoutMs?: number
  /** Часы: время подписи, 24 часа прежнего секрета, 5 суток без успеха. Тесты подменяют. */
  now?: () => Date
}

/** Задача доставки, как её отдаёт pg-boss (с метаданными повторов). */
export interface DeliveryJob {
  data: DeliveryMessage
  retryCount: number
  retryLimit: number
  retryDelay: number
  retryBackoff: boolean
  retryDelayMax?: number | null
  signal?: AbortSignal
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Неудачная попытка, после которой pg-boss повторит доставку. Текст — без адреса и секрета. */
export class DeliveryFailedError extends Error {
  constructor(deliveryId: string, result: SendResult) {
    super(
      `доставка ${deliveryId}: ${result.statusCode === null ? result.error : `ответ ${result.statusCode}`}`,
    )
    this.name = 'DeliveryFailedError'
  }
}

/**
 * Самое раннее время следующей попытки — по формуле pg-boss (plans.ts, failJobs) без случайной
 * добавки: пауза `retryDelay`, с retryBackoff — `max(retryDelay, 1) × 2^min(16, retryCount + 1) / 2`,
 * не больше `retryDelayMax`.
 */
export function earliestRetryAt(job: DeliveryJob, now: Date): Date {
  let seconds = job.retryDelay
  if (job.retryBackoff) {
    seconds = (Math.max(job.retryDelay, 1) * 2 ** Math.min(16, job.retryCount + 1)) / 2
    if (job.retryDelayMax != null) seconds = Math.min(seconds, job.retryDelayMax)
  }
  return new Date(now.getTime() + seconds * 1000)
}

/**
 * Отключает адрес `endpointId` (если он ещё активен): причина, время, ожидающие доставки —
 * cancelled, запись в журнал проекта. `actor` — пользователь при ручном отключении, null —
 * система. Возвращает true, если адрес был активен.
 */
export async function disableEndpoint(
  trx: Kysely<Database>,
  projectId: string,
  endpointId: string,
  reason: WebhookDisabledReason,
  actor: { actorId: string | null; actorApiKeyId?: string | null; ip: string | null } = {
    actorId: null,
    ip: null,
  },
): Promise<boolean> {
  const disabled = await trx
    .updateTable('webhook_endpoint')
    .set({
      state: 'disabled',
      disabled_reason: reason,
      disabled_at: sql<Date>`now()`,
      updated_at: sql<Date>`now()`,
    })
    .where('id', '=', endpointId)
    .where('state', '=', 'active')
    .returning(['url'])
    .executeTakeFirst()
  if (!disabled) return false
  await trx
    .updateTable('webhook_delivery')
    .set({ state: 'cancelled', next_attempt_at: null, updated_at: sql<Date>`now()` })
    .where('endpoint_id', '=', endpointId)
    .where('state', '=', 'pending')
    .execute()
  await audit.record(trx, projectId, {
    action: 'webhook_endpoint.disabled',
    ...actor,
    entity: { type: 'webhook_endpoint', id: endpointId },
    details: { reason, url: disabled.url },
  })
  return true
}

/** Что нужно для отправки: доставка, адрес, тело события. */
async function loadPending(trx: Kysely<Database>, deliveryId: string) {
  const row = await trx
    .selectFrom('webhook_delivery as d')
    .innerJoin('webhook_endpoint as e', 'e.id', 'd.endpoint_id')
    .innerJoin('webhook_event as ev', 'ev.id', 'd.event_id')
    .select([
      'd.id',
      'd.state',
      'd.endpoint_id',
      'e.url',
      'e.state as endpoint_state',
      'e.secret_encrypted',
      'e.previous_secret_encrypted',
      'e.previous_secret_expires_at',
      'ev.id as event_id',
      'ev.body',
    ])
    .where('d.id', '=', deliveryId)
    .executeTakeFirst()
  if (row?.state !== 'pending') return null
  if (row.endpoint_state !== 'active') {
    await trx
      .updateTable('webhook_delivery')
      .set({ state: 'cancelled', next_attempt_at: null, updated_at: sql<Date>`now()` })
      .where('id', '=', deliveryId)
      .execute()
    return null
  }
  return row
}

type Pending = NonNullable<Awaited<ReturnType<typeof loadPending>>>

/** Действующие секреты: текущий и прежний, если его 24 часа ещё не истекли. */
function activeSecrets(row: Pending, key: Buffer, projectId: string, now: Date): string[] {
  const owner = { projectId, endpointId: row.endpoint_id }
  const secrets = [decryptWebhookSecret(key, owner, row.secret_encrypted)]
  if (
    row.previous_secret_encrypted !== null &&
    row.previous_secret_expires_at !== null &&
    new Date(row.previous_secret_expires_at).getTime() > now.getTime()
  ) {
    secrets.push(decryptWebhookSecret(key, owner, row.previous_secret_encrypted))
  }
  return secrets
}

/** Попытка без запроса: адрес не прошёл проверку перед отправкой. */
function refusedAttempt(error: WebhookAttemptError): SendResult {
  return { statusCode: null, error, durationMs: 0, responseBody: null }
}

/** Проверяет адрес и отправляет подписанное событие. */
async function attempt(
  row: Pending,
  options: WebhookDeliveryOptions,
  secrets: string[],
  now: Date,
  signal: AbortSignal | undefined,
): Promise<SendResult> {
  const checked = await checkWebhookUrl(row.url, {
    allowInsecure: options.allowInsecureUrls,
    ...(options.lookup ? { lookup: options.lookup } : {}),
  })
  if (!checked.ok) {
    return refusedAttempt(checked.problem === 'unresolvable' ? 'dns' : 'forbidden_address')
  }
  const [address] = checked.value.addresses
  if (!address) return refusedAttempt('dns')
  const body = JSON.stringify(row.body)
  return sendWebhook({
    url: checked.value.url,
    address,
    body,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'user-agent': 'Alpi-CRM-Webhooks/1',
      ...webhookHeaders({
        id: row.event_id,
        timestamp: Math.floor(now.getTime() / 1000),
        body,
        secrets,
      }),
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(signal ? { signal } : {}),
  })
}

/** Итог попытки для pg-boss: retry — бросить ошибку, чтобы pg-boss повторил. */
type Outcome = 'done' | 'retry'

async function recordAttempt(
  trx: Kysely<Database>,
  job: DeliveryJob,
  row: Pending,
  result: SendResult,
  now: Date,
): Promise<Outcome> {
  const { projectId, deliveryId } = job.data
  await trx
    .insertInto('webhook_delivery_attempt')
    .values({
      project_id: projectId,
      delivery_id: deliveryId,
      status_code: result.statusCode,
      error: result.error,
      duration_ms: result.durationMs,
      response_body: result.responseBody,
    })
    .execute()
  const status = result.statusCode
  const bump = { attempts: sql<number>`attempts + 1`, updated_at: sql<Date>`now()` }
  const delivery = trx.updateTable('webhook_delivery').where('id', '=', deliveryId)

  if (status !== null && status >= 200 && status < 300) {
    await delivery
      .set({ ...bump, state: 'succeeded', succeeded_at: sql<Date>`now()`, next_attempt_at: null })
      .execute()
    // Успех обрывает серию неудач: 5 суток считаются заново от следующей неудачи.
    await trx
      .updateTable('webhook_endpoint')
      .set({ last_success_at: sql<Date>`now()`, failing_since: null })
      .where('id', '=', row.endpoint_id)
      .execute()
    return 'done'
  }
  const after = await delivery.set(bump).returning('state').executeTakeFirst()
  // Пока шёл запрос, адрес отключили (и доставку отменили) — повторять нечего.
  if (after?.state !== 'pending') return 'done'
  if (status === 410) {
    await disableEndpoint(trx, projectId, row.endpoint_id, 'gone_410')
    return 'done'
  }
  // 5 суток без успеха — от первой неудачи серии (после последнего успеха или включения), а не
  // от самого успеха: адрес, на который давно ничего не отправлялось, первая неудача не
  // отключает. Первая неудача серии пишется одним UPDATE: блокировка строки адреса
  // упорядочивает параллельные доставки, и вторая видит время, записанное первой.
  const endpoint = await trx
    .updateTable('webhook_endpoint')
    .set({ failing_since: sql<Date>`coalesce(failing_since, ${now})` })
    .where('id', '=', row.endpoint_id)
    .where('state', '=', 'active')
    .returning('failing_since')
    .executeTakeFirst()
  if (
    endpoint?.failing_since != null &&
    now.getTime() - new Date(endpoint.failing_since).getTime() >= WEBHOOK_FAILING_DAYS * DAY_MS
  ) {
    await disableEndpoint(trx, projectId, row.endpoint_id, 'failing_5_days')
    return 'done'
  }
  if (job.retryCount >= job.retryLimit) {
    await delivery.set({ state: 'failed', next_attempt_at: null }).execute()
    return 'done'
  }
  await delivery.set({ next_attempt_at: earliestRetryAt(job, now) }).execute()
  return 'retry'
}

/** Обработчик одной задачи `webhook-deliver`. Неудача, которую надо повторить, — исключение. */
export async function deliverWebhook(
  db: Kysely<Database>,
  options: WebhookDeliveryOptions,
  job: DeliveryJob,
): Promise<void> {
  const { projectId, deliveryId } = job.data
  if (typeof projectId !== 'string' || typeof deliveryId !== 'string') {
    throw new Error('задача webhook-deliver без projectId или deliveryId')
  }
  const row = await withProject(db, projectId, (trx) => loadPending(trx, deliveryId))
  if (!row) return
  const key = options.secretKey
  if (key === null) {
    throw new Error('доставка событий невозможна: не задана WEBHOOK_SECRET_KEY (config.ts)')
  }
  const now = (options.now ?? (() => new Date()))()
  const secrets = activeSecrets(row, key, projectId, now)
  const result = await attempt(row, options, secrets, now, job.signal)
  const outcome = await withProject(db, projectId, (trx) =>
    recordAttempt(trx, job, row, result, now),
  )
  if (outcome === 'retry') throw new DeliveryFailedError(deliveryId, result)
}

/**
 * Обработчик `webhook-deliver-dead`: задача доставки исчерпала повторы, не дойдя до итога
 * (процесс убит, срок задачи истёк, сбой базы) — доставка, если ещё ждёт, становится failed.
 */
export async function failDeadDelivery(
  db: Kysely<Database>,
  message: DeliveryMessage,
): Promise<void> {
  await withProject(db, message.projectId, (trx) =>
    trx
      .updateTable('webhook_delivery')
      .set({ state: 'failed', next_attempt_at: null, updated_at: sql<Date>`now()` })
      .where('id', '=', message.deliveryId)
      .where('state', '=', 'pending')
      .execute(),
  )
}
