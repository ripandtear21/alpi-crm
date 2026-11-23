import type { Database } from '@alpi/db'
import type { ProjectAccess, ProjectSummary } from '@alpi/shared'
import { Hono } from 'hono'
import { type Kysely, sql } from 'kysely'
import type { AccessEnv } from '../auth/access-guard.ts'
import { OWNER_ROLE } from '../auth/owner.ts'
import type { ProjectEnv } from '../middleware/project-context.ts'
import { loadMemberAccess } from '../roles/access.ts'

// Проекты: список «мои проекты» и создание проекта — вне контекста проекта; текущий проект —
// внутри него (после projectContext). Роль приложения не может вставлять в project и не видит
// чужих участий: оба действия — функции базы из migrations/0003_projects.ts.

/** Код проекта: латиница в нижнем регистре, цифры и дефис. */
const PROJECT_CODE = /^[a-z0-9][a-z0-9-]{1,31}$/
const MAX_NAME_LENGTH = 120

/** SQLSTATE PostgreSQL. */
const UNIQUE_VIOLATION = '23505'
const INSUFFICIENT_PRIVILEGE = '42501'

/** Владелец системы — роль admin плагина admin Better Auth (роли там через запятую). */
export function isSystemOwner(user: { role?: string | null | undefined }): boolean {
  return (user.role ?? '')
    .split(',')
    .map((role) => role.trim())
    .includes(OWNER_ROLE)
}

/** Проекты, в которых состоит пользователь. Только свои: id берётся из сессии. */
export async function listUserProjects(
  db: Kysely<Database>,
  userId: string,
): Promise<ProjectSummary[]> {
  const { rows } = await sql<ProjectSummary>`
    select id, code, name from public.user_projects(${userId}) order by name, code
  `.execute(db)
  return rows
}

/** Маршруты вне контекста проекта: сессия с 2FA уже проверена accessGuard. */
export function projectsRoutes(db: Kysely<Database>) {
  return new Hono<AccessEnv>()
    .get('/', async (c) => {
      const { user } = c.get('session')
      return c.json<ProjectSummary[]>(await listUserProjects(db, user.id))
    })
    .post('/', async (c) => {
      const { user } = c.get('session')
      if (!isSystemOwner(user)) {
        return c.json({ code: 'FORBIDDEN' }, 403)
      }
      const body = (await c.req.json().catch(() => null)) as { code?: unknown; name?: unknown }
      const code = typeof body?.code === 'string' ? body.code.trim() : ''
      const name = typeof body?.name === 'string' ? body.name.trim() : ''
      if (!PROJECT_CODE.test(code) || name.length === 0 || name.length > MAX_NAME_LENGTH) {
        return c.json({ code: 'INVALID_PROJECT' }, 400)
      }
      try {
        const { rows } = await sql<ProjectSummary>`
          select id, code, name from public.create_project(${code}, ${name}, ${user.id})
        `.execute(db)
        const created = rows[0]
        if (!created) throw new Error('create_project не вернула проект')
        return c.json<ProjectSummary>(created, 201)
      } catch (error) {
        const sqlState = (error as { code?: unknown }).code
        if (sqlState === UNIQUE_VIOLATION) return c.json({ code: 'PROJECT_CODE_TAKEN' }, 409)
        if (sqlState === INSUFFICIENT_PRIVILEGE) return c.json({ code: 'FORBIDDEN' }, 403)
        throw error
      }
    })
}

/** Маршруты в контексте проекта: участие проверено, запросы — через транзакцию проекта. */
export function currentProjectRoutes() {
  return (
    new Hono<ProjectEnv>()
      .get('/', async (c) => {
        const project = await c
          .get('db')
          .selectFrom('project')
          .select(['id', 'code', 'name'])
          .where('id', '=', c.get('projectId'))
          .executeTakeFirstOrThrow()
        return c.json<ProjectSummary>(project)
      })
      // Права самого пользователя в текущем проекте (роль участника): интерфейс прячет по ним
      // кнопки, на которые нет права. Только свои права и только этого проекта — сервер всё
      // равно проверяет каждый запрос сам.
      .get('/access', async (c) => {
        const userId = c.get('session').user.id
        const access = await loadMemberAccess(c.get('db'), userId)
        // projectContext уже проверил участие; пропасть оно могло только в этой же транзакции.
        if (!access) return c.json({ code: 'PERMISSION_DENIED' }, 403)
        return c.json<ProjectAccess>({ userId, permissions: access.permissions })
      })
  )
}
