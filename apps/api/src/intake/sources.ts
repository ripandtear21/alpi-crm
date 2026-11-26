import type { Database } from '@alpi/db'
import {
  type IntakeSourceSummary,
  type IntakeSourcesErrorCode,
  type IntakeSourceWithKey,
  MAX_INTAKE_SOURCE_NAME_LENGTH,
} from '@alpi/shared'
import { Hono } from 'hono'
import { type Kysely, sql } from 'kysely'
import { recordInRequest } from '../audit/record.ts'
import {
  type Ctx,
  fail,
  type Outcome,
  ok,
  readBody,
  refuse,
  requiredText,
  UUID,
} from '../contacts/http.ts'
import { omitFromIdempotentReplay } from '../http/idempotency.ts'
import { type PermissionsEnv, requirePermission } from '../middleware/permissions.ts'
import { inSavepoint, sqlState } from '../roles/roles.ts'
import { issueIntakeKey } from './key.ts'

// Управление источниками регистраций проекта (тикет crm-intake/03): `/v1/intake-sources`
// (снаружи — /api/v1/intake-sources). Только по сессии пользователя: маршруты без отметки
// apiKeyRoute, ключ API получает 403 API_KEY_NOT_ALLOWED.
//
// - Список — право «интеграции: смотреть»; создать — «интеграции: создавать»; сменить ключ,
//   отключить и включить снова — «интеграции: изменять».
// - Ключ — только в ответе на создание и смену ключа; в базе — отпечаток и первые 12 символов.
//   В журнал (intake_source.*) и в повтор по Idempotency-Key ключ не попадает.
// - Смена ключа — новый ключ, старый перестаёт работать сразу; у отключённого источника тоже
//   (источник остаётся отключённым). Название и воронка после создания не меняются. Отключённый
//   источник можно включить снова (решено без владельца — подтвердить). Строка не удаляется:
//   регистрации и журналы ссылаются на неё.

type Result<T> = Outcome<T, IntakeSourcesErrorCode>

const invalid = (path: string) => refuse(400, 'INVALID_INTAKE_SOURCE', { path })

/** SQLSTATE unique_violation: название занято другим источником проекта. */
const UNIQUE_VIOLATION = '23505'

function selectSources(db: Kysely<Database>) {
  return db
    .selectFrom('intake_source as s')
    .innerJoin('pipeline as p', (join) =>
      join.onRef('p.id', '=', 's.pipeline_id').onRef('p.project_id', '=', 's.project_id'),
    )
    .innerJoin('user as u', 'u.id', 's.created_by')
    .leftJoin('user as d', 'd.id', 's.disabled_by')
    .select([
      's.id',
      's.name',
      's.pipeline_id',
      'p.name as pipeline_name',
      's.key_prefix',
      's.created_at',
      's.created_by',
      'u.name as created_by_name',
      's.last_used_at',
      's.disabled_at',
      's.disabled_by',
      'd.name as disabled_by_name',
    ])
}

type SourceRow = Awaited<ReturnType<ReturnType<typeof selectSources>['executeTakeFirstOrThrow']>>

const iso = (value: Date | string | null) => (value === null ? null : new Date(value).toISOString())

function sourceSummary(row: SourceRow): IntakeSourceSummary {
  return {
    id: row.id,
    name: row.name,
    pipeline: { id: row.pipeline_id, name: row.pipeline_name },
    keyPrefix: row.key_prefix,
    createdAt: new Date(row.created_at).toISOString(),
    createdBy: { id: row.created_by, name: row.created_by_name },
    lastUsedAt: iso(row.last_used_at),
    disabledAt: iso(row.disabled_at),
    disabledBy:
      row.disabled_by === null ? null : { id: row.disabled_by, name: row.disabled_by_name ?? '' },
  }
}

async function sourceById(db: Kysely<Database>, id: string): Promise<IntakeSourceSummary> {
  return sourceSummary(await selectSources(db).where('s.id', '=', id).executeTakeFirstOrThrow())
}

/** Подробности записи журнала: название и воронка, без ключа. */
function auditDetails(source: IntakeSourceSummary) {
  return { name: source.name, pipeline: source.pipeline }
}

/** Пользователь запроса: источниками управляют только по сессии. */
function sessionUser(c: Ctx): string {
  const actor = c.get('actor')
  if (actor.type !== 'user') throw new Error('источниками управляет только пользователь')
  return actor.userId
}

async function createSource(c: Ctx): Promise<Result<IntakeSourceWithKey>> {
  const body = await readBody(c)
  if (!body) return invalid('')
  const extra = Object.keys(body).find((key) => !['name', 'pipelineId'].includes(key))
  if (extra !== undefined) return invalid(extra)
  const name = requiredText(body.name, MAX_INTAKE_SOURCE_NAME_LENGTH)
  if (name === undefined) return invalid('name')
  if (typeof body.pipelineId !== 'string' || !UUID.test(body.pipelineId)) {
    return invalid('pipelineId')
  }

  const db = c.get('db')
  // Воронка — своего проекта (row-level security) и не в архиве: в архивную воронку новые
  // сделки приёма не ставятся (решено без владельца — подтвердить).
  const pipeline = await db
    .selectFrom('pipeline')
    .select('id')
    .where('id', '=', body.pipelineId)
    .where('archived_at', 'is', null)
    .executeTakeFirst()
  if (!pipeline) return refuse(422, 'PIPELINE_NOT_FOUND')

  const userId = sessionUser(c)
  const issued = issueIntakeKey()
  let id: string
  try {
    ;({ id } = await inSavepoint(db, () =>
      db
        .insertInto('intake_source')
        .values({
          project_id: c.get('projectId'),
          name,
          pipeline_id: pipeline.id,
          key_hash: issued.hash,
          key_prefix: issued.shownPrefix,
          created_by: userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    ))
  } catch (error) {
    if (sqlState(error) === UNIQUE_VIOLATION) return refuse(409, 'INTAKE_SOURCE_NAME_TAKEN')
    throw error
  }
  const source = await sourceById(db, id)
  await recordInRequest(c, {
    action: 'intake_source.created',
    entity: { type: 'intake_source', id },
    details: auditDetails(source),
  })
  return ok({ source, key: issued.key })
}

/** Источник `id`, заблокированный до конца транзакции. */
async function lockSource(c: Ctx, id: string): Promise<Result<{ disabled: boolean }>> {
  if (!UUID.test(id)) return refuse(404, 'INTAKE_SOURCE_NOT_FOUND')
  const row = await c
    .get('db')
    .selectFrom('intake_source')
    .select(['id', 'disabled_at'])
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  return row ? ok({ disabled: row.disabled_at !== null }) : refuse(404, 'INTAKE_SOURCE_NOT_FOUND')
}

async function reissueKey(c: Ctx, id: string): Promise<Result<IntakeSourceWithKey>> {
  const locked = await lockSource(c, id)
  if (!locked.ok) return locked
  const db = c.get('db')
  const issued = issueIntakeKey()
  await db
    .updateTable('intake_source')
    .set({ key_hash: issued.hash, key_prefix: issued.shownPrefix })
    .where('id', '=', id)
    .execute()
  const source = await sourceById(db, id)
  await recordInRequest(c, {
    action: 'intake_source.key_reissued',
    entity: { type: 'intake_source', id },
    details: auditDetails(source),
  })
  return ok({ source, key: issued.key })
}

async function setDisabled(
  c: Ctx,
  id: string,
  disable: boolean,
): Promise<Result<IntakeSourceSummary>> {
  const locked = await lockSource(c, id)
  if (!locked.ok) return locked
  if (locked.value.disabled === disable) {
    return refuse(409, disable ? 'INTAKE_SOURCE_DISABLED' : 'INTAKE_SOURCE_ENABLED')
  }
  const db = c.get('db')
  await db
    .updateTable('intake_source')
    .set(
      disable
        ? { disabled_at: sql`now()`, disabled_by: sessionUser(c) }
        : { disabled_at: null, disabled_by: null },
    )
    .where('id', '=', id)
    .execute()
  const source = await sourceById(db, id)
  await recordInRequest(c, {
    action: disable ? 'intake_source.disabled' : 'intake_source.enabled',
    entity: { type: 'intake_source', id },
    details: auditDetails(source),
  })
  return ok(source)
}

/** Маршруты источников регистраций: `/v1/intake-sources`. */
export function intakeSourcesRoutes() {
  const respond = <T>(c: Ctx, outcome: Result<T>, status: 200 | 201 = 200) =>
    outcome.ok ? c.json(outcome.value as object, status) : fail(c, outcome)
  // Создание и смена ключа показывают ключ один раз: повтор с тем же Idempotency-Key отдаёт
  // ответ без него (http/idempotency.ts, omitFromIdempotentReplay); ответ не кэшируется.
  return new Hono<PermissionsEnv>()
    .get('/', requirePermission('integrations', 'view'), async (c) => {
      const rows = await selectSources(c.get('db'))
        .orderBy(sql`s.disabled_at is not null`)
        .orderBy('s.created_at', 'desc')
        .orderBy('s.id')
        .execute()
      return c.json<IntakeSourceSummary[]>(rows.map(sourceSummary))
    })
    .post('/', requirePermission('integrations', 'create'), async (c) => {
      omitFromIdempotentReplay(c, ['key'])
      c.header('cache-control', 'no-store')
      return respond(c, await createSource(c), 201)
    })
    .post('/:id/reissue-key', requirePermission('integrations', 'edit'), async (c) => {
      omitFromIdempotentReplay(c, ['key'])
      c.header('cache-control', 'no-store')
      return respond(c, await reissueKey(c, c.req.param('id')))
    })
    .post('/:id/disable', requirePermission('integrations', 'edit'), async (c) =>
      respond(c, await setDisabled(c, c.req.param('id'), true)),
    )
    .post('/:id/enable', requirePermission('integrations', 'edit'), async (c) =>
      respond(c, await setDisabled(c, c.req.param('id'), false)),
    )
}
