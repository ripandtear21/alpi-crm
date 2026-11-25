import {
  can,
  FILTER_ENTITIES,
  FILTER_FIELD_ENTITY,
  type FilterEntity,
  type FilterGroup,
  hasStandalone,
  parseFilter,
  type Resource,
  SAVED_FILTER_VISIBILITIES,
  type SavedFilterSummary,
  type SavedFilterVisibility,
  withoutUnavailable,
} from '@alpi/shared'
import { Hono } from 'hono'
import { type Ctx, fail, readBody, refuse, requiredText, UUID } from '../contacts/http.ts'
import type { PermissionsEnv } from '../middleware/permissions.ts'
import { loadMemberAccess, type MemberAccess } from '../roles/access.ts'
import { type CatalogField, loadFilterCatalog } from './custom.ts'

// Сохранённые фильтры списков (тикет crm-deals/12; таблица — migrations/0014_saved_filters.ts):
// `/v1/saved-filters`. Видимость (spec.md, раздел 3.2; ответ владельца, пункт 32):
// - personal — фильтр видит и удаляет только автор; сохранить может каждый, кто видит список;
// - team — видят участники команды; сохранить — с правом «общие фильтры» (shared_filters) и
//   только для своей команды; для чужой команды — ещё и охват сделок «все» (руководитель);
// - project — видят все участники проекта; сохранить — с правом «общие фильтры» и охватом
//   сделок «все» (администратор, руководитель). Тимлиду (охват «команда») — 403.
// Общий фильтр удаляет его автор, пока у него есть «общие фильтры», и администратор проекта.
// Пользовательские поля (тикет crm-fields/07): условие хранится по id поля. Сохранить условие по
// полю, которого пользователь не видит, — 422 CUSTOM_FIELD_UNKNOWN. Открывается фильтр без
// условий по полям в архиве, удалённым и скрытым от того, кто открыл: `filter` — что можно
// применить, `unavailableConditions` — сколько условий не применяется («умова недоступна»,
// решено без владельца, подтвердить). В базе условие остаётся: вернул поле из архива — оно
// снова действует.

export type SavedFiltersErrorCode =
  | 'PERMISSION_DENIED'
  | 'INVALID_SAVED_FILTER'
  | 'SAVED_FILTER_NOT_FOUND'
  /** Фильтр для команды, а пользователь ни в одной команде не состоит. */
  | 'NO_TEAM'
  | 'TEAM_NOT_FOUND'
  /** Условие по пользовательскому полю, которого пользователь не видит или нет (422). */
  | 'CUSTOM_FIELD_UNKNOWN'

/** Наибольшее число сохранённых фильтров одного списка, видимых пользователю, в ответе. */
const LIST_LIMIT = 200
const MAX_NAME_LENGTH = 100

/** Часть системы списка: право «смотреть» на неё нужно и для сохранённых фильтров. */
const RESOURCE: Record<FilterEntity, Resource> = {
  deals: 'deals',
  contacts: 'contacts',
  organizations: 'organizations',
}

const isEntity = (value: unknown): value is FilterEntity =>
  FILTER_ENTITIES.some((entity) => entity === value)
const isVisibility = (value: unknown): value is SavedFilterVisibility =>
  SAVED_FILTER_VISIBILITIES.some((visibility) => visibility === value)

const invalid = (path: string, message?: string) =>
  refuse(400, 'INVALID_SAVED_FILTER', { path, ...(message ? { message } : {}) })

/** Команда пользователя в текущем проекте; null — не в команде. */
async function teamOf(c: Ctx): Promise<string | null> {
  const row = await c
    .get('db')
    .selectFrom('project_member')
    .select('team_id')
    .where('user_id', '=', c.get('session').user.id)
    .executeTakeFirst()
  return row?.team_id ?? null
}

/** Может ли пользователь сохранять общие фильтры с этой видимостью. */
function sharesWithProject(c: Ctx): boolean {
  const { permissions, isAdmin } = c.get('access')
  return (
    hasStandalone(permissions, 'shared_filters') &&
    (isAdmin || permissions.scopes.deals.read === 'all')
  )
}

function canDelete(c: Ctx, row: { owner_id: string; visibility: SavedFilterVisibility }): boolean {
  const { permissions, isAdmin } = c.get('access')
  if (isAdmin) return true
  if (row.owner_id !== c.get('session').user.id) return false
  return row.visibility === 'personal' || hasStandalone(permissions, 'shared_filters')
}

type Row = {
  id: string
  entity: FilterEntity
  name: string
  visibility: SavedFilterVisibility
  team_id: string | null
  owner_id: string
  filter: Record<string, unknown>
  created_at: Date
}

function summary(c: Ctx, row: Row, custom: readonly CatalogField[]): SavedFilterSummary {
  const { filter, removed } = withoutUnavailable(row.filter as FilterGroup, custom)
  return {
    id: row.id,
    entity: row.entity,
    name: row.name,
    visibility: row.visibility,
    teamId: row.team_id,
    ownerId: row.owner_id,
    filter,
    unavailableConditions: removed,
    canDelete: canDelete(c, row),
    createdAt: new Date(row.created_at).toISOString(),
  }
}

const COLUMNS = [
  'id',
  'entity',
  'name',
  'visibility',
  'team_id',
  'owner_id',
  'filter',
  'created_at',
] as const

/** Видимые пользователю фильтры (row-level security уже ограничила проектом). */
async function visibleFilters(c: Ctx, entity: FilterEntity) {
  const userId = c.get('session').user.id
  const team = await teamOf(c)
  return c
    .get('db')
    .selectFrom('saved_filter')
    .select(COLUMNS)
    .where('entity', '=', entity)
    .where((eb) =>
      eb.or([
        eb('owner_id', '=', userId),
        eb('visibility', '=', 'project'),
        ...(team === null
          ? []
          : [eb.and([eb('visibility', '=', 'team'), eb('team_id', '=', team)])]),
      ]),
    )
    .orderBy('name')
    .orderBy('id')
    .limit(LIST_LIMIT)
    .execute() as Promise<Row[]>
}

export function savedFiltersRoutes() {
  return new Hono<PermissionsEnv>()
    .get('/', async (c) => {
      const entity = c.req.query('entity')
      if (!isEntity(entity)) return fail(c, invalid('entity'))
      if (!(await canView(c, entity))) return fail(c, refuse(403, 'PERMISSION_DENIED'))
      const rows = await visibleFilters(c, entity)
      const custom = await catalogOf(c, entity)
      return c.json<SavedFilterSummary[]>(rows.map((row) => summary(c, row, custom)))
    })
    .post('/', async (c) => {
      const body = await readBody(c)
      if (!body) return fail(c, invalid(''))
      for (const key of Object.keys(body)) {
        if (!['entity', 'name', 'visibility', 'teamId', 'filter'].includes(key)) {
          return fail(c, invalid(key))
        }
      }
      const { entity, visibility } = body
      if (!isEntity(entity)) return fail(c, invalid('entity'))
      if (!(await canView(c, entity))) return fail(c, refuse(403, 'PERMISSION_DENIED'))
      const name = requiredText(body.name, MAX_NAME_LENGTH)
      if (name === undefined) return fail(c, invalid('name'))
      if (!isVisibility(visibility)) return fail(c, invalid('visibility'))
      const custom = await catalogOf(c, entity)
      const parsed = parseFilter(entity, body.filter, custom)
      if (!parsed.ok) {
        const unknown = parsed.error.unknownCustomField
        return fail(
          c,
          unknown === undefined
            ? invalid(`filter${parsed.error.path}`, parsed.error.message)
            : refuse(422, 'CUSTOM_FIELD_UNKNOWN', { field: unknown }),
        )
      }
      if (body.teamId !== undefined && visibility !== 'team') return fail(c, invalid('teamId'))

      let teamId: string | null = null
      if (visibility === 'project' && !sharesWithProject(c)) {
        return fail(c, refuse(403, 'PERMISSION_DENIED'))
      }
      if (visibility === 'team') {
        if (!hasStandalone(c.get('access').permissions, 'shared_filters')) {
          return fail(c, refuse(403, 'PERMISSION_DENIED'))
        }
        const own = await teamOf(c)
        if (body.teamId === undefined || body.teamId === own) {
          if (own === null) return fail(c, refuse(422, 'NO_TEAM', { path: 'teamId' }))
          teamId = own
        } else {
          // Чужая команда — только с охватом «все» (руководитель, администратор).
          if (!sharesWithProject(c)) return fail(c, refuse(403, 'PERMISSION_DENIED'))
          if (typeof body.teamId !== 'string' || !UUID.test(body.teamId)) {
            return fail(c, invalid('teamId'))
          }
          const team = await c
            .get('db')
            .selectFrom('team')
            .select('id')
            .where('id', '=', body.teamId)
            .executeTakeFirst()
          if (!team) return fail(c, refuse(422, 'TEAM_NOT_FOUND', { path: 'teamId' }))
          teamId = team.id
        }
      }
      const row = (await c
        .get('db')
        .insertInto('saved_filter')
        .values({
          project_id: c.get('projectId'),
          entity,
          name,
          visibility,
          team_id: teamId,
          owner_id: c.get('session').user.id,
          filter: JSON.stringify(parsed.filter),
        })
        .returning(COLUMNS)
        .executeTakeFirstOrThrow()) as Row
      return c.json<SavedFilterSummary>(summary(c, row, custom), 201)
    })
    .delete('/:id', async (c) => {
      const id = c.req.param('id')
      const notFound = () => fail(c, refuse(404, 'SAVED_FILTER_NOT_FOUND'))
      if (!UUID.test(id)) return notFound()
      const row = (await c
        .get('db')
        .selectFrom('saved_filter')
        .select(COLUMNS)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()) as Row | undefined
      if (!row || !(await canView(c, row.entity))) return notFound()
      // Невидимый фильтр — как несуществующий.
      const visible = (await visibleFilters(c, row.entity)).some((item) => item.id === row.id)
      if (!visible) return notFound()
      if (!canDelete(c, row)) return fail(c, refuse(403, 'PERMISSION_DENIED'))
      await c.get('db').deleteFrom('saved_filter').where('id', '=', id).execute()
      return c.body(null, 204)
    })
}

/** Пользовательские поля списка `entity`, которые видит пользователь (canView уже загрузил роль). */
function catalogOf(c: Ctx, entity: FilterEntity): Promise<CatalogField[]> {
  return loadFilterCatalog(c.get('db'), c.get('access').permissions, FILTER_FIELD_ENTITY[entity])
}

/**
 * Роль пользователя в проекте (как в requirePermission: читается один раз и кладётся в
 * `c.var.access`) и право смотреть список `entity`.
 */
async function canView(c: Ctx, entity: FilterEntity): Promise<boolean> {
  let access = c.get('access') as MemberAccess | undefined
  if (!access) {
    const loaded = await loadMemberAccess(c.get('db'), c.get('session').user.id)
    if (!loaded) return false
    access = loaded
    c.set('access', access)
  }
  return can(access.permissions, RESOURCE[entity], 'view')
}
