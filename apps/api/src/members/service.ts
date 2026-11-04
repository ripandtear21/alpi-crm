import { randomBytes } from 'node:crypto'
import type { Database } from '@alpi/db'
import {
  type MemberSummary,
  type MembersErrorCode,
  type ProjectAuditAction,
  parseRolePermissions,
  type RolePermissions,
  type RolesErrorCode,
} from '@alpi/shared'
import { APIError } from 'better-auth/api'
import { type Kysely, sql } from 'kysely'
import { type AuditEvent, audit } from '../audit/record.ts'
import type { Auth } from '../auth/auth.ts'
import type { MemberAccess } from '../roles/access.ts'
import { effectivePermissions } from '../roles/access.ts'
import {
  checkAssignment,
  checkMemberChange,
  checkTeamChange,
  type GuardFailure,
  type GuardTarget,
} from '../roles/guard.ts'
import { inSavepoint, sqlState } from '../roles/roles.ts'
import type { OpenDealsChecker } from './open-deals.ts'

// Все изменения участников проекта — здесь (тикет crm-foundation/06): добавить существующего
// пользователя, завести нового с временным паролем, назначить роль и команду, флаг «принимает
// новые сделки», отключить и включить участие. Маршруты (members.ts, teams/teams.ts) только
// разбирают запрос и зовут функции отсюда. Каждое изменение пишется в журнал проекта
// (audit/record.ts, тикет 07) той же транзакцией проекта: не записалось в журнал — откатилось и
// действие (ответ 500).
//
// Каждая функция: блокирует строку участия цели, проверяет правила guard.ts (кто кого может
// менять), пишет в точке сохранения. Правила, не зависящие от того, кто меняет (тимлид в своей
// команде, тимлид не отключён, последний администратор), держит база
// (packages/db/migrations/0004_roles.ts, 0006_teams.ts); её отказы становятся 409.

/** Тот, кто меняет: роль в текущем проекте и id учётной записи. */
export interface MemberActor extends MemberAccess {
  userId: string
}

/** Транзакция проекта, проект и тот, кто меняет. */
export interface MemberContext {
  db: Kysely<Database>
  projectId: string
  actor: MemberActor
  /** Адрес клиента для журнала; null — не определён. */
  ip: string | null
}

/** Запись в журнал проекта от имени того, кто меняет, в транзакции проекта. */
export function record(
  ctx: MemberContext,
  event: Omit<AuditEvent<ProjectAuditAction>, 'actorId' | 'ip'>,
): Promise<void> {
  return audit.record(ctx.db, ctx.projectId, { ...event, actorId: ctx.actor.userId, ip: ctx.ip })
}

/** Название команды для журнала; null — без команды. */
export async function teamName(
  db: Kysely<Database>,
  teamId: string | null,
): Promise<string | null> {
  if (teamId === null) return null
  const row = await db.selectFrom('team').select('name').where('id', '=', teamId).executeTakeFirst()
  return row?.name ?? null
}

/** Смена команды участника в журнал: было → стало (id и название). */
export async function recordTeamChange(
  ctx: MemberContext,
  userId: string,
  from: string | null,
  to: string | null,
): Promise<void> {
  if (from === to) return
  await record(ctx, {
    action: 'member.team_changed',
    entity: { type: 'user', id: userId },
    details: {
      before: { teamId: from, teamName: await teamName(ctx.db, from) },
      after: { teamId: to, teamName: await teamName(ctx.db, to) },
    },
  })
}

export type MemberErrorCode = RolesErrorCode | MembersErrorCode | GuardFailure

export type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 403 | 404 | 409; code: MemberErrorCode }

export const ok = <T>(value: T): Outcome<T> => ({ ok: true, value })
export const refuse = (status: 400 | 403 | 404 | 409, code: MemberErrorCode) =>
  ({ ok: false, status, code }) as const

/** Наибольшие длины: email — RFC 5321, имя — с запасом для ФИО. */
const MAX_EMAIL_LENGTH = 254
const MAX_NAME_LENGTH = 100
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** SQLSTATE: стандартные PostgreSQL и свои — из триггеров 0004_roles и 0006_teams. */
const UNIQUE_VIOLATION = '23505'
const FOREIGN_KEY_VIOLATION = '23503'
const LAST_ADMIN = 'AR002'
const TEAM_LEAD_DISABLED = 'TM001'
const MEMBER_IS_TEAM_LEAD = 'TM002'

/** Права участника без роли: у нового участника прав ещё нет. */
function noPermissions(): RolePermissions {
  const parsed = parseRolePermissions({})
  if (!parsed.ok) throw new Error('пустые права не прошли проверку каталога')
  return parsed.permissions
}

/**
 * Ответ на отказ базы; другие ошибки пробрасываются (500). Имена ограничений — из
 * migrations/0001_project_isolation.ts и 0006_teams.ts.
 */
export function dbRefusal(error: unknown): Outcome<never> {
  const constraint = (error as { constraint?: unknown }).constraint
  switch (sqlState(error)) {
    case LAST_ADMIN:
      return refuse(409, 'LAST_ADMIN')
    case TEAM_LEAD_DISABLED:
      return refuse(409, 'TEAM_LEAD_DISABLED')
    case MEMBER_IS_TEAM_LEAD:
      return refuse(409, 'MEMBER_IS_TEAM_LEAD')
    case FOREIGN_KEY_VIOLATION:
      if (constraint === 'team_lead_in_team') return refuse(409, 'MEMBER_IS_TEAM_LEAD')
      if (constraint === 'project_member_team_fkey') return refuse(404, 'TEAM_NOT_FOUND')
      break
    case UNIQUE_VIOLATION:
      if (constraint === 'team_project_id_name_key') return refuse(409, 'TEAM_NAME_TAKEN')
      if (constraint === 'team_project_id_lead_user_id_key') return refuse(409, 'LEADS_OTHER_TEAM')
      if (constraint === 'project_member_project_id_user_id_key') {
        return refuse(409, 'MEMBER_EXISTS')
      }
      break
  }
  throw error
}

/**
 * Отложенная проверка «тимлид состоит в своей команде» — сейчас, а не в конце транзакции:
 * внутри точки сохранения её отказ откатывается и становится 409, а не 500 при фиксации.
 */
export async function checkTeamLeads(db: Kysely<Database>): Promise<void> {
  await sql`set constraints team_lead_in_team immediate`.execute(db)
  await sql`set constraints team_lead_in_team deferred`.execute(db)
}

/** Участники проекта (или один — `userId`): по имени, затем по email. */
export async function listMembers(db: Kysely<Database>, userId?: string): Promise<MemberSummary[]> {
  let query = db
    .selectFrom('project_member as m')
    .innerJoin('user as u', 'u.id', 'm.user_id')
    .select([
      'm.user_id',
      'u.email',
      'u.name',
      'm.role_id',
      'm.team_id',
      'm.accepts_new_deals',
      'm.disabled_at',
    ])
    .orderBy('u.name')
    .orderBy('u.email')
  if (userId !== undefined) query = query.where('m.user_id', '=', userId)
  const rows = await query.execute()
  return rows.map((row) => ({
    userId: row.user_id,
    email: row.email,
    name: row.name,
    roleId: row.role_id,
    teamId: row.team_id,
    acceptsNewDeals: row.accepts_new_deals,
    disabled: row.disabled_at !== null,
  }))
}

async function memberSummary(db: Kysely<Database>, userId: string): Promise<MemberSummary> {
  const [member] = await listMembers(db, userId)
  if (!member) throw new Error('участник пропал в той же транзакции')
  return member
}

/** Участник, которого меняют: роль, команда, отключён ли. */
export interface LockedMember extends GuardTarget {
  roleId: string
  roleName: string
  teamId: string | null
  disabled: boolean
}

/** Строка участия `userId` текущего проекта, заблокированная до конца транзакции; null — нет. */
export async function lockMember(
  db: Kysely<Database>,
  projectId: string,
  userId: string,
): Promise<LockedMember | null> {
  const row = await db
    .selectFrom('project_member as m')
    .innerJoin('role as r', (join) =>
      join.onRef('r.id', '=', 'm.role_id').onRef('r.project_id', '=', 'm.project_id'),
    )
    .select([
      'm.user_id',
      'm.team_id',
      'm.disabled_at',
      'r.id',
      'r.name',
      'r.is_admin',
      'r.permissions',
    ])
    .where('m.project_id', '=', projectId)
    .where('m.user_id', '=', userId)
    .forUpdate('m')
    .executeTakeFirst()
  if (!row) return null
  return {
    userId: row.user_id,
    roleId: row.id,
    roleName: row.name,
    roleIsAdmin: row.is_admin,
    permissions: effectivePermissions(row),
    teamId: row.team_id,
    disabled: row.disabled_at !== null,
  }
}

/** Команда, которую ведёт `userId`; null — не тимлид. */
export async function ledTeam(db: Kysely<Database>, userId: string): Promise<string | null> {
  const row = await db
    .selectFrom('team')
    .select('id')
    .where('lead_user_id', '=', userId)
    .executeTakeFirst()
  return row?.id ?? null
}

async function teamExists(db: Kysely<Database>, teamId: string): Promise<boolean> {
  const row = await db.selectFrom('team').select('id').where('id', '=', teamId).executeTakeFirst()
  return row !== undefined
}

async function loadRole(db: Kysely<Database>, roleId: string) {
  const role = await db
    .selectFrom('role')
    .select(['id', 'name', 'is_admin', 'permissions'])
    .where('id', '=', roleId)
    .executeTakeFirst()
  return role
    ? { name: role.name, isAdmin: role.is_admin, permissions: effectivePermissions(role) }
    : null
}

/** Перевод участника в команду (null — из команды) без проверок: их делает вызывающий. */
export async function putIntoTeam(
  ctx: MemberContext,
  userId: string,
  teamId: string | null,
): Promise<void> {
  await ctx.db
    .updateTable('project_member')
    .set({ team_id: teamId, updated_at: sql`now()` })
    .where('project_id', '=', ctx.projectId)
    .where('user_id', '=', userId)
    .execute()
}

/** Назначить участнику роль. */
export async function assignRole(
  ctx: MemberContext,
  userId: string,
  roleId: string,
): Promise<Outcome<MemberSummary>> {
  const role = await loadRole(ctx.db, roleId)
  if (!role) return refuse(404, 'ROLE_NOT_FOUND')
  const target = await lockMember(ctx.db, ctx.projectId, userId)
  if (!target) return refuse(404, 'MEMBER_NOT_FOUND')
  const failure = checkAssignment(ctx.actor, target, role)
  if (failure) return refuse(403, failure)
  try {
    await inSavepoint(ctx.db, () =>
      ctx.db
        .updateTable('project_member')
        .set({ role_id: roleId, updated_at: sql`now()` })
        .where('project_id', '=', ctx.projectId)
        .where('user_id', '=', userId)
        .execute(),
    )
  } catch (error) {
    return dbRefusal(error)
  }
  if (target.roleId !== roleId) {
    await record(ctx, {
      action: 'member.role_changed',
      entity: { type: 'user', id: userId },
      details: {
        before: { roleId: target.roleId, roleName: target.roleName },
        after: { roleId, roleName: role.name },
      },
    })
  }
  return ok(await memberSummary(ctx.db, userId))
}

export interface NewMemberInput {
  roleId: string
  teamId: string | null
}

/**
 * Проверки до добавления участника: роль и команда есть в проекте, тот, кто добавляет, может
 * выдать эту роль и привести участника в эту команду. `userId` — id будущего участника
 * (пусто, пока учётной записи нет).
 */
async function checkNewMember(
  ctx: MemberContext,
  userId: string,
  input: NewMemberInput,
): Promise<Outcome<null>> {
  const role = await loadRole(ctx.db, input.roleId)
  if (!role) return refuse(404, 'ROLE_NOT_FOUND')
  if (input.teamId !== null && !(await teamExists(ctx.db, input.teamId))) {
    return refuse(404, 'TEAM_NOT_FOUND')
  }
  const target = { userId, roleIsAdmin: false, permissions: noPermissions() }
  // Команду новому участнику выбирает только администратор (guard.ts, правило (д)): иначе
  // не-администратор завёл бы учётную запись, пароль которой знает, сразу в чужую команду.
  const failure =
    checkAssignment(ctx.actor, target, role) ??
    (input.teamId === null ? null : checkTeamChange(ctx.actor))
  if (failure) return refuse(403, failure)
  return ok(null)
}

async function insertMember(
  ctx: MemberContext,
  userId: string,
  input: NewMemberInput,
  action: 'member.added' | 'member.created',
): Promise<Outcome<MemberSummary>> {
  try {
    await inSavepoint(ctx.db, () =>
      ctx.db
        .insertInto('project_member')
        .values({
          project_id: ctx.projectId,
          user_id: userId,
          role_id: input.roleId,
          team_id: input.teamId,
          created_by: ctx.actor.userId,
        })
        .execute(),
    )
  } catch (error) {
    return dbRefusal(error)
  }
  const role = await loadRole(ctx.db, input.roleId)
  // Временный пароль в журнал не попадает: только роль и команда.
  await record(ctx, {
    action,
    entity: { type: 'user', id: userId },
    details: {
      after: {
        roleId: input.roleId,
        roleName: role?.name ?? null,
        teamId: input.teamId,
        teamName: await teamName(ctx.db, input.teamId),
      },
    },
  })
  return ok(await memberSummary(ctx.db, userId))
}

/** Разбор email: обрезанный, в нижнем регистре (так его хранит Better Auth); null — не email. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  return email.length <= MAX_EMAIL_LENGTH && EMAIL.test(email) ? email : null
}

/** Разбор имени: обрезанное, непустое, не длиннее предела; null — не подходит. */
export function normalizeName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  return name.length > 0 && name.length <= MAX_NAME_LENGTH ? name : null
}

async function userIdByEmail(db: Kysely<Database>, email: string): Promise<string | null> {
  const row = await db
    .selectFrom('user')
    .select('id')
    .where(sql`lower(email)`, '=', email)
    .executeTakeFirst()
  return row?.id ?? null
}

/** Добавить в проект существующую учётную запись по email. */
export async function addExistingMember(
  ctx: MemberContext,
  email: string,
  input: NewMemberInput,
): Promise<Outcome<MemberSummary>> {
  const userId = await userIdByEmail(ctx.db, email)
  if (!userId) return refuse(404, 'USER_NOT_FOUND')
  const existing = await ctx.db
    .selectFrom('project_member')
    .select('id')
    .where('user_id', '=', userId)
    .executeTakeFirst()
  if (existing) return refuse(409, 'MEMBER_EXISTS')
  const checked = await checkNewMember(ctx, userId, input)
  if (!checked.ok) return checked
  return insertMember(ctx, userId, input, 'member.added')
}

/** Временный пароль: 16 символов base64url (96 бит), длиннее минимума MIN_PASSWORD_LENGTH. */
function temporaryPassword(): string {
  return randomBytes(12).toString('base64url')
}

/**
 * Завести учётную запись с временным паролем и добавить её в проект. Учётную запись создаёт
 * Better Auth вызовом на сервере (без сессии и без прав владельца системы: тот, кто добавляет, —
 * администратор проекта или держатель права «пользователи и роли»), с ролью вне проектов по
 * умолчанию — не владелец системы. Пароль возвращается один раз и нигде не пишется в открытом
 * виде; флаг must_change_password заставляет сменить его при первом входе.
 *
 * shortcut: учётную запись Better Auth создаёт своим подключением, вне транзакции проекта; если
 * участие потом не запишется (сбой базы между двумя шагами), останется учётная запись без
 * проекта с паролем, которого никто не видел — её можно добавить как существующую, но пароль
 * придётся сбросить владельцу системы. Переделать, когда появится сброс пароля администратором.
 */
export async function createMember(
  ctx: MemberContext,
  auth: Auth,
  account: { email: string; name: string },
  input: NewMemberInput,
): Promise<Outcome<{ member: MemberSummary; temporaryPassword: string }>> {
  // Сначала права: отказ не зависит от того, занят ли email.
  const checked = await checkNewMember(ctx, '', input)
  if (!checked.ok) return checked
  if (await userIdByEmail(ctx.db, account.email)) return refuse(409, 'EMAIL_TAKEN')
  const password = temporaryPassword()
  let userId: string
  try {
    // Флаг смены пароля — в той же вставке строки "user": серверный вызов передаёт data в
    // адаптер как есть (поле с input: false режет только разбор тела HTTP-запроса). Учётной
    // записи без флага с временным паролем не бывает ни на миг. Тест проверяет флаг в базе.
    const { user } = await auth.api.createUser({
      body: {
        email: account.email,
        name: account.name,
        password,
        data: { mustChangePassword: true },
      },
    })
    userId = user.id
  } catch (error) {
    // Учётную запись с этим email успели создать между проверкой и созданием.
    if (error instanceof APIError && error.body?.code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL') {
      return refuse(409, 'EMAIL_TAKEN')
    }
    throw error
  }
  const added = await insertMember(ctx, userId, input, 'member.created')
  if (!added.ok) return added
  return ok({ member: added.value, temporaryPassword: password })
}

/** Перевести участника в команду `teamId` (null — вывести из команды). */
export async function setMemberTeam(
  ctx: MemberContext,
  userId: string,
  teamId: string | null,
): Promise<Outcome<MemberSummary>> {
  const target = await lockMember(ctx.db, ctx.projectId, userId)
  if (!target) return refuse(404, 'MEMBER_NOT_FOUND')
  if (teamId !== null && !(await teamExists(ctx.db, teamId))) return refuse(404, 'TEAM_NOT_FOUND')
  const failure = checkTeamChange(ctx.actor)
  if (failure) return refuse(403, failure)
  if (target.teamId === teamId) return ok(await memberSummary(ctx.db, userId))
  try {
    await inSavepoint(ctx.db, async () => {
      await putIntoTeam(ctx, userId, teamId)
      // Тимлида из его команды не выпускает база (team_lead_in_team) — 409 MEMBER_IS_TEAM_LEAD.
      await checkTeamLeads(ctx.db)
    })
  } catch (error) {
    return dbRefusal(error)
  }
  await recordTeamChange(ctx, userId, target.teamId, teamId)
  return ok(await memberSummary(ctx.db, userId))
}

/** Флаг «принимает новые сделки». */
export async function setAcceptsNewDeals(
  ctx: MemberContext,
  userId: string,
  value: boolean,
): Promise<Outcome<MemberSummary>> {
  const target = await lockMember(ctx.db, ctx.projectId, userId)
  if (!target) return refuse(404, 'MEMBER_NOT_FOUND')
  const failure = checkMemberChange(ctx.actor, target)
  if (failure) return refuse(403, failure)
  await ctx.db
    .updateTable('project_member')
    .set({ accepts_new_deals: value, updated_at: sql`now()` })
    .where('project_id', '=', ctx.projectId)
    .where('user_id', '=', userId)
    .execute()
  return ok(await memberSummary(ctx.db, userId))
}

/**
 * Отключить участие: пользователь больше не входит в проект, но остаётся в истории (строки
 * участия и учётные записи не удаляются). Отказ, если у участника открытые сделки
 * (`openDeals`), если он ведёт команду или если это последний администратор.
 */
export async function disableMember(
  ctx: MemberContext,
  openDeals: OpenDealsChecker,
  userId: string,
): Promise<Outcome<MemberSummary>> {
  const target = await lockMember(ctx.db, ctx.projectId, userId)
  if (!target) return refuse(404, 'MEMBER_NOT_FOUND')
  const failure = checkMemberChange(ctx.actor, target)
  if (failure) return refuse(403, failure)
  if (target.disabled) return ok(await memberSummary(ctx.db, userId))
  if (await openDeals.hasOpenDeals(ctx.db, userId)) return refuse(409, 'HAS_OPEN_DEALS')
  try {
    await inSavepoint(ctx.db, () =>
      ctx.db
        .updateTable('project_member')
        .set({
          disabled_at: sql`now()`,
          disabled_by: ctx.actor.userId,
          updated_at: sql`now()`,
        })
        .where('project_id', '=', ctx.projectId)
        .where('user_id', '=', userId)
        .execute(),
    )
  } catch (error) {
    // Тимлид (TM002) и последний администратор (AR002) — отказ базы.
    return dbRefusal(error)
  }
  await record(ctx, { action: 'member.disabled', entity: { type: 'user', id: userId } })
  return ok(await memberSummary(ctx.db, userId))
}

/** Включить отключённое участие. */
export async function enableMember(
  ctx: MemberContext,
  userId: string,
): Promise<Outcome<MemberSummary>> {
  const target = await lockMember(ctx.db, ctx.projectId, userId)
  if (!target) return refuse(404, 'MEMBER_NOT_FOUND')
  const failure = checkMemberChange(ctx.actor, target)
  if (failure) return refuse(403, failure)
  if (!target.disabled) return ok(await memberSummary(ctx.db, userId))
  await ctx.db
    .updateTable('project_member')
    .set({ disabled_at: null, disabled_by: null, updated_at: sql`now()` })
    .where('project_id', '=', ctx.projectId)
    .where('user_id', '=', userId)
    .execute()
  await record(ctx, { action: 'member.enabled', entity: { type: 'user', id: userId } })
  return ok(await memberSummary(ctx.db, userId))
}
