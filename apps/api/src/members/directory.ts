import { can, type ProjectUser, type TeamSummary } from '@alpi/shared'
import { OpenAPIHono, z } from '@hono/zod-openapi'
import { createMiddleware } from 'hono/factory'
import { type PermissionsEnv, requirePermission } from '../middleware/permissions.ts'
import { IdSchema, jsonContent, keyRoute } from '../openapi/openapi.ts'
import { listTeams } from '../teams/teams.ts'
import { listMembers } from './service.ts'

// Справочники участников и команд для ключа API и интеграций (тикет crm-api/04):
// `GET /api/v1/users` и `GET /api/v1/teams`, только чтение. Ключу — по праву «сделки: смотреть»
// (автоматизации нужно назначать ответственных и понимать команды), сессии — по «пользователи и
// роли: смотреть», как прежние `/members` и `/teams` (управление участниками, только сессия;
// решено без владельца — подтвердить).
//
// - Пользователь: id, имя, команда, активен ли. Email — только если у роли есть «пользователи и
//   роли: смотреть» (персональные данные; решено без владельца — подтвердить). Пароли, 2FA и роли
//   не отдаются.
// - Справочник отдаётся целиком, массивом (как воронки и причины проигрыша).
// - Только участники и команды своего проекта: транзакция проекта и row-level security.
// - Примеры — выдуманные.

const EXAMPLE_IDS = {
  user: 'Xq7tR2mK9vLp4sWb',
  lead: 'Lp4sWbXq7tR2mK9v',
  team: '3c7a1e9d-5b2f-4d8a-b6e0-9f1c3a7d5e24',
}

const UserSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    teamId: IdSchema.nullable().openapi({ description: 'Команда; null — ни в одной' }),
    active: z.boolean().openapi({ description: 'false — участие в проекте отключено' }),
    email: z.string().optional().openapi({
      description: 'Только если у роли есть «пользователи и роли: смотреть»',
    }),
  })
  .openapi('User')

const TeamSchema = z
  .object({
    id: IdSchema,
    name: z.string(),
    leadUserId: z.string().openapi({ description: 'Тимлид — участник этой команды' }),
    memberUserIds: z.array(z.string()).openapi({ description: 'Участники, тимлид среди них' }),
  })
  .openapi('Team')

const keyView = requirePermission('deals', 'view')
const sessionView = requirePermission('users_roles', 'view')

/**
 * Ключу API справочник открыт по «сделки: смотреть». Сессии — по прежнему праву
 * «пользователи и роли: смотреть», как у `/members` и `/teams`: иначе менеджер без этого права
 * увидел бы всех участников и состав команд.
 */
const view = createMiddleware<PermissionsEnv>((c, next) =>
  c.get('actor').type === 'api_key' ? keyView(c, next) : sessionView(c, next),
)

export const listUsersRoute = keyRoute({
  method: 'get',
  path: '/',
  tags: ['Справочники'],
  summary: 'Участники проекта',
  description:
    'Все участники проекта, в том числе с отключённым участием (`active: false`). Email — только у роли с правом «пользователи и роли: смотреть».',
  middleware: [view],
  responses: {
    200: {
      description: 'Участники',
      content: jsonContent(z.array(UserSchema), [
        {
          id: EXAMPLE_IDS.user,
          name: 'Тестовий Менеджер',
          teamId: EXAMPLE_IDS.team,
          active: true,
          email: 'manager@example.test',
        },
      ]),
    },
  },
})

export const listTeamsRoute = keyRoute({
  method: 'get',
  path: '/',
  tags: ['Справочники'],
  summary: 'Команды проекта',
  middleware: [view],
  responses: {
    200: {
      description: 'Команды',
      content: jsonContent(z.array(TeamSchema), [
        {
          id: EXAMPLE_IDS.team,
          name: 'Команда «Схід»',
          leadUserId: EXAMPLE_IDS.lead,
          memberUserIds: [EXAMPLE_IDS.lead, EXAMPLE_IDS.user],
        },
      ]),
    },
  },
})

/** `GET /v1/users`: участники проекта для ключа API и интеграций. */
export function usersRoutes() {
  const app = new OpenAPIHono<PermissionsEnv>()
  app.openapi(listUsersRoute, async (c) => {
    const withEmail = can(c.get('access').permissions, 'users_roles', 'view')
    const users = (await listMembers(c.get('db'))).map(
      (member): ProjectUser => ({
        id: member.userId,
        name: member.name,
        teamId: member.teamId,
        active: !member.disabled,
        ...(withEmail ? { email: member.email } : {}),
      }),
    )
    return c.json<ProjectUser[], 200>(users, 200)
  })
  return app
}

/** `GET /v1/teams`: команды проекта для ключа API и интеграций. */
export function teamDirectoryRoutes() {
  const app = new OpenAPIHono<PermissionsEnv>()
  app.openapi(listTeamsRoute, async (c) =>
    c.json<TeamSummary[], 200>(await listTeams(c.get('db')), 200),
  )
  return app
}
