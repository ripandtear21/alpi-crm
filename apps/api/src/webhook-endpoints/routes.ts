import { randomUUID } from 'node:crypto'
import type { Database } from '@alpi/db'
import {
  EVENT_CATALOG,
  EVENT_TYPE_TITLES,
  EVENT_TYPES,
  type EventType,
  MAX_WEBHOOK_DESCRIPTION_LENGTH,
  WEBHOOK_DELIVERY_STATES,
  WEBHOOK_SECRET_OVERLAP_HOURS,
  type WebhookAlert,
  type WebhookAttemptError,
  type WebhookDeliveryState,
  type WebhookDeliveryView,
  type WebhookDisabledReason,
  type WebhookEndpointState,
  type WebhookEndpointSummary,
  type WebhookEndpointsErrorCode,
  type WebhookEndpointWithSecret,
  type WebhookEventTypeInfo,
} from '@alpi/shared'
import { Hono } from 'hono'
import { type Kysely, sql, type UpdateQueryBuilder, type UpdateResult } from 'kysely'
import { requestAuthor } from '../api-keys/actor.ts'
import { recordInRequest } from '../audit/record.ts'
import {
  type Ctx,
  fail,
  type Outcome,
  ok,
  optionalText,
  readBody,
  readLimit,
  refuse,
  UUID,
} from '../contacts/http.ts'
import { disableEndpoint, type WebhookDeliveryOptions } from '../events/deliver.ts'
import { enqueueDeliveries } from '../events/queue.ts'
import { encryptWebhookSecret, generateWebhookSecret } from '../events/secret.ts'
import { checkWebhookUrl, type UrlProblem } from '../events/ssrf.ts'
import { decodePageCursor, encodePageCursor } from '../filters/page.ts'
import { type PermissionsEnv, requirePermission } from '../middleware/permissions.ts'

// Адреса автоматизации и журнал доставок (тикет crm-api/06): `/v1/webhook-endpoints` (снаружи —
// /api/v1/webhook-endpoints). Только по сессии пользователя: маршруты без отметки apiKeyRoute,
// ключ получает 403 API_KEY_NOT_ALLOWED. Право «интеграции» (`integrations`): смотреть —
// список, типы событий, журнал, предупреждения; создавать; изменять — адрес, типы, включение,
// ручное отключение, смена секрета, ручной повтор; удалять.
//
// - Адрес проверяется на SSRF при сохранении (events/ssrf.ts): не https, внутренний IP, имя не
//   разрешилось — 422 с кодом причины. Перед каждой отправкой проверка повторяется (deliver.ts).
// - Секрет подписи — только в ответе на создание и на смену секрета; в базе — зашифрованным
//   (events/secret.ts). В журнал проекта и в журнал процесса секрет не попадает.
// - Смена секрета: прежний действует ещё 24 часа — события подписываются обоими (решено без
//   владельца — подтвердить). Вторая смена за 24 часа оставляет прежним только предыдущий.
// - Ручной повтор: одной доставки и «всё неудачное с даты» (failed и cancelled) для адреса
//   (решено без владельца — подтвердить). Повтор возвращает доставку в pending и ставит новую
//   задачу: попытки добавляются к той же доставке, `webhook-id` — тот же id события. Отключённому
//   адресу повтор недоступен (409) — сначала включить.
// - Создание, изменение, удаление, смена секрета, включение и отключение — в журнал проекта.

type Result<T> = Outcome<T, WebhookEndpointsErrorCode>

const invalid = (path: string) => refuse(400, 'INVALID_WEBHOOK_ENDPOINT', { path })
const invalidQuery = (path: string) => refuse(400, 'INVALID_WEBHOOK_DELIVERIES', { path })
const notFound = () => refuse(404, 'WEBHOOK_ENDPOINT_NOT_FOUND')

const URL_PROBLEM_CODES: Record<UrlProblem, WebhookEndpointsErrorCode> = {
  invalid: 'WEBHOOK_URL_INVALID',
  not_https: 'WEBHOOK_URL_NOT_HTTPS',
  forbidden_address: 'WEBHOOK_URL_FORBIDDEN_ADDRESS',
  unresolvable: 'WEBHOOK_URL_UNRESOLVABLE',
}

/** Сортировка журнала доставок для курсора: новые сверху. */
const DELIVERY_SORT = 'created_at:desc'

const HOUR_MS = 60 * 60 * 1000

/** Нет ключа шифрования — адреса не создаются (ответ 500, причина — в журнале процесса). */
export const NO_WEBHOOKS: WebhookDeliveryOptions = { secretKey: null, allowInsecureUrls: false }

function requireKey(deps: WebhookDeliveryOptions): Buffer {
  if (deps.secretKey === null) {
    throw new Error('адреса событий недоступны: не задана WEBHOOK_SECRET_KEY (config.ts)')
  }
  return deps.secretKey
}

function selectEndpoints(db: Kysely<Database>) {
  return db
    .selectFrom('webhook_endpoint as e')
    .innerJoin('user as u', 'u.id', 'e.created_by')
    .select([
      'e.id',
      'e.url',
      'e.description',
      'e.event_types',
      'e.state',
      'e.disabled_reason',
      'e.disabled_at',
      'e.last_success_at',
      'e.previous_secret_expires_at',
      'e.created_at',
      'e.created_by',
      'u.name as created_by_name',
    ])
}

type EndpointRow = Awaited<
  ReturnType<ReturnType<typeof selectEndpoints>['executeTakeFirstOrThrow']>
>

const iso = (value: Date | string | null) => (value === null ? null : new Date(value).toISOString())

function summary(row: EndpointRow): WebhookEndpointSummary {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    eventTypes: row.event_types as EventType[],
    state: row.state as WebhookEndpointState,
    disabledReason: row.disabled_reason as WebhookDisabledReason | null,
    disabledAt: iso(row.disabled_at),
    lastSuccessAt: iso(row.last_success_at),
    // Срок прежнего секрета, который уже прошёл, не показываем.
    previousSecretExpiresAt:
      row.previous_secret_expires_at !== null &&
      new Date(row.previous_secret_expires_at).getTime() > Date.now()
        ? iso(row.previous_secret_expires_at)
        : null,
    createdAt: new Date(row.created_at).toISOString(),
    createdBy: { id: row.created_by, name: row.created_by_name },
  }
}

async function endpointById(db: Kysely<Database>, id: string): Promise<WebhookEndpointSummary> {
  return summary(await selectEndpoints(db).where('e.id', '=', id).executeTakeFirstOrThrow())
}

/** Адрес `id` текущего проекта, заблокированный до конца транзакции; нет — 404. */
async function lockEndpoint(c: Ctx, id: string) {
  if (!UUID.test(id)) return null
  return c
    .get('db')
    .selectFrom('webhook_endpoint')
    .select(['id', 'url', 'state', 'secret_encrypted'])
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
}

/** Типы событий: непустой список известных типов без повторов (порядок каталога). */
function readEventTypes(value: unknown): EventType[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  if (!value.every((type) => typeof type === 'string' && Object.hasOwn(EVENT_CATALOG, type))) {
    return undefined
  }
  return EVENT_TYPES.filter((type) => value.includes(type))
}

/** Адрес: форма и SSRF; годится — нормализованный URL, иначе 422 с причиной. */
async function readUrl(value: unknown, deps: WebhookDeliveryOptions): Promise<Result<string>> {
  const checked = await checkWebhookUrl(value, {
    allowInsecure: deps.allowInsecureUrls,
    ...(deps.lookup ? { lookup: deps.lookup } : {}),
  })
  return checked.ok
    ? ok(checked.value.url.href)
    : refuse(422, URL_PROBLEM_CODES[checked.problem], { path: 'url' })
}

/** Что пишется в журнал проекта об адресе: без секрета. */
function auditDetails(endpoint: WebhookEndpointSummary) {
  return {
    url: endpoint.url,
    description: endpoint.description,
    eventTypes: endpoint.eventTypes,
  }
}

async function createEndpoint(
  c: Ctx,
  deps: WebhookDeliveryOptions,
): Promise<Result<WebhookEndpointWithSecret>> {
  const body = await readBody(c)
  if (!body) return invalid('')
  const extra = Object.keys(body).find((key) => !['url', 'description', 'eventTypes'].includes(key))
  if (extra !== undefined) return invalid(extra)
  const description =
    body.description === undefined
      ? null
      : optionalText(body.description, MAX_WEBHOOK_DESCRIPTION_LENGTH)
  if (description === undefined) return invalid('description')
  const eventTypes = readEventTypes(body.eventTypes)
  if (!eventTypes) return invalid('eventTypes')
  const url = await readUrl(body.url, deps)
  if (!url.ok) return url
  const key = requireKey(deps)

  const actor = c.get('actor')
  if (actor.type !== 'user') throw new Error('адрес событий создаёт только пользователь')
  const db = c.get('db')
  const projectId = c.get('projectId')
  const id = randomUUID()
  const secret = generateWebhookSecret()
  await db
    .insertInto('webhook_endpoint')
    .values({
      id,
      project_id: projectId,
      url: url.value,
      description,
      event_types: eventTypes,
      secret_encrypted: encryptWebhookSecret(key, { projectId, endpointId: id }, secret),
      created_by: actor.userId,
    })
    .execute()
  const endpoint = await endpointById(db, id)
  await recordInRequest(c, {
    action: 'webhook_endpoint.created',
    entity: { type: 'webhook_endpoint', id },
    details: auditDetails(endpoint),
  })
  return ok({ endpoint, secret })
}

async function updateEndpoint(
  c: Ctx,
  id: string,
  deps: WebhookDeliveryOptions,
): Promise<Result<WebhookEndpointSummary>> {
  const body = await readBody(c)
  if (!body) return invalid('')
  const keys = Object.keys(body)
  const extra = keys.find((key) => !['url', 'description', 'eventTypes'].includes(key))
  if (extra !== undefined) return invalid(extra)
  if (keys.length === 0) return invalid('')
  const changes: { url?: string; description?: string | null; event_types?: EventType[] } = {}
  if ('description' in body) {
    const description = optionalText(body.description, MAX_WEBHOOK_DESCRIPTION_LENGTH)
    if (description === undefined) return invalid('description')
    changes.description = description
  }
  if ('eventTypes' in body) {
    const eventTypes = readEventTypes(body.eventTypes)
    if (!eventTypes) return invalid('eventTypes')
    changes.event_types = eventTypes
  }
  // Адрес проверяется (DNS) до блокировки строки: запрос в DNS не держит блокировку.
  if ('url' in body) {
    const url = await readUrl(body.url, deps)
    if (!url.ok) return url
    changes.url = url.value
  }
  if (!(await lockEndpoint(c, id))) return notFound()
  const db = c.get('db')
  const before = await endpointById(db, id)
  await db
    .updateTable('webhook_endpoint')
    .set({ ...changes, updated_at: sql<Date>`now()` })
    .where('id', '=', id)
    .execute()
  const endpoint = await endpointById(db, id)
  await recordInRequest(c, {
    action: 'webhook_endpoint.updated',
    entity: { type: 'webhook_endpoint', id },
    details: { before: auditDetails(before), after: auditDetails(endpoint) },
  })
  return ok(endpoint)
}

async function enableEndpoint(c: Ctx, id: string): Promise<Result<WebhookEndpointSummary>> {
  const locked = await lockEndpoint(c, id)
  if (!locked) return notFound()
  const db = c.get('db')
  if (locked.state === 'disabled') {
    await db
      .updateTable('webhook_endpoint')
      .set({
        state: 'active',
        disabled_reason: null,
        disabled_at: null,
        // 5 суток без успеха считаются заново — от включения.
        enabled_at: sql<Date>`now()`,
        updated_at: sql<Date>`now()`,
      })
      .where('id', '=', id)
      .execute()
    await recordInRequest(c, {
      action: 'webhook_endpoint.enabled',
      entity: { type: 'webhook_endpoint', id },
      details: { url: locked.url },
    })
  }
  return ok(await endpointById(db, id))
}

async function disableByUser(c: Ctx, id: string): Promise<Result<WebhookEndpointSummary>> {
  if (!(await lockEndpoint(c, id))) return notFound()
  const db = c.get('db')
  await disableEndpoint(db, c.get('projectId'), id, 'manual', {
    ...requestAuthor(c.get('actor')),
    ip: c.get('clientIp'),
  })
  return ok(await endpointById(db, id))
}

async function deleteEndpoint(c: Ctx, id: string): Promise<Result<null>> {
  const locked = await lockEndpoint(c, id)
  if (!locked) return notFound()
  await c.get('db').deleteFrom('webhook_endpoint').where('id', '=', id).execute()
  await recordInRequest(c, {
    action: 'webhook_endpoint.deleted',
    entity: { type: 'webhook_endpoint', id },
    details: { url: locked.url },
  })
  return ok(null)
}

async function rotateSecret(
  c: Ctx,
  id: string,
  deps: WebhookDeliveryOptions,
): Promise<Result<WebhookEndpointWithSecret>> {
  const locked = await lockEndpoint(c, id)
  if (!locked) return notFound()
  const key = requireKey(deps)
  const db = c.get('db')
  const projectId = c.get('projectId')
  const secret = generateWebhookSecret()
  await db
    .updateTable('webhook_endpoint')
    .set({
      secret_encrypted: encryptWebhookSecret(key, { projectId, endpointId: id }, secret),
      // Шифротекст привязан к тому же адресу — переносится как есть.
      previous_secret_encrypted: locked.secret_encrypted,
      previous_secret_expires_at: new Date(Date.now() + WEBHOOK_SECRET_OVERLAP_HOURS * HOUR_MS),
      updated_at: sql<Date>`now()`,
    })
    .where('id', '=', id)
    .execute()
  const endpoint = await endpointById(db, id)
  await recordInRequest(c, {
    action: 'webhook_endpoint.secret_rotated',
    entity: { type: 'webhook_endpoint', id },
    details: { url: endpoint.url, previousSecretExpiresAt: endpoint.previousSecretExpiresAt },
  })
  return ok({ endpoint, secret })
}

/**
 * Возвращает в pending доставки адреса `endpointId`, отобранные `filter` (одной командой
 * update, без списка id — их бывают тысячи), и ставит им новые задачи в этой же транзакции.
 */
async function requeue(
  c: Ctx,
  endpointId: string,
  filter: (
    query: UpdateQueryBuilder<Database, 'webhook_delivery', 'webhook_delivery', UpdateResult>,
  ) => UpdateQueryBuilder<Database, 'webhook_delivery', 'webhook_delivery', UpdateResult>,
): Promise<number> {
  const db = c.get('db')
  const rows = await filter(
    db
      .updateTable('webhook_delivery')
      .set({ state: 'pending', next_attempt_at: sql<Date>`now()`, updated_at: sql<Date>`now()` })
      .where('endpoint_id', '=', endpointId)
      .where('state', '!=', 'pending'),
  )
    .returning('id')
    .execute()
  const projectId = c.get('projectId')
  await enqueueDeliveries(
    db,
    rows.map(({ id }) => ({ projectId, deliveryId: id })),
  )
  return rows.length
}

async function retryDelivery(
  c: Ctx,
  endpointId: string,
  deliveryId: string,
): Promise<Result<{ queued: number }>> {
  const locked = await lockEndpoint(c, endpointId)
  if (!locked) return notFound()
  if (locked.state !== 'active') return refuse(409, 'WEBHOOK_ENDPOINT_DISABLED')
  if (!UUID.test(deliveryId)) return refuse(404, 'WEBHOOK_DELIVERY_NOT_FOUND')
  const delivery = await c
    .get('db')
    .selectFrom('webhook_delivery')
    .select(['id', 'state'])
    .where('id', '=', deliveryId)
    .where('endpoint_id', '=', endpointId)
    .forUpdate()
    .executeTakeFirst()
  if (!delivery) return refuse(404, 'WEBHOOK_DELIVERY_NOT_FOUND')
  if (delivery.state === 'pending') return refuse(409, 'WEBHOOK_DELIVERY_PENDING')
  return ok({ queued: await requeue(c, endpointId, (q) => q.where('id', '=', delivery.id)) })
}

/** Время ISO 8601 с часовым поясом; иначе undefined. */
function readTime(value: unknown): Date | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T[^ ]+(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return undefined
  }
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : undefined
}

async function retryFailedSince(c: Ctx, endpointId: string): Promise<Result<{ queued: number }>> {
  const body = await readBody(c)
  if (!body) return invalid('')
  const extra = Object.keys(body).find((key) => key !== 'since')
  if (extra !== undefined) return invalid(extra)
  const since = readTime(body.since)
  if (!since) return invalid('since')
  const locked = await lockEndpoint(c, endpointId)
  if (!locked) return notFound()
  if (locked.state !== 'active') return refuse(409, 'WEBHOOK_ENDPOINT_DISABLED')
  const queued = await requeue(c, endpointId, (q) =>
    q.where('state', 'in', ['failed', 'cancelled']).where('created_at', '>=', since),
  )
  return ok({ queued })
}

interface DeliveryRow {
  id: string
  event_id: string
  event_type: string
  occurred_at: Date
  state: string
  attempts: number
  next_attempt_at: Date | null
  succeeded_at: Date | null
  cursor_at: string
}

/** Журнал доставок адреса: новые сверху, с попытками; фильтр по состоянию, типу и событию. */
async function listDeliveries(
  c: Ctx,
  endpointId: string,
): Promise<Result<{ data: WebhookDeliveryView[]; next_cursor: string | null }>> {
  const limit = readLimit(c.req.query('limit'))
  if (limit === undefined) return invalidQuery('limit')
  const state = c.req.query('state')
  if (state !== undefined && !WEBHOOK_DELIVERY_STATES.includes(state as WebhookDeliveryState)) {
    return invalidQuery('state')
  }
  const type = c.req.query('type')
  if (type !== undefined && !Object.hasOwn(EVENT_CATALOG, type)) return invalidQuery('type')
  const eventId = c.req.query('event_id')
  if (eventId !== undefined && !/^evt_[0-9a-f-]{36}$/.test(eventId)) return invalidQuery('event_id')
  const rawCursor = c.req.query('cursor')
  const cursor =
    rawCursor === undefined ? undefined : decodePageCursor(rawCursor, DELIVERY_SORT, 'timestamptz')
  if (rawCursor !== undefined && !cursor) return invalidQuery('cursor')
  if (!UUID.test(endpointId)) return notFound()
  const db = c.get('db')
  const exists = await db
    .selectFrom('webhook_endpoint')
    .select('id')
    .where('id', '=', endpointId)
    .executeTakeFirst()
  if (!exists) return notFound()

  const { rows } = await sql<DeliveryRow>`
    select d.id, d.event_id, ev.type as event_type, ev.occurred_at, d.state, d.attempts,
      d.next_attempt_at, d.succeeded_at,
      to_char(d.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at
    from webhook_delivery d
    join webhook_event ev on ev.id = d.event_id
    where d.endpoint_id = ${endpointId}
      and ${state === undefined ? sql`true` : sql`d.state = ${state}`}
      and ${type === undefined ? sql`true` : sql`ev.type = ${type}`}
      and ${eventId === undefined ? sql`true` : sql`d.event_id = ${eventId}`}
      and ${
        cursor
          ? sql`(d.created_at, d.id) < (${cursor.v}::timestamptz, ${cursor.id}::uuid)`
          : sql`true`
      }
    order by d.created_at desc, d.id desc
    limit ${limit + 1}
  `.execute(db)
  const page = rows.slice(0, limit)
  const attempts =
    page.length === 0
      ? []
      : await db
          .selectFrom('webhook_delivery_attempt')
          .select([
            'delivery_id',
            'attempted_at',
            'status_code',
            'error',
            'duration_ms',
            'response_body',
          ])
          .where(
            'delivery_id',
            'in',
            page.map((row) => row.id),
          )
          .orderBy('attempted_at')
          .orderBy('id')
          .execute()
  const last = page.at(-1)
  return ok({
    data: page.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      eventType: row.event_type as EventType,
      occurredAt: new Date(row.occurred_at).toISOString(),
      state: row.state as WebhookDeliveryState,
      attempts: row.attempts,
      nextAttemptAt: iso(row.next_attempt_at),
      succeededAt: iso(row.succeeded_at),
      attemptLog: attempts
        .filter((attempt) => attempt.delivery_id === row.id)
        .map((attempt) => ({
          attemptedAt: new Date(attempt.attempted_at).toISOString(),
          statusCode: attempt.status_code,
          error: attempt.error as WebhookAttemptError | null,
          durationMs: attempt.duration_ms,
          responseBody: attempt.response_body,
        })),
    })),
    next_cursor:
      rows.length > limit && last
        ? encodePageCursor(DELIVERY_SORT, { v: last.cursor_at, id: last.id })
        : null,
  })
}

/** Маршруты адресов событий: `/v1/webhook-endpoints`. */
export function webhookEndpointsRoutes(deps: WebhookDeliveryOptions = NO_WEBHOOKS) {
  const respond = <T>(c: Ctx, outcome: Result<T>, status: 200 | 201 | 202 = 200) =>
    outcome.ok ? c.json(outcome.value as object, status) : fail(c, outcome)
  const view = requirePermission('integrations', 'view')
  const edit = requirePermission('integrations', 'edit')
  return (
    new Hono<PermissionsEnv>()
      .get('/event-types', view, (c) =>
        c.json<WebhookEventTypeInfo[]>(
          EVENT_TYPES.map((type) => ({
            type,
            entity: EVENT_CATALOG[type].entity,
            title: EVENT_TYPE_TITLES[type],
          })),
        ),
      )
      // Адреса, отключённые системой (410 или 5 суток без успеха): предупреждение в шапке до
      // включения адреса или его удаления.
      .get('/alerts', view, async (c) => {
        const rows = await c
          .get('db')
          .selectFrom('webhook_endpoint')
          .select(['id', 'url', 'description', 'disabled_reason', 'disabled_at'])
          .where('state', '=', 'disabled')
          .where('disabled_reason', 'in', ['gone_410', 'failing_5_days'])
          .orderBy('disabled_at', 'desc')
          .orderBy('id')
          .execute()
        return c.json<WebhookAlert[]>(
          rows.map((row) => ({
            endpointId: row.id,
            url: row.url,
            description: row.description,
            reason: row.disabled_reason as WebhookAlert['reason'],
            disabledAt: new Date(row.disabled_at ?? 0).toISOString(),
          })),
        )
      })
      .get('/', view, async (c) => {
        const rows = await selectEndpoints(c.get('db'))
          .orderBy('e.created_at', 'desc')
          .orderBy('e.id')
          .execute()
        return c.json<WebhookEndpointSummary[]>(rows.map(summary))
      })
      .post('/', requirePermission('integrations', 'create'), async (c) =>
        respond(c, await createEndpoint(c, deps), 201),
      )
      .get('/:id', view, async (c) => {
        const id = c.req.param('id')
        const row = UUID.test(id)
          ? await selectEndpoints(c.get('db')).where('e.id', '=', id).executeTakeFirst()
          : undefined
        return row ? c.json(summary(row)) : fail(c, notFound())
      })
      .patch('/:id', edit, async (c) =>
        respond(c, await updateEndpoint(c, c.req.param('id'), deps)),
      )
      .delete('/:id', requirePermission('integrations', 'delete'), async (c) => {
        const outcome = await deleteEndpoint(c, c.req.param('id'))
        return outcome.ok ? c.body(null, 204) : fail(c, outcome)
      })
      .post('/:id/enable', edit, async (c) =>
        respond(c, await enableEndpoint(c, c.req.param('id'))),
      )
      .post('/:id/disable', edit, async (c) =>
        respond(c, await disableByUser(c, c.req.param('id'))),
      )
      .post('/:id/rotate-secret', edit, async (c) =>
        respond(c, await rotateSecret(c, c.req.param('id'), deps)),
      )
      .get('/:id/deliveries', view, async (c) =>
        respond(c, await listDeliveries(c, c.req.param('id'))),
      )
      .post('/:id/deliveries/:deliveryId/retry', edit, async (c) =>
        respond(c, await retryDelivery(c, c.req.param('id'), c.req.param('deliveryId')), 202),
      )
      .post('/:id/retry-failed', edit, async (c) =>
        respond(c, await retryFailedSince(c, c.req.param('id')), 202),
      )
  )
}
