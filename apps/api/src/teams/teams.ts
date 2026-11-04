import type { Database } from '@alpi/db'
import type { TeamSummary } from '@alpi/shared'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { type Kysely, sql } from 'kysely'
import {
  checkTeamLeads,
  dbRefusal,
  ledTeam,
  lockMember,
  type MemberContext,
  type MemberErrorCode,
  type Outcome,
  ok,
  putIntoTeam,
  refuse,
} from '../members/service.ts'
import { type PermissionsEnv, requirePermission } from '../middleware/permissions.ts'
import { checkTeamChange } from '../roles/guard.ts'
import { inSavepoint } from '../roles/roles.ts'

// Команды проекта (тикет crm-foundation/06; GLOSSARY.md — «Команда»): маршруты `/teams` под
// правом «пользователи и роли». Тимлид один и сам состоит в команде, участник — не больше чем в
// одной команде: это держит база (packages/db/migrations/0005_teams.ts). Состав команды меняет
// PUT /members/:userId/team; здесь — создание, название, тимлид, удаление. Всё это меняет
// только администратор проекта (guard.ts, правило (д)): команда задаёт охват «команда».
// Держатели права «пользователи и роли» без роли администратора команды только смотрят.
// Запись участия (перевод тимлида в команду) — функции members/service.ts.

const MAX_NAME_LENGTH = 60
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Ctx = Context<PermissionsEnv>

function context(c: Ctx): MemberContext {
  return {
    db: c.get('db'),
    projectId: c.get('projectId'),
    actor: { ...c.get('access'), userId: c.get('session').user.id },
  }
}

function fail(c: Ctx, status: 400 | 403 | 404 | 409, code: MemberErrorCode, details?: unknown) {
  return c.json(details === undefined ? { code } : { code, details }, status)
}

function respond<T>(c: Ctx, outcome: Outcome<T>, status: 200 | 201 = 200) {
  return outcome.ok ? c.json(outcome.value, status) : fail(c, outcome.status, outcome.code)
}

/** Команды проекта (или одна — `teamId`) с участниками, по названию. */
export async function listTeams(db: Kysely<Database>, teamId?: string): Promise<TeamSummary[]> {
  let query = db
    .selectFrom('team as t')
    .leftJoin('project_member as m', (join) =>
      join.onRef('m.team_id', '=', 't.id').onRef('m.project_id', '=', 't.project_id'),
    )
    .select([
      't.id',
      't.name',
      't.lead_user_id',
      sql<
        string[]
      >`coalesce(array_agg(m.user_id order by m.user_id) filter (where m.user_id is not null), '{}')`.as(
        'member_user_ids',
      ),
    ])
    .groupBy('t.id')
    .orderBy('t.name')
  if (teamId !== undefined) query = query.where('t.id', '=', teamId)
  const rows = await query.execute()
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    leadUserId: row.lead_user_id,
    memberUserIds: row.member_user_ids,
  }))
}

async function teamSummary(db: Kysely<Database>, teamId: string): Promise<TeamSummary> {
  const [team] = await listTeams(db, teamId)
  if (!team) throw new Error('команда пропала в той же транзакции')
  return team
}

/**
 * Тимлидом команды `teamId` становится `userId`: проверки участия и перевод в команду.
 * `teamId` null — команда ещё создаётся (её id появится в той же точке сохранения).
 */
async function checkNewLead(
  ctx: MemberContext,
  userId: string,
  teamId: string | null,
): Promise<Outcome<null>> {
  const lead = await lockMember(ctx.db, ctx.projectId, userId)
  if (!lead) return refuse(404, 'MEMBER_NOT_FOUND')
  if (lead.disabled) return refuse(409, 'TEAM_LEAD_DISABLED')
  const led = await ledTeam(ctx.db, userId)
  if (led !== null && led !== teamId) return refuse(409, 'LEADS_OTHER_TEAM')
  return ok(null)
}

function readName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  return name.length > 0 && name.length <= MAX_NAME_LENGTH ? name : null
}

async function readBody(c: Ctx): Promise<Record<string, unknown> | null> {
  const body = (await c.req.json().catch(() => null)) as unknown
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null
}

function invalid(c: Ctx, path: string) {
  return fail(c, 400, 'INVALID_TEAM', { path })
}

async function createTeam(
  ctx: MemberContext,
  name: string,
  leadUserId: string,
): Promise<Outcome<TeamSummary>> {
  const failure = checkTeamChange(ctx.actor)
  if (failure) return refuse(403, failure)
  const checked = await checkNewLead(ctx, leadUserId, null)
  if (!checked.ok) return checked
  try {
    const id = await inSavepoint(ctx.db, async () => {
      const { id } = await ctx.db
        .insertInto('team')
        .values({
          project_id: ctx.projectId,
          name,
          lead_user_id: leadUserId,
          created_by: ctx.actor.userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      await putIntoTeam(ctx, leadUserId, id)
      await checkTeamLeads(ctx.db)
      return id
    })
    return ok(await teamSummary(ctx.db, id))
  } catch (error) {
    return dbRefusal(error)
  }
}

async function updateTeam(
  ctx: MemberContext,
  teamId: string,
  change: { name?: string; leadUserId?: string },
): Promise<Outcome<TeamSummary>> {
  const failure = checkTeamChange(ctx.actor)
  if (failure) return refuse(403, failure)
  // Строка команды блокируется: смены тимлида одной команды идут по очереди.
  const team = await ctx.db
    .selectFrom('team')
    .select(['id', 'lead_user_id'])
    .where('id', '=', teamId)
    .forUpdate()
    .executeTakeFirst()
  if (!team) return refuse(404, 'TEAM_NOT_FOUND')
  const newLead =
    change.leadUserId !== undefined && change.leadUserId !== team.lead_user_id
      ? change.leadUserId
      : undefined
  if (newLead !== undefined) {
    // Прежний тимлид остаётся в команде участником.
    const checked = await checkNewLead(ctx, newLead, teamId)
    if (!checked.ok) return checked
  }
  try {
    await inSavepoint(ctx.db, async () => {
      await ctx.db
        .updateTable('team')
        .set({
          ...(change.name === undefined ? {} : { name: change.name }),
          ...(newLead === undefined ? {} : { lead_user_id: newLead }),
          updated_at: sql`now()`,
        })
        .where('id', '=', teamId)
        .execute()
      if (newLead !== undefined) {
        await putIntoTeam(ctx, newLead, teamId)
        await checkTeamLeads(ctx.db)
      }
    })
  } catch (error) {
    return dbRefusal(error)
  }
  return ok(await teamSummary(ctx.db, teamId))
}

async function deleteTeam(ctx: MemberContext, teamId: string): Promise<Outcome<null>> {
  const failure = checkTeamChange(ctx.actor)
  if (failure) return refuse(403, failure)
  const team = await ctx.db
    .selectFrom('team')
    .select('id')
    .where('id', '=', teamId)
    .forUpdate()
    .executeTakeFirst()
  if (!team) return refuse(404, 'TEAM_NOT_FOUND')
  // Удаление выводит из команды всех её участников (ON DELETE SET NULL в базе).
  try {
    await inSavepoint(ctx.db, () => ctx.db.deleteFrom('team').where('id', '=', teamId).execute())
  } catch (error) {
    return dbRefusal(error)
  }
  return ok(null)
}

/** Маршруты команд: `/teams`. */
export function teamsRoutes() {
  return new Hono<PermissionsEnv>()
    .get('/', requirePermission('users_roles', 'view'), async (c) =>
      c.json<TeamSummary[]>(await listTeams(c.get('db'))),
    )
    .post('/', requirePermission('users_roles', 'create'), async (c) => {
      const body = await readBody(c)
      const name = readName(body?.name)
      if (!name) return invalid(c, 'name')
      const leadUserId = body?.leadUserId
      if (typeof leadUserId !== 'string' || leadUserId === '') return invalid(c, 'leadUserId')
      return respond(c, await createTeam(context(c), name, leadUserId), 201)
    })
    .put('/:id', requirePermission('users_roles', 'edit'), async (c) => {
      const id = c.req.param('id')
      if (!UUID.test(id)) return fail(c, 404, 'TEAM_NOT_FOUND')
      const body = await readBody(c)
      if (!body) return invalid(c, '')
      const change: { name?: string; leadUserId?: string } = {}
      if (body.name !== undefined) {
        const name = readName(body.name)
        if (!name) return invalid(c, 'name')
        change.name = name
      }
      if (body.leadUserId !== undefined) {
        if (typeof body.leadUserId !== 'string' || body.leadUserId === '') {
          return invalid(c, 'leadUserId')
        }
        change.leadUserId = body.leadUserId
      }
      if (change.name === undefined && change.leadUserId === undefined) return invalid(c, '')
      return respond(c, await updateTeam(context(c), id, change))
    })
    .delete('/:id', requirePermission('users_roles', 'delete'), async (c) => {
      const id = c.req.param('id')
      if (!UUID.test(id)) return fail(c, 404, 'TEAM_NOT_FOUND')
      const outcome = await deleteTeam(context(c), id)
      return outcome.ok ? c.body(null, 204) : fail(c, outcome.status, outcome.code)
    })
}
