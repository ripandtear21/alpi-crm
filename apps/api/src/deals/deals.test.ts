import { randomInt } from 'node:crypto'
import { withProject } from '@alpi/db'
import type { TeamSummary } from '@alpi/shared'
import { type Kysely, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
      const [first, second] = await Promise.all([
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
      await expectStatus(await call(admin, 'GET', `/v1/contacts/${contact.id}`), 200)
      await expectStatus(await call(admin, 'GET', `/v1/deals/${d1.id}`), 200)
      // Подтверждён не тот список — снова вопрос.
      await expectStatus(
        await call(admin, 'DELETE', `/v1/contacts/${contact.id}?confirm=${d1.id}`),
        409,
      )

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
  })
})
