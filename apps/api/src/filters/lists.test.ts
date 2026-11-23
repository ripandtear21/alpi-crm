import { randomUUID } from 'node:crypto'
import {
  FILTER_ENTITIES,
  FILTER_FIELDS,
  FILTER_OPERATORS,
  type FilterFieldSpec,
  type FilterGroup,
  type FilterOperator,
  type ListCount,
  operatorsOf,
  parseFilter,
  ROLE_TEMPLATES,
  type SavedFilterSummary,
  VALUELESS_OPERATORS,
} from '@alpi/shared'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ContactListPage } from '../contacts/list.ts'
import type { DealsPage } from '../deals/board.ts'
import type { OrganizationListPage } from '../organizations/list.ts'
import { type ApiHarness, type SignedInUser, startApiHarness } from '../testing/api-harness.ts'
import { compileFilter } from './compile.ts'

// Списки, фильтры и сохранённые фильтры (тикет crm-deals/12) на настоящем PostgreSQL: API ходит
// ролью приложения (без BYPASSRLS). Имена — вымышленные.

interface Pipeline {
  id: string
  stages: string[]
}

describe('списки и фильтры', () => {
  let h: ApiHarness
  let admin: SignedInUser
  let manager: SignedInUser
  let colleague: SignedInUser
  let teamlead: SignedInUser
  let teamMember: SignedInUser
  let otherTeamMember: SignedInUser
  let projectA: string
  let projectB: string
  let teamId: string
  let counter = 0

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_lists')
    admin = await h.signIn('owner')
    projectA = (await h.createProject(admin, 'Списки А')).id
    projectB = (await h.createProject(admin, 'Списки Б')).id
    manager = await h.signIn()
    colleague = await h.signIn()
    teamlead = await h.signIn()
    teamMember = await h.signIn()
    await h.addMember(projectA, manager.id, 'manager')
    await h.addMember(projectA, colleague.id, 'manager')
    await h.addMember(projectA, teamlead.id, 'teamlead')
    await h.addMember(projectA, teamMember.id, 'manager')
    // Команда тимлида: он сам и teamMember (тимлид состоит в своей команде).
    teamId = await h.owner.transaction().execute(async (trx) => {
      const team = await trx
        .insertInto('team')
        .values({ project_id: projectA, name: 'Команда А', lead_user_id: teamlead.id })
        .returning('id')
        .executeTakeFirstOrThrow()
      await trx
        .updateTable('project_member')
        .set({ team_id: team.id })
        .where('project_id', '=', projectA)
        .where('user_id', 'in', [teamlead.id, teamMember.id])
        .execute()
      return team.id
    })
    // Другая команда того же проекта: её участник не должен видеть фильтр команды тимлида.
    otherTeamMember = await h.signIn()
    await h.addMember(projectA, otherTeamMember.id, 'manager')
    await h.owner.transaction().execute(async (trx) => {
      const team = await trx
        .insertInto('team')
        .values({ project_id: projectA, name: 'Команда Б', lead_user_id: otherTeamMember.id })
        .returning('id')
        .executeTakeFirstOrThrow()
      await trx
        .updateTable('project_member')
        .set({ team_id: team.id })
        .where('project_id', '=', projectA)
        .where('user_id', '=', otherTeamMember.id)
        .execute()
    })
  })

  afterAll(async () => {
    await h?.stop()
  })

  async function createPipeline(projectId: string, stages = ['Новий лід', 'Дзвінок']) {
    counter += 1
    const { id } = await h.owner
      .insertInto('pipeline')
      .values({
        project_id: projectId,
        code: `l${counter}`,
        name: `Воронка ${counter}`,
        position: counter,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const ids: string[] = []
    for (const [index, name] of stages.entries()) {
      const stage = await h.owner
        .insertInto('stage')
        .values({ project_id: projectId, pipeline_id: id, name, position: index + 1 })
        .returning('id')
        .executeTakeFirstOrThrow()
      ids.push(stage.id)
    }
    return { id, stages: ids } satisfies Pipeline
  }

  interface SeedDeal {
    stage: string
    amount?: number
    owner?: string | null
    createdAt?: string
    archived?: boolean
    deleted?: boolean
    title?: string
  }

  /** Сделки прямо в базе одной вставкой, у каждой — свой контакт. */
  async function seed(projectId: string, pipeline: Pipeline, deals: SeedDeal[]): Promise<string[]> {
    const contacts = await h.owner
      .insertInto('contact')
      .values(
        deals.map(() => {
          counter += 1
          return { project_id: projectId, first_name: `Клієнт${counter}`, last_name: 'Вигаданий' }
        }),
      )
      .returning('id')
      .execute()
    const rows = await h.owner
      .insertInto('deal')
      .values(
        deals.map((deal, index) => ({
          project_id: projectId,
          title: deal.title ?? `Угода ${counter}-${index}`,
          pipeline_id: pipeline.id,
          stage_id: deal.stage,
          amount: deal.amount ?? 0,
          owner_id: deal.owner === undefined ? admin.id : deal.owner,
          primary_contact_id: contacts[index]?.id ?? '',
          created_at: deal.createdAt ?? new Date().toISOString(),
          archived_at: deal.archived ? new Date() : null,
          deleted_at: deal.deleted ? new Date() : null,
        })),
      )
      .returning('id')
      .execute()
    return rows.map((row) => row.id)
  }

  async function json<T>(res: Response, status = 200): Promise<T> {
    const text = await res.text()
    expect(res.status, text).toBe(status)
    return JSON.parse(text) as T
  }

  const q = (filter: FilterGroup) => encodeURIComponent(JSON.stringify(filter))

  /** Все страницы выдачи `path` (с параметрами) — id по порядку. */
  async function allPages(user: SignedInUser, path: string, project = projectA) {
    const ids: string[] = []
    let cursor: string | null = null
    do {
      const sep = path.includes('?') ? '&' : '?'
      const url: string = cursor ? `${path}${sep}cursor=${encodeURIComponent(cursor)}` : path
      const page: { items: { id: string }[]; nextCursor: string | null } = await json(
        await user.api('GET', url, { project }),
      )
      ids.push(...page.items.map((item) => item.id))
      cursor = page.nextCursor
    } while (cursor)
    return ids
  }

  describe('построитель фильтра', () => {
    it('«(этап = Новий лід И создана раньше даты) ИЛИ ответственный пуст» — те же строки, что прямой SQL; архивные скрыты', async () => {
      const pipeline = await createPipeline(projectA)
      const [lead, call] = pipeline.stages as [string, string]
      const cutoff = '2026-10-01T00:00:00.000Z'
      const old = '2026-09-01T10:00:00.000Z'
      const fresh = '2026-11-01T10:00:00.000Z'
      await seed(projectA, pipeline, [
        { stage: lead, createdAt: old },
        { stage: lead, createdAt: old },
        { stage: lead, createdAt: fresh },
        { stage: call, createdAt: old },
        { stage: call, createdAt: fresh, owner: null },
        { stage: lead, createdAt: old, archived: true },
        { stage: call, createdAt: fresh, owner: null, archived: true },
        { stage: lead, createdAt: old, deleted: true },
      ])
      const filter: FilterGroup = {
        or: [
          {
            and: [
              { field: 'pipeline', op: 'eq', value: pipeline.id },
              { field: 'stage', op: 'eq', value: lead },
              { field: 'createdAt', op: 'lt', value: cutoff },
            ],
          },
          {
            and: [
              { field: 'pipeline', op: 'eq', value: pipeline.id },
              { field: 'owner', op: 'empty' },
            ],
          },
        ],
      }
      const viaApi = await allPages(
        admin,
        `/v1/deals?status=any&archived=any&limit=2&filter=${q(filter)}`,
      )
      const direct = await sql<{ id: string }>`
        select id from deal
        where project_id = ${projectA} and deleted_at is null and archived_at is null
          and pipeline_id = ${pipeline.id}
          and ((stage_id = ${lead} and created_at < ${cutoff}::timestamptz) or owner_id is null)
      `.execute(h.owner)
      expect(direct.rows).toHaveLength(3)
      expect([...viaApi].sort()).toEqual(direct.rows.map((r) => r.id).sort())

      // С условием «архив = да» — только архивные.
      const archived = await allPages(
        admin,
        `/v1/deals?status=any&archived=any&filter=${q({
          and: [
            { field: 'pipeline', op: 'eq', value: pipeline.id },
            { field: 'archived', op: 'eq', value: true },
          ],
        })}`,
      )
      expect(archived).toHaveLength(2)

      // Счётчик — по тем же условиям.
      const count = await json<ListCount>(
        await admin.api('GET', `/v1/deals/count?status=any&archived=any&filter=${q(filter)}`, {
          project: projectA,
        }),
      )
      expect(count).toEqual({ count: 3, approximate: false })

      // Канбан принимает тот же фильтр: агрегаты колонки «Новий лід» — только старые.
      const aggregates = await json<{ stages: { stageId: string; count: number }[] }>(
        await admin.api(
          'GET',
          `/v1/pipelines/${pipeline.id}/aggregates?filter=${q({
            and: [{ field: 'createdAt', op: 'lt', value: cutoff }],
          })}`,
          { project: projectA },
        ),
      )
      expect(aggregates.stages.find((s) => s.stageId === lead)?.count).toBe(2)
    })

    it('только параметризованный SQL: имя поля из запроса не доходит до базы, значение — параметр', async () => {
      const injected = "x'); drop table deal; --"
      const compiled = h.appDb
        .selectFrom('deal')
        .select('deal.id')
        .where(
          compileFilter(
            'deals',
            {
              or: [
                { field: 'title', op: 'contains', value: injected },
                { field: 'owner', op: 'in', value: [injected] },
                { field: 'createdAt', op: 'lt', value: '2026-01-01T00:00:00Z' },
              ],
            },
            { actorId: 'me-id' },
          ),
        )
        .compile()
      expect(compiled.sql).not.toContain('drop table')
      expect(compiled.sql).toMatch(/\$1/)
      expect(compiled.parameters).toContain(`%${injected}%`)

      // Каждое поле каждого списка с каждым своим оператором: значение — только в параметрах,
      // в тексте SQL его нет. Строки — с попыткой вставки SQL (поле-пользователь пропускает
      // любую строку до 100 символов).
      const tables = { deals: 'deal', contacts: 'contact', organizations: 'organization' } as const
      const seen = new Set<FilterOperator>()
      let n = 0
      const scalar = (spec: FilterFieldSpec): string | number | boolean => {
        n += 1
        switch (spec.type) {
          case 'id':
            return randomUUID()
          case 'user':
            return `${injected} u${n}`
          case 'enum':
            return spec.values?.at(-1) ?? ''
          case 'number':
            return 4242.5 + n
          case 'date':
            return `2026-03-04T05:06:${String(n % 60).padStart(2, '0')}Z`
          case 'text':
            return `${injected} t${n}`
          case 'boolean':
            return true
        }
      }
      for (const entity of FILTER_ENTITIES) {
        const fields: Record<string, FilterFieldSpec> = FILTER_FIELDS[entity]
        for (const [field, spec] of Object.entries(fields)) {
          for (const op of operatorsOf(spec)) {
            seen.add(op)
            const one = scalar(spec)
            const values = op === 'in' || op === 'not_in' ? [String(one)] : [one]
            const condition = VALUELESS_OPERATORS.includes(op)
              ? { field, op }
              : { field, op, value: op === 'in' || op === 'not_in' ? values : one }
            const label = `${entity}.${field} ${op}`
            const parsed = parseFilter(entity, { and: [condition] })
            expect(parsed.ok, label).toBe(true)
            if (!parsed.ok) continue
            const { sql: text, parameters } = h.appDb
              .selectFrom(tables[entity])
              .select('id')
              .where(compileFilter(entity, parsed.filter, { actorId: 'me-id' }))
              .compile()
            if (VALUELESS_OPERATORS.includes(op) || spec.type === 'boolean') continue
            const flat = parameters.flatMap((p) => (Array.isArray(p) ? p : [p]))
            for (const value of values) {
              expect(text, label).not.toContain(String(value))
              expect(
                flat.some((p) =>
                  typeof value === 'string' ? String(p).includes(value) : p === value,
                ),
                `${label}: значения нет в параметрах ${JSON.stringify(parameters)}`,
              ).toBe(true)
            }
          }
        }
      }
      expect([...seen].sort()).toEqual([...FILTER_OPERATORS].sort())
      // 'me' у поля-пользователя — id того, кто смотрит, тоже параметром.
      const me = h.appDb
        .selectFrom('deal')
        .select('id')
        .where(
          compileFilter(
            'deals',
            { and: [{ field: 'owner', op: 'eq', value: 'me' }] },
            { actorId: 'viewer-marker' },
          ),
        )
        .compile()
      expect(me.sql).not.toContain('viewer-marker')
      expect(me.parameters).toContain('viewer-marker')

      // Неизвестное поле, оператор не того типа, значение не той формы — 400, без запроса.
      for (const filter of [
        { and: [{ field: 'title; drop table deal', op: 'contains', value: 'x' }] },
        { and: [{ field: 'amount', op: 'contains', value: 'x' }] },
        { and: [{ field: 'stage', op: 'eq', value: "' or 1=1 --" }] },
        { and: [{ field: '__proto__', op: 'eq', value: 'x' }] },
        { and: [], extra: 1 },
      ]) {
        const res = await admin.api('GET', `/v1/deals?filter=${q(filter as FilterGroup)}`, {
          project: projectA,
        })
        expect(res.status, JSON.stringify(filter)).toBe(400)
      }
      const res = await admin.api(
        'GET',
        `/v1/deals?status=any&filter=${q({ and: [{ field: 'title', op: 'contains', value: injected }] })}`,
        { project: projectA },
      )
      expect((await json<DealsPage>(res)).items).toEqual([])
      const table = await sql<{ n: number }>`select count(*)::int as n from deal`.execute(h.owner)
      expect(table.rows[0]?.n).toBeGreaterThan(0)
    })
  })

  describe('сортировка и курсор', () => {
    it('по сумме с равными значениями — все строки ровно по одному разу, в порядке суммы', async () => {
      const pipeline = await createPipeline(projectA)
      const stage = pipeline.stages[0] ?? ''
      const amounts = [100, 100, 100, 50, 50, 200, 100, 100, 0, 0, 0]
      const ids = await seed(
        projectA,
        pipeline,
        amounts.map((amount) => ({ stage, amount })),
      )
      const filter = q({ and: [{ field: 'pipeline', op: 'eq', value: pipeline.id }] })
      for (const direction of ['desc', 'asc'] as const) {
        const seen = await allPages(
          admin,
          `/v1/deals?status=any&archived=any&limit=2&sort=amount:${direction}&filter=${filter}`,
        )
        expect(seen).toHaveLength(ids.length)
        expect(new Set(seen).size).toBe(ids.length)
        expect([...seen].sort()).toEqual([...ids].sort())
        const byId = new Map(ids.map((id, i) => [id, amounts[i] ?? 0]))
        const values = seen.map((id) => byId.get(id) ?? 0)
        const sorted = [...values].sort((a, b) => (direction === 'desc' ? b - a : a - b))
        expect(values).toEqual(sorted)
      }
      // Курсор другой сортировки и неизвестная колонка — 400.
      const first = await json<DealsPage>(
        await admin.api('GET', `/v1/deals?status=any&limit=2&sort=amount:desc&filter=${filter}`, {
          project: projectA,
        }),
      )
      const wrong = await admin.api(
        'GET',
        `/v1/deals?status=any&limit=2&sort=title:asc&cursor=${first.nextCursor ?? ''}`,
        { project: projectA },
      )
      expect(wrong.status).toBe(400)
      expect(
        (await admin.api('GET', '/v1/deals?sort=owner:asc', { project: projectA })).status,
      ).toBe(400)
    })
  })

  describe('охват и права', () => {
    it('менеджер «свои» видит в списке только свои сделки и общую очередь', async () => {
      const pipeline = await createPipeline(projectA)
      const stage = pipeline.stages[0] ?? ''
      const [mine, queue, theirs] = await seed(projectA, pipeline, [
        { stage, owner: manager.id },
        { stage, owner: null },
        { stage, owner: colleague.id },
      ])
      const filter = q({ and: [{ field: 'pipeline', op: 'eq', value: pipeline.id }] })
      const seen = await allPages(manager, `/v1/deals?status=any&archived=any&filter=${filter}`)
      expect(seen.sort()).toEqual([mine, queue].sort())
      expect(seen).not.toContain(theirs)
      const count = await json<ListCount>(
        await manager.api('GET', `/v1/deals/count?status=any&archived=any&filter=${filter}`, {
          project: projectA,
        }),
      )
      expect(count.count).toBe(2)
    })

    it('сохранённые фильтры: менеджеру для проекта — 403, тимлиду для проекта — 403, для своей команды — да', async () => {
      const filter: FilterGroup = { and: [{ field: 'owner', op: 'eq', value: 'me' }] }
      const save = (user: SignedInUser, body: Record<string, unknown>, project = projectA) =>
        user.api('POST', '/v1/saved-filters', {
          project,
          body: { entity: 'deals', name: 'Мої', filter, ...body },
        })

      expect((await save(manager, { visibility: 'project' })).status).toBe(403)
      expect((await save(manager, { visibility: 'team' })).status).toBe(403)
      const personal = await json<SavedFilterSummary>(
        await save(manager, { visibility: 'personal' }),
        201,
      )
      expect(personal).toMatchObject({ visibility: 'personal', teamId: null, canDelete: true })

      expect((await save(teamlead, { visibility: 'project' })).status).toBe(403)
      const team = await json<SavedFilterSummary>(
        await save(teamlead, { visibility: 'team', name: 'Команда' }),
        201,
      )
      expect(team).toMatchObject({ visibility: 'team', teamId })
      // Чужую команду тимлид не выбирает.
      expect((await save(teamlead, { visibility: 'team', teamId: randomUUID() })).status).toBe(403)

      const shared = await json<SavedFilterSummary>(
        await save(admin, { visibility: 'project', name: 'Для всіх' }),
        201,
      )

      const list = async (user: SignedInUser, project = projectA) =>
        (
          await json<SavedFilterSummary[]>(
            await user.api('GET', '/v1/saved-filters?entity=deals', { project }),
          )
        ).map((f) => f.id)
      // Участник команды видит фильтр команды, менеджер вне команды — нет; личный — только автор.
      expect(await list(teamMember)).toEqual(expect.arrayContaining([team.id, shared.id]))
      expect(await list(teamMember)).not.toContain(personal.id)
      expect(await list(colleague)).toEqual([shared.id])
      // Участник другой команды того же проекта фильтр этой команды тоже не видит.
      expect(await list(otherTeamMember)).toEqual([shared.id])
      expect(await list(manager)).toEqual(expect.arrayContaining([personal.id, shared.id]))
      // Удалить чужой фильтр нельзя: не видно — 404, виден — 403.
      expect(
        (await colleague.api('DELETE', `/v1/saved-filters/${personal.id}`, { project: projectA }))
          .status,
      ).toBe(404)
      expect(
        (await colleague.api('DELETE', `/v1/saved-filters/${shared.id}`, { project: projectA }))
          .status,
      ).toBe(403)
      // Неверный фильтр не сохраняется.
      expect(
        (await save(manager, { visibility: 'personal', filter: { and: [{ field: 'x' }] } })).status,
      ).toBe(400)
      expect(
        (await manager.api('DELETE', `/v1/saved-filters/${personal.id}`, { project: projectA }))
          .status,
      ).toBe(204)
    })

    it('право «общие фильтры» — в шаблонах руководителя и тимлида, у менеджера нет', () => {
      const standalone = (key: string) =>
        ROLE_TEMPLATES.find((t) => t.key === key)?.permissions.standalone ?? []
      expect(standalone('head')).toContain('shared_filters')
      expect(standalone('teamlead')).toContain('shared_filters')
      expect(standalone('manager')).not.toContain('shared_filters')
    })
  })

  describe('изоляция проектов', () => {
    it('список, счётчик и сохранённые фильтры проекта A не показывают записей B; фильтр A не виден в B', async () => {
      const pipelineB = await createPipeline(projectB)
      const [inB] = await seed(projectB, pipelineB, [{ stage: pipelineB.stages[0] ?? '' }])
      const fromA = await allPages(admin, '/v1/deals?status=any&archived=any&limit=200')
      expect(fromA).not.toContain(inB)
      const bFilter = q({ and: [{ field: 'pipeline', op: 'eq', value: pipelineB.id }] })
      const count = await json<ListCount>(
        await admin.api('GET', `/v1/deals/count?status=any&archived=any&filter=${bFilter}`, {
          project: projectA,
        }),
      )
      expect(count.count).toBe(0)

      const saved = await json<SavedFilterSummary>(
        await admin.api('POST', '/v1/saved-filters', {
          project: projectA,
          body: { entity: 'deals', name: 'Тільки А', visibility: 'project', filter: { and: [] } },
        }),
        201,
      )
      const inProjectB = await json<SavedFilterSummary[]>(
        await admin.api('GET', '/v1/saved-filters?entity=deals', { project: projectB }),
      )
      expect(inProjectB.map((f) => f.id)).not.toContain(saved.id)
      expect(
        (await admin.api('DELETE', `/v1/saved-filters/${saved.id}`, { project: projectB })).status,
      ).toBe(404)

      // Организации и контакты проекта B — тоже не видны.
      await h.owner
        .insertInto('organization')
        .values({ project_id: projectB, name: 'Організація Б' })
        .execute()
      const orgs = await allPages(admin, '/v1/organizations/list?limit=200')
      const orgNames = await h.owner
        .selectFrom('organization')
        .select('id')
        .where('project_id', '=', projectB)
        .execute()
      for (const { id } of orgNames) expect(orgs).not.toContain(id)
    })
  })

  describe('контакты и организации', () => {
    it('список контактов: фильтр по имени, охват «свои», сортировка с курсором', async () => {
      const created = await manager.api('POST', '/v1/contacts', {
        project: projectA,
        body: { firstName: 'Зоряна', lastName: 'Вигадана', phones: ['+380671112233'] },
      })
      const own = await json<{ id: string }>(created, 201)
      const others = await h.owner
        .insertInto('contact')
        .values({ project_id: projectA, first_name: 'Зоряна', last_name: 'Чужа' })
        .returning('id')
        .executeTakeFirstOrThrow()
      const filter = q({ and: [{ field: 'name', op: 'contains', value: 'зоряна' }] })
      const asManager = await json<ContactListPage>(
        await manager.api('GET', `/v1/contacts/list?filter=${filter}`, { project: projectA }),
      )
      expect(asManager.items.map((c) => c.id)).toEqual([own.id])
      expect(asManager.items[0]?.phone).toBe('+380671112233')
      const asAdmin = await allPages(
        admin,
        `/v1/contacts/list?limit=1&sort=name:asc&filter=${filter}`,
      )
      expect(asAdmin.sort()).toEqual([own.id, others.id].sort())
    })

    it('список организаций: сортировка по названию, курсор без повторов', async () => {
      await h.owner
        .insertInto('organization')
        .values(['Гамма', 'Альфа', 'Бета', 'Альфа'].map((name) => ({ project_id: projectA, name })))
        .execute()
      const ids = await allPages(admin, '/v1/organizations/list?limit=1&sort=name:asc')
      expect(new Set(ids).size).toBe(ids.length)
      const page = await json<OrganizationListPage>(
        await admin.api('GET', '/v1/organizations/list?limit=200&sort=name:asc', {
          project: projectA,
        }),
      )
      const names = page.items.map((o) => o.name)
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
    })
  })
})
