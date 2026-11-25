import { randomUUID } from 'node:crypto'
import { type FilterGroup, ROLE_TEMPLATES, type RolePermissions } from '@alpi/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import type { BulkAction } from '../bulk/registry.ts'
import type { BulkJobDetails, BulkJobSummary } from '../bulk/routes.ts'
import { type BulkJobMessage, runBulkJob } from '../bulk/runner.ts'
import { type ApiHarness, type SignedInUser, startApiHarness } from '../testing/api-harness.ts'
import { purgeTrash } from '../trash/purge.ts'
import { TRASH_PURGERS } from '../trash/purgers.ts'
import type { TrashPage } from '../trash/routes.ts'
import { archiveDeals, DEAL_BULK_REGISTRY } from './bulk.ts'

// Массовые действия, выгрузка CSV и корзина списка сделок (тикет crm-deals/12) на настоящем
// PostgreSQL. Массовую операцию запускает API, выполняет обработчик каркаса тикета 04
// (runBulkJob) — тем же подключением ролью приложения, что и pg-boss в работе.

describe('массовые действия, выгрузка, корзина', () => {
  let h: ApiHarness
  let app: ReturnType<typeof createApp>
  let admin: SignedInUser
  let manager: SignedInUser
  let colleague: SignedInUser
  let projectA: string
  let projectB: string
  let counter = 0
  const queued: BulkJobMessage[] = []
  /** Сколько записей было обработано к началу каждой записи: прогресс по порциям. */
  const progress = new Set<number>()

  const probedArchive: BulkAction = {
    ...archiveDeals,
    async apply(trx, id, ctx) {
      const job = await trx
        .selectFrom('bulk_job')
        .select('processed')
        .where('id', '=', ctx.bulkJobId)
        .executeTakeFirstOrThrow()
      progress.add(job.processed)
      return archiveDeals.apply(trx, id, ctx)
    },
  }
  const actions = new Map<string, BulkAction>([
    ...DEAL_BULK_REGISTRY,
    ['deals.archive', probedArchive],
  ])

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_list_actions')
    app = createApp({
      auth: h.auth,
      db: h.appDb,
      bulk: {
        actions,
        enqueue: async (_trx, message) => {
          queued.push(message)
        },
      },
    })
    admin = await h.signIn('owner')
    projectA = (await h.createProject(admin, 'Дії А')).id
    projectB = (await h.createProject(admin, 'Дії Б')).id
    manager = await h.signIn()
    colleague = await h.signIn()
    await h.addMember(projectA, manager.id, 'manager')
    await h.addMember(projectA, colleague.id, 'manager')
  })

  afterAll(async () => {
    await h?.stop()
  })

  /** Участник с ролью шаблона `template`, где охват сделок и отдельные права заменены. */
  async function memberWithRole(
    template: 'head' | 'teamlead' | 'manager',
    scope: { read: 'own' | 'all'; write: 'own' | 'all' },
    standalone: RolePermissions['standalone'],
  ) {
    const user = await h.signIn()
    const base = ROLE_TEMPLATES.find((t) => t.key === template)?.permissions
    if (!base) throw new Error(`нет шаблона ${template}`)
    const permissions = {
      ...base,
      scopes: { ...base.scopes, deals: scope, contacts: scope },
      standalone,
    }
    const role = await h.owner
      .insertInto('role')
      .values({
        project_id: projectA,
        name: `${template}-${randomUUID().slice(0, 8)}`,
        permissions: JSON.stringify(permissions),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await h.owner
      .insertInto('project_member')
      .values({ project_id: projectA, user_id: user.id, role_id: role.id })
      .execute()
    return user
  }

  async function createPipeline(projectId: string) {
    counter += 1
    const { id } = await h.owner
      .insertInto('pipeline')
      .values({
        project_id: projectId,
        code: `a${counter}`,
        name: `Воронка ${counter}`,
        position: counter,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const stages: string[] = []
    for (const [index, name] of ['Новий лід', 'Дзвінок'].entries()) {
      const stage = await h.owner
        .insertInto('stage')
        .values({ project_id: projectId, pipeline_id: id, name, position: index + 1 })
        .returning('id')
        .executeTakeFirstOrThrow()
      stages.push(stage.id)
    }
    return { id, lead: stages[0] ?? '', call: stages[1] ?? '' }
  }

  /** `count` сделок одной вставкой (у каждой свой контакт); id по порядку вставки. */
  async function seed(
    projectId: string,
    deal: {
      pipeline: string
      stage: string
      owner: string | null
      createdAt?: string
      title?: string
    },
    count = 1,
  ): Promise<string[]> {
    const contacts = await h.owner
      .insertInto('contact')
      .values(
        Array.from({ length: count }, () => {
          counter += 1
          return { project_id: projectId, first_name: `Клієнт${counter}`, last_name: 'Вигаданий' }
        }),
      )
      .returning('id')
      .execute()
    const rows = await h.owner
      .insertInto('deal')
      .values(
        contacts.map((contact, index) => ({
          project_id: projectId,
          title: deal.title ?? `Угода ${counter}-${index}`,
          pipeline_id: deal.pipeline,
          stage_id: deal.stage,
          owner_id: deal.owner,
          primary_contact_id: contact.id,
          created_at: deal.createdAt ?? new Date().toISOString(),
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

  const call = (
    user: SignedInUser,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    project = projectA,
  ) => user.call(app, method, path, { project, ...(body === undefined ? {} : { body }) })

  describe('массовые действия', () => {
    it('2 000 сделок «Новий лід» по фильтру архивируются порциями; сделка вне охвата не тронута и в журнале', async () => {
      // Инициатор видит все сделки, менять может только свои.
      const initiator = await memberWithRole('head', { read: 'all', write: 'own' }, [
        'bulk_operations',
      ])
      const pipeline = await createPipeline(projectA)
      const old = '2026-09-01T00:00:00.000Z'
      const mine = await seed(
        projectA,
        { pipeline: pipeline.id, stage: pipeline.lead, owner: initiator.id, createdAt: old },
        2000,
      )
      const [foreign] = await seed(projectA, {
        pipeline: pipeline.id,
        stage: pipeline.lead,
        owner: colleague.id,
        createdAt: old,
      })
      // Свежая сделка и сделка на другом этапе под фильтр не попадают.
      const [fresh] = await seed(projectA, {
        pipeline: pipeline.id,
        stage: pipeline.lead,
        owner: initiator.id,
      })
      const [called] = await seed(projectA, {
        pipeline: pipeline.id,
        stage: pipeline.call,
        owner: initiator.id,
        createdAt: old,
      })
      const filter: FilterGroup = {
        and: [
          { field: 'stage', op: 'eq', value: pipeline.lead },
          { field: 'createdAt', op: 'lt', value: '2026-10-01T00:00:00.000Z' },
        ],
      }
      const started = await json<BulkJobSummary>(
        await call(initiator, 'POST', '/v1/bulk-jobs', {
          action: 'deals.archive',
          selection: { filter },
        }),
        202,
      )
      const message = queued.find((m) => m.bulkJobId === started.id)
      expect(message).toBeDefined()
      progress.clear()
      await runBulkJob(h.appDb, actions, message as BulkJobMessage, { batchSize: 500 })

      const job = await json<BulkJobDetails>(
        await call(initiator, 'GET', `/v1/bulk-jobs/${started.id}`),
      )
      expect(job).toMatchObject({ status: 'done', total: 2001, processed: 2001, failed: 1 })
      expect(job.errors).toEqual([
        expect.objectContaining({ recordId: foreign, code: 'OUT_OF_SCOPE' }),
      ])
      // Прогресс фиксировался по порциям: каждая порция видела обработанные предыдущими.
      expect([...progress].sort((a, b) => a - b)).toEqual([0, 500, 1000, 1500, 2000])

      const archived = await h.owner
        .selectFrom('deal')
        .select(['id', 'archived_at'])
        .where('pipeline_id', '=', pipeline.id)
        .execute()
      const byId = new Map(archived.map((row) => [row.id, row.archived_at]))
      expect(mine.every((id) => byId.get(id) !== null)).toBe(true)
      expect(byId.get(foreign ?? '')).toBeNull()
      expect(byId.get(fresh ?? '')).toBeNull()
      expect(byId.get(called ?? '')).toBeNull()
      // История «было → стало» у архивированной сделки.
      const history = await h.owner
        .selectFrom('change_log')
        .select('field')
        .where('entity_id', '=', mine[0] ?? '')
        .execute()
      expect(history.map((r) => r.field)).toEqual(['archivedAt'])
    }, 120_000)

    it('без «массовых операций» — 403; передача требует ещё и «передачу сделок»', async () => {
      const pipeline = await createPipeline(projectA)
      const [deal] = await seed(projectA, {
        pipeline: pipeline.id,
        stage: pipeline.lead,
        owner: manager.id,
      })
      const archive = { action: 'deals.archive', selection: { ids: [deal] } }
      expect((await call(manager, 'POST', '/v1/bulk-jobs', archive)).status).toBe(403)
      const bulkOnly = await memberWithRole('head', { read: 'all', write: 'all' }, [
        'bulk_operations',
      ])
      const assign = {
        action: 'deals.assign',
        selection: { ids: [deal] },
        params: { ownerId: null },
      }
      expect((await call(bulkOnly, 'POST', '/v1/bulk-jobs', assign)).status).toBe(403)
      const both = await memberWithRole('head', { read: 'all', write: 'all' }, [
        'bulk_operations',
        'transfer_deals',
      ])
      expect((await call(both, 'POST', '/v1/bulk-jobs', assign)).status).toBe(202)
      // Неверный фильтр — 400 при запуске.
      const bad = {
        action: 'deals.archive',
        selection: { filter: { and: [{ field: 'nope', op: 'eq', value: 1 }] } },
      }
      expect((await call(both, 'POST', '/v1/bulk-jobs', bad)).status).toBe(400)
    })

    it('возврат из архива проверяет «одну открытую сделку»: конфликт — в журнале, сделка в архиве', async () => {
      const initiator = await memberWithRole('head', { read: 'all', write: 'all' }, [
        'bulk_operations',
      ])
      const pipeline = await createPipeline(projectA)
      const [archived] = await seed(projectA, {
        pipeline: pipeline.id,
        stage: pipeline.lead,
        owner: initiator.id,
      })
      await h.owner
        .updateTable('deal')
        .set({ archived_at: new Date() })
        .where('id', '=', archived ?? '')
        .execute()
      const contact = await h.owner
        .selectFrom('deal')
        .select('primary_contact_id')
        .where('id', '=', archived ?? '')
        .executeTakeFirstOrThrow()
      const open = await h.owner
        .insertInto('deal')
        .values({
          project_id: projectA,
          title: 'Відкрита',
          pipeline_id: pipeline.id,
          stage_id: pipeline.lead,
          owner_id: initiator.id,
          primary_contact_id: contact.primary_contact_id,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const started = await json<BulkJobSummary>(
        await call(initiator, 'POST', '/v1/bulk-jobs', {
          action: 'deals.unarchive',
          selection: { ids: [archived] },
        }),
        202,
      )
      await runBulkJob(
        h.appDb,
        actions,
        queued.find((m) => m.bulkJobId === started.id) as BulkJobMessage,
      )
      const job = await json<BulkJobDetails>(
        await call(initiator, 'GET', `/v1/bulk-jobs/${started.id}`),
      )
      expect(job.errors).toEqual([
        expect.objectContaining({ recordId: archived, code: 'OPEN_DEAL_EXISTS' }),
      ])
      expect(job.errors[0]?.message).toContain(open.id)
      const row = await h.owner
        .selectFrom('deal')
        .select('archived_at')
        .where('id', '=', archived ?? '')
        .executeTakeFirstOrThrow()
      expect(row.archived_at).not.toBeNull()
    })

    it('смена этапа — только в пределах воронки; удаление в корзину — с правом «удалять»', async () => {
      const initiator = await memberWithRole('head', { read: 'all', write: 'all' }, [
        'bulk_operations',
      ])
      const pipeline = await createPipeline(projectA)
      const other = await createPipeline(projectA)
      const [a, b] = await seed(
        projectA,
        { pipeline: pipeline.id, stage: pipeline.lead, owner: initiator.id },
        2,
      )
      const [c] = await seed(projectA, {
        pipeline: other.id,
        stage: other.lead,
        owner: initiator.id,
      })
      const started = await json<BulkJobSummary>(
        await call(initiator, 'POST', '/v1/bulk-jobs', {
          action: 'deals.stage',
          selection: { ids: [a, b, c] },
          params: { stageId: pipeline.call },
        }),
        202,
      )
      await runBulkJob(
        h.appDb,
        actions,
        queued.find((m) => m.bulkJobId === started.id) as BulkJobMessage,
      )
      const job = await json<BulkJobDetails>(
        await call(initiator, 'GET', `/v1/bulk-jobs/${started.id}`),
      )
      expect(job.errors).toEqual([
        expect.objectContaining({ recordId: c, code: 'STAGE_NOT_IN_PIPELINE' }),
      ])
      const stages = await h.owner
        .selectFrom('deal')
        .select(['id', 'stage_id'])
        .where('id', 'in', [a ?? '', b ?? '', c ?? ''])
        .execute()
      expect(new Map(stages.map((s) => [s.id, s.stage_id]))).toEqual(
        new Map([
          [a, pipeline.call],
          [b, pipeline.call],
          [c, other.lead],
        ]),
      )

      const trash = await json<BulkJobSummary>(
        await call(initiator, 'POST', '/v1/bulk-jobs', {
          action: 'deals.trash',
          selection: { ids: [a] },
        }),
        202,
      )
      await runBulkJob(
        h.appDb,
        actions,
        queued.find((m) => m.bulkJobId === trash.id) as BulkJobMessage,
      )
      const deleted = await h.owner
        .selectFrom('deal')
        .select('deleted_by')
        .where('id', '=', a ?? '')
        .executeTakeFirstOrThrow()
      expect(deleted.deleted_by).toBe(initiator.id)
    })

    it('удаление в корзину без права «сделки: удалять» — 403, сделка не в корзине', async () => {
      // Тимлид: «сделки» — смотреть, создавать, изменять, но не удалять.
      const editor = await memberWithRole('teamlead', { read: 'all', write: 'all' }, [
        'bulk_operations',
      ])
      const pipeline = await createPipeline(projectA)
      const [deal] = await seed(projectA, {
        pipeline: pipeline.id,
        stage: pipeline.lead,
        owner: editor.id,
      })
      const before = queued.length
      const res = await call(editor, 'POST', '/v1/bulk-jobs', {
        action: 'deals.trash',
        selection: { ids: [deal] },
      })
      expect(res.status, await res.text()).toBe(403)
      expect(queued).toHaveLength(before)
      // То же право «изменять» пропускает массовую смену этапа: отказ — именно из-за «удалять».
      await json<BulkJobSummary>(
        await call(editor, 'POST', '/v1/bulk-jobs', {
          action: 'deals.stage',
          selection: { ids: [deal] },
          params: { stageId: pipeline.call },
        }),
        202,
      )
      const row = await h.owner
        .selectFrom('deal')
        .select('deleted_at')
        .where('id', '=', deal ?? '')
        .executeTakeFirstOrThrow()
      expect(row.deleted_at).toBeNull()
    })
  })

  describe('выгрузка CSV', () => {
    it('только записи в охвате, UTF-8 с BOM, выгрузка записана в журнал; без права — 403', async () => {
      const pipeline = await createPipeline(projectA)
      const exporter = await memberWithRole('manager', { read: 'own', write: 'own' }, ['export'])
      await seed(projectA, {
        pipeline: pipeline.id,
        stage: pipeline.lead,
        owner: exporter.id,
        title: '=HYPERLINK("x"), «моя»',
      })
      await seed(projectA, {
        pipeline: pipeline.id,
        stage: pipeline.lead,
        owner: colleague.id,
        title: 'Чужа угода',
      })
      await seed(projectA, {
        pipeline: pipeline.id,
        stage: pipeline.lead,
        owner: null,
        title: 'Черга',
      })
      const filter = encodeURIComponent(
        JSON.stringify({ and: [{ field: 'pipeline', op: 'eq', value: pipeline.id }] }),
      )
      const path = `/v1/deals/export.csv?status=any&archived=any&columns=title,owner,stage&filter=${filter}`

      expect((await call(manager, 'GET', path)).status).toBe(403)

      const res = await call(exporter, 'GET', path)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8')
      const bytes = new Uint8Array(await res.arrayBuffer())
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
      const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
      const lines = text.slice(1).trimEnd().split('\r\n')
      expect(lines[0]).toBe('Назва,Відповідальний,Етап')
      expect(lines.slice(1).sort()).toEqual(
        [
          `"'=HYPERLINK(""x""), «моя»",Користувач,Новий лід`,
          'Черга,Без відповідального,Новий лід',
        ].sort(),
      )
      expect(text).not.toContain('Чужа угода')

      const audit = await h.owner
        .selectFrom('audit_log')
        .select(['action', 'actor_id', 'details'])
        .where('project_id', '=', projectA)
        .where('action', '=', 'export.downloaded')
        .execute()
      expect(audit).toEqual([
        expect.objectContaining({
          actor_id: exporter.id,
          details: expect.objectContaining({ list: 'deals', columns: ['title', 'owner', 'stage'] }),
        }),
      ])

      // Контакты и организации: то же право.
      expect((await call(manager, 'GET', '/v1/contacts/export.csv')).status).toBe(403)
      expect((await call(manager, 'GET', '/v1/organizations/export.csv')).status).toBe(403)
      const contacts = await call(admin, 'GET', '/v1/contacts/export.csv?columns=name,phone')
      expect(contacts.status).toBe(200)
      const contactsText = new TextDecoder('utf-8', { ignoreBOM: true }).decode(
        await contacts.arrayBuffer(),
      )
      expect(contactsText.startsWith("\uFEFFІм'я,Телефон\r\n")).toBe(true)
    })

    it('выгрузка проекта A не содержит записей B; больше одной порции — без пропусков', async () => {
      const pipelineB = await createPipeline(projectB)
      await seed(projectB, {
        pipeline: pipelineB.id,
        stage: pipelineB.lead,
        owner: null,
        title: 'Угода проєкту Б',
      })
      const pipeline = await createPipeline(projectA)
      await seed(projectA, { pipeline: pipeline.id, stage: pipeline.lead, owner: null }, 1203)
      const res = await call(
        admin,
        'GET',
        '/v1/deals/export.csv?status=any&archived=any&columns=title',
      )
      const text = await res.text()
      expect(text).not.toContain('Угода проєкту Б')
      const { n } = await h.owner
        .selectFrom('deal')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('project_id', '=', projectA)
        .where('deleted_at', 'is', null)
        .executeTakeFirstOrThrow()
      expect(text.trimEnd().split('\r\n')).toHaveLength(Number(n) + 1)
    })
  })

  describe('корзина', () => {
    it('восстановление, нарушающее «одну открытую сделку», отклоняется с подсказкой', async () => {
      const pipeline = await createPipeline(projectA)
      const [first] = await seed(projectA, {
        pipeline: pipeline.id,
        stage: pipeline.lead,
        owner: admin.id,
      })
      expect((await call(admin, 'DELETE', `/v1/deals/${first}`)).status).toBe(204)
      const contact = await h.owner
        .selectFrom('deal')
        .select('primary_contact_id')
        .where('id', '=', first ?? '')
        .executeTakeFirstOrThrow()
      const second = await h.owner
        .insertInto('deal')
        .values({
          project_id: projectA,
          title: 'Друга',
          pipeline_id: pipeline.id,
          stage_id: pipeline.lead,
          owner_id: admin.id,
          primary_contact_id: contact.primary_contact_id,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const trash = await json<TrashPage>(await call(admin, 'GET', '/v1/trash?type=deal'))
      const item = trash.data.find((i) => i.id === first)
      expect(item).toBeDefined()
      expect(
        new Date(item?.purgeAt ?? '').getTime() - new Date(item?.deletedAt ?? '').getTime(),
      ).toBe(30 * 24 * 60 * 60 * 1000)
      const refused = await json<{ code: string; details: { dealId?: string } }>(
        await call(admin, 'POST', `/v1/deals/${first}/restore`),
        409,
      )
      expect(refused).toMatchObject({ code: 'OPEN_DEAL_EXISTS', details: { dealId: second.id } })
    })

    it('корзина: охват и изоляция; запись старше 30 дней исчезает после задачи по расписанию', async () => {
      const pipeline = await createPipeline(projectA)
      const head = await memberWithRole('head', { read: 'own', write: 'own' }, [])
      const [own, foreign, old] = await seed(
        projectA,
        { pipeline: pipeline.id, stage: pipeline.lead, owner: head.id },
        3,
      )
      await h.owner
        .updateTable('deal')
        .set({ owner_id: colleague.id })
        .where('id', '=', foreign ?? '')
        .execute()
      const now = Date.now()
      await h.owner
        .updateTable('deal')
        .set({ deleted_at: new Date(now - 60_000) })
        .where('id', 'in', [own ?? '', foreign ?? ''])
        .execute()
      await h.owner
        .updateTable('deal')
        .set({ deleted_at: new Date(now - 31 * 24 * 60 * 60 * 1000) })
        .where('id', '=', old ?? '')
        .execute()
      const oldContact = await h.owner
        .selectFrom('deal')
        .select('primary_contact_id')
        .where('id', '=', old ?? '')
        .executeTakeFirstOrThrow()
      await h.owner
        .updateTable('contact')
        .set({ deleted_at: new Date(now - 31 * 24 * 60 * 60 * 1000) })
        .where('id', '=', oldContact.primary_contact_id)
        .execute()
      const org = await h.owner
        .insertInto('organization')
        .values({
          project_id: projectA,
          name: 'Стара',
          deleted_at: new Date(now - 40 * 24 * 60 * 60 * 1000),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const pipelineB = await createPipeline(projectB)
      const [inB] = await seed(projectB, {
        pipeline: pipelineB.id,
        stage: pipelineB.lead,
        owner: null,
      })
      await h.owner
        .updateTable('deal')
        .set({ deleted_at: new Date() })
        .where('id', '=', inB ?? '')
        .execute()

      const seenByHead = (
        await json<TrashPage>(await call(head, 'GET', '/v1/trash?type=deal'))
      ).data.map((i) => i.id)
      expect(seenByHead).toContain(own)
      expect(seenByHead).not.toContain(foreign)
      const seenByAdmin = (
        await json<TrashPage>(await call(admin, 'GET', '/v1/trash?type=deal&limit=200'))
      ).data.map((i) => i.id)
      expect(seenByAdmin).toEqual(expect.arrayContaining([own, foreign, old]))
      expect(seenByAdmin).not.toContain(inB)
      // Без права «корзина: смотреть» — 403.
      expect((await call(manager, 'GET', '/v1/trash?type=deal')).status).toBe(403)
      expect((await call(admin, 'GET', '/v1/trash?type=nope')).status).toBe(400)

      await purgeTrash(h.appDb, TRASH_PURGERS, new Date(now))
      const left = await h.owner
        .selectFrom('deal')
        .select('id')
        .where('id', 'in', [own ?? '', foreign ?? '', old ?? ''])
        .execute()
      expect(left.map((r) => r.id).sort()).toEqual([own, foreign].sort())
      const contactLeft = await h.owner
        .selectFrom('contact')
        .select('id')
        .where('id', '=', oldContact.primary_contact_id)
        .execute()
      expect(contactLeft).toEqual([])
      const orgLeft = await h.owner
        .selectFrom('organization')
        .select('id')
        .where('id', '=', org.id)
        .execute()
      expect(orgLeft).toEqual([])
      // Сделка проекта B (удалена только что) не тронута.
      expect(
        await h.owner
          .selectFrom('deal')
          .select('id')
          .where('id', '=', inB ?? '')
          .execute(),
      ).toHaveLength(1)
    })

    it('окончательное удаление сделки — право «корзина: удалять», запись в журнале', async () => {
      const pipeline = await createPipeline(projectA)
      const [deal] = await seed(projectA, {
        pipeline: pipeline.id,
        stage: pipeline.lead,
        owner: admin.id,
      })
      expect((await call(admin, 'DELETE', `/v1/deals/${deal}/permanent`)).status).toBe(409)
      expect((await call(admin, 'DELETE', `/v1/deals/${deal}`)).status).toBe(204)
      // Руководитель: «корзина» — смотреть и восстанавливать, но не удалять.
      const head = await memberWithRole('head', { read: 'all', write: 'all' }, [])
      expect((await call(head, 'DELETE', `/v1/deals/${deal}/permanent`)).status).toBe(403)
      expect((await call(admin, 'DELETE', `/v1/deals/${deal}/permanent`)).status).toBe(204)
      expect(
        await h.owner
          .selectFrom('deal')
          .select('id')
          .where('id', '=', deal ?? '')
          .execute(),
      ).toEqual([])
      const audit = await h.owner
        .selectFrom('audit_log')
        .select('entity_id')
        .where('action', '=', 'deal.purged')
        .execute()
      expect(audit.map((a) => a.entity_id)).toContain(deal)
    })
  })
})
