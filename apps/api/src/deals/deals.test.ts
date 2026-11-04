import { randomInt } from 'node:crypto'
import { withProject } from '@alpi/db'
import type { TeamSummary } from '@alpi/shared'
import { type Kysely, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { down as downDeals } from '../../../../packages/db/migrations/0010_deals.ts'
import { down as downProducts } from '../../../../packages/db/migrations/0011_products.ts'
import { down as downNotesFiles } from '../../../../packages/db/migrations/0012_notes_files.ts'
import type { ContactView } from '../contacts/contacts.ts'
import {
  type ApiHarness,
  type Method,
  type SignedInUser,
  startApiHarness,
} from '../testing/api-harness.ts'
import type { DealHistoryEntry } from './deals.ts'
import type { DealView } from './store.ts'

// Сделки (тикет crm-deals/05): изоляция проектов, права и охват, общая очередь, «одна открытая
// сделка» на каждом пути и при одновременных запросах, статусы, история, удаление контакта со
// сделками — на настоящем PostgreSQL, API ходит ролью приложения. Имена и телефоны — вымышленные.

const fakePhone = () => `+38067${randomInt(1_000_000, 9_999_999)}`

interface Directory {
  /** Основная воронка: этапы s1, s2, s3. */
  main: { id: string; stages: string[] }
  /** Вторая воронка: этапы t1, t2. */
  other: { id: string; stages: string[] }
  /** Воронка допродаж: этапы u1, u2. */
  upsell: { id: string; stages: string[] }
  reason: string
  archivedReason: string
  /** Действующая причина в архивной группе. */
  reasonInArchivedGroup: string
}

describe('сделки', () => {
  let h: ApiHarness
  let admin: SignedInUser
  let projectA: string
  let projectB: string
  let dirA: Directory
  let dirB: Directory
  let managerA1: SignedInUser
  let managerA2: SignedInUser
  let lead: SignedInUser
  let teamMate: SignedInUser
  let head: SignedInUser
  let noRights: SignedInUser
  /** Сделки видит все, меняет только свои. */
  let readAll: SignedInUser
  /** Контакты видит все, меняет только свои; сделки — свои. */
  let contactsReadAll: SignedInUser
  /** Сделки видит и меняет все, контакты — только свои. */
  let dealsAll: SignedInUser
  /** Всё только своё, но может удалять и работать с корзиной. */
  let trashOwn: SignedInUser
  /** Контакты — все и корзина; сделки — только свои, без изменения. */
  let trashKeeper: SignedInUser

  /** Каждая проверка — в своей воронке: правила «одной открытой сделки» не мешают соседям. */
  let pipelineCounter = 0

  async function createPipeline(
    projectId: string,
    stages: string[],
    isUpsell = false,
  ): Promise<{ id: string; stages: string[] }> {
    const { id } = await h.owner
      .insertInto('pipeline')
      .values({
        project_id: projectId,
        code: `p${++pipelineCounter}`,
        name: `Воронка ${pipelineCounter}`,
        is_upsell: isUpsell,
        position: pipelineCounter,
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
    return { id, stages: ids }
  }

  async function createDirectory(projectId: string): Promise<Directory> {
    const reasons = async (archivedGroup: boolean) => {
      const group = await h.owner
        .insertInto('lost_reason_group')
        .values({
          project_id: projectId,
          name: `Група ${randomInt(1e9)}`,
          archived_at: archivedGroup ? new Date() : null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const add = async (name: string, archived: boolean) =>
        (
          await h.owner
            .insertInto('lost_reason')
            .values({
              project_id: projectId,
              group_id: group.id,
              name,
              archived_at: archived ? new Date() : null,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id
      return { active: await add('Дорого', false), archived: await add('Застаріла', true) }
    }
    const open = await reasons(false)
    const inArchivedGroup = await reasons(true)
    return {
      main: await createPipeline(projectId, ['s1', 's2', 's3']),
      other: await createPipeline(projectId, ['t1', 't2']),
      upsell: await createPipeline(projectId, ['u1', 'u2'], true),
      reason: open.active,
      archivedReason: open.archived,
      reasonInArchivedGroup: inArchivedGroup.active,
    }
  }

  async function rename(user: SignedInUser, name: string) {
    await h.owner.updateTable('user').set({ name }).where('id', '=', user.id).execute()
  }

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_deals')
    admin = await h.signIn('owner')
    projectA = (await h.createProject(admin, 'Угоди А')).id
    projectB = (await h.createProject(admin, 'Угоди Б')).id
    dirA = await createDirectory(projectA)
    dirB = await createDirectory(projectB)
    managerA1 = await h.signIn()
    managerA2 = await h.signIn()
    lead = await h.signIn()
    teamMate = await h.signIn()
    head = await h.signIn()
    noRights = await h.signIn()
    readAll = await h.signIn()
    contactsReadAll = await h.signIn()
    dealsAll = await h.signIn()
    trashOwn = await h.signIn()
    trashKeeper = await h.signIn()
    await rename(managerA1, 'Ганна Вигадана')
    await rename(managerA2, 'Остап Тестовий')
    await h.addMember(projectA, managerA1.id, 'manager')
    await h.addMember(projectA, managerA2.id, 'manager')
    await h.addMember(projectA, lead.id, 'teamlead')
    await h.addMember(projectA, teamMate.id, 'manager')
    await h.addMember(projectA, head.id, 'head')
    const role = async (name: string, permissions: unknown) =>
      (
        await h.owner
          .insertInto('role')
          .values({ project_id: projectA, name, permissions: JSON.stringify(permissions) })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id
    await h.owner
      .insertInto('project_member')
      .values([
        { project_id: projectA, user_id: noRights.id, role_id: await role('Без прав', {}) },
        {
          project_id: projectA,
          user_id: readAll.id,
          role_id: await role('Бачить усе', {
            actions: { deals: ['view', 'create', 'edit'], contacts: ['view'] },
            scopes: { deals: { read: 'all', write: 'own' } },
          }),
        },
        {
          project_id: projectA,
          user_id: contactsReadAll.id,
          role_id: await role('Контакти: бачить усі, змінювати свої', {
            actions: { deals: ['view', 'create', 'edit'], contacts: ['view', 'create', 'edit'] },
            scopes: { contacts: { read: 'all', write: 'own' } },
          }),
        },
        {
          project_id: projectA,
          user_id: dealsAll.id,
          role_id: await role('Угоди всі, контакти свої', {
            actions: { deals: ['view', 'create', 'edit'], contacts: ['view', 'create', 'edit'] },
            scopes: { deals: { read: 'all', write: 'all' } },
          }),
        },
        {
          project_id: projectA,
          user_id: trashOwn.id,
          role_id: await role('Усе своє з кошиком', {
            actions: {
              deals: ['view', 'create', 'edit', 'delete'],
              contacts: ['view', 'create', 'edit', 'delete'],
              trash: ['view', 'edit', 'delete'],
            },
          }),
        },
        {
          project_id: projectA,
          user_id: trashKeeper.id,
          role_id: await role('Кошик: контакти всі, угоди свої', {
            actions: {
              deals: ['view', 'delete'],
              contacts: ['view', 'create', 'edit', 'delete'],
              trash: ['view', 'edit', 'delete'],
            },
            scopes: { contacts: { read: 'all', write: 'all' } },
          }),
        },
      ])
      .execute()
    const team = await call(admin, 'POST', '/teams', {
      name: 'Команда тімліда',
      leadUserId: lead.id,
    })
    expect(team.status).toBe(201)
    const { id: teamId } = (await team.json()) as TeamSummary
    expect((await call(admin, 'PUT', `/members/${teamMate.id}/team`, { teamId })).status).toBe(200)
  })

  afterAll(async () => {
    await h?.stop()
  })

  function call(
    user: SignedInUser,
    method: Method,
    path: string,
    body?: unknown,
    project = projectA,
  ) {
    return user.api(method, path, { project, ...(body === undefined ? {} : { body }) })
  }

  async function json<T>(res: Response): Promise<T> {
    return (await res.json()) as T
  }

  async function expectStatus(res: Response, status: number) {
    expect(
      res.status,
      JSON.stringify(
        await res
          .clone()
          .json()
          .catch(() => null),
      ),
    ).toBe(status)
    return res
  }

  async function createContact(
    user: SignedInUser,
    firstName: string,
    project = projectA,
    lastName: string | null = 'Вигаданий',
  ): Promise<ContactView> {
    const res = await call(
      user,
      'POST',
      '/v1/contacts',
      { firstName, lastName, phones: [fakePhone()] },
      project,
    )
    await expectStatus(res, 201)
    return json<ContactView>(res)
  }

  async function createDeal(
    user: SignedInUser,
    body: Record<string, unknown>,
    project = projectA,
  ): Promise<DealView> {
    const res = await call(user, 'POST', '/v1/deals', { title: 'Угода', ...body }, project)
    await expectStatus(res, 201)
    return json<DealView>(res)
  }

  async function act(
    user: SignedInUser,
    dealId: string,
    action: string,
    body?: unknown,
  ): Promise<Response> {
    return call(user, 'POST', `/v1/deals/${dealId}/${action}`, body ?? {})
  }

  async function history(dealId: string) {
    return h.owner
      .selectFrom('change_log')
      .select(['field', 'before', 'after', 'actor_id'])
      .where('entity_type', '=', 'deal')
      .where('entity_id', '=', dealId)
      .orderBy('occurred_at')
      .orderBy('id')
      .execute()
  }

  /** Запрос ролью приложения в контексте проекта, как его делает API. */
  const inProject = <T>(projectId: string, fn: (trx: Kysely<never>) => Promise<T>) =>
    withProject(h.appDb, projectId, (trx) => fn(trx as unknown as Kysely<never>))

  describe('создание', () => {
    it('по умолчанию: первый этап, EUR, сумма 0, ответственный — создатель, статус open', async () => {
      const contact = await createContact(managerA1, 'Олена')
      const deal = await createDeal(managerA1, {
        pipelineId: dirA.main.id,
        contactId: contact.id,
      })
      expect(deal).toMatchObject({
        title: 'Угода',
        pipelineId: dirA.main.id,
        stageId: dirA.main.stages[0],
        status: 'open',
        lostReasonId: null,
        amount: 0,
        currency: 'EUR',
        ownerId: managerA1.id,
        primaryContactId: contact.id,
        organizationId: null,
        wonAt: null,
        lostAt: null,
        archivedAt: null,
        expectedCloseDate: null,
        participants: [],
      })
    })

    it('с новым контактом — одним запросом; отказ сделки откатывает и контакт', async () => {
      const phone = fakePhone()
      const deal = await createDeal(admin, {
        pipelineId: dirA.main.id,
        stageId: dirA.main.stages[1],
        amount: 1500.5,
        currency: 'UAH',
        expectedCloseDate: '2026-12-31',
        contact: { firstName: 'Новий', lastName: 'Клієнт', phones: [phone] },
      })
      expect(deal).toMatchObject({
        stageId: dirA.main.stages[1],
        amount: 1500.5,
        currency: 'UAH',
        expectedCloseDate: '2026-12-31',
      })
      const contact = await json<ContactView>(
        await call(admin, 'GET', `/v1/contacts/${deal.primaryContactId}`),
      )
      expect(contact).toMatchObject({ firstName: 'Новий', phones: [phone] })

      const otherPhone = fakePhone()
      await expectStatus(
        await call(admin, 'POST', '/v1/deals', {
          title: 'Не вийде',
          pipelineId: dirA.main.id,
          stageId: dirA.other.stages[0],
          contact: { firstName: 'Відкат', phones: [otherPhone] },
        }),
        404,
      )
      const leftover = await h.owner
        .selectFrom('contact_phone')
        .select('id')
        .where('phone', '=', otherPhone)
        .execute()
      expect(leftover).toEqual([])
    })

    it('неверное тело — 400 с полем; сумма меньше нуля — 400; валюта не из списка — 400', async () => {
      const contact = await createContact(admin, 'Форма')
      const base = { title: 'Т', pipelineId: dirA.main.id, contactId: contact.id }
      for (const [patch, path] of [
        [{ amount: -1 }, 'amount'],
        [{ amount: 1.234 }, 'amount'],
        [{ currency: 'GBP' }, 'currency'],
        [{ title: ' ' }, 'title'],
        [{ status: 'won' }, 'status'],
        [{ expectedCloseDate: '2026-02-30' }, 'expectedCloseDate'],
      ] as const) {
        const res = await call(admin, 'POST', '/v1/deals', { ...base, ...patch })
        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({ code: 'INVALID_DEAL', details: { path } })
      }
    })

    it('в архивную воронку и на удалённый этап — нельзя', async () => {
      const pipeline = await createPipeline(projectA, ['a1', 'a2'])
      const contact = await createContact(admin, 'Архів')
      await h.owner
        .updateTable('stage')
        .set({ deleted_at: new Date() })
        .where('id', '=', pipeline.stages[0] ?? '')
        .execute()
      // Первый действующий этап — второй.
      const deal = await createDeal(admin, { pipelineId: pipeline.id, contactId: contact.id })
      expect(deal.stageId).toBe(pipeline.stages[1])
      await expectStatus(
        await call(admin, 'POST', '/v1/deals', {
          title: 'Т',
          pipelineId: pipeline.id,
          stageId: pipeline.stages[0],
          contactId: (await createContact(admin, 'Ще')).id,
        }),
        404,
      )
      await h.owner
        .updateTable('pipeline')
        .set({ archived_at: new Date() })
        .where('id', '=', pipeline.id)
        .execute()
      const res = await call(admin, 'POST', '/v1/deals', {
        title: 'Т',
        pipelineId: pipeline.id,
        contactId: (await createContact(admin, 'Третій')).id,
      })
      expect(res.status).toBe(422)
      expect(await res.json()).toEqual({ code: 'PIPELINE_ARCHIVED' })
    })
  })

  describe('изоляция проектов', () => {
    it('сделки и участники A не видны в B; воронка и контакт другого проекта — 404', async () => {
      const contact = await createContact(admin, 'Ізоляція')
      const participant = await createContact(admin, 'Учасник')
      const deal = await createDeal(admin, { pipelineId: dirA.main.id, contactId: contact.id })
      await expectStatus(
        await call(admin, 'POST', `/v1/deals/${deal.id}/participants`, {
          contactId: participant.id,
        }),
        201,
      )

      await expectStatus(await call(admin, 'GET', `/v1/deals/${deal.id}`, undefined, projectB), 404)
      await expectStatus(await call(admin, 'POST', `/v1/deals/${deal.id}/win`, {}, projectB), 404)
      const seen = await inProject(projectB, async (trx) => ({
        deals: await sql`select id from deal`.execute(trx),
        participants: await sql`select id from deal_participant`.execute(trx),
      }))
      expect(seen.deals.rows).toEqual([])
      expect(seen.participants.rows).toEqual([])

      // Воронка B для сделки A, контакт B для сделки A — как несуществующие.
      const moved = await act(admin, deal.id, 'move', { pipelineId: dirB.main.id })
      expect(moved.status).toBe(404)
      expect(await moved.json()).toEqual({ code: 'PIPELINE_NOT_FOUND' })
      const contactB = await createContact(admin, 'Чужий', projectB)
      await expectStatus(
        await call(admin, 'POST', '/v1/deals', {
          title: 'Т',
          pipelineId: dirA.other.id,
          contactId: contactB.id,
        }),
        404,
      )
      await expectStatus(
        await call(admin, 'POST', `/v1/deals/${deal.id}/participants`, { contactId: contactB.id }),
        404,
      )
      await expectStatus(
        await call(admin, 'PUT', `/v1/deals/${deal.id}`, { primaryContactId: contactB.id }),
        404,
      )

      // И мимо API: база не даст связать сделку A с воронкой или контактом B.
      await expect(
        inProject(projectA, (trx) =>
          sql`update deal set pipeline_id = ${dirB.main.id} where id = ${deal.id}`.execute(trx),
        ),
      ).rejects.toMatchObject({ code: '23503' })
      await expect(
        inProject(projectA, (trx) =>
          sql`update deal set primary_contact_id = ${contactB.id} where id = ${deal.id}`.execute(
            trx,
          ),
        ),
      ).rejects.toMatchObject({ code: '23503' })
      // Этап чужой воронки своего проекта — тоже нет.
      await expect(
        inProject(projectA, (trx) =>
          sql`update deal set stage_id = ${dirA.other.stages[0]} where id = ${deal.id}`.execute(
            trx,
          ),
        ),
      ).rejects.toMatchObject({ code: '23503' })
    })

    it('у роли приложения нет DELETE на deal, id при вставке не задать', async () => {
      const contact = await createContact(admin, 'Права')
      const deal = await createDeal(admin, { pipelineId: dirA.other.id, contactId: contact.id })
      await expect(
        inProject(projectA, (trx) => sql`delete from deal where id = ${deal.id}`.execute(trx)),
      ).rejects.toMatchObject({ code: '42501' })
      await expect(
        inProject(projectA, (trx) =>
          sql`insert into deal (id, project_id, title, pipeline_id, stage_id, primary_contact_id)
              values (gen_random_uuid(), ${projectA}, 'Т', ${dirA.main.id}, ${dirA.main.stages[0]},
                ${contact.id})`.execute(trx),
        ),
      ).rejects.toMatchObject({ code: '42501' })
    })
  })

  describe('права и охват', () => {
    it('без права — 403', async () => {
      const contact = await createContact(admin, 'Безправний')
      const deal = await createDeal(admin, { pipelineId: dirA.main.id, contactId: contact.id })
      await expectStatus(await call(noRights, 'GET', `/v1/deals/${deal.id}`), 403)
      await expectStatus(
        await call(noRights, 'POST', '/v1/deals', {
          title: 'Т',
          pipelineId: dirA.other.id,
          contactId: contact.id,
        }),
        403,
      )
      await expectStatus(await act(noRights, deal.id, 'take'), 403)
      // Менеджер не удаляет сделки (шаблон «менеджер» без «сделки: удалять»).
      await expectStatus(await call(managerA1, 'DELETE', `/v1/deals/${deal.id}`), 403)
    })

    it('«свои»: сделка коллеги — 404, сделка общей очереди — видна', async () => {
      const contact = await createContact(managerA1, 'Охват')
      const mine = await createDeal(managerA1, { pipelineId: dirA.main.id, contactId: contact.id })
      await expectStatus(await call(managerA2, 'GET', `/v1/deals/${mine.id}`), 404)
      await expectStatus(await call(managerA2, 'PUT', `/v1/deals/${mine.id}`, { title: 'Х' }), 404)
      await expectStatus(await call(managerA2, 'GET', `/v1/deals/${mine.id}/history`), 404)

      const queued = await createDeal(admin, {
        pipelineId: dirA.other.id,
        contactId: contact.id,
        ownerId: null,
      })
      expect(queued.ownerId).toBeNull()
      const seen = await json<DealView>(await call(managerA2, 'GET', `/v1/deals/${queued.id}`))
      expect(seen.id).toBe(queued.id)
    })

    it('тимлид видит сделки своей команды и не видит чужие', async () => {
      const contact = await createContact(admin, 'Команда')
      const teamDeal = await createDeal(admin, {
        pipelineId: dirA.main.id,
        contactId: contact.id,
        ownerId: teamMate.id,
      })
      const foreign = await createDeal(admin, {
        pipelineId: dirA.other.id,
        contactId: contact.id,
        ownerId: managerA1.id,
      })
      await expectStatus(await call(lead, 'GET', `/v1/deals/${teamDeal.id}`), 200)
      await expectStatus(await call(lead, 'GET', `/v1/deals/${foreign.id}`), 404)
    })

    it('в охвате чтения, но не изменения — 403', async () => {
      const contact = await createContact(admin, 'Читач')
      const deal = await createDeal(admin, {
        pipelineId: dirA.main.id,
        contactId: contact.id,
        ownerId: managerA1.id,
      })
      await expectStatus(await call(readAll, 'GET', `/v1/deals/${deal.id}`), 200)
      await expectStatus(await call(readAll, 'PUT', `/v1/deals/${deal.id}`, { title: 'Х' }), 403)
      await expectStatus(await act(readAll, deal.id, 'win'), 403)
    })

    it('смена ответственного: без «передачи сделок» — 403; тимлид — только в своей команде', async () => {
      const contact = await createContact(managerA1, 'Передача')
      const deal = await createDeal(managerA1, { pipelineId: dirA.main.id, contactId: contact.id })
      await expectStatus(
        await call(managerA1, 'PUT', `/v1/deals/${deal.id}`, { ownerId: managerA2.id }),
        403,
      )
      // В общую очередь — тоже передача.
      await expectStatus(
        await call(managerA1, 'PUT', `/v1/deals/${deal.id}`, { ownerId: null }),
        403,
      )
      // Создать сделку на коллегу — тоже передача.
      await expectStatus(
        await call(managerA1, 'POST', '/v1/deals', {
          title: 'Т',
          pipelineId: dirA.other.id,
          contactId: contact.id,
          ownerId: managerA2.id,
        }),
        403,
      )

      const teamDeal = await createDeal(admin, {
        pipelineId: dirA.other.id,
        contactId: contact.id,
        ownerId: teamMate.id,
      })
      await expectStatus(
        await call(lead, 'PUT', `/v1/deals/${teamDeal.id}`, { ownerId: managerA1.id }),
        403,
      )
      const toLead = await json<DealView>(
        await expectStatus(
          await call(lead, 'PUT', `/v1/deals/${teamDeal.id}`, { ownerId: lead.id }),
          200,
        ),
      )
      expect(toLead.ownerId).toBe(lead.id)

      // Руководитель передаёт кому угодно в проекте, но только участнику проекта.
      const transferred = await json<DealView>(
        await call(head, 'PUT', `/v1/deals/${deal.id}`, { ownerId: managerA2.id }),
      )
      expect(transferred.ownerId).toBe(managerA2.id)
      const outsider = await call(head, 'PUT', `/v1/deals/${deal.id}`, { ownerId: 'no-such-user' })
      expect(outsider.status).toBe(422)
      expect(await outsider.json()).toEqual({ code: 'OWNER_NOT_MEMBER' })
    })
  })

  describe('«одна открытая сделка у человека в воронке»', () => {
    async function conflictOf(res: Response) {
      expect(res.status, JSON.stringify(await res.clone().json())).toBe(409)
      return json<{ code: string; details?: Record<string, unknown> }>(res)
    }

    it('создание: вторая открытая — 409 с id первой; в другой воронке — можно; архивная не мешает', async () => {
      const contact = await createContact(admin, 'Один')
      const first = await createDeal(admin, { pipelineId: dirA.main.id, contactId: contact.id })
      expect(
        await conflictOf(
          await call(admin, 'POST', '/v1/deals', {
            title: 'Друга',
            pipelineId: dirA.main.id,
            contactId: contact.id,
          }),
        ),
      ).toEqual({ code: 'OPEN_DEAL_EXISTS', details: { dealId: first.id } })
      await createDeal(admin, { pipelineId: dirA.other.id, contactId: contact.id })

      await expectStatus(await act(admin, first.id, 'archive'), 200)
      const fresh = await createDeal(admin, { pipelineId: dirA.main.id, contactId: contact.id })
      expect(fresh.status).toBe('open')

      // Возврат из архива — второй открытой стала бы первая.
      expect(await conflictOf(await act(admin, first.id, 'unarchive'))).toEqual({
        code: 'OPEN_DEAL_EXISTS',
        details: { dealId: fresh.id },
      })
    })

    it('повторное открытие, перенос в воронку, смена основного контакта — 409', async () => {
      const contact = await createContact(admin, 'Шляхи')
      const lost = await createDeal(admin, { pipelineId: dirA.main.id, contactId: contact.id })
      await expectStatus(await act(admin, lost.id, 'lose', { lostReasonId: dirA.reason }), 200)
      const open = await createDeal(admin, { pipelineId: dirA.main.id, contactId: contact.id })
      expect((await conflictOf(await act(admin, lost.id, 'reopen'))).details).toEqual({
        dealId: open.id,
      })

      const elsewhere = await createDeal(admin, {
        pipelineId: dirA.other.id,
        contactId: contact.id,
      })
      expect(
        (await conflictOf(await act(admin, elsewhere.id, 'move', { pipelineId: dirA.main.id })))
          .details,
      ).toEqual({ dealId: open.id })

      const someoneElse = await createContact(admin, 'Інший')
      const theirs = await createDeal(admin, {
        pipelineId: dirA.main.id,
        contactId: someoneElse.id,
      })
      expect(
        (
          await conflictOf(
            await call(admin, 'PUT', `/v1/deals/${theirs.id}`, { primaryContactId: contact.id }),
          )
        ).details,
      ).toEqual({ dealId: open.id })
      // Ничего не поменялось.
      const unchanged = await json<DealView>(await call(admin, 'GET', `/v1/deals/${theirs.id}`))
      expect(unchanged.primaryContactId).toBe(someoneElse.id)
    })

    it('восстановление из корзины и допродажа — 409', async () => {
      const contact = await createContact(admin, 'Кошик')
      const trashed = await createDeal(admin, { pipelineId: dirA.main.id, contactId: contact.id })
      await expectStatus(await call(admin, 'DELETE', `/v1/deals/${trashed.id}`), 204)
      const open = await createDeal(admin, { pipelineId: dirA.main.id, contactId: contact.id })
      expect((await conflictOf(await act(admin, trashed.id, 'restore'))).details).toEqual({
        dealId: open.id,
      })

      const inUpsell = await createDeal(admin, {
        pipelineId: dirA.upsell.id,
        contactId: contact.id,
      })
      const won = await createDeal(admin, { pipelineId: dirA.other.id, contactId: contact.id })
      await expectStatus(await act(admin, won.id, 'win'), 200)
      expect((await conflictOf(await act(admin, won.id, 'upsell'))).details).toEqual({
        dealId: inUpsell.id,
      })
    })

    it('мешающая сделка не видна — без её id, только имя менеджера', async () => {
      // Контакт создал менеджер A2 (он видит его), сделка — у менеджера A1.
      const contact = await createContact(managerA2, 'Чужий клієнт')
      await createDeal(admin, {
        pipelineId: dirA.main.id,
        contactId: contact.id,
        ownerId: managerA1.id,
      })
      expect(
        await conflictOf(
          await call(managerA2, 'POST', '/v1/deals', {
            title: 'Моя',
            pipelineId: dirA.main.id,
            contactId: contact.id,
          }),
        ),
      ).toEqual({ code: 'OPEN_DEAL_EXISTS', details: { managerName: 'Ганна Вигадана' } })
    })

    it('база держит правило и без API: вторая открытая строка — нарушение уникальности', async () => {
      const contact = await createContact(admin, 'База')
      const deal = await createDeal(admin, { pipelineId: dirA.main.id, contactId: contact.id })
      await expect(
        inProject(projectA, (trx) =>
          sql`insert into deal (project_id, title, pipeline_id, stage_id, primary_contact_id)
              values (${projectA}, 'Т', ${deal.pipelineId}, ${deal.stageId}, ${contact.id})`.execute(
            trx,
          ),
        ),
      ).rejects.toMatchObject({ code: '23505', constraint: 'deal_one_open_per_contact' })
    })
  })

  describe('одновременные запросы', () => {
    /**
     * Ждёт, пока `count` запросов к базе теста ждут блокировку (pg_stat_activity,
     * wait_event_type = 'Lock'), — не дольше 10 секунд, потом ошибка.
     */
    async function lockWaiters(count: number) {
      const deadline = Date.now() + 10_000
      for (;;) {
        const { rows } = await sql<{ waiting: number }>`
          select count(*)::int as waiting from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
        `.execute(h.owner)
        if ((rows[0]?.waiting ?? 0) >= count) return
        if (Date.now() > deadline) throw new Error('запросы не дошли до блокировки строки')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }

    /**
     * Держит строку сделки `dealId` заблокированной отдельной транзакцией, запускает запросы
     * `start` и отпускает строку, только когда `count` из них ждут блокировку в базе: так
     * запросы сходятся в базе, а не доходят до неё по очереди. `start` может запускать запросы
     * по одному, дожидаясь каждого (lockWaiters), — так задаётся, кто ждёт строку первым и
     * первым её получит. Ошибка ожидания откатывает транзакцию — строка отпускается.
     */
    async function whileDealLocked(
      dealId: string,
      count: number,
      start: () => Promise<Response>[] | Promise<Promise<Response>[]>,
    ): Promise<Response[]> {
      let requests: Promise<Response>[] = []
      await h.owner.transaction().execute(async (trx) => {
        await trx.selectFrom('deal').select('id').where('id', '=', dealId).forUpdate().execute()
        requests = await start()
        await lockWaiters(count)
      })
      return Promise.all(requests)
    }

    /** Сделки `a` и `b` по возрастанию id. */
    const byId = <T extends { id: string }>(a: T, b: T): [T, T] => (a.id < b.id ? [a, b] : [b, a])

    it('«стереть X» и «в корзину Y» с общими сделками (X — участник, Y — основной) — без взаимоблокировки', async () => {
      const x = await createContact(admin, 'Учасник')
      const y = await createContact(admin, 'Основний')
      const [low, high] = byId(
        await createDeal(admin, { pipelineId: dirA.main.id, contactId: y.id }),
        await createDeal(admin, { pipelineId: dirA.other.id, contactId: y.id }),
      )
      // Порядок создания обратный порядку id: сделка с большим id создана раньше.
      await h.owner
        .updateTable('deal')
        .set({ created_at: sql`now() - interval '1 hour'` })
        .where('id', '=', high.id)
        .execute()
      for (const deal of [low, high]) {
        await expectStatus(
          await call(admin, 'POST', `/v1/deals/${deal.id}/participants`, { contactId: x.id }),
          201,
        )
      }
      await expectStatus(await call(admin, 'DELETE', `/v1/contacts/${x.id}`), 204)
      // Список в ответе 409 — по-прежнему по времени создания.
      const ask = await call(admin, 'DELETE', `/v1/contacts/${y.id}`)
      expect(ask.status).toBe(409)
      expect(await ask.json()).toMatchObject({
        details: { deals: [{ id: high.id }, { id: low.id }] },
      })

      // Сделка с меньшим id заблокирована; первым её ждёт «стереть X», вторым — «в корзину Y».
      // Если Y блокирует сделки не по id, он держит сделку с большим id, X получает сделку с
      // меньшим и ждёт сделку с большим — взаимоблокировка, 40P01, ответ 500.
      const [purged, trashed] = await whileDealLocked(low.id, 2, async () => {
        const purge = call(admin, 'DELETE', `/v1/contacts/${x.id}/permanent`)
        await lockWaiters(1)
        return [purge, call(admin, 'DELETE', `/v1/contacts/${y.id}?confirm=${low.id},${high.id}`)]
      })
      expect([purged?.status, trashed?.status]).toEqual([204, 204])
      const contactLeft = await h.owner
        .selectFrom('contact')
        .select('id')
        .where('id', '=', x.id)
        .execute()
      expect(contactLeft).toEqual([])
      const participants = await h.owner
        .selectFrom('deal_participant')
        .select('id')
        .where('deal_id', 'in', [low.id, high.id])
        .execute()
      expect(participants).toEqual([])
      const deals = await h.owner
        .selectFrom('deal')
        .select('deleted_at')
        .where('id', 'in', [low.id, high.id])
        .execute()
      expect(deals.map((d) => d.deleted_at !== null)).toEqual([true, true])
    })

    it('одновременное «стереть» двух контактов, участников сделок друг друга, — без взаимоблокировки', async () => {
      const a = await createContact(admin, 'Перший')
      const b = await createContact(admin, 'Другий')
      const dealA = await createDeal(admin, { pipelineId: dirA.main.id, contactId: a.id })
      const dealB = await createDeal(admin, { pipelineId: dirA.main.id, contactId: b.id })
      await expectStatus(
        await call(admin, 'POST', `/v1/deals/${dealA.id}/participants`, { contactId: b.id }),
        201,
      )
      await expectStatus(
        await call(admin, 'POST', `/v1/deals/${dealB.id}/participants`, { contactId: a.id }),
        201,
      )
      // W — основной в сделке с меньшим id, X — в сделке с большим; каждый — участник другой.
      const [low, high] = byId(dealA, dealB)
      const w = low === dealA ? a : b
      const x = low === dealA ? b : a
      for (const [contact, deal] of [
        [w, low],
        [x, high],
      ] as const) {
        await expectStatus(
          await call(admin, 'DELETE', `/v1/contacts/${contact.id}?confirm=${deal.id}`),
          204,
        )
      }

      // Сделка с меньшим id заблокирована; первым её ждёт «стереть W», вторым — «стереть X».
      // Если X блокирует свои сделки двумя заходами (где основной, потом где участник), он
      // держит сделку с большим id и ждёт сделку с меньшим; W получает сделку с меньшим и ждёт
      // сделку с большим — взаимоблокировка, 40P01, ответ 500.
      const [first, second] = await whileDealLocked(low.id, 2, async () => {
        const purgeW = call(admin, 'DELETE', `/v1/contacts/${w.id}/permanent`)
        await lockWaiters(1)
        return [purgeW, call(admin, 'DELETE', `/v1/contacts/${x.id}/permanent`)]
      })
      expect([first?.status, second?.status]).toEqual([204, 204])
      const left = await h.owner
        .selectFrom('deal')
        .select('id')
        .where('id', 'in', [low.id, high.id])
        .execute()
      expect(left).toEqual([])
    })

    it('10 параллельных созданий открытой сделки одного контакта в воронке — ровно одна', async () => {
      const contact = await createContact(admin, 'Гонка')
      const pipeline = await createPipeline(projectA, ['g1'])
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          call(admin, 'POST', '/v1/deals', {
            title: `Гонка ${i}`,
            pipelineId: pipeline.id,
            contactId: contact.id,
          }),
        ),
      )
      const statuses = results.map((r) => r.status).sort()
      expect(statuses).toEqual([201, ...Array(9).fill(409)])
      const rows = await h.owner
        .selectFrom('deal')
        .select('id')
        .where('pipeline_id', '=', pipeline.id)
        .execute()
      expect(rows).toHaveLength(1)
    })

    it('2 параллельных «взять в работу» — один ответственный, второму 409', async () => {
      const contact = await createContact(admin, 'Черга')
      const deal = await createDeal(admin, {
        pipelineId: dirA.main.id,
        contactId: contact.id,
        ownerId: null,
      })
      // Оба запроса сходятся в базе: строка сделки заблокирована, пока оба не ждут её.
      const [first, second] = await whileDealLocked(deal.id, 2, () => [
        act(managerA1, deal.id, 'take'),
        act(managerA2, deal.id, 'take'),
      ])
      const statuses = [first?.status, second?.status].sort()
      expect(statuses).toEqual([200, 409])
      const winner = first?.status === 200 ? managerA1 : managerA2
      const loser = first?.status === 200 ? second : first
      expect(await loser?.json()).toEqual({ code: 'DEAL_ALREADY_TAKEN' })
      const row = await h.owner
        .selectFrom('deal')
        .select('owner_id')
        .where('id', '=', deal.id)
        .executeTakeFirstOrThrow()
      expect(row.owner_id).toBe(winner.id)
      expect(await history(deal.id)).toEqual([
        { field: 'ownerId', before: null, after: winner.id, actor_id: winner.id },
      ])
      // Взятая сделка — уже не очередь: второй её не видит.
      const other = winner === managerA1 ? managerA2 : managerA1
      await expectStatus(await call(other, 'GET', `/v1/deals/${deal.id}`), 404)
    })
  })

  describe('статусы', () => {
    it('проигрыш без причины, с архивной или в архивной группе — 422', async () => {
      const contact = await createContact(admin, 'Програш')
      const deal = await createDeal(admin, { pipelineId: dirA.main.id, contactId: contact.id })
      for (const [body, code] of [
        [{}, 'LOST_REASON_REQUIRED'],
        [{ lostReasonId: null }, 'LOST_REASON_REQUIRED'],
        [{ lostReasonId: dirA.archivedReason }, 'LOST_REASON_ARCHIVED'],
        [{ lostReasonId: dirA.reasonInArchivedGroup }, 'LOST_REASON_ARCHIVED'],
        [{ lostReasonId: dirB.reason }, 'LOST_REASON_NOT_FOUND'],
      ] as const) {
        const res = await act(admin, deal.id, 'lose', body)
        expect(res.status).toBe(422)
        expect(((await res.json()) as { code: string }).code).toBe(code)
      }
      const same = await json<DealView>(await call(admin, 'GET', `/v1/deals/${deal.id}`))
      expect(same.status).toBe('open')

      // База держит то же правило без API.
      await expect(
        inProject(projectA, (trx) =>
          sql`update deal set status = 'lost', lost_at = now() where id = ${deal.id}`.execute(trx),
        ),
      ).rejects.toMatchObject({ code: '23514' })
      await expect(
        inProject(projectA, (trx) =>
          sql`update deal set status = 'lost', lost_at = now(), lost_reason_id = ${dirA.archivedReason}
              where id = ${deal.id}`.execute(trx),
        ),
      ).rejects.toMatchObject({ code: 'DL002' })
    })

    it('проигрыш ставит причину и lost_at; повторное открытие снимает причину и пишет её в историю', async () => {
      const contact = await createContact(admin, 'Повернення')
      const deal = await createDeal(admin, { pipelineId: dirA.main.id, contactId: contact.id })
      await expectStatus(await act(admin, deal.id, 'stage', { stageId: dirA.main.stages[1] }), 200)
      const lost = await json<DealView>(
        await act(admin, deal.id, 'lose', { lostReasonId: dirA.reason }),
      )
      expect(lost).toMatchObject({ status: 'lost', lostReasonId: dirA.reason, wonAt: null })
      expect(lost.lostAt).not.toBeNull()

      const reopened = await json<DealView>(await act(admin, deal.id, 'reopen'))
      expect(reopened).toMatchObject({
        status: 'open',
        lostReasonId: null,
        lostAt: null,
        // Остаётся на своём этапе.
        stageId: dirA.main.stages[1],
      })
      const log = await history(deal.id)
      expect(log).toContainEqual({
        field: 'lostReasonId',
        before: dirA.reason,
        after: null,
        actor_id: admin.id,
      })
      expect(log).toContainEqual({
        field: 'status',
        before: 'lost',
        after: 'open',
        actor_id: admin.id,
      })
    })

    it('архив — отметка в любом статусе: статус и этап не меняются', async () => {
      const contact = await createContact(admin, 'Архівна')
      const deal = await createDeal(admin, { pipelineId: dirA.main.id, contactId: contact.id })
      await expectStatus(await act(admin, deal.id, 'win'), 200)
      const archived = await json<DealView>(await act(admin, deal.id, 'archive'))
      expect(archived).toMatchObject({ status: 'won', stageId: deal.stageId })
      expect(archived.archivedAt).not.toBeNull()
      const back = await json<DealView>(await act(admin, deal.id, 'unarchive'))
      expect(back).toMatchObject({ status: 'won', archivedAt: null })
    })
  })

  describe('история и «ровно то, что сказано» (ADR 0003)', () => {
    it('этап, сумма, валюта, ответственный и статус — «было → стало» с автором', async () => {
      const contact = await createContact(admin, 'Історія')
      const deal = await createDeal(admin, { pipelineId: dirA.main.id, contactId: contact.id })
      await expectStatus(await act(admin, deal.id, 'stage', { stageId: dirA.main.stages[2] }), 200)
      await expectStatus(
        await call(head, 'PUT', `/v1/deals/${deal.id}`, {
          amount: 250,
          currency: 'USD',
          ownerId: managerA1.id,
        }),
        200,
      )
      await expectStatus(await act(managerA1, deal.id, 'win'), 200)

      const log = await history(deal.id)
      expect(log).toEqual(
        expect.arrayContaining([
          {
            field: 'stageId',
            before: dirA.main.stages[0],
            after: dirA.main.stages[2],
            actor_id: admin.id,
          },
          { field: 'amount', before: 0, after: 250, actor_id: head.id },
          { field: 'currency', before: 'EUR', after: 'USD', actor_id: head.id },
          { field: 'ownerId', before: admin.id, after: managerA1.id, actor_id: head.id },
          { field: 'status', before: 'open', after: 'won', actor_id: managerA1.id },
        ]),
      )
      const entries = await json<DealHistoryEntry[]>(
        await call(managerA1, 'GET', `/v1/deals/${deal.id}/history`),
      )
      expect(entries[0]).toMatchObject({ actorId: managerA1.id, actorName: 'Ганна Вигадана' })
      expect(entries.map((e) => e.field)).toContain('stageId')
    })

    it('смена этапа не меняет статус и сумму; выигрыш не меняет этап', async () => {
      const contact = await createContact(admin, 'Рівно')
      const deal = await createDeal(admin, {
        pipelineId: dirA.main.id,
        contactId: contact.id,
        amount: 100,
      })
      const moved = await json<DealView>(
        await act(admin, deal.id, 'stage', { stageId: dirA.main.stages[2] }),
      )
      const changed = (a: DealView, b: DealView) =>
        (Object.keys(a) as (keyof DealView)[])
          .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
          .sort()
      expect(changed(deal, moved)).toEqual(['stageChangedAt', 'stageId', 'updatedAt'])

      const won = await json<DealView>(await act(admin, deal.id, 'win'))
      expect(changed(moved, won)).toEqual(['status', 'updatedAt', 'wonAt'])

      const archived = await json<DealView>(await act(admin, deal.id, 'archive'))
      expect(changed(won, archived)).toEqual(['archivedAt', 'updatedAt'])

      const renamed = await json<DealView>(
        await call(admin, 'PUT', `/v1/deals/${deal.id}`, { title: 'Нова назва' }),
      )
      expect(changed(archived, renamed)).toEqual(['title', 'updatedAt'])
    })
  })

  describe('перенос в другую воронку', () => {
    it('по умолчанию — первый этап новой воронки, можно выбрать этап; чужой этап — 404', async () => {
      const contact = await createContact(admin, 'Перенос')
      const deal = await createDeal(admin, { pipelineId: dirA.main.id, contactId: contact.id })
      const moved = await json<DealView>(
        await act(admin, deal.id, 'move', { pipelineId: dirA.other.id }),
      )
      expect(moved).toMatchObject({ pipelineId: dirA.other.id, stageId: dirA.other.stages[0] })
      await expectStatus(
        await act(admin, deal.id, 'move', {
          pipelineId: dirA.main.id,
          stageId: dirA.other.stages[1],
        }),
        404,
      )
      const chosen = await json<DealView>(
        await act(admin, deal.id, 'move', {
          pipelineId: dirA.main.id,
          stageId: dirA.main.stages[2],
        }),
      )
      expect(chosen).toMatchObject({ pipelineId: dirA.main.id, stageId: dirA.main.stages[2] })
    })
  })

  describe('допродажа', () => {
    it('из выигранной: новая открытая в воронке допродаж на первом этапе; исходная не меняется', async () => {
      const org = await json<{ id: string }>(
        await call(admin, 'POST', '/v1/organizations', { name: 'ТОВ Вигадка' }),
      )
      const contact = await createContact(admin, 'Марія', projectA, 'Приклад')
      const source = await createDeal(admin, {
        pipelineId: dirA.main.id,
        contactId: contact.id,
        organizationId: org.id,
        amount: 900,
      })
      const notWon = await act(admin, source.id, 'upsell')
      expect(notWon.status).toBe(409)
      expect(await notWon.json()).toEqual({ code: 'DEAL_NOT_WON' })

      const won = await json<DealView>(await act(admin, source.id, 'win'))
      // Чужую выигранную сделку менеджер не видит — и допродажу из неё не создаст.
      await expectStatus(await act(managerA1, source.id, 'upsell'), 404)
      const created = await json<DealView>(
        await expectStatus(await act(admin, source.id, 'upsell'), 201),
      )
      expect(created).toMatchObject({
        title: 'Марія Приклад — допродаж',
        pipelineId: dirA.upsell.id,
        stageId: dirA.upsell.stages[0],
        status: 'open',
        primaryContactId: contact.id,
        organizationId: org.id,
        amount: 0,
        ownerId: admin.id,
      })
      expect(await json<DealView>(await call(admin, 'GET', `/v1/deals/${source.id}`))).toEqual(won)

      // Другая воронка — по выбору пользователя.
      const elsewhere = await json<DealView>(
        await expectStatus(
          await act(admin, source.id, 'upsell', { pipelineId: dirA.other.id, title: 'Курс 2' }),
          201,
        ),
      )
      expect(elsewhere).toMatchObject({ pipelineId: dirA.other.id, title: 'Курс 2' })
    })
  })

  describe('допродажа: права', () => {
    it('исходная сделка — в охвате изменения, её контакт — в охвате контактов', async () => {
      const contact = await createContact(managerA1, 'Допродаж-охоплення')
      const won = await createDeal(managerA1, { pipelineId: dirA.main.id, contactId: contact.id })
      await expectStatus(await act(managerA1, won.id, 'win'), 200)

      // Видит все сделки, меняет только свои: чужую выигранную видит, но допродать не может.
      const readOnly = await act(readAll, won.id, 'upsell')
      expect(readOnly.status).toBe(403)
      expect(await readOnly.json()).toEqual({ code: 'PERMISSION_DENIED' })
      // Сделки — все, контакты — свои: контакт сделки коллеги вне охвата контактов.
      const outOfScope = await act(dealsAll, won.id, 'upsell')
      expect(outOfScope.status).toBe(404)
      expect(await outOfScope.json()).toEqual({ code: 'CONTACT_NOT_FOUND' })

      const deals = await h.owner
        .selectFrom('deal')
        .select('id')
        .where('primary_contact_id', '=', contact.id)
        .execute()
      expect(deals).toEqual([{ id: won.id }])
      await expectStatus(await act(managerA1, won.id, 'upsell'), 201)
    })
  })

  describe('привязка контакта к сделке', () => {
    it('только из охвата изменения контактов: на каждом пути 403, контакт не становится «своим»', async () => {
      const foreign = await createContact(admin, 'Чужий')
      const own = await createContact(contactsReadAll, 'Свій')
      const create = await call(contactsReadAll, 'POST', '/v1/deals', {
        title: 'Угода',
        pipelineId: dirA.main.id,
        contactId: foreign.id,
      })
      expect(create.status).toBe(403)
      expect(await create.json()).toEqual({ code: 'PERMISSION_DENIED' })

      const deal = await createDeal(contactsReadAll, {
        pipelineId: dirA.main.id,
        contactId: own.id,
      })
      await expectStatus(
        await call(contactsReadAll, 'PUT', `/v1/deals/${deal.id}`, {
          primaryContactId: foreign.id,
        }),
        403,
      )
      await expectStatus(
        await call(contactsReadAll, 'POST', `/v1/deals/${deal.id}/participants`, {
          contactId: foreign.id,
        }),
        403,
      )
      const after = await json<DealView>(await call(contactsReadAll, 'GET', `/v1/deals/${deal.id}`))
      expect(after).toMatchObject({ primaryContactId: own.id, participants: [] })
      // Чужой контакт так и не стал «своим»: менять и удалять его нельзя.
      await expectStatus(
        await call(contactsReadAll, 'PUT', `/v1/contacts/${foreign.id}`, { firstName: 'Інший' }),
        403,
      )
      // Контакт вне охвата чтения — как несуществующий.
      await expectStatus(
        await call(managerA1, 'POST', '/v1/deals', {
          title: 'Угода',
          pipelineId: dirA.main.id,
          contactId: foreign.id,
        }),
        404,
      )
    })

    it('менеджер, взявший сделку общей очереди, меняет её контакт и ставит его в свою сделку', async () => {
      const contact = await createContact(admin, 'З черги')
      const queued = await createDeal(admin, {
        pipelineId: dirA.main.id,
        contactId: contact.id,
        ownerId: null,
      })
      await expectStatus(await act(managerA2, queued.id, 'take'), 200)
      await expectStatus(
        await call(managerA2, 'PUT', `/v1/contacts/${contact.id}`, { firstName: 'Оновлений' }),
        200,
      )
      await createDeal(managerA2, { pipelineId: dirA.other.id, contactId: contact.id })
    })
  })

  describe('участники', () => {
    it('добавить, сменить роль, убрать — с историей; основной контакт участником не бывает', async () => {
      const contact = await createContact(admin, 'Основний')
      const helper = await createContact(admin, 'Помічник')
      const deal = await createDeal(admin, {
        pipelineId: dirA.main.id,
        contactId: contact.id,
        ownerId: managerA1.id,
      })
      const primary = await call(admin, 'POST', `/v1/deals/${deal.id}/participants`, {
        contactId: contact.id,
      })
      expect(primary.status).toBe(409)
      expect(await primary.json()).toEqual({ code: 'CONTACT_IS_PRIMARY' })

      const added = await json<DealView>(
        await expectStatus(
          await call(admin, 'POST', `/v1/deals/${deal.id}/participants`, {
            contactId: helper.id,
            role: 'оплачує',
          }),
          201,
        ),
      )
      expect(added.participants).toEqual([{ contactId: helper.id, role: 'оплачує' }])
      await expectStatus(
        await call(admin, 'POST', `/v1/deals/${deal.id}/participants`, { contactId: helper.id }),
        409,
      )
      // Основным — только не участник.
      await expectStatus(
        await call(admin, 'PUT', `/v1/deals/${deal.id}`, { primaryContactId: helper.id }),
        409,
      )

      // Участник сделки — «свой» контакт для её менеджера; коллеге — нет.
      await expectStatus(await call(managerA1, 'GET', `/v1/contacts/${helper.id}`), 200)
      await expectStatus(await call(managerA1, 'GET', `/v1/contacts/${contact.id}`), 200)
      await expectStatus(await call(managerA2, 'GET', `/v1/contacts/${helper.id}`), 404)

      const renamed = await json<DealView>(
        await call(admin, 'PUT', `/v1/deals/${deal.id}/participants/${helper.id}`, {
          role: 'колега',
        }),
      )
      expect(renamed.participants).toEqual([{ contactId: helper.id, role: 'колега' }])
      await expectStatus(
        await call(admin, 'DELETE', `/v1/deals/${deal.id}/participants/${helper.id}`),
        204,
      )
      expect(
        (await history(deal.id)).filter((e) => e.field === 'participants').map((e) => e.after),
      ).toEqual([
        [{ contactId: helper.id, role: 'оплачує' }],
        [{ contactId: helper.id, role: 'колега' }],
        [],
      ])
    })
  })

  describe('«чужой клиент» в контактах', () => {
    it('телефон контакта вне охвата — 409 с именем менеджера его открытой сделки, без данных', async () => {
      const phone = fakePhone()
      const contactRes = await call(admin, 'POST', '/v1/contacts', {
        firstName: 'Зайнятий',
        phones: [phone],
      })
      const contact = await json<ContactView>(contactRes)
      await createDeal(admin, {
        pipelineId: dirA.main.id,
        contactId: contact.id,
        ownerId: managerA1.id,
      })
      const res = await call(managerA2, 'POST', '/v1/contacts', {
        firstName: 'Спроба',
        phones: [phone],
      })
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({
        code: 'CONTACT_OUT_OF_SCOPE',
        details: { managerName: 'Ганна Вигадана' },
      })
    })
  })

  describe('корзина', () => {
    it('удаление контакта, основного в двух сделках: сначала список, с подтверждением — все три в корзине', async () => {
      const contact = await createContact(admin, 'Видалення')
      const d1 = await createDeal(admin, { pipelineId: dirA.main.id, contactId: contact.id })
      const d2 = await createDeal(admin, { pipelineId: dirA.other.id, contactId: contact.id })

      // Менеджер не может удалять сделки — и контакт с ними.
      await expectStatus(await call(managerA1, 'DELETE', `/v1/contacts/${contact.id}`), 403)

      const ask = await call(admin, 'DELETE', `/v1/contacts/${contact.id}`)
      expect(ask.status).toBe(409)
      expect(await ask.json()).toEqual({
        code: 'CONTACT_HAS_DEALS',
        details: {
          deals: [
            { id: d1.id, title: d1.title },
            { id: d2.id, title: d2.title },
          ],
        },
      })
      const nothingDeleted = async () => {
        await expectStatus(await call(admin, 'GET', `/v1/contacts/${contact.id}`), 200)
        await expectStatus(await call(admin, 'GET', `/v1/deals/${d1.id}`), 200)
        await expectStatus(await call(admin, 'GET', `/v1/deals/${d2.id}`), 200)
      }
      await nothingDeleted()
      // Подтверждён не тот список — снова вопрос.
      await expectStatus(
        await call(admin, 'DELETE', `/v1/contacts/${contact.id}?confirm=${d1.id}`),
        409,
      )
      await nothingDeleted()

      await expectStatus(
        await call(admin, 'DELETE', `/v1/contacts/${contact.id}?confirm=${d1.id},${d2.id}`),
        204,
      )
      await expectStatus(await call(admin, 'GET', `/v1/contacts/${contact.id}`), 404)
      await expectStatus(await call(admin, 'GET', `/v1/deals/${d1.id}`), 404)
      await expectStatus(await call(admin, 'GET', `/v1/deals/${d2.id}`), 404)
      // Сделку не восстановить, пока её контакт в корзине.
      const blocked = await act(admin, d1.id, 'restore')
      expect(blocked.status).toBe(409)
      expect(await blocked.json()).toEqual({ code: 'CONTACT_IN_TRASH' })

      await expectStatus(await call(head, 'POST', `/v1/contacts/${contact.id}/restore`), 200)
      await expectStatus(await call(admin, 'GET', `/v1/deals/${d1.id}`), 200)
      await expectStatus(await call(admin, 'GET', `/v1/deals/${d2.id}`), 200)
      expect((await history(d1.id)).map((e) => e.field)).toEqual(['deletedAt', 'deletedAt'])
    })

    it('восстановление контакта не возвращает сделку, удалённую раньше отдельно', async () => {
      const contact = await createContact(admin, 'Окремо')
      const early = await createDeal(admin, { pipelineId: dirA.main.id, contactId: contact.id })
      await expectStatus(await call(admin, 'DELETE', `/v1/deals/${early.id}`), 204)
      const later = await createDeal(admin, { pipelineId: dirA.other.id, contactId: contact.id })
      await expectStatus(
        await call(admin, 'DELETE', `/v1/contacts/${contact.id}?confirm=${later.id}`),
        204,
      )
      await expectStatus(await call(admin, 'POST', `/v1/contacts/${contact.id}/restore`), 200)
      await expectStatus(await call(admin, 'GET', `/v1/deals/${later.id}`), 200)
      await expectStatus(await call(admin, 'GET', `/v1/deals/${early.id}`), 404)
      const restored = await json<DealView>(await act(admin, early.id, 'restore'))
      expect(restored.deletedAt).toBeNull()
    })

    it('окончательное удаление контакта удаляет его сделки из корзины вместе с историей', async () => {
      const contact = await createContact(admin, 'Назавжди')
      const deal = await createDeal(admin, { pipelineId: dirA.main.id, contactId: contact.id })
      await expectStatus(await act(admin, deal.id, 'win'), 200)
      await expectStatus(
        await call(admin, 'DELETE', `/v1/contacts/${contact.id}?confirm=${deal.id}`),
        204,
      )
      await expectStatus(await call(admin, 'DELETE', `/v1/contacts/${contact.id}/permanent`), 204)
      const left = await h.owner.selectFrom('deal').select('id').where('id', '=', deal.id).execute()
      expect(left).toEqual([])
      expect(await history(deal.id)).toEqual([])
    })

    /** Строка в корзине: отметка deleted_at, прочитанная мимо API. */
    async function trashedAt(table: 'deal' | 'contact', id: string) {
      const row = await h.owner
        .selectFrom(table)
        .select('deleted_at')
        .where('id', '=', id)
        .executeTakeFirst()
      return row?.deleted_at ?? null
    }

    it('восстановление и окончательное удаление контакта — 403, если его сделки вне охвата изменения', async () => {
      const contact = await createContact(admin, 'Чужі угоди')
      const deal = await createDeal(admin, {
        pipelineId: dirA.main.id,
        contactId: contact.id,
        ownerId: managerA1.id,
      })
      await expectStatus(
        await call(admin, 'DELETE', `/v1/contacts/${contact.id}?confirm=${deal.id}`),
        204,
      )
      // Контакты и корзина — все, сделки — только свои: сделку менеджера не тронуть.
      const restore = await call(trashKeeper, 'POST', `/v1/contacts/${contact.id}/restore`)
      expect(restore.status).toBe(403)
      expect(await restore.json()).toEqual({ code: 'PERMISSION_DENIED' })
      const purge = await call(trashKeeper, 'DELETE', `/v1/contacts/${contact.id}/permanent`)
      expect(purge.status).toBe(403)
      expect(await purge.json()).toEqual({ code: 'PERMISSION_DENIED' })
      expect(await trashedAt('contact', contact.id)).not.toBeNull()
      expect(await trashedAt('deal', deal.id)).not.toBeNull()
      expect((await history(deal.id)).map((e) => e.field)).toEqual(['deletedAt'])
    })

    it('окончательное удаление контакта не стирает чужую сделку, удалённую раньше отдельно', async () => {
      const contact = await createContact(trashKeeper, 'Мій контакт')
      const foreign = await createDeal(admin, {
        pipelineId: dirA.main.id,
        contactId: contact.id,
        ownerId: managerA1.id,
      })
      await expectStatus(await call(admin, 'DELETE', `/v1/deals/${foreign.id}`), 204)
      // Живых сделок у контакта нет — уходит в корзину без вопроса.
      await expectStatus(await call(trashKeeper, 'DELETE', `/v1/contacts/${contact.id}`), 204)
      await expectStatus(
        await call(trashKeeper, 'DELETE', `/v1/contacts/${contact.id}/permanent`),
        403,
      )
      expect(await trashedAt('deal', foreign.id)).not.toBeNull()
      expect(await trashedAt('contact', contact.id)).not.toBeNull()
      // Тот, кто может удалить и сделку, удаляет контакт окончательно вместе с ней.
      await expectStatus(await call(admin, 'DELETE', `/v1/contacts/${contact.id}/permanent`), 204)
      const left = await h.owner
        .selectFrom('deal')
        .select('id')
        .where('id', '=', foreign.id)
        .execute()
      expect(left).toEqual([])
    })

    it('контакт, видимый только через свою сделку, после удаления вместе с ней восстанавливается', async () => {
      const contact = await createContact(admin, 'Через угоду')
      const deal = await createDeal(admin, {
        pipelineId: dirA.main.id,
        contactId: contact.id,
        ownerId: trashOwn.id,
      })
      await expectStatus(
        await call(trashOwn, 'DELETE', `/v1/contacts/${contact.id}?confirm=${deal.id}`),
        204,
      )
      await expectStatus(await call(trashOwn, 'POST', `/v1/contacts/${contact.id}/restore`), 200)
      await expectStatus(await call(trashOwn, 'GET', `/v1/deals/${deal.id}`), 200)

      // Сделка, удалённая в корзину отдельно, контакт «своим» не делает.
      const other = await createContact(admin, 'Окрема угода')
      const separate = await createDeal(admin, {
        pipelineId: dirA.main.id,
        contactId: other.id,
        ownerId: trashOwn.id,
      })
      await expectStatus(await call(trashOwn, 'GET', `/v1/contacts/${other.id}`), 200)
      await expectStatus(await call(trashOwn, 'DELETE', `/v1/deals/${separate.id}`), 204)
      await expectStatus(await call(trashOwn, 'GET', `/v1/contacts/${other.id}`), 404)
    })

    it('окончательное удаление контакта-участника убирает его из сделок с записью в историю', async () => {
      const primary = await createContact(admin, 'Основний')
      const guest = await createContact(admin, 'Учасник')
      const deal = await createDeal(admin, { pipelineId: dirA.main.id, contactId: primary.id })
      await expectStatus(
        await call(admin, 'POST', `/v1/deals/${deal.id}/participants`, {
          contactId: guest.id,
          role: 'колега',
        }),
        201,
      )
      await expectStatus(await call(admin, 'DELETE', `/v1/contacts/${guest.id}`), 204)
      await expectStatus(await call(admin, 'DELETE', `/v1/contacts/${guest.id}/permanent`), 204)
      const view = await json<DealView>(await call(admin, 'GET', `/v1/deals/${deal.id}`))
      expect(view.participants).toEqual([])
      expect((await history(deal.id)).at(-1)).toEqual({
        field: 'participants',
        before: [{ contactId: guest.id, role: 'колега' }],
        after: [],
        actor_id: admin.id,
      })
    })
  })

  describe('этап с открытыми сделками', () => {
    it('удалить нельзя; после выигрыша — можно; открыть заново на удалённом этапе — 409', async () => {
      const pipeline = await createPipeline(projectA, ['e1', 'e2'])
      const contact = await createContact(admin, 'Етап')
      const deal = await createDeal(admin, { pipelineId: pipeline.id, contactId: contact.id })
      const stagePath = `/v1/pipelines/${pipeline.id}/stages/${deal.stageId}`
      const refused = await call(admin, 'DELETE', stagePath)
      expect(refused.status).toBe(409)
      expect(await refused.json()).toEqual({ code: 'STAGE_HAS_OPEN_DEALS' })

      // Архивная открытая сделка тоже стоит на этапе.
      await expectStatus(await act(admin, deal.id, 'archive'), 200)
      await expectStatus(await call(admin, 'DELETE', stagePath), 409)

      await expectStatus(await act(admin, deal.id, 'win'), 200)
      await expectStatus(await call(admin, 'DELETE', stagePath), 204)
      const reopen = await act(admin, deal.id, 'reopen')
      expect(reopen.status).toBe(409)
      expect(await reopen.json()).toEqual({ code: 'STAGE_DELETED' })
      // Сначала — на действующий этап, потом открыть.
      await expectStatus(await act(admin, deal.id, 'stage', { stageId: pipeline.stages[1] }), 200)
      await expectStatus(await act(admin, deal.id, 'reopen'), 200)
    })

    it('открытая сделка в корзине держит этап: удалить нельзя, сделка восстанавливается на него', async () => {
      const pipeline = await createPipeline(projectA, ['k1', 'k2'])
      const contact = await createContact(admin, 'Кошик')
      const deal = await createDeal(admin, { pipelineId: pipeline.id, contactId: contact.id })
      const stagePath = `/v1/pipelines/${pipeline.id}/stages/${deal.stageId}`

      await expectStatus(await call(admin, 'DELETE', `/v1/deals/${deal.id}`), 204)
      const refused = await call(admin, 'DELETE', stagePath)
      expect(refused.status).toBe(409)
      expect(await refused.json()).toEqual({ code: 'STAGE_HAS_OPEN_DEALS' })
      await expectStatus(await act(admin, deal.id, 'restore'), 200)

      // Удалённая вместе с контактом — так же.
      await expectStatus(
        await call(admin, 'DELETE', `/v1/contacts/${contact.id}?confirm=${deal.id}`),
        204,
      )
      await expectStatus(await call(admin, 'DELETE', stagePath), 409)
      await expectStatus(await call(admin, 'POST', `/v1/contacts/${contact.id}/restore`), 200)
      const restored = await json<DealView>(await call(admin, 'GET', `/v1/deals/${deal.id}`))
      expect(restored).toMatchObject({ stageId: deal.stageId, status: 'open', deletedAt: null })
    })
  })

  describe('откат миграции 0010_deals', () => {
    it('убирает и историю сделок', async () => {
      const contact = await createContact(admin, 'Відкат')
      const deal = await createDeal(admin, { pipelineId: dirA.other.id, contactId: contact.id })
      await expectStatus(await act(admin, deal.id, 'win'), 200)
      // Откат — в транзакции, которая потом откатывается: схема остальных тестов не меняется.
      await expect(
        h.owner.transaction().execute(async (trx) => {
          // Сначала миграции, чьи таблицы ссылаются на deal (откат идёт в обратном порядке).
          await downNotesFiles(trx as unknown as Kysely<unknown>)
          // Затем 0011_products: её строки товаров ссылаются на сделки.
          await downProducts(trx as unknown as Kysely<unknown>)
          await downDeals(trx as unknown as Kysely<unknown>)
          const left = await trx
            .selectFrom('change_log')
            .select('id')
            .where('entity_type', '=', 'deal')
            .execute()
          expect(left).toEqual([])
          throw new Error('откат проверки')
        }),
      ).rejects.toThrow('откат проверки')
      expect(await history(deal.id)).not.toEqual([])
    })
  })
})
