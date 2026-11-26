import { randomUUID } from 'node:crypto'
import {
  type FieldDefinitionSummary,
  type FieldGroupSummary,
  fullPermissions,
  type RolePermissions,
} from '@alpi/shared'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { entityReader } from '../fields/common.ts'
import { apiKeyAuth, apiKeyRoute } from '../middleware/api-key.ts'
import type { PermissionsEnv } from '../middleware/permissions.ts'
import { projectContext } from '../middleware/project-context.ts'
import { type ApiHarness, type SignedInUser, startApiHarness } from '../testing/api-harness.ts'
import { createApiKey, createRole, type KeyClient } from '../testing/api-key.ts'
import { problemOf, requiredErrors } from '../testing/problem.ts'
import type { DealView } from './store.ts'

// Запросы сделок по ключу API (тикет crm-api/03) на настоящем PostgreSQL, API ходит ролью
// приложения: изоляция проекта, права и охват роли ключа, «передача сделок», ADR 0003,
// обязательные поля, «одна открытая сделка», скрытые поля, автор-ключ в истории, журнале и
// событиях, закрытые для ключа маршруты, описание OpenAPI. Названия и имена — выдуманные.

/** Полные права, кроме того, что меняет `change`. */
function permissions(change: (p: RolePermissions) => void = () => {}): RolePermissions {
  const p = fullPermissions()
  change(p)
  return p
}

interface Pipeline {
  id: string
  stages: string[]
}

describe('запросы сделок по ключу API', () => {
  let h: ApiHarness
  let admin: SignedInUser
  let manager: SignedInUser
  let disabledMember: SignedInUser
  let memberB: SignedInUser
  let projectA: string
  let projectB: string
  let main: Pipeline
  let other: Pipeline
  let pipelineB: Pipeline
  let reason: string
  let archivedReason: string
  let reasonB: string
  let organizationB: string
  let contactB: string
  let dealB: string
  let openGroup: FieldGroupSummary
  let hiddenField: FieldDefinitionSummary
  let readField: FieldDefinitionSummary
  /** Ключи проекта A: все права; без «передачи сделок»; только смотреть; охват «свои»; поля. */
  let full: KeyClient
  let noTransfer: KeyClient
  let viewOnly: KeyClient
  let own: KeyClient
  let limitedFields: KeyClient
  /** Ключ проекта B со всеми правами. */
  let keyB: KeyClient
  let counter = 0

  async function json<T>(res: Response, status = 200): Promise<T> {
    const text = await res.text()
    expect(res.status, text).toBe(status)
    return JSON.parse(text) as T
  }

  async function createPipeline(projectId: string, stages: string[]): Promise<Pipeline> {
    const n = ++counter
    const { id } = await h.owner
      .insertInto('pipeline')
      .values({ project_id: projectId, code: `api${n}`, name: `Воронка ${n}`, position: n })
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
    return { id, stages: ids }
  }

  async function createReason(projectId: string, archived = false): Promise<string> {
    const n = ++counter
    const group = await h.owner
      .insertInto('lost_reason_group')
      .values({ project_id: projectId, name: `Група ${n}`, position: n })
      .returning('id')
      .executeTakeFirstOrThrow()
    const { id } = await h.owner
      .insertInto('lost_reason')
      .values({
        project_id: projectId,
        group_id: group.id,
        name: `Причина ${n}`,
        archived_at: archived ? new Date() : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return id
  }

  async function createContact(projectId = projectA): Promise<string> {
    const { id } = await h.owner
      .insertInto('contact')
      .values({ project_id: projectId, first_name: `Клієнт ${++counter}` })
      .returning('id')
      .executeTakeFirstOrThrow()
    return id
  }

  /** Сделка в обход API (как старая запись): по умолчанию — в main на первом этапе, без ответственного. */
  async function seedDeal(
    options: {
      projectId?: string
      pipeline?: Pipeline
      stage?: number
      owner?: string | null
      contact?: string
      status?: 'open' | 'won' | 'lost'
      archived?: boolean
      custom?: Record<string, unknown>
    } = {},
  ): Promise<string> {
    const pipeline = options.pipeline ?? main
    const { id } = await h.owner
      .insertInto('deal')
      .values({
        project_id: options.projectId ?? projectA,
        title: `Угода ${++counter}`,
        pipeline_id: pipeline.id,
        stage_id: pipeline.stages[options.stage ?? 0] ?? '',
        primary_contact_id: options.contact ?? (await createContact(options.projectId)),
        owner_id: options.owner ?? null,
        status: options.status ?? 'open',
        won_at: options.status === 'won' ? new Date() : null,
        lost_at: options.status === 'lost' ? new Date() : null,
        lost_reason_id: options.status === 'lost' ? reason : null,
        archived_at: options.archived ? new Date() : null,
        custom: JSON.stringify(options.custom ?? {}),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return id
  }

  async function dealRow(id: string) {
    return h.owner
      .selectFrom('deal')
      .select(['stage_id', 'pipeline_id', 'status', 'amount', 'owner_id', 'archived_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  }

  async function adminCall<T>(path: string, body: unknown, status = 201): Promise<T> {
    return json<T>(await admin.api('POST', `/v1${path}`, { project: projectA, body }), status)
  }

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_deals_api_key')
    admin = await h.signIn('owner')
    manager = await h.signIn()
    disabledMember = await h.signIn()
    memberB = await h.signIn()
    projectA = (await h.createProject(admin, 'Проєкт А')).id
    projectB = (await h.createProject(admin, 'Проєкт Б')).id
    await h.addMember(projectA, manager.id)
    await h.addMember(projectA, disabledMember.id)
    await h.owner
      .updateTable('project_member')
      .set({ disabled_at: new Date() })
      .where('project_id', '=', projectA)
      .where('user_id', '=', disabledMember.id)
      .execute()
    await h.addMember(projectB, memberB.id)

    main = await createPipeline(projectA, ['Новий', 'Дзвінок', 'Рішення'])
    other = await createPipeline(projectA, ['Інший новий', 'Інше рішення'])
    pipelineB = await createPipeline(projectB, ['Б новий'])
    reason = await createReason(projectA)
    archivedReason = await createReason(projectA, true)
    reasonB = await createReason(projectB)
    contactB = await createContact(projectB)
    organizationB = (
      await h.owner
        .insertInto('organization')
        .values({ project_id: projectB, name: 'Організація Б' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
    dealB = await seedDeal({ projectId: projectB, pipeline: pipelineB, owner: memberB.id })

    // Поля сделок проекта A: «budget» — с этапа «Рішення» воронки main, «contract» — при
    // выигрыше в main, «curator» — пользователь; скрытая группа и группа «только чтение».
    openGroup = await adminCall<FieldGroupSummary>('/field-groups', {
      entity: 'deal',
      nameUk: 'Відкрита',
    })
    const field = (group: FieldGroupSummary, code: string, input: Record<string, unknown> = {}) =>
      adminCall<FieldDefinitionSummary>('/fields', {
        groupId: group.id,
        nameUk: `Поле ${code}`,
        code,
        type: 'text',
        ...input,
      })
    await field(openGroup, 'budget', {
      required: { mode: 'stages', stages: [{ pipelineId: main.id, stageId: main.stages[2] }] },
    })
    await field(openGroup, 'contract', {
      required: { mode: 'stages', stages: [{ pipelineId: main.id, stageId: null }] },
    })
    await field(openGroup, 'curator', { type: 'user' })
    const hiddenGroup = await adminCall<FieldGroupSummary>('/field-groups', {
      entity: 'deal',
      nameUk: 'Таємна',
    })
    hiddenField = await field(hiddenGroup, 'secret_note')
    const readGroup = await adminCall<FieldGroupSummary>('/field-groups', {
      entity: 'deal',
      nameUk: 'Лише читання',
    })
    readField = await field(readGroup, 'read_note')

    const key = async (projectId: string, p: RolePermissions) =>
      createApiKey(h, admin, projectId, await createRole(h, projectId, p))
    full = await key(projectA, permissions())
    noTransfer = await key(
      projectA,
      permissions((p) => {
        p.standalone = p.standalone.filter((s) => s !== 'transfer_deals')
      }),
    )
    viewOnly = await key(
      projectA,
      permissions((p) => {
        p.actions.deals = ['view']
      }),
    )
    own = await key(
      projectA,
      permissions((p) => {
        p.scopes.deals = { read: 'own', write: 'own' }
      }),
    )
    limitedFields = await key(
      projectA,
      permissions((p) => {
        p.fieldGroups = { [hiddenGroup.id]: 'hidden', [readGroup.id]: 'read' }
      }),
    )
    keyB = await key(projectB, permissions())
  })

  afterAll(async () => {
    await h?.stop()
  })

  describe('изоляция проектов', () => {
    it('ключ проекта B не читает и не меняет сделку проекта A — 404; список B без сделок A', async () => {
      const dealA = await seedDeal()
      expect((await keyB.api('GET', `/v1/deals/${dealA}`)).status).toBe(404)
      expect(
        (await keyB.api('PATCH', `/v1/deals/${dealA}`, { body: { title: 'Злам' } })).status,
      ).toBe(404)
      for (const [action, body] of [
        ['stage', { stageId: main.stages[1] }],
        ['win', {}],
        ['lose', { lostReasonId: reasonB }],
        ['reopen', {}],
        ['archive', {}],
        ['unarchive', {}],
        ['move', { pipelineId: pipelineB.id }],
        ['owner', { ownerId: null }],
      ] as const) {
        const res = await keyB.api('POST', `/v1/deals/${dealA}/${action}`, { body })
        expect([action, res.status]).toEqual([action, 404])
      }
      const page = await json<{ data: { id: string }[] }>(
        await keyB.api('GET', '/v1/deals?status=any&archived=any&limit=200'),
      )
      expect(page.data.map((d) => d.id)).toEqual([dealB])
      expect(await dealRow(dealA)).toMatchObject({ stage_id: main.stages[0], status: 'open' })
    })

    it('ключ проекта A не ставит этап, воронку, причину, контакт, организацию и ответственного из проекта B', async () => {
      const contact = await createContact()
      const create = (body: Record<string, unknown>) =>
        full.api('POST', '/v1/deals', {
          body: { title: 'Чужі посилання', pipelineId: main.id, contactId: contact, ...body },
        })
      const refused = async (res: Response, status: number, code: string) =>
        expect({ status: res.status, code: (await problemOf(res)).code }).toEqual({ status, code })

      await refused(await create({ pipelineId: pipelineB.id }), 404, 'PIPELINE_NOT_FOUND')
      await refused(await create({ stageId: pipelineB.stages[0] }), 404, 'STAGE_NOT_FOUND')
      await refused(await create({ contactId: contactB }), 404, 'CONTACT_NOT_FOUND')
      await refused(await create({ organizationId: organizationB }), 404, 'ORGANIZATION_NOT_FOUND')
      await refused(await create({ ownerId: memberB.id }), 422, 'OWNER_NOT_MEMBER')

      const deal = await seedDeal()
      const action = (name: string, body: Record<string, unknown>) =>
        full.api('POST', `/v1/deals/${deal}/${name}`, { body })
      await refused(await action('stage', { stageId: pipelineB.stages[0] }), 404, 'STAGE_NOT_FOUND')
      await refused(await action('move', { pipelineId: pipelineB.id }), 404, 'PIPELINE_NOT_FOUND')
      await refused(await action('lose', { lostReasonId: reasonB }), 422, 'LOST_REASON_NOT_FOUND')
      await refused(
        await action('lose', { lostReasonId: archivedReason }),
        422,
        'LOST_REASON_ARCHIVED',
      )
      await refused(await action('lose', {}), 422, 'LOST_REASON_REQUIRED')
      await refused(await action('owner', { ownerId: memberB.id }), 422, 'OWNER_NOT_MEMBER')
      await refused(
        await full.api('PATCH', `/v1/deals/${deal}`, { body: { organizationId: organizationB } }),
        404,
        'ORGANIZATION_NOT_FOUND',
      )
      expect(await dealRow(deal)).toMatchObject({
        stage_id: main.stages[0],
        pipeline_id: main.id,
        status: 'open',
        owner_id: null,
      })
      expect(
        await h.owner
          .selectFrom('deal')
          .select('id')
          .where('title', '=', 'Чужі посилання')
          .execute(),
      ).toEqual([])
    })
  })

  describe('права и охват роли ключа', () => {
    it('без «сделки: изменять» и «создавать» — 403 на каждое изменяющее действие; читать можно', async () => {
      const deal = await seedDeal()
      expect((await viewOnly.api('GET', `/v1/deals/${deal}`)).status).toBe(200)
      const attempts: [string, Response][] = [
        [
          'create',
          await viewOnly.api('POST', '/v1/deals', {
            body: { title: 'Ні', pipelineId: main.id, contactId: await createContact() },
          }),
        ],
        ['patch', await viewOnly.api('PATCH', `/v1/deals/${deal}`, { body: { amount: 5 } })],
      ]
      for (const [action, body] of [
        ['stage', { stageId: main.stages[1] }],
        ['win', {}],
        ['lose', { lostReasonId: reason }],
        ['reopen', {}],
        ['archive', {}],
        ['unarchive', {}],
        ['move', { pipelineId: other.id }],
        ['owner', { ownerId: manager.id }],
      ] as const) {
        attempts.push([action, await viewOnly.api('POST', `/v1/deals/${deal}/${action}`, { body })])
      }
      for (const [action, res] of attempts) {
        expect([action, res.status, (await problemOf(res)).code]).toEqual([
          action,
          403,
          'PERMISSION_DENIED',
        ])
      }
      expect(await dealRow(deal)).toMatchObject({ stage_id: main.stages[0], status: 'open' })
    })

    it('охват «свои»: ключ видит и меняет только сделки общей очереди', async () => {
      const queue = await seedDeal()
      const owned = await seedDeal({ owner: admin.id })
      const page = await json<{ data: { id: string }[] }>(
        await own.api('GET', `/v1/deals?pipeline=${main.id}&status=any&archived=any&limit=200`),
      )
      const ids = page.data.map((d) => d.id)
      expect(ids).toContain(queue)
      expect(ids).not.toContain(owned)
      expect(page.data.every((d) => (d as { ownerId?: unknown }).ownerId === null)).toBe(true)
      expect((await own.api('GET', `/v1/deals/${owned}`)).status).toBe(404)
      expect(
        (await own.api('POST', `/v1/deals/${owned}/stage`, { body: { stageId: main.stages[1] } }))
          .status,
      ).toBe(404)
      expect(
        (await own.api('POST', `/v1/deals/${queue}/stage`, { body: { stageId: main.stages[1] } }))
          .status,
      ).toBe(200)
      // Ответственного ключ с охватом «свои» назначить не может: его охват — только очередь.
      const assign = await own.api('POST', `/v1/deals/${queue}/owner`, {
        body: { ownerId: manager.id },
      })
      expect(assign.status).toBe(403)
    })

    it('назначить, сменить и снять ответственного — только с «передачей сделок», в том числе на сделке очереди', async () => {
      const queue = await seedDeal()
      const owned = await seedDeal({ owner: admin.id })
      for (const [deal, ownerId] of [
        [queue, manager.id],
        [owned, manager.id],
        [owned, null],
      ] as const) {
        const res = await noTransfer.api('POST', `/v1/deals/${deal}/owner`, { body: { ownerId } })
        expect({ status: res.status, body: await problemOf(res) }).toEqual({
          status: 403,
          body: { code: 'PERMISSION_DENIED' },
        })
      }
      const created = await noTransfer.api('POST', '/v1/deals', {
        body: {
          title: 'З відповідальним',
          pipelineId: main.id,
          contactId: await createContact(),
          ownerId: manager.id,
        },
      })
      expect(created.status).toBe(403)
      expect((await dealRow(queue)).owner_id).toBeNull()
      expect((await dealRow(owned)).owner_id).toBe(admin.id)

      // Без ответственного (по умолчанию у ключа) — сделка в общей очереди, право не нужно.
      const queued = await json<DealView>(
        await noTransfer.api('POST', '/v1/deals', {
          body: { title: 'У черзі', pipelineId: main.id, contactId: await createContact() },
        }),
        201,
      )
      expect(queued.ownerId).toBeNull()

      // С правом: назначить на сделку очереди, сменить, снять; неактивный участник — 422.
      const assigned = await json<DealView>(
        await full.api('POST', `/v1/deals/${queue}/owner`, { body: { ownerId: manager.id } }),
      )
      expect(assigned.ownerId).toBe(manager.id)
      const changed = await json<DealView>(
        await full.api('POST', `/v1/deals/${queue}/owner`, { body: { ownerId: admin.id } }),
      )
      expect(changed.ownerId).toBe(admin.id)
      const removed = await json<DealView>(
        await full.api('POST', `/v1/deals/${queue}/owner`, { body: { ownerId: null } }),
      )
      expect(removed.ownerId).toBeNull()
      const disabled = await full.api('POST', `/v1/deals/${queue}/owner`, {
        body: { ownerId: disabledMember.id },
      })
      expect({ status: disabled.status, body: await problemOf(disabled) }).toEqual({
        status: 422,
        body: { code: 'OWNER_NOT_MEMBER' },
      })
    })
  })

  describe('действия ключом: автор-ключ в истории, журнале и событиях', () => {
    async function keyChanges(entityId: string): Promise<string[]> {
      const rows = await h.owner
        .selectFrom('change_log')
        .select(['field', 'actor_id', 'actor_api_key_id'])
        .where('entity_id', '=', entityId)
        .execute()
      for (const row of rows) {
        expect(row).toMatchObject({ actor_id: null, actor_api_key_id: full.id })
      }
      return rows.map((r) => r.field)
    }

    it('каждое действие из списка проходит по ключу и пишет в change_log автора-ключ, в audit_log — запрос ключа', async () => {
      const created = await json<DealView>(
        await full.api('POST', '/v1/deals', {
          body: {
            title: 'Від автоматизації',
            pipelineId: main.id,
            contact: { firstName: 'Новий клієнт', phones: ['+380671112233'] },
            amount: 100,
            currency: 'UAH',
            custom: { budget: 'великий' },
          },
          headers: { 'Idempotency-Key': randomUUID() },
        }),
        201,
      )
      expect(created).toMatchObject({
        title: 'Від автоматизації',
        stageId: main.stages[0],
        ownerId: null,
        amount: 100,
        currency: 'UAH',
        createdBy: null,
      })
      const id = created.id
      const steps: [string, string, Record<string, unknown>, Record<string, unknown>][] = [
        [
          'PATCH',
          '',
          { title: 'Нова назва', expectedCloseDate: '2026-12-31' },
          { title: 'Нова назва' },
        ],
        ['POST', '/stage', { stageId: main.stages[1] }, { stageId: main.stages[1] }],
        ['POST', '/owner', { ownerId: manager.id }, { ownerId: manager.id }],
        ['POST', '/lose', { lostReasonId: reason }, { status: 'lost', lostReasonId: reason }],
        ['POST', '/reopen', {}, { status: 'open', lostReasonId: null }],
        ['POST', '/archive', {}, { archivedAt: expect.any(String) }],
        ['POST', '/unarchive', {}, { archivedAt: null }],
        [
          'POST',
          '/move',
          { pipelineId: other.id },
          { pipelineId: other.id, stageId: other.stages[0] },
        ],
        ['POST', '/win', {}, { status: 'won' }],
      ]
      for (const [method, path, body, expected] of steps) {
        const res = await full.api(method as 'POST' | 'PATCH', `/v1/deals/${id}${path}`, { body })
        expect([method, path, res.status]).toEqual([method, path, 200])
        expect(await res.json()).toMatchObject(expected)
      }
      expect(new Set(await keyChanges(id))).toEqual(
        new Set([
          'title',
          'expectedCloseDate',
          'stageId',
          'ownerId',
          'status',
          'lostReasonId',
          'lostAt',
          'archivedAt',
          'pipelineId',
          'wonAt',
        ]),
      )

      // Журнал проекта: каждый изменяющий запрос ключа — api_key.request с автором-ключом.
      const audit = await h.owner
        .selectFrom('audit_log')
        .select(['actor_id', 'actor_api_key_id', 'details'])
        .where('action', '=', 'api_key.request')
        .where('actor_api_key_id', '=', full.id)
        .execute()
      const paths = audit.map((a) => (a.details as { path: string }).path)
      for (const path of [
        '',
        '/stage',
        '/owner',
        '/lose',
        '/reopen',
        '/archive',
        '/unarchive',
        '/move',
        '/win',
      ]) {
        expect(paths).toContain(`/v1/deals/${id}${path}`)
      }
      expect(paths).toContain('/v1/deals')
    })

    it('события запроса по ключу называют автором ключ: deal.created, contact.created, deal.stage_changed', async () => {
      const created = await json<DealView>(
        await full.api('POST', '/v1/deals', {
          body: { title: 'Подія', pipelineId: main.id, contact: { firstName: 'Подієвий' } },
        }),
        201,
      )
      await json(
        await full.api('POST', `/v1/deals/${created.id}/stage`, {
          body: { stageId: main.stages[1] },
        }),
      )
      const events = await h.owner
        .selectFrom('webhook_event')
        .select(['type', 'entity_id', 'actor_type', 'actor_id', 'body'])
        .where('entity_id', 'in', [created.id, created.primaryContactId])
        .execute()
      expect(events.map((e) => e.type).sort()).toEqual([
        'contact.created',
        'deal.created',
        'deal.stage_changed',
      ])
      for (const event of events) {
        expect(event).toMatchObject({ actor_type: 'api_key', actor_id: full.id })
        expect((event.body as { data: { actor: unknown } }).data.actor).toEqual({
          type: 'api_key',
          id: full.id,
        })
      }
      // Новый контакт — тоже от ключа: автор в истории, created_by пуст.
      const contact = await h.owner
        .selectFrom('contact')
        .select('created_by')
        .where('id', '=', created.primaryContactId)
        .executeTakeFirstOrThrow()
      expect(contact.created_by).toBeNull()
    })

    it('удаление, восстановление, «взять в работу», допродажа, участники, строки товаров, история и PUT — 403 API_KEY_NOT_ALLOWED', async () => {
      const deal = await seedDeal({ status: 'won' })
      const lineId = randomUUID()
      const contactId = await createContact()
      const closed: ['GET' | 'POST' | 'PUT' | 'DELETE', string][] = [
        ['DELETE', `/v1/deals/${deal}`],
        ['POST', `/v1/deals/${deal}/restore`],
        ['DELETE', `/v1/deals/${deal}/permanent`],
        ['POST', `/v1/deals/${deal}/take`],
        ['POST', `/v1/deals/${deal}/upsell`],
        ['POST', `/v1/deals/${deal}/participants`],
        ['PUT', `/v1/deals/${deal}/participants/${contactId}`],
        ['DELETE', `/v1/deals/${deal}/participants/${contactId}`],
        ['POST', `/v1/deals/${deal}/products`],
        ['PUT', `/v1/deals/${deal}/products/${lineId}`],
        ['DELETE', `/v1/deals/${deal}/products/${lineId}`],
        ['POST', `/v1/deals/${deal}/apply-products-total`],
        ['GET', `/v1/deals/${deal}/history`],
        ['GET', `/v1/deals/${deal}/timeline`],
        ['PUT', `/v1/deals/${deal}`],
        ['GET', '/v1/deals/owners'],
      ]
      for (const [method, path] of closed) {
        const res = await full.api(method, path, method === 'GET' ? {} : { body: {} })
        expect([method, path, res.status, (await problemOf(res)).code]).toEqual([
          method,
          path,
          403,
          'API_KEY_NOT_ALLOWED',
        ])
      }
      expect(await dealRow(deal)).toMatchObject({ status: 'won', owner_id: null })
    })
  })

  describe('ADR 0003: действие меняет ровно названные поля', () => {
    it('PATCH суммы не меняет этап, статус и ответственного; смена этапа — статус и сумму; выигрыш — этап', async () => {
      const deal = await seedDeal({ owner: manager.id, stage: 1 })
      const patched = await json<DealView>(
        await full.api('PATCH', `/v1/deals/${deal}`, { body: { amount: 990.5 } }),
      )
      expect(patched).toMatchObject({
        amount: 990.5,
        stageId: main.stages[1],
        status: 'open',
        ownerId: manager.id,
      })
      expect(await dealRow(deal)).toMatchObject({
        stage_id: main.stages[1],
        status: 'open',
        owner_id: manager.id,
      })

      const staged = await json<DealView>(
        await full.api('POST', `/v1/deals/${deal}/stage`, { body: { stageId: main.stages[0] } }),
      )
      expect(staged).toMatchObject({ stageId: main.stages[0], status: 'open', amount: 990.5 })

      const won = await json<DealView>(
        await full.api('POST', `/v1/deals/${deal}/win`, {
          body: { custom: { contract: 'так', budget: '1 000' } },
        }),
      )
      expect(won).toMatchObject({ status: 'won', stageId: main.stages[0], amount: 990.5 })
      expect(await dealRow(deal)).toMatchObject({ stage_id: main.stages[0], status: 'won' })
    })

    it('PATCH не меняет этап, статус, ответственного, контакт и архив — 400 на эти поля', async () => {
      const deal = await seedDeal()
      for (const body of [
        { stageId: main.stages[1] },
        { status: 'won' },
        { ownerId: manager.id },
        { primaryContactId: await createContact() },
        { archivedAt: null },
        { pipelineId: other.id },
      ]) {
        const res = await full.api('PATCH', `/v1/deals/${deal}`, { body })
        const [field = ''] = Object.keys(body)
        expect({ status: res.status, code: (await problemOf(res)).code, field }).toEqual({
          status: 400,
          code: 'INVALID_DEAL',
          field,
        })
      }
      expect(await dealRow(deal)).toMatchObject({
        stage_id: main.stages[0],
        status: 'open',
        owner_id: null,
        archived_at: null,
      })
    })
  })

  describe('обязательные поля по ключу', () => {
    it('смена этапа и выигрыш с пустым обязательным полем — 422 со списком в errors, сделка на месте; со значением в том же запросе — проходит', async () => {
      const deal = await seedDeal({ stage: 1 })
      const toStage = await full.api('POST', `/v1/deals/${deal}/stage`, {
        body: { stageId: main.stages[2] },
      })
      expect(toStage.status).toBe(422)
      const stageProblem = await problemOf(toStage)
      expect(stageProblem.code).toBe('STAGE_REQUIREMENTS_MISSING')
      expect(stageProblem.errors).toEqual(requiredErrors('budget'))

      const win = await full.api('POST', `/v1/deals/${deal}/win`, { body: {} })
      expect(win.status).toBe(422)
      const winProblem = await problemOf(win)
      expect(winProblem.code).toBe('STAGE_REQUIREMENTS_MISSING')
      expect(winProblem.errors).toEqual(expect.arrayContaining(requiredErrors('contract')))
      expect(await dealRow(deal)).toMatchObject({ stage_id: main.stages[1], status: 'open' })

      const staged = await json<DealView>(
        await full.api('POST', `/v1/deals/${deal}/stage`, {
          body: { stageId: main.stages[2], custom: { budget: '10 000' } },
        }),
      )
      expect(staged).toMatchObject({ stageId: main.stages[2], custom: { budget: '10 000' } })
      const won = await json<DealView>(
        await full.api('POST', `/v1/deals/${deal}/win`, { body: { custom: { contract: 'Д-1' } } }),
      )
      expect(won).toMatchObject({ status: 'won', custom: { budget: '10 000', contract: 'Д-1' } })
    })

    it('создание сразу на этапе и перенос в воронку с пустым обязательным полем — 422', async () => {
      const create = await full.api('POST', '/v1/deals', {
        body: {
          title: 'Одразу на рішення',
          pipelineId: main.id,
          stageId: main.stages[2],
          contactId: await createContact(),
        },
      })
      expect(create.status).toBe(422)
      expect((await problemOf(create)).errors).toEqual(requiredErrors('budget'))

      const deal = await seedDeal({ pipeline: other })
      const move = await full.api('POST', `/v1/deals/${deal}/move`, {
        body: { pipelineId: main.id, stageId: main.stages[2] },
      })
      expect(move.status).toBe(422)
      expect((await problemOf(move)).errors).toEqual(requiredErrors('budget'))
      expect(await dealRow(deal)).toMatchObject({ pipeline_id: other.id })
    })
  })

  describe('одна открытая сделка у человека в воронке', () => {
    it('создание, повторное открытие, перенос и возврат из архива второй открытой сделки — 409', async () => {
      const contact = await createContact()
      const open = await seedDeal({ contact, owner: admin.id })
      const lost = await seedDeal({ contact, status: 'lost' })
      const archived = await seedDeal({ contact, archived: true })
      const elsewhere = await seedDeal({ contact, pipeline: other })

      const attempts: [string, Response][] = [
        [
          'create',
          await full.api('POST', '/v1/deals', {
            body: { title: 'Друга', pipelineId: main.id, contactId: contact },
          }),
        ],
        ['reopen', await full.api('POST', `/v1/deals/${lost}/reopen`, { body: {} })],
        [
          'move',
          await full.api('POST', `/v1/deals/${elsewhere}/move`, { body: { pipelineId: main.id } }),
        ],
        ['unarchive', await full.api('POST', `/v1/deals/${archived}/unarchive`, { body: {} })],
      ]
      for (const [action, res] of attempts) {
        expect([action, res.status, await problemOf(res)]).toEqual([
          action,
          409,
          { code: 'OPEN_DEAL_EXISTS', details: { dealId: open } },
        ])
      }
    })

    it('мешающая сделка вне охвата ключа — «чужой клиент» без её данных', async () => {
      const contact = await createContact()
      const foreign = await seedDeal({ contact, owner: manager.id })
      const res = await own.api('POST', '/v1/deals', {
        body: { title: 'Чужий клієнт', pipelineId: main.id, contactId: contact },
      })
      expect(res.status).toBe(409)
      const body = await problemOf(res)
      expect(body).toEqual({ code: 'OPEN_DEAL_EXISTS', details: { managerName: 'Користувач' } })
      expect(JSON.stringify(body)).not.toContain(foreign)
    })
  })

  describe('пользовательские поля по ключу', () => {
    it('скрытая группа: ни кода, ни значения в ответе сделки и списка; запись — 422 как неизвестный код', async () => {
      const deal = await seedDeal({
        custom: {
          [hiddenField.code]: 'таємниця-42',
          [readField.code]: 'видно',
          budget: 'відкрито',
        },
      })
      const one = await limitedFields.api('GET', `/v1/deals/${deal}`)
      const text = await one.text()
      expect(one.status).toBe(200)
      expect(text).not.toContain(hiddenField.code)
      expect(text).not.toContain('таємниця-42')
      expect((JSON.parse(text) as DealView).custom).toEqual({
        [readField.code]: 'видно',
        budget: 'відкрито',
      })
      const list = await limitedFields.api(
        'GET',
        `/v1/deals?pipeline=${main.id}&status=any&archived=any&limit=200`,
      )
      const listText = await list.text()
      expect(list.status).toBe(200)
      expect(listText).toContain(deal)
      expect(listText).not.toContain(hiddenField.code)
      expect(listText).not.toContain('таємниця-42')

      const hidden = await limitedFields.api('PATCH', `/v1/deals/${deal}`, {
        body: { custom: { [hiddenField.code]: 'злам' } },
      })
      expect({ status: hidden.status, body: await problemOf(hidden) }).toEqual({
        status: 422,
        body: { code: 'CUSTOM_FIELD_UNKNOWN', details: { field: hiddenField.code } },
      })
      const readOnly = await limitedFields.api('PATCH', `/v1/deals/${deal}`, {
        body: { custom: { [readField.code]: 'інакше' } },
      })
      expect(readOnly.status).toBe(403)
    })

    it('«я» в filter= для ключа — 400, а не пустое значение: системное поле и поле-пользователь', async () => {
      for (const condition of [
        { field: 'owner', op: 'eq', value: 'me' },
        { field: 'owner', op: 'neq', value: 'me' },
        { field: 'custom.curator', op: 'in', value: [manager.id, 'me'] },
        { field: 'custom.curator', op: 'neq', value: 'me' },
      ]) {
        const filter = encodeURIComponent(JSON.stringify({ and: [condition] }))
        const res = await full.api('GET', `/v1/deals?filter=${filter}`)
        expect({ condition, status: res.status, code: (await problemOf(res)).code }).toEqual({
          condition,
          status: 400,
          code: 'INVALID_DEAL',
        })
      }
      // Пользователю «я» по-прежнему доступно.
      const filter = encodeURIComponent(
        JSON.stringify({ and: [{ field: 'owner', op: 'eq', value: 'me' }] }),
      )
      expect(
        (await admin.api('GET', `/v1/deals?filter=${filter}`, { project: projectA })).status,
      ).toBe(200)
    })

    it('entityReader читает роль ключа, а не сессию', async () => {
      const app = new Hono<PermissionsEnv>()
        .use('*', apiKeyAuth(h.appDb, h.auth))
        .use('*', projectContext(h.appDb))
        .get('/probe', apiKeyRoute, async (c) => {
          const permissions = await entityReader(c, 'deal')
          return c.json({ visible: permissions !== null })
        })
      const res = await full.call(app, 'GET', '/probe')
      expect(await json(res)).toEqual({ visible: true })
      const blind = await createApiKey(
        h,
        admin,
        projectA,
        await createRole(
          h,
          projectA,
          permissions((p) => {
            p.actions.deals = []
          }),
        ),
      )
      expect(await json(await blind.call(app, 'GET', '/probe'))).toEqual({ visible: false })
    })
  })

  describe('описание OpenAPI', () => {
    const OPEN_DEAL_ROUTES = [
      'get /deals',
      'post /deals',
      'get /deals/{id}',
      'patch /deals/{id}',
      'post /deals/{id}/stage',
      'post /deals/{id}/owner',
      'post /deals/{id}/win',
      'post /deals/{id}/lose',
      'post /deals/{id}/reopen',
      'post /deals/{id}/archive',
      'post /deals/{id}/unarchive',
      'post /deals/{id}/move',
    ]

    it('содержит все маршруты сделок, открытые ключу, с примерами, и только их', async () => {
      const app = createApp({ auth: h.auth, db: h.appDb })
      type Operation = {
        requestBody?: { content: Record<string, { example?: unknown }> }
        responses: Record<string, { content?: Record<string, { example?: unknown }> }>
      }
      const doc = await json<{ paths: Record<string, Record<string, Operation>> }>(
        await app.request('http://localhost/v1/openapi.json'),
      )
      const routes: string[] = []
      for (const [path, methods] of Object.entries(doc.paths)) {
        // Заметки сделки открыл тикет crm-api/04: их проверяет contacts/api-key.test.ts.
        if (!path.startsWith('/deals') || path.includes('/notes')) continue
        for (const [method, operation] of Object.entries(methods)) {
          routes.push(`${method} ${path}`)
          const success = operation.responses['200'] ?? operation.responses['201']
          expect([method, path, success?.content?.['application/json']?.example]).toEqual([
            method,
            path,
            expect.anything(),
          ])
          if (operation.requestBody) {
            expect([
              method,
              path,
              operation.requestBody.content['application/json']?.example,
            ]).toEqual([method, path, expect.anything()])
          }
        }
      }
      expect(routes.sort()).toEqual([...OPEN_DEAL_ROUTES].sort())
    })
  })
})
