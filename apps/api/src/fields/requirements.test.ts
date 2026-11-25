import { randomUUID } from 'node:crypto'
import type {
  FieldDefinitionSummary,
  FieldGroupSummary,
  PipelineSummary,
  RequiredFieldsMissing,
  RoleSummary,
  StageSummary,
} from '@alpi/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import type { BulkJobDetails, BulkJobSummary } from '../bulk/routes.ts'
import { type BulkJobMessage, runBulkJob } from '../bulk/runner.ts'
import type { ContactView } from '../contacts/contacts.ts'
import { DEAL_BULK_REGISTRY } from '../deals/bulk.ts'
import type { DealView } from '../deals/store.ts'
import type { OrganizationView } from '../organizations/organizations.ts'
import { type ApiHarness, type SignedInUser, startApiHarness } from '../testing/api-harness.ts'

// Обязательность пользовательских полей «всегда» и «с этапа X» (тикет crm-fields/04) — на
// настоящем PostgreSQL, API ходит ролью приложения. Каждая группа проверок — в своём проекте:
// поле «всегда» действует на все записи проекта.

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'
type Entity = 'deal' | 'contact' | 'organization'

interface Refusal {
  code: string
  details?: RequiredFieldsMissing & Record<string, unknown>
}

describe('обязательность пользовательских полей', () => {
  let h: ApiHarness
  let app: ReturnType<typeof createApp>
  let admin: SignedInUser
  let manager: SignedInUser
  let limited: SignedInUser
  const queued: BulkJobMessage[] = []
  const actions = new Map(DEAL_BULK_REGISTRY)
  let counter = 0

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_field_requirements')
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
    manager = await h.signIn()
    limited = await h.signIn()
  })

  afterAll(async () => {
    await h?.stop()
  })

  const as =
    (user: SignedInUser, project: string) => (method: Method, path: string, body?: unknown) =>
      user.call(app, method, `/v1${path}`, { project, ...(body === undefined ? {} : { body }) })

  async function json<T>(res: Response, status = 200): Promise<T> {
    const text = await res.text()
    expect(res.status, text).toBe(status)
    return (text === '' ? null : JSON.parse(text)) as T
  }

  const refusal = (res: Response, status = 422) => json<Refusal>(res, status)

  async function createPipeline(project: string, stages: string[]) {
    counter += 1
    const call = as(admin, project)
    const pipeline = await json<PipelineSummary>(
      await call('POST', '/pipelines', { name: `Воронка ${counter}`, code: `req${counter}` }),
      201,
    )
    const stageIds: string[] = []
    for (const name of stages) {
      stageIds.push(
        (
          await json<StageSummary>(
            await call('POST', `/pipelines/${pipeline.id}/stages`, { name }),
            201,
          )
        ).id,
      )
    }
    return { id: pipeline.id, stages: stageIds }
  }

  async function createGroup(project: string, entity: Entity, nameUk = 'Обов’язкові') {
    return json<FieldGroupSummary>(
      await as(admin, project)('POST', '/field-groups', { entity, nameUk }),
      201,
    )
  }

  async function createField(
    project: string,
    group: FieldGroupSummary,
    code: string,
    input: Record<string, unknown>,
  ) {
    return json<FieldDefinitionSummary>(
      await as(admin, project)('POST', '/fields', {
        groupId: group.id,
        nameUk: `Поле ${code}`,
        code,
        type: 'text',
        ...input,
      }),
      201,
    )
  }

  async function createContact(project: string, custom?: Record<string, unknown>) {
    counter += 1
    return json<ContactView>(
      await as(admin, project)('POST', '/contacts', {
        firstName: `Клієнт ${counter}`,
        ...(custom === undefined ? {} : { custom }),
      }),
      201,
    )
  }

  /** Сделка на этапе `stageId`, записанная в обход API (старая запись — без проверок). */
  async function seedDeal(
    project: string,
    pipelineId: string,
    stageId: string,
    { owner = admin.id, custom = {} }: { owner?: string; custom?: Record<string, unknown> } = {},
  ) {
    counter += 1
    const contact = await h.owner
      .insertInto('contact')
      .values({ project_id: project, first_name: `Старий ${counter}`, created_by: admin.id })
      .returning('id')
      .executeTakeFirstOrThrow()
    const deal = await h.owner
      .insertInto('deal')
      .values({
        project_id: project,
        title: `Угода ${counter}`,
        pipeline_id: pipelineId,
        stage_id: stageId,
        owner_id: owner,
        primary_contact_id: contact.id,
        custom: JSON.stringify(custom),
        created_by: admin.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return deal.id
  }

  async function stored(id: string) {
    return h.owner
      .selectFrom('deal')
      .select(['stage_id', 'pipeline_id', 'status', 'custom'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  }

  async function lostReason(project: string) {
    const group = await h.owner
      .insertInto('lost_reason_group')
      .values({ project_id: project, name: `Група ${randomUUID().slice(0, 8)}` })
      .returning('id')
      .executeTakeFirstOrThrow()
    const reason = await h.owner
      .insertInto('lost_reason')
      .values({ project_id: project, group_id: group.id, name: 'Дорого' })
      .returning('id')
      .executeTakeFirstOrThrow()
    return reason.id
  }

  describe('«с этапа X» и «с выигрыша»', () => {
    let project: string
    /** Этапы: до X, X, после X. */
    let main: { id: string; stages: string[] }
    let other: { id: string; stages: string[] }

    beforeAll(async () => {
      project = (await h.createProject(admin, 'Обов’язкові з етапу')).id
      await h.addMember(project, manager.id, 'manager')
      main = await createPipeline(project, ['Новий', 'Дзвінок', 'Рішення', 'Оплата'])
      other = await createPipeline(project, ['Інший новий', 'Інше рішення'])
      const group = await createGroup(project, 'deal')
      await createField(project, group, 'budget', {
        required: {
          mode: 'stages',
          stages: [
            { pipelineId: main.id, stageId: main.stages[2] },
            { pipelineId: other.id, stageId: other.stages[1] },
          ],
        },
      })
      await createField(project, group, 'contract', {
        required: { mode: 'stages', stages: [{ pipelineId: main.id, stageId: null }] },
      })
    })

    it('на этап X и после него — 422 со списком, сделка на месте; до X — проходит; с значением в том же запросе — проходит', async () => {
      const call = as(admin, project)
      const id = await seedDeal(project, main.id, main.stages[0] ?? '')

      for (const stageId of [main.stages[2], main.stages[3]]) {
        const refused = await refusal(await call('POST', `/deals/${id}/stage`, { stageId }))
        expect(refused).toEqual({
          code: 'STAGE_REQUIREMENTS_MISSING',
          details: {
            fields: ['budget'],
            names: [{ code: 'budget', nameUk: 'Поле budget', nameRu: null }],
            hiddenCount: 0,
          },
        })
        expect((await stored(id)).stage_id).toBe(main.stages[0])
      }

      const before = await json<DealView>(
        await call('POST', `/deals/${id}/stage`, { stageId: main.stages[1] }),
      )
      expect(before.stageId).toBe(main.stages[1])

      const moved = await json<DealView>(
        await call('POST', `/deals/${id}/stage`, {
          stageId: main.stages[2],
          custom: { budget: '1000 €' },
        }),
      )
      expect(moved).toMatchObject({ stageId: main.stages[2], custom: { budget: '1000 €' } })
      const history = await h.owner
        .selectFrom('change_log')
        .select(['field', 'after'])
        .where('entity_id', '=', id)
        .where('field', '=', 'custom.budget')
        .execute()
      expect(history).toEqual([{ field: 'custom.budget', after: '1000 €' }])
    })

    it('выигрыш с пустым полем «с этапа X» или «с выигрыша» — 422; с заполненными — выиграна, этап тот же', async () => {
      const call = as(admin, project)
      const id = await seedDeal(project, main.id, main.stages[0] ?? '')
      const refused = await refusal(await call('POST', `/deals/${id}/win`))
      expect(refused.code).toBe('STAGE_REQUIREMENTS_MISSING')
      expect(refused.details?.fields).toEqual(['budget', 'contract'])
      expect((await stored(id)).status).toBe('open')

      // «С выигрыша» не требуется для этапов: X проходит без договора.
      await json(
        await call('POST', `/deals/${id}/stage`, {
          stageId: main.stages[2],
          custom: { budget: '5' },
        }),
      )
      const onlyContract = await refusal(await call('POST', `/deals/${id}/win`, {}))
      expect(onlyContract.details?.fields).toEqual(['contract'])

      const won = await json<DealView>(
        await call('POST', `/deals/${id}/win`, { custom: { contract: '№ 7' } }),
      )
      expect(won).toMatchObject({
        status: 'won',
        stageId: main.stages[2],
        custom: { budget: '5', contract: '№ 7' },
      })
    })

    it('создание сразу на X, перенос в воронку на X и массовая смена этапа блокируются; повторное открытие и проигрыш — нет', async () => {
      const call = as(admin, project)
      const contact = await createContact(project)
      const create = (custom?: Record<string, unknown>) =>
        call('POST', '/deals', {
          title: 'Нова',
          pipelineId: main.id,
          stageId: main.stages[2],
          contactId: contact.id,
          ...(custom ? { custom } : {}),
        })
      expect((await refusal(await create())).details?.fields).toEqual(['budget'])
      const created = await json<DealView>(await create({ budget: '9' }), 201)
      expect(created.stageId).toBe(main.stages[2])

      // Перенос из другой воронки на X главной: правило главной воронки.
      const moving = await seedDeal(project, other.id, other.stages[0] ?? '')
      const refusedMove = await refusal(
        await call('POST', `/deals/${moving}/move`, {
          pipelineId: main.id,
          stageId: main.stages[2],
        }),
      )
      expect(refusedMove.details?.fields).toEqual(['budget'])
      expect(await stored(moving)).toMatchObject({ pipeline_id: other.id })
      await json(
        await call('POST', `/deals/${moving}/move`, {
          pipelineId: main.id,
          stageId: main.stages[1],
        }),
      )
      // Правило своей воронки для другой воронки не действует: в «Іншій» — свой этап.
      const back = await seedDeal(project, main.id, main.stages[1] ?? '')
      await json(
        await call('POST', `/deals/${back}/move`, {
          pipelineId: other.id,
          stageId: other.stages[0],
        }),
      )

      // Массовая смена этапа: запись без поля — в журнале ошибок, заполненная — переходит.
      const empty = await seedDeal(project, main.id, main.stages[0] ?? '')
      const filled = await seedDeal(project, main.id, main.stages[0] ?? '', {
        custom: { budget: '1' },
      })
      const started = await json<BulkJobSummary>(
        await admin.call(app, 'POST', '/v1/bulk-jobs', {
          project,
          body: {
            action: 'deals.stage',
            selection: { ids: [empty, filled] },
            params: { stageId: main.stages[2] },
          },
        }),
        202,
      )
      await runBulkJob(
        h.appDb,
        actions,
        queued.find((m) => m.bulkJobId === started.id) as BulkJobMessage,
      )
      const job = await json<BulkJobDetails>(
        await admin.call(app, 'GET', `/v1/bulk-jobs/${started.id}`, { project }),
      )
      expect(job.errors).toEqual([
        expect.objectContaining({ recordId: empty, code: 'STAGE_REQUIREMENTS_MISSING' }),
      ])
      expect(job.errors[0]?.message).toContain('budget')
      expect((await stored(empty)).stage_id).toBe(main.stages[0])
      expect((await stored(filled)).stage_id).toBe(main.stages[2])

      // Повторное открытие и проигрыш не проверяются.
      const lost = await seedDeal(project, main.id, main.stages[3] ?? '')
      expect(
        (
          await json<DealView>(
            await call('POST', `/deals/${lost}/lose`, { lostReasonId: await lostReason(project) }),
          )
        ).status,
      ).toBe('lost')
      expect((await json<DealView>(await call('POST', `/deals/${lost}/reopen`))).status).toBe(
        'open',
      )
    })

    it('одна проверка для менеджера и администратора; невидимое в воронке и архивное поле не блокируют', async () => {
      const group = await createGroup(project, 'deal', 'Інші')
      // Видно только в другой воронке: в главной не требуется.
      await createField(project, group, 'elsewhere', {
        pipelines: [other.id],
        required: { mode: 'stages', stages: [{ pipelineId: other.id, stageId: other.stages[0] }] },
      })
      await createField(project, group, 'elsewhere_always', {
        pipelines: [other.id],
        required: { mode: 'always' },
      })
      const archived = await createField(project, group, 'archived_rule', {
        required: { mode: 'stages', stages: [{ pipelineId: main.id, stageId: main.stages[1] }] },
      })
      await json(await as(admin, project)('POST', `/fields/${archived.id}/archive`))

      for (const user of [manager, admin]) {
        const id = await seedDeal(project, main.id, main.stages[0] ?? '', { owner: user.id })
        const refused = await refusal(
          await as(user, project)('POST', `/deals/${id}/stage`, { stageId: main.stages[2] }),
        )
        expect(refused.details?.fields).toEqual(['budget'])
        await json(
          await as(user, project)('POST', `/deals/${id}/stage`, { stageId: main.stages[1] }),
        )
      }
    })
  })

  describe('«всегда»', () => {
    let project: string
    let pipeline: { id: string; stages: string[] }
    const always = {} as Record<Entity, FieldDefinitionSummary>
    const optional = {} as Record<Entity, FieldDefinitionSummary>

    beforeAll(async () => {
      project = (await h.createProject(admin, 'Обов’язкові завжди')).id
      pipeline = await createPipeline(project, ['Новий', 'Дзвінок'])
      for (const entity of ['deal', 'contact', 'organization'] as const) {
        const group = await createGroup(project, entity)
        always[entity] = await createField(project, group, `${entity}_always`, {
          required: { mode: 'always' },
        })
        optional[entity] = await createField(project, group, `${entity}_note`, {})
      }
    })

    it('создание без значения — 422, со значением — 201; очистка — 422', async () => {
      const call = as(admin, project)
      const noContact = await refusal(await call('POST', '/contacts', { firstName: 'Без поля' }))
      expect(noContact).toEqual({
        code: 'REQUIRED_FIELDS_MISSING',
        details: {
          fields: ['contact_always'],
          names: [{ code: 'contact_always', nameUk: 'Поле contact_always', nameRu: null }],
          hiddenCount: 0,
        },
      })
      const contact = await createContact(project, { contact_always: 'є' })
      const cleared = await refusal(
        await call('PUT', `/contacts/${contact.id}`, { custom: { contact_always: null } }),
      )
      expect(cleared.code).toBe('REQUIRED_FIELDS_MISSING')
      expect(cleared.details?.fields).toEqual(['contact_always'])

      expect((await refusal(await call('POST', '/organizations', { name: 'Без поля' }))).code).toBe(
        'REQUIRED_FIELDS_MISSING',
      )
      const organization = await json<OrganizationView>(
        await call('POST', '/organizations', {
          name: 'З полем',
          custom: { organization_always: 'є' },
        }),
        201,
      )
      expect(
        (
          await refusal(
            await call('PUT', `/organizations/${organization.id}`, {
              custom: { organization_always: '' },
            }),
          )
        ).code,
      ).toBe('REQUIRED_FIELDS_MISSING')

      const deal = (custom?: Record<string, unknown>) =>
        call('POST', '/deals', {
          title: 'Угода',
          pipelineId: pipeline.id,
          contactId: contact.id,
          ...(custom ? { custom } : {}),
        })
      const noDeal = await refusal(await deal())
      expect(noDeal.code).toBe('STAGE_REQUIREMENTS_MISSING')
      expect(noDeal.details?.fields).toEqual(['deal_always'])
      const created = await json<DealView>(await deal({ deal_always: 'є' }), 201)
      const clearedDeal = await refusal(
        await call('PUT', `/deals/${created.id}`, { custom: { deal_always: null } }),
      )
      expect(clearedDeal.code).toBe('REQUIRED_FIELDS_MISSING')

      // Новый контакт вместе со сделкой — тоже без пропуска «всегда» контакта.
      const withNewContact = await refusal(
        await call('POST', '/deals', {
          title: 'З новим контактом',
          pipelineId: pipeline.id,
          contact: { firstName: 'Новий' },
          custom: { deal_always: 'є' },
        }),
      )
      expect(withNewContact.code).toBe('REQUIRED_FIELDS_MISSING')
    })

    it('старая запись с пустым полем: правка другого поля — 200; смена этапа и выигрыш — 422', async () => {
      const call = as(admin, project)
      const id = await seedDeal(project, pipeline.id, pipeline.stages[0] ?? '')
      const edited = await json<DealView>(
        await call('PUT', `/deals/${id}`, { title: 'Нова назва', custom: { deal_note: 'так' } }),
      )
      expect(edited).toMatchObject({ title: 'Нова назва', custom: { deal_note: 'так' } })
      const stage = await refusal(
        await call('POST', `/deals/${id}/stage`, { stageId: pipeline.stages[1] }),
      )
      expect(stage.details?.fields).toEqual(['deal_always'])
      expect((await refusal(await call('POST', `/deals/${id}/win`))).details?.fields).toEqual([
        'deal_always',
      ])

      const contact = await h.owner
        .insertInto('contact')
        .values({ project_id: project, first_name: 'Старий контакт', created_by: admin.id })
        .returning('id')
        .executeTakeFirstOrThrow()
      await json(await call('PUT', `/contacts/${contact.id}`, { lastName: 'Прізвище' }))
      await json(await call('PUT', `/contacts/${contact.id}`, { custom: { contact_note: 'інше' } }))
    })
  })

  describe('скрытое от роли', () => {
    it('незаполненное поле скрытой группы — 422 без кода и названия, только число', async () => {
      const project = (await h.createProject(admin, 'Обов’язкові приховані')).id
      const pipeline = await createPipeline(project, ['Новий', 'Рішення'])
      const secretGroup = await createGroup(project, 'deal', 'Таємна')
      const openGroup = await createGroup(project, 'deal', 'Відкрита')
      const rule = {
        required: {
          mode: 'stages',
          stages: [{ pipelineId: pipeline.id, stageId: pipeline.stages[1] }],
        },
      }
      await createField(project, secretGroup, 'secret_budget', rule)
      await createField(project, openGroup, 'open_budget', rule)
      const permissions = {
        actions: { deals: ['view', 'create', 'edit'], contacts: ['view', 'create', 'edit'] },
        scopes: { deals: { read: 'all', write: 'all' }, contacts: { read: 'all', write: 'all' } },
        fieldGroups: { [secretGroup.id]: 'hidden' },
      }
      const role = await json<RoleSummary>(
        await admin.api('POST', '/roles', { project, body: { name: 'Обмежена', permissions } }),
        201,
      )
      await h.owner
        .insertInto('project_member')
        .values({ project_id: project, user_id: limited.id, role_id: role.id })
        .execute()

      const id = await seedDeal(project, pipeline.id, pipeline.stages[0] ?? '')
      const res = await as(limited, project)('POST', `/deals/${id}/stage`, {
        stageId: pipeline.stages[1],
      })
      const text = await res.clone().text()
      expect(await refusal(res)).toEqual({
        code: 'STAGE_REQUIREMENTS_MISSING',
        details: {
          fields: ['open_budget'],
          names: [{ code: 'open_budget', nameUk: 'Поле open_budget', nameRu: null }],
          hiddenCount: 1,
        },
      })
      expect(text).not.toContain('secret')

      // Администратор видит оба поля и обязательность не обходит.
      const forAdmin = await refusal(
        await as(admin, project)('POST', `/deals/${id}/stage`, { stageId: pipeline.stages[1] }),
      )
      expect(forAdmin.details).toMatchObject({
        fields: ['secret_budget', 'open_budget'],
        hiddenCount: 0,
      })
    })
  })
})
