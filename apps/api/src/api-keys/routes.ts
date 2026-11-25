import type { Database } from '@alpi/db'
import {
  type ApiKeySummary,
  type ApiKeysErrorCode,
  type ApiKeyWithSecret,
  MAX_API_KEY_NAME_LENGTH,
  type RoleTemplateKey,
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
import { loadFieldGroupRefs } from '../fields/access.ts'
import { omitFromIdempotentReplay } from '../http/idempotency.ts'
import { type PermissionsEnv, requirePermission } from '../middleware/permissions.ts'
import { effectivePermissions, type MemberAccess } from '../roles/access.ts'
import { grantsBeyondOwn } from '../roles/guard.ts'
import { inSavepoint, sqlState } from '../roles/roles.ts'
import { issueApiKeySecret } from './secret.ts'

// Управление ключами API проекта (тикет crm-api/01): `/v1/api-keys` (снаружи —
// /api/v1/api-keys). Только по сессии пользователя: маршруты без отметки apiKeyRoute, ключ
// получает 403 API_KEY_NOT_ALLOWED.
//
// - Список — право «интеграции: смотреть». Создать, перевыпустить, отозвать — «интеграции:
//   создавать / изменять / удалять» и «пользователи и роли: изменять»: выдать ключу роль — то
//   же, что выдать её участнику (решено без владельца — подтвердить). По шаблонам ролей это
//   администратор. Не-администратор, кроме того, не выдаёт ключу роль администратора и роль
//   шире своей и не перевыпускает и не отзывает такой ключ (правила roles/guard.ts).
// - Секрет — только в ответе на создание и перевыпуск; в базе — отпечаток и первые 8 символов.
//   В журнал (api_key.created, api_key.reissued, api_key.revoked) секрет не попадает.
// - Перевыпуск — новый секрет, старый перестаёт работать сразу (решено без владельца —
//   подтвердить). Название ключа не меняется (решено без владельца — подтвердить). Отзыв
//   окончателен: строка остаётся, журнал на неё ссылается.

type Result<T> = Outcome<T, ApiKeysErrorCode>

const invalid = (path: string) => refuse(400, 'INVALID_API_KEY', { path })

/** SQLSTATE unique_violation: название занято неотозванным ключом. */
const UNIQUE_VIOLATION = '23505'

function selectKeys(db: Kysely<Database>) {
  return db
    .selectFrom('api_key as k')
    .leftJoin('role as r', (join) =>
      join.onRef('r.id', '=', 'k.role_id').onRef('r.project_id', '=', 'k.project_id'),
    )
    .innerJoin('user as u', 'u.id', 'k.created_by')
    .select([
      'k.id',
      'k.name',
      'k.secret_prefix',
      'k.created_at',
      'k.expires_at',
      'k.last_used_at',
      'k.revoked_at',
      'k.created_by',
      'u.name as created_by_name',
      'r.id as role_id',
      'r.name as role_name',
      'r.template_key as role_template_key',
    ])
}

type KeyRow = Awaited<ReturnType<ReturnType<typeof selectKeys>['executeTakeFirstOrThrow']>>

const iso = (value: Date | string | null) => (value === null ? null : new Date(value).toISOString())

function keySummary(row: KeyRow): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    role:
      row.role_id === null
        ? null
        : {
            id: row.role_id,
            name: row.role_name ?? '',
            templateKey: row.role_template_key as RoleTemplateKey | null,
          },
    secretPrefix: row.secret_prefix,
    createdAt: new Date(row.created_at).toISOString(),
    createdBy: { id: row.created_by, name: row.created_by_name },
    expiresAt: iso(row.expires_at),
    lastUsedAt: iso(row.last_used_at),
    revokedAt: iso(row.revoked_at),
  }
}

async function keyById(db: Kysely<Database>, id: string): Promise<ApiKeySummary> {
  return keySummary(await selectKeys(db).where('k.id', '=', id).executeTakeFirstOrThrow())
}

/** Роль проекта, которую выдают ключу или которая у ключа уже есть. */
interface KeyRole {
  id: string
  name: string
  is_admin: boolean
  permissions: unknown
}

/**
 * Может ли `actor` выдать ключу роль `role` (или перевыпустить и отозвать ключ с ней): те же
 * правила, что при назначении роли участнику (roles/guard.ts, (а) и (б)).
 */
async function checkKeyRole(
  db: Kysely<Database>,
  actor: MemberAccess,
  role: KeyRole | null,
): Promise<Result<null>> {
  if (actor.isAdmin || role === null) return ok(null)
  if (role.is_admin) return refuse(403, 'ADMIN_ONLY')
  const groups = await loadFieldGroupRefs(db)
  return grantsBeyondOwn(actor.permissions, null, effectivePermissions(role), groups)
    ? refuse(403, 'EXCEEDS_OWN_PERMISSIONS')
    : ok(null)
}

function roleById(db: Kysely<Database>, id: string) {
  return db
    .selectFrom('role')
    .select(['id', 'name', 'is_admin', 'permissions'])
    .where('id', '=', id)
    .executeTakeFirst()
}

/** Срок действия: ISO 8601 в будущем; null или нет — бессрочный; иначе undefined. */
function readExpiresAt(value: unknown): Date | null | undefined {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return undefined
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.getTime() > Date.now() ? date : undefined
}

function auditDetails(key: ApiKeySummary) {
  return { name: key.name, role: key.role && { id: key.role.id, name: key.role.name } }
}

async function createKey(c: Ctx): Promise<Result<ApiKeyWithSecret>> {
  const body = await readBody(c)
  if (!body) return invalid('')
  const extra = Object.keys(body).find((key) => !['name', 'roleId', 'expiresAt'].includes(key))
  if (extra !== undefined) return invalid(extra)
  const name = requiredText(body.name, MAX_API_KEY_NAME_LENGTH)
  if (name === undefined) return invalid('name')
  if (typeof body.roleId !== 'string' || !UUID.test(body.roleId)) return invalid('roleId')
  const expiresAt = readExpiresAt(body.expiresAt)
  if (expiresAt === undefined) return invalid('expiresAt')

  const db = c.get('db')
  const role = await roleById(db, body.roleId)
  if (!role) return refuse(422, 'ROLE_NOT_FOUND')
  const allowed = await checkKeyRole(db, c.get('access'), role)
  if (!allowed.ok) return allowed

  const issued = issueApiKeySecret()
  const actor = c.get('actor')
  if (actor.type !== 'user') throw new Error('ключ API создаёт только пользователь')
  let id: string
  try {
    ;({ id } = await inSavepoint(db, () =>
      db
        .insertInto('api_key')
        .values({
          project_id: c.get('projectId'),
          name,
          role_id: role.id,
          secret_hash: issued.hash,
          secret_prefix: issued.shownPrefix,
          created_by: actor.userId,
          expires_at: expiresAt,
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    ))
  } catch (error) {
    if (sqlState(error) === UNIQUE_VIOLATION) return refuse(409, 'API_KEY_NAME_TAKEN')
    throw error
  }
  const key = await keyById(db, id)
  await recordInRequest(c, {
    action: 'api_key.created',
    entity: { type: 'api_key', id },
    details: { ...auditDetails(key), expiresAt: key.expiresAt },
  })
  return ok({ key, secret: issued.secret })
}

/** Неотозванный ключ `id` с его ролью, заблокированный до конца транзакции. */
async function lockActiveKey(c: Ctx, id: string): Promise<Result<{ role: KeyRole | null }>> {
  if (!UUID.test(id)) return refuse(404, 'API_KEY_NOT_FOUND')
  const db = c.get('db')
  const key = await db
    .selectFrom('api_key')
    .select(['id', 'role_id', 'revoked_at'])
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  if (!key) return refuse(404, 'API_KEY_NOT_FOUND')
  if (key.revoked_at !== null) return refuse(409, 'API_KEY_REVOKED')
  const role = key.role_id === null ? null : ((await roleById(db, key.role_id)) ?? null)
  const allowed = await checkKeyRole(db, c.get('access'), role)
  return allowed.ok ? ok({ role }) : allowed
}

async function reissueKey(c: Ctx, id: string): Promise<Result<ApiKeyWithSecret>> {
  const locked = await lockActiveKey(c, id)
  if (!locked.ok) return locked
  const db = c.get('db')
  const issued = issueApiKeySecret()
  await db
    .updateTable('api_key')
    .set({ secret_hash: issued.hash, secret_prefix: issued.shownPrefix })
    .where('id', '=', id)
    .execute()
  const key = await keyById(db, id)
  await recordInRequest(c, {
    action: 'api_key.reissued',
    entity: { type: 'api_key', id },
    details: auditDetails(key),
  })
  return ok({ key, secret: issued.secret })
}

async function revokeKey(c: Ctx, id: string): Promise<Result<ApiKeySummary>> {
  const locked = await lockActiveKey(c, id)
  if (!locked.ok) return locked
  const db = c.get('db')
  const actor = c.get('actor')
  if (actor.type !== 'user') throw new Error('ключ API отзывает только пользователь')
  await db
    .updateTable('api_key')
    .set({ revoked_at: sql`now()`, revoked_by: actor.userId })
    .where('id', '=', id)
    .execute()
  const key = await keyById(db, id)
  await recordInRequest(c, {
    action: 'api_key.revoked',
    entity: { type: 'api_key', id },
    details: auditDetails(key),
  })
  return ok(key)
}

/** Маршруты ключей API: `/v1/api-keys`. */
export function apiKeysRoutes() {
  const respond = <T>(c: Ctx, outcome: Result<T>, status: 200 | 201 = 200) =>
    outcome.ok ? c.json(outcome.value as object, status) : fail(c, outcome)
  const grantRole = requirePermission('users_roles', 'edit')
  return new Hono<PermissionsEnv>()
    .get('/', requirePermission('integrations', 'view'), async (c) => {
      const rows = await selectKeys(c.get('db'))
        .orderBy(sql`k.revoked_at is not null`)
        .orderBy('k.created_at', 'desc')
        .orderBy('k.id')
        .execute()
      return c.json<ApiKeySummary[]>(rows.map(keySummary))
    })
    // Секрет показывается один раз: повтор с тем же Idempotency-Key отдаёт ответ без него.
    .post('/', requirePermission('integrations', 'create'), grantRole, async (c) => {
      omitFromIdempotentReplay(c, ['secret'])
      return respond(c, await createKey(c), 201)
    })
    .post('/:id/reissue', requirePermission('integrations', 'edit'), grantRole, async (c) => {
      omitFromIdempotentReplay(c, ['secret'])
      return respond(c, await reissueKey(c, c.req.param('id')))
    })
    .post('/:id/revoke', requirePermission('integrations', 'delete'), grantRole, async (c) =>
      respond(c, await revokeKey(c, c.req.param('id'))),
    )
}
