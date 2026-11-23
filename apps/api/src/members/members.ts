import type { CreatedMemberResponse, MemberSummary } from '@alpi/shared'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { Auth } from '../auth/auth.ts'
import { type PermissionsEnv, requirePermission } from '../middleware/permissions.ts'
import type { OpenDealsChecker } from './open-deals.ts'
import {
  addExistingMember,
  assignRole,
  createMember,
  disableMember,
  enableMember,
  listMembers,
  type MemberContext,
  type MemberErrorCode,
  type NewMemberInput,
  normalizeEmail,
  normalizeName,
  type Outcome,
  setAcceptsNewDeals,
  setMemberTeam,
} from './service.ts'

// Участники проекта (тикет crm-foundation/06): маршруты `/members`, все — в контексте проекта
// (после projectContext) и под правом «пользователи и роли» на соответствующее действие.
// Изменения делает service.ts; здесь — разбор запроса и ответ.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Ctx = Context<PermissionsEnv>

export interface MembersDeps {
  auth: Auth
  openDeals: OpenDealsChecker
}

function fail(c: Ctx, status: 400 | 403 | 404 | 409, code: MemberErrorCode, details?: unknown) {
  return c.json(details === undefined ? { code } : { code, details }, status)
}

function respond<T>(c: Ctx, outcome: Outcome<T>, status: 200 | 201 = 200) {
  return outcome.ok
    ? c.json(outcome.value, status)
    : fail(c, outcome.status, outcome.code, outcome.details)
}

/** Транзакция проекта, проект, тот, кто меняет, и его адрес (для журнала) — из запроса. */
export function memberContext(c: Ctx): MemberContext {
  return {
    db: c.get('db'),
    projectId: c.get('projectId'),
    actor: { ...c.get('access'), userId: c.get('session').user.id },
    ip: c.get('clientIp'),
  }
}

async function readBody(c: Ctx): Promise<Record<string, unknown> | null> {
  const body = (await c.req.json().catch(() => null)) as unknown
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null
}

/** Команда в теле: id команды или null (без команды); undefined — поле неверное. */
function readTeamId(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null
  return typeof value === 'string' && UUID.test(value) ? value : undefined
}

/** Роль и команда нового участника; строка — что не так. */
function readNewMember(body: Record<string, unknown>): NewMemberInput | string {
  if (typeof body.roleId !== 'string' || !UUID.test(body.roleId)) return 'roleId'
  const teamId = readTeamId(body.teamId)
  if (teamId === undefined) return 'teamId'
  return { roleId: body.roleId, teamId }
}

function invalid(c: Ctx, path: string) {
  return fail(c, 400, 'INVALID_MEMBER', { path })
}

/** Маршруты участников: `/members`. */
export function membersRoutes({ auth, openDeals }: MembersDeps) {
  return (
    new Hono<PermissionsEnv>()
      .get('/', requirePermission('users_roles', 'view'), async (c) =>
        c.json<MemberSummary[]>(await listMembers(c.get('db'))),
      )
      // Добавить существующую учётную запись по email.
      .post('/', requirePermission('users_roles', 'create'), async (c) => {
        const body = await readBody(c)
        if (!body) return invalid(c, '')
        const email = normalizeEmail(body.email)
        if (!email) return invalid(c, 'email')
        const input = readNewMember(body)
        if (typeof input === 'string') return invalid(c, input)
        return respond(c, await addExistingMember(memberContext(c), email, input), 201)
      })
      // Завести учётную запись с временным паролем и добавить её в проект.
      .post('/new', requirePermission('users_roles', 'create'), async (c) => {
        const body = await readBody(c)
        if (!body) return invalid(c, '')
        const email = normalizeEmail(body.email)
        if (!email) return invalid(c, 'email')
        const name = normalizeName(body.name)
        if (!name) return invalid(c, 'name')
        const input = readNewMember(body)
        if (typeof input === 'string') return invalid(c, input)
        const outcome = await createMember(memberContext(c), auth, { email, name }, input)
        if (!outcome.ok) return fail(c, outcome.status, outcome.code)
        // Пароль — только в этом ответе; не кэшировать.
        c.header('cache-control', 'no-store')
        return c.json<CreatedMemberResponse>(outcome.value, 201)
      })
      .put('/:userId/role', requirePermission('users_roles', 'edit'), async (c) => {
        const body = await readBody(c)
        const roleId = body?.roleId
        if (typeof roleId !== 'string' || !UUID.test(roleId)) {
          return fail(c, 400, 'INVALID_ROLE', { path: 'roleId', message: 'ожидается id роли' })
        }
        const outcome = await assignRole(memberContext(c), c.req.param('userId'), roleId)
        // Ответ прежнего маршрута (тикет 05): { userId, roleId }, плюс остальные поля участника.
        return respond(c, outcome)
      })
      .put('/:userId/team', requirePermission('users_roles', 'edit'), async (c) => {
        const body = await readBody(c)
        if (!body || !('teamId' in body)) return invalid(c, 'teamId')
        const teamId = readTeamId(body.teamId)
        if (teamId === undefined) return invalid(c, 'teamId')
        return respond(c, await setMemberTeam(memberContext(c), c.req.param('userId'), teamId))
      })
      .put('/:userId/accepts-new-deals', requirePermission('users_roles', 'edit'), async (c) => {
        const body = await readBody(c)
        if (typeof body?.acceptsNewDeals !== 'boolean') return invalid(c, 'acceptsNewDeals')
        return respond(
          c,
          await setAcceptsNewDeals(memberContext(c), c.req.param('userId'), body.acceptsNewDeals),
        )
      })
      .post('/:userId/disable', requirePermission('users_roles', 'edit'), async (c) =>
        respond(c, await disableMember(memberContext(c), openDeals, c.req.param('userId'))),
      )
      .post('/:userId/enable', requirePermission('users_roles', 'edit'), async (c) =>
        respond(c, await enableMember(memberContext(c), c.req.param('userId'))),
      )
  )
}
