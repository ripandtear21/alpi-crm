import { withProject } from '@alpi/db'
import type {
  LostReasonGroupSummary,
  LostReasonSummary,
  PipelineSummary,
  RoleSummary,
  StageSummary,
} from '@alpi/shared'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { type ApiHarness, type SignedInUser, startApiHarness } from '../testing/api-harness.ts'
import { problemOf } from '../testing/problem.ts'
import type { StageDealsChecker } from './stage-deals.ts'

// Воронки, этапы и причины проигрыша (тикет crm-deals/02) — на настоящем PostgreSQL, API ходит
// ролью приложения. Маршруты /v1/... — это /api/v1/... снаружи: префикс /api снимает прокси.

describe('воронки, этапы и причины проигрыша', () => {
  let h: ApiHarness
  let admin: SignedInUser
  let projectA: string
  let projectB: string

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_pipelines')
    admin = await h.signIn('owner')
    projectA = (await h.createProject(admin, 'Воронки А')).id
    projectB = (await h.createProject(admin, 'Воронки Б')).id
  })

  afterAll(async () => {
    await h?.stop()
  })

  type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'
  const as =
    (user: SignedInUser, project: string) => (method: Method, path: string, body?: unknown) =>
      user.api(method, `/v1${path}`, { project, ...(body === undefined ? {} : { body }) })

  async function json<T>(res: Response, status = 200): Promise<T> {
    const text = await res.text()
    expect(res.status, text).toBe(status)
    return (text === '' ? null : JSON.parse(text)) as T
  }

  let codeCounter = 0
  async function createPipeline(
    project: string,
    input: { name?: string; code?: string; isUpsell?: boolean; stages?: string[] } = {},
  ): Promise<PipelineSummary> {
    const call = as(admin, project)
    codeCounter += 1
    const pipeline = await json<PipelineSummary>(
      await call('POST', '/pipelines', {
        name: input.name ?? `Воронка ${codeCounter}`,
        code: input.code ?? `p${codeCounter}`,
        ...(input.isUpsell === undefined ? {} : { isUpsell: input.isUpsell }),
      }),
      201,
    )
    for (const name of input.stages ?? []) {
      await json<StageSummary>(
        await call('POST', `/pipelines/${pipeline.id}/stages`, { name }),
        201,
      )
    }
    return pipeline
  }

  async function stagesOf(project: string, pipelineId: string): Promise<StageSummary[]> {
    return json<StageSummary[]>(await as(admin, project)('GET', `/pipelines/${pipelineId}/stages`))
  }

  async function createGroup(project: string, name: string, reasons: string[] = []) {
    const call = as(admin, project)
    const group = await json<LostReasonGroupSummary>(
      await call('POST', '/lost-reasons/groups', { name }),
      201,
    )
    for (const reason of reasons) {
      await json<LostReasonSummary>(
        await call('POST', '/lost-reasons', { groupId: group.id, name: reason }),
        201,
      )
    }
    return group
  }

  /** Участник проекта с ролью из `permissions` (своя роль, создаётся администратором). */
  async function memberWith(project: string, permissions: unknown): Promise<SignedInUser> {
    const role = await json<RoleSummary>(
      await admin.api('POST', '/roles', {
        project,
        body: { name: `Роль ${Math.random().toString(36).slice(2, 8)}`, permissions },
      }),
      201,
    )
    const user = await h.signIn()
    await h.owner
      .insertInto('project_member')
      .values({ project_id: project, user_id: user.id, role_id: role.id })
      .execute()
    return user
  }

  describe('изоляция проектов', () => {
    it('строки проекта A не видны в контексте B без фильтра в коде; запись в чужой проект отклоняет политика', async () => {
      const a = await createPipeline(projectA, { stages: ['Етап А'] })
      await createGroup(projectA, 'Група А', ['Причина А'])
      const b = await createPipeline(projectB, { stages: ['Етап Б'] })
      await createGroup(projectB, 'Група Б', ['Причина Б'])

      const seen = await withProject(h.appDb, projectB, async (trx) => ({
        pipelines: (await sql<{ project_id: string }>`select * from pipeline`.execute(trx)).rows,
        stages: (await sql<{ project_id: string }>`select * from stage`.execute(trx)).rows,
        groups: (await sql<{ project_id: string }>`select * from lost_reason_group`.execute(trx))
          .rows,
        reasons: (await sql<{ project_id: string }>`select * from lost_reason`.execute(trx)).rows,
      }))
      for (const rows of Object.values(seen)) {
        expect(rows.length).toBeGreaterThan(0)
        expect(rows.every((row) => row.project_id === projectB)).toBe(true)
      }

      // Запись в чужой проект: и прямая вставка, и этап в чужую воронку.
      await expect(
        withProject(h.appDb, projectB, (trx) =>
          trx
            .insertInto('pipeline')
            .values({ project_id: projectA, code: 'foreign', name: 'Чужа' })
            .execute(),
        ),
      ).rejects.toThrow(/row-level security/)
      await expect(
        withProject(h.appDb, projectB, (trx) =>
          trx
            .insertInto('stage')
            .values({ project_id: projectB, pipeline_id: a.id, name: 'Чужий етап' })
            .execute(),
        ),
      ).rejects.toThrow(/stage_project_id_pipeline_id_fkey/)

      // Через API: чужая воронка — как несуществующая.
      const listB = await json<PipelineSummary[]>(await as(admin, projectB)('GET', '/pipelines'))
      expect(listB.map((p) => p.id)).toContain(b.id)
      expect(listB.map((p) => p.id)).not.toContain(a.id)
      expect((await as(admin, projectB)('GET', `/pipelines/${a.id}/stages`)).status).toBe(404)
      expect(
        (await as(admin, projectB)('PUT', `/pipelines/${a.id}`, { name: 'Захоплено' })).status,
      ).toBe(404)
      const reasonsB = await json<LostReasonGroupSummary[]>(
        await as(admin, projectB)('GET', '/lost-reasons'),
      )
      expect(reasonsB.map((g) => g.name)).not.toContain('Група А')
    })
  })

  describe('права', () => {
    it('без права «сделки: смотреть» списки — 403', async () => {
      const nobody = await memberWith(projectA, {})
      const call = as(nobody, projectA)
      const pipeline = await createPipeline(projectA)
      expect((await call('GET', '/pipelines')).status).toBe(403)
      expect((await call('GET', `/pipelines/${pipeline.id}/stages`)).status).toBe(403)
      expect((await call('GET', '/lost-reasons')).status).toBe(403)
    })

    it('без права «воронки и этапы» создание, изменение и удаление — 403; менеджер по шаблону читает', async () => {
      const manager = await h.signIn()
      await h.addMember(projectA, manager.id, 'manager')
      const call = as(manager, projectA)
      const pipeline = await createPipeline(projectA, { stages: ['Перший'] })
      const [stage] = await stagesOf(projectA, pipeline.id)
      const group = await createGroup(projectA, `Група ${pipeline.code}`, ['Причина'])
      const [reason] =
        (
          await json<LostReasonGroupSummary[]>(await as(admin, projectA)('GET', '/lost-reasons'))
        ).find((g) => g.id === group.id)?.reasons ?? []

      expect((await call('GET', '/pipelines')).status).toBe(200)
      expect((await call('GET', `/pipelines/${pipeline.id}/stages`)).status).toBe(200)
      expect((await call('GET', '/lost-reasons')).status).toBe(200)

      const attempts: [Method, string, unknown?][] = [
        ['POST', '/pipelines', { name: 'Нова', code: 'manager-new' }],
        ['PUT', `/pipelines/${pipeline.id}`, { name: 'Інша' }],
        ['PUT', `/pipelines/${pipeline.id}`, { archived: true }],
        ['PUT', '/pipelines/order', { ids: [pipeline.id] }],
        ['POST', `/pipelines/${pipeline.id}/stages`, { name: 'Ще' }],
        ['PUT', `/pipelines/${pipeline.id}/stages/${stage?.id}`, { name: 'Ще' }],
        ['PUT', `/pipelines/${pipeline.id}/stages/order`, { ids: [stage?.id] }],
        ['DELETE', `/pipelines/${pipeline.id}/stages/${stage?.id}`],
        ['POST', '/lost-reasons/groups', { name: 'Ще' }],
        ['PUT', `/lost-reasons/groups/${group.id}`, { archived: true }],
        ['PUT', '/lost-reasons/groups/order', { ids: [group.id] }],
        ['PUT', `/lost-reasons/groups/${group.id}/order`, { ids: [reason?.id] }],
        ['POST', '/lost-reasons', { groupId: group.id, name: 'Ще' }],
        ['PUT', `/lost-reasons/${reason?.id}`, { archived: true }],
      ]
      for (const [method, path, body] of attempts) {
        const res = await call(method, path, body)
        expect(res.status, `${method} ${path}`).toBe(403)
        expect(await problemOf(res)).toEqual({ code: 'PERMISSION_DENIED' })
      }
      expect(await stagesOf(projectA, pipeline.id)).toHaveLength(1)
    })

    it('право «воронки и этапы» без роли администратора — достаточно для изменений', async () => {
      const editor = await memberWith(projectA, {
        actions: { deals: ['view'], pipelines: ['view', 'create', 'edit', 'delete'] },
      })
      const call = as(editor, projectA)
      const created = await json<PipelineSummary>(
        await call('POST', '/pipelines', { name: 'Редактора', code: 'editor' }),
        201,
      )
      await json(await call('PUT', `/pipelines/${created.id}`, { name: 'Редактора 2' }))
    })
  })

  describe('воронки', () => {
    it('создание пишет журнал проекта той же транзакцией', async () => {
      const pipeline = await createPipeline(projectA, { name: 'З журналом', code: 'audited' })
      const rows = await h.owner
        .selectFrom('audit_log')
        .select(['action', 'actor_id', 'details'])
        .where('project_id', '=', projectA)
        .where('entity_id', '=', pipeline.id)
        .execute()
      expect(rows).toEqual([
        {
          action: 'pipeline.created',
          actor_id: admin.id,
          details: { after: { name: 'З журналом', code: 'audited', isUpsell: false } },
        },
      ])
    })

    it('второй code воронки в проекте отклоняется; в другом проекте — можно', async () => {
      await createPipeline(projectA, { code: 'dup' })
      const again = await as(admin, projectA)('POST', '/pipelines', { name: 'Дубль', code: 'dup' })
      expect(again.status).toBe(409)
      expect(await problemOf(again)).toEqual({ code: 'PIPELINE_CODE_TAKEN' })
      await createPipeline(projectB, { code: 'dup' })

      const other = await createPipeline(projectA, { code: 'dup-2' })
      const renamed = await as(admin, projectA)('PUT', `/pipelines/${other.id}`, { code: 'dup' })
      expect(renamed.status).toBe(409)
      expect(await problemOf(renamed)).toEqual({ code: 'PIPELINE_CODE_TAKEN' })
    })

    it('код — только латиница', async () => {
      for (const code of ['Альфа', 'ALPI', '1abc', '', 'a b']) {
        const res = await as(admin, projectA)('POST', '/pipelines', { name: 'Код', code })
        expect(res.status, code).toBe(400)
      }
    })

    it('вторая «воронка допродаж» отклоняется — и при создании, и при изменении', async () => {
      const project = (await h.createProject(admin, 'Допродаж')).id
      const upsell = await createPipeline(project, { code: 'upsell', isUpsell: true })
      expect(upsell.isUpsell).toBe(true)
      const second = await as(admin, project)('POST', '/pipelines', {
        name: 'Ще одна',
        code: 'upsell-2',
        isUpsell: true,
      })
      expect(second.status).toBe(409)
      expect(await problemOf(second)).toEqual({ code: 'UPSELL_PIPELINE_EXISTS' })

      const plain = await createPipeline(project, { code: 'plain' })
      const marked = await as(admin, project)('PUT', `/pipelines/${plain.id}`, { isUpsell: true })
      expect(marked.status).toBe(409)
      expect(await problemOf(marked)).toEqual({ code: 'UPSELL_PIPELINE_EXISTS' })

      // Снять отметку с одной и поставить другой — можно.
      await json(await as(admin, project)('PUT', `/pipelines/${upsell.id}`, { isUpsell: false }))
      const moved = await json<PipelineSummary>(
        await as(admin, project)('PUT', `/pipelines/${plain.id}`, { isUpsell: true }),
      )
      expect(moved.isUpsell).toBe(true)
    })

    it('архив и возврат из архива; порядок воронок', async () => {
      const project = (await h.createProject(admin, 'Порядок')).id
      const first = await createPipeline(project, { code: 'first' })
      const second = await createPipeline(project, { code: 'second' })
      const archived = await json<PipelineSummary>(
        await as(admin, project)('PUT', `/pipelines/${first.id}`, { archived: true }),
      )
      expect(archived.archivedAt).not.toBeNull()

      const reordered = await json<PipelineSummary[]>(
        await as(admin, project)('PUT', '/pipelines/order', { ids: [second.id, first.id] }),
      )
      expect(reordered.map((p) => p.code)).toEqual(['second', 'first'])
      expect(reordered.map((p) => p.position)).toEqual([1, 2])

      const bad = await as(admin, project)('PUT', '/pipelines/order', { ids: [second.id] })
      expect(bad.status).toBe(400)
      expect(await problemOf(bad)).toEqual({ code: 'INVALID_ORDER' })

      const restored = await json<PipelineSummary>(
        await as(admin, project)('PUT', `/pipelines/${first.id}`, { archived: false }),
      )
      expect(restored.archivedAt).toBeNull()
    })
  })

  describe('этапы', () => {
    it('порядок этапов меняется одним запросом; новый этап — в конец', async () => {
      const pipeline = await createPipeline(projectA, { stages: ['Один', 'Два', 'Три'] })
      const stages = await stagesOf(projectA, pipeline.id)
      expect(stages.map((s) => [s.name, s.position])).toEqual([
        ['Один', 1],
        ['Два', 2],
        ['Три', 3],
      ])
      const [one, two, three] = stages.map((s) => s.id)
      const reordered = await json<StageSummary[]>(
        await as(admin, projectA)('PUT', `/pipelines/${pipeline.id}/stages/order`, {
          ids: [three, one, two],
        }),
      )
      expect(reordered.map((s) => s.name)).toEqual(['Три', 'Один', 'Два'])

      const renamed = await json<StageSummary>(
        await as(admin, projectA)('PUT', `/pipelines/${pipeline.id}/stages/${one}`, {
          name: 'Перший',
        }),
      )
      expect(renamed.name).toBe('Перший')
    })

    it('удаление этапа вызывает проверку открытых сделок и отказывает, если заглушка вернула «есть»', async () => {
      const pipeline = await createPipeline(projectA, { stages: ['Зайнятий', 'Вільний'] })
      const [busy, free] = await stagesOf(projectA, pipeline.id)
      const asked: string[] = []
      const withDeals: StageDealsChecker = {
        async hasOpenDeals(_db, stageId) {
          asked.push(stageId)
          return true
        },
      }
      const app = createApp({ auth: h.auth, db: h.appDb, stageDeals: withDeals })
      const refused = await admin.call(
        app,
        'DELETE',
        `/v1/pipelines/${pipeline.id}/stages/${busy?.id}`,
        { project: projectA },
      )
      expect(refused.status).toBe(409)
      expect(await problemOf(refused)).toEqual({ code: 'STAGE_HAS_OPEN_DEALS' })
      expect(asked).toEqual([busy?.id])
      expect((await stagesOf(projectA, pipeline.id)).map((s) => s.id)).toEqual([busy?.id, free?.id])

      // Проверка по умолчанию (таблица deal): сделок нет — этап уходит из списка, строка остаётся.
      const deleted = await as(admin, projectA)(
        'DELETE',
        `/pipelines/${pipeline.id}/stages/${free?.id}`,
      )
      expect(deleted.status).toBe(204)
      expect((await stagesOf(projectA, pipeline.id)).map((s) => s.id)).toEqual([busy?.id])
      const row = await h.owner
        .selectFrom('stage')
        .select('deleted_at')
        .where('id', '=', free?.id ?? '')
        .executeTakeFirstOrThrow()
      expect(row.deleted_at).not.toBeNull()
      const again = await as(admin, projectA)(
        'DELETE',
        `/pipelines/${pipeline.id}/stages/${free?.id}`,
      )
      expect(again.status).toBe(404)
    })
  })

  describe('причины проигрыша', () => {
    it('группа → причина, порядок, архив; дубль названия отклоняется', async () => {
      const project = (await h.createProject(admin, 'Причини')).id
      const call = as(admin, project)
      const group = await createGroup(project, 'Якість', ['Не дозвон', 'Не актуально'])
      const dup = await call('POST', '/lost-reasons', { groupId: group.id, name: 'Не дозвон' })
      expect(dup.status).toBe(409)
      expect(await problemOf(dup)).toEqual({ code: 'LOST_REASON_NAME_TAKEN' })
      const dupGroup = await call('POST', '/lost-reasons/groups', { name: 'Якість' })
      expect(dupGroup.status).toBe(409)
      expect(await problemOf(dupGroup)).toEqual({ code: 'LOST_REASON_GROUP_NAME_TAKEN' })

      let [listed] = await json<LostReasonGroupSummary[]>(await call('GET', '/lost-reasons'))
      const [first, second] = listed?.reasons ?? []
      await json(
        await call('PUT', `/lost-reasons/groups/${group.id}/order`, {
          ids: [second?.id, first?.id],
        }),
      )
      const archived = await json<LostReasonSummary>(
        await call('PUT', `/lost-reasons/${first?.id}`, { archived: true }),
      )
      expect(archived.archivedAt).not.toBeNull()

      ;[listed] = await json<LostReasonGroupSummary[]>(await call('GET', '/lost-reasons'))
      expect(listed?.reasons.map((r) => [r.name, r.archivedAt === null])).toEqual([
        ['Не актуально', true],
        ['Не дозвон', false],
      ])

      const other = await createGroup(project, 'Інше')
      await json(await call('PUT', '/lost-reasons/groups/order', { ids: [other.id, group.id] }))
      const groups = await json<LostReasonGroupSummary[]>(await call('GET', '/lost-reasons'))
      expect(groups.map((g) => g.name)).toEqual(['Інше', 'Якість'])
    })
  })
})
