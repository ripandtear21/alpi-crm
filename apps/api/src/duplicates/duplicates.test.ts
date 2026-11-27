import { randomInt } from 'node:crypto'
import { withProject } from '@alpi/db'
import { type IntakeSourceWithKey, normalizeEmail, normalizePhone } from '@alpi/shared'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { NO_BULK_ACTIONS } from '../bulk/registry.ts'
import { replaceContactKeys } from '../contacts/contacts.ts'
import { startJobs } from '../jobs/jobs.ts'
import {
  type ApiHarness,
  type Method,
  ORIGIN,
  type SignedInUser,
  startApiHarness,
} from '../testing/api-harness.ts'
import { createApiKey, createRole } from '../testing/api-key.ts'
import { problemOf } from '../testing/problem.ts'
import { NO_TRASH_PURGERS } from '../trash/purge.ts'
import { scanAllDuplicates, scanDuplicates, syncDuplicatePairs } from './finder.ts'
import { DUPLICATE_SCAN_QUEUE, type DuplicateScanMessage, enqueueDuplicateScan } from './queue.ts'
import type { DuplicateDealRecord, DuplicateGroupView } from './routes.ts'

// Надсмотрщик за дублями и запросы экрана «Дублі» (тикет crm-intake/05) на настоящем PostgreSQL:
// API и надсмотрщик ходят ролью приложения, данные готовятся и проверяются служебным
// подключением. Имена, телефоны и email — вымышленные.

let counter = 0
const fakePhone = () => `+38067${randomInt(1_000_000, 9_999_999)}`
const fakeEmail = () => `dup-${++counter}-${randomInt(1e9)}@example.test`
const uniqueName = (prefix: string) => `${prefix}${randomInt(1e9).toString(36)}`

interface PairRow {
  entity_type: string
  a_id: string
  b_id: string
  reason: string
}

const sorted = (a: string, b: string) => (a < b ? [a, b] : [b, a]) as [string, string]

describe('надсмотрщик за дублями', () => {
  let h: ApiHarness
  let admin: SignedInUser
  let projectA: string
  let projectB: string
  /** Контакты — только смотреть; сделки — изменять. */
  let dealsOnly: SignedInUser
  /** Контакты: читать все, изменять свои (созданные им). */
  let writeOwn: SignedInUser
  /** Сделки: изменять все; контакты: только свои (созданные им). */
  let dealsContactsOwn: SignedInUser
  let pipelineCounter = 0

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_duplicates')
    admin = await h.signIn('owner')
    projectA = (await h.createProject(admin, 'Дублі А')).id
    projectB = (await h.createProject(admin, 'Дублі Б')).id
    dealsOnly = await h.signIn()
    writeOwn = await h.signIn()
    dealsContactsOwn = await h.signIn()
    const member = async (user: SignedInUser, permissions: unknown) => {
      const role = await createRole(h, projectA, permissions as never)
      await h.owner
        .insertInto('project_member')
        .values({ project_id: projectA, user_id: user.id, role_id: role })
        .execute()
    }
    await member(dealsOnly, {
      actions: { contacts: ['view'], deals: ['view', 'create', 'edit'] },
      scopes: { contacts: { read: 'all', write: 'all' }, deals: { read: 'all', write: 'all' } },
    })
    await member(writeOwn, {
      actions: { contacts: ['view', 'create', 'edit'], deals: ['view'] },
      scopes: { contacts: { read: 'all', write: 'own' } },
    })
    await member(dealsContactsOwn, {
      actions: { contacts: ['view'], deals: ['view', 'create', 'edit'] },
      scopes: { contacts: { read: 'own', write: 'own' }, deals: { read: 'all', write: 'all' } },
    })
  })

  afterAll(async () => {
    await h?.stop()
  })

  beforeEach(async () => {
    // Каждый тест — со своими записями: записи, пары и задачи прошлых тестов не мешают
    // проверкам (записи прошлых тестов — в корзину).
    await h.owner.deleteFrom('duplicate_pair').execute()
    await h.owner
      .updateTable('deal')
      .set({ deleted_at: sql`now()` })
      .where('deleted_at', 'is', null)
      .execute()
    await h.owner
      .updateTable('contact')
      .set({ deleted_at: sql`now()` })
      .where('deleted_at', 'is', null)
      .execute()
    await clearScanJobs()
  })

  const call = (
    user: SignedInUser,
    method: Method,
    path: string,
    body?: unknown,
    project = projectA,
  ) => user.api(method, path, { project, ...(body === undefined ? {} : { body }) })

  async function ok<T>(res: Response, status = 200): Promise<T> {
    const body = await res.json()
    expect(res.status, JSON.stringify(body)).toBe(status)
    return body as T
  }

  /** Контакт напрямую в базе — как пришедший импортом: API не дал бы два одинаковых телефона. */
  async function insertContact(
    contact: {
      firstName?: string
      lastName?: string | null
      phones?: string[]
      emails?: string[]
      createdBy?: string | null
      duplicateOf?: string
    } = {},
    project = projectA,
  ): Promise<string> {
    const { id } = await h.owner
      .insertInto('contact')
      .values({
        project_id: project,
        first_name: contact.firstName ?? uniqueName('Клієнт'),
        last_name: contact.lastName ?? null,
        created_by: contact.createdBy ?? null,
        possible_duplicate: contact.duplicateOf !== undefined,
        possible_duplicate_of: contact.duplicateOf ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    for (const [index, phone] of (contact.phones ?? []).entries()) {
      await h.owner
        .insertInto('contact_phone')
        .values({ project_id: project, contact_id: id, phone, is_primary: index === 0 })
        .execute()
    }
    for (const [index, email] of (contact.emails ?? []).entries()) {
      await h.owner
        .insertInto('contact_email')
        .values({ project_id: project, contact_id: id, email, is_primary: index === 0 })
        .execute()
    }
    return id
  }

  async function pipeline(project = projectA): Promise<{ id: string; stageId: string }> {
    const n = ++pipelineCounter
    const { id } = await h.owner
      .insertInto('pipeline')
      .values({ project_id: project, code: `dup${n}`, name: `Воронка ${n}`, position: 100 + n })
      .returning('id')
      .executeTakeFirstOrThrow()
    const stage = await h.owner
      .insertInto('stage')
      .values({ project_id: project, pipeline_id: id, name: 'Новий', position: 1 })
      .returning('id')
      .executeTakeFirstOrThrow()
    return { id, stageId: stage.id }
  }

  async function createDeal(contactId: string, p: { id: string; stageId: string }) {
    const deal = await ok<{ id: string }>(
      await call(admin, 'POST', '/v1/deals', {
        title: uniqueName('Угода '),
        pipelineId: p.id,
        stageId: p.stageId,
        contactId,
      }),
      201,
    )
    return deal.id
  }

  const scanJobs = async () =>
    (
      await sql<{ id: string; data: DuplicateScanMessage }>`
        select id, data from pgboss.job where name = ${DUPLICATE_SCAN_QUEUE} and state = 'created'
        order by created_on
      `.execute(h.owner)
    ).rows

  async function clearScanJobs() {
    await sql`delete from pgboss.job where name = ${DUPLICATE_SCAN_QUEUE}`.execute(h.owner)
  }

  /** Выполняет поставленные задачи поиска тем же обработчиком, что фоновые задачи. */
  async function drain(): Promise<DuplicateScanMessage[]> {
    const jobs = await scanJobs()
    for (const job of jobs) await scanDuplicates(h.appDb, job.data)
    await clearScanJobs()
    return jobs.map((job) => job.data)
  }

  const scanContact = (id: string, project = projectA) =>
    scanDuplicates(h.appDb, { projectId: project, entity: 'contact', id })

  const scanProject = (project = projectA) =>
    withProject(h.appDb, project, (trx) => syncDuplicatePairs(trx, project, null))

  const pairs = async (project = projectA): Promise<PairRow[]> =>
    h.owner
      .selectFrom('duplicate_pair')
      .select(['entity_type', 'a_id', 'b_id', 'reason'])
      .where('project_id', '=', project)
      .orderBy(['entity_type', 'a_id', 'b_id', 'reason'])
      .execute()

  const pairsOf = async (id: string) =>
    (await pairs()).filter((pair) => pair.a_id === id || pair.b_id === id)

  const pair = (entity: string, x: string, y: string, reason: string): PairRow => {
    const [a, b] = sorted(x, y)
    return { entity_type: entity, a_id: a, b_id: b, reason }
  }

  const groupsOf = async (user: SignedInUser, type: 'contact' | 'deal', query = '') =>
    ok<{ data: DuplicateGroupView[]; next_cursor: string | null }>(
      await call(user, 'GET', `/v1/duplicates?type=${type}${query}`),
    )

  // ---- Правила -------------------------------------------------------------------------------

  describe('правила пары', () => {
    it('телефон в разной записи: `067 123 45 67` и `+380671234567`', async () => {
      const suffix = randomInt(1_000_000, 9_999_999).toString()
      const local = `067 ${suffix.slice(0, 3)} ${suffix.slice(3, 5)} ${suffix.slice(5)}`
      const created = await ok<{ id: string; phones: string[] }>(
        await call(admin, 'POST', '/v1/contacts', {
          firstName: uniqueName('Олена'),
          phones: [local],
        }),
        201,
      )
      const e164 = `+38067${suffix}`
      expect(normalizePhone(e164)).toBe(e164)
      expect(created.phones).toEqual([e164])
      const other = await insertContact({ phones: [normalizePhone(e164) ?? ''] })
      await scanContact(other)
      expect(await pairsOf(other)).toEqual([pair('contact', created.id, other, 'phone')])
    })

    it('email в разном регистре', async () => {
      const email = fakeEmail()
      const created = await ok<{ id: string; emails: string[] }>(
        await call(admin, 'POST', '/v1/contacts', {
          firstName: uniqueName('Ірина'),
          emails: [email.toUpperCase()],
        }),
        201,
      )
      expect(created.emails).toEqual([email])
      const other = await insertContact({ emails: [normalizeEmail(` ${email} `) ?? ''] })
      await scanContact(created.id)
      expect(await pairsOf(other)).toEqual([pair('contact', created.id, other, 'email')])
    })

    it('отметка «возможный дубль»', async () => {
      const first = await insertContact({ phones: [fakePhone()] })
      const marked = await insertContact({ phones: [fakePhone()], duplicateOf: first })
      // Пару находит пересчёт любого из двух контактов.
      await scanContact(first)
      expect(await pairsOf(first)).toEqual([pair('contact', first, marked, 'mark')])
      await h.owner.deleteFrom('duplicate_pair').execute()
      await scanContact(marked)
      expect(await pairsOf(first)).toEqual([pair('contact', first, marked, 'mark')])
    })

    it('имя и фамилия без регистра и пробелов по краям и последние 9 цифр телефона', async () => {
      const digits = randomInt(100_000_000, 999_999_999).toString()
      const first = await insertContact({
        firstName: 'Олена',
        lastName: 'Коваленко',
        phones: [`+380${digits}`],
      })
      const same = await insertContact({
        firstName: ' ОЛЕНА ',
        lastName: 'коваленко ',
        phones: [`+48${digits}`],
      })
      // Другое имя с теми же 9 цифрами — не пара.
      const otherName = await insertContact({
        firstName: 'Ольга',
        lastName: 'Коваленко',
        phones: [`+49${digits}`],
      })
      await scanContact(first)
      await scanContact(otherName)
      expect(await pairsOf(first)).toEqual([pair('contact', first, same, 'name_phone')])
      expect(await pairsOf(otherName)).toEqual([])
    })

    it('две открытые сделки контакта в воронке (одна архивная) — пара; закрытая — нет', async () => {
      const contact = await insertContact({ phones: [fakePhone()] })
      const p = await pipeline()
      const won = await createDeal(contact, p)
      await h.owner
        .updateTable('deal')
        .set({ status: 'won', won_at: sql`now()` })
        .where('id', '=', won)
        .execute()
      const archived = await createDeal(contact, p)
      await h.owner
        .updateTable('deal')
        .set({ archived_at: sql`now()` })
        .where('id', '=', archived)
        .execute()
      const open = await createDeal(contact, p)
      // В другой воронке — не пара.
      await createDeal(contact, await pipeline())
      await scanContact(contact)
      expect((await pairs()).filter((row) => row.entity_type === 'deal')).toEqual([
        pair('deal', archived, open, 'open_deals'),
      ])
    })

    it('записи в корзине и слитые не считаются', async () => {
      const phone = fakePhone()
      const live = await insertContact({ phones: [phone] })
      const trashed = await insertContact({ phones: [phone] })
      await h.owner
        .updateTable('contact')
        .set({ deleted_at: sql`now()` })
        .where('id', '=', trashed)
        .execute()
      const merged = await insertContact({ phones: [phone] })
      await h.owner
        .updateTable('contact')
        .set({ merged_into_id: live, merged_at: sql`now()` })
        .where('id', '=', merged)
        .execute()
      await scanContact(live)
      await scanProject()
      expect(await pairsOf(live)).toEqual([])
    })
  })

  // ---- Изоляция ------------------------------------------------------------------------------

  describe('изоляция проектов', () => {
    it('одинаковый телефон в двух проектах — не дубль', async () => {
      const phone = fakePhone()
      const inA = await insertContact({ phones: [phone] })
      const inB = await insertContact({ phones: [phone] }, projectB)
      await scanContact(inA)
      await scanContact(inB, projectB)
      await scanAllDuplicates(h.appDb)
      expect(await pairsOf(inA)).toEqual([])
      expect(await pairs(projectB)).toEqual([])
    })

    it('пары и отметки «не дубль» проекта A не видны в контексте B без фильтра в коде', async () => {
      const phone = fakePhone()
      const x = await insertContact({ phones: [phone] })
      const y = await insertContact({ phones: [phone] })
      const z = await insertContact({ phones: [phone] })
      await scanContact(x)
      await ok(
        await call(admin, 'POST', '/v1/duplicates/not-duplicate', {
          type: 'contact',
          a_id: x,
          b_id: z,
        }),
      )
      const seen = (project: string) =>
        withProject(h.appDb, project, async (trx) => ({
          pairs: (await sql`select * from duplicate_pair`.execute(trx)).rows.length,
          notDuplicate: (await sql`select * from not_duplicate`.execute(trx)).rows.length,
        }))
      expect(await seen(projectA)).toMatchObject({ pairs: 1, notDuplicate: 1 })
      expect(await seen(projectB)).toEqual({ pairs: 0, notDuplicate: 0 })
      // Запись в чужой проект политика не пропускает.
      await expect(
        withProject(h.appDb, projectB, (trx) =>
          trx
            .insertInto('duplicate_pair')
            .values({
              project_id: projectA,
              entity_type: 'contact',
              a_id: x,
              b_id: y,
              reason: 'email',
            })
            .execute(),
        ),
      ).rejects.toThrow(/row-level security/)
      expect((await groupsOf(admin, 'contact')).data).toHaveLength(1)
      expect(
        (
          await ok<{ data: unknown[] }>(
            await call(admin, 'GET', '/v1/duplicates?type=contact', undefined, projectB),
          )
        ).data,
      ).toEqual([])
    })
  })

  // ---- Сам ничего не меняет ------------------------------------------------------------------

  it('прогон задачи и ночного прохода не меняет контакты и сделки и не создаёт событий', async () => {
    const phone = fakePhone()
    const first = await insertContact({ phones: [phone] })
    await insertContact({ phones: [phone], duplicateOf: first })
    const p = await pipeline()
    const deal = await createDeal(first, p)
    await h.owner
      .updateTable('deal')
      .set({ archived_at: sql`now()` })
      .where('id', '=', deal)
      .execute()
    await createDeal(first, p)

    const snapshot = async () => ({
      contact: await sql`select * from contact order by id`.execute(h.owner),
      phone: await sql`select * from contact_phone order by id`.execute(h.owner),
      email: await sql`select * from contact_email order by id`.execute(h.owner),
      deal: await sql`select * from deal order by id`.execute(h.owner),
      participant: await sql`select * from deal_participant order by deal_id, contact_id`.execute(
        h.owner,
      ),
      history: await sql`select * from change_log order by id`.execute(h.owner),
      events: await sql`select * from webhook_event order by id`.execute(h.owner),
      jobs: await sql`select count(*)::int as n from pgboss.job where name <> ${DUPLICATE_SCAN_QUEUE}`.execute(
        h.owner,
      ),
    })
    const before = await snapshot()
    await scanContact(first)
    await scanDuplicates(h.appDb, { projectId: projectA, entity: 'deal', id: deal })
    await scanAllDuplicates(h.appDb)
    expect((await pairsOf(first)).map((row) => row.reason)).toEqual(['mark', 'phone'])
    expect(await snapshot()).toEqual(before)
  })

  // ---- Задача поиска -------------------------------------------------------------------------

  describe('задача поиска', () => {
    it('изменение телефона ставит задачу той же транзакцией; откат задачи не оставляет', async () => {
      const contact = await ok<{ id: string }>(
        await call(admin, 'POST', '/v1/contacts', { firstName: uniqueName('Марта') }),
        201,
      )
      expect((await drain()).map((job) => job.id)).toEqual([contact.id])

      await ok(await call(admin, 'PATCH', `/v1/contacts/${contact.id}`, { phones: [fakePhone()] }))
      expect(await scanJobs()).toEqual([
        {
          id: expect.any(String),
          data: { projectId: projectA, entity: 'contact', id: contact.id },
        },
      ])
      await clearScanJobs()

      const author = { projectId: projectA, actorId: admin.id }
      // До фиксации задачи не видно снаружи; после — видна.
      await withProject(h.appDb, projectA, async (trx) => {
        await replaceContactKeys({ ...author, db: trx }, contact.id, { phones: [fakePhone()] })
        expect(await scanJobs()).toEqual([])
      })
      expect((await scanJobs()).map((job) => job.data.id)).toEqual([contact.id])
      await clearScanJobs()

      const failure = new Error('откат')
      await expect(
        withProject(h.appDb, projectA, async (trx) => {
          await replaceContactKeys({ ...author, db: trx }, contact.id, { phones: [fakePhone()] })
          throw failure
        }),
      ).rejects.toBe(failure)
      expect(await scanJobs()).toEqual([])
    })

    it('правка, зафиксированная после того, как ждущую задачу записи взяли, ставит свою задачу', async () => {
      const contact = await ok<{ id: string }>(
        await call(admin, 'POST', '/v1/contacts', { firstName: uniqueName('Ліна') }),
        201,
      )
      await drain()
      const author = { projectId: projectA, actorId: admin.id }
      const edit = (trx: Parameters<typeof replaceContactKeys>[0]['db']) =>
        replaceContactKeys({ ...author, db: trx }, contact.id, { phones: [fakePhone()] })
      // Задача первой правки ждёт в очереди.
      await withProject(h.appDb, projectA, edit)
      expect((await scanJobs()).map((job) => job.data.id)).toEqual([contact.id])
      await withProject(h.appDb, projectA, async (trx) => {
        await edit(trx)
        // Вторая правка ещё не зафиксирована, а фоновая задача уже взяла первую задачу и прочтёт
        // состояние без второй правки.
        await sql`
          update pgboss.job set state = 'active', started_on = now()
          where name = ${DUPLICATE_SCAN_QUEUE} and state = 'created'
        `.execute(h.owner)
      })
      expect((await scanJobs()).map((job) => job.data.id)).toEqual([contact.id])
    })

    it('несколько постановок одной записи в одной транзакции — одна задача', async () => {
      const contact = await ok<{ id: string }>(
        await call(admin, 'POST', '/v1/contacts', { firstName: uniqueName('Іра') }),
        201,
      )
      await drain()
      await withProject(h.appDb, projectA, async (trx) => {
        await enqueueDuplicateScan(trx, projectA, [{ entity: 'contact', id: contact.id }])
        await enqueueDuplicateScan(trx, projectA, [
          { entity: 'contact', id: contact.id },
          { entity: 'contact', id: contact.id },
        ])
      })
      expect((await scanJobs()).map((job) => job.data.id)).toEqual([contact.id])
    })

    it('регистрация ставит задачу контакта; вторая открытая сделка в воронке — пара сделок', async () => {
      const p = await pipeline()
      const source = await ok<IntakeSourceWithKey>(
        await call(admin, 'POST', '/v1/intake-sources', {
          name: uniqueName('Лендінг '),
          pipelineId: p.id,
        }),
        201,
      )
      const phone = fakePhone()
      const register = () =>
        h.app.request(`${ORIGIN}/intake/registrations`, {
          method: 'POST',
          headers: {
            origin: ORIGIN,
            authorization: `Bearer ${source.key}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ event_id: `evt-${++counter}-${randomInt(1e9)}`, phone }),
        })
      const first = await ok<{ contact_id: string; deal_id: string }>(await register(), 201)
      expect((await drain()).map((job) => job.id)).toEqual([first.contact_id])
      await h.owner
        .updateTable('deal')
        .set({ archived_at: sql`now()` })
        .where('id', '=', first.deal_id)
        .execute()
      const second = await ok<{ contact_id: string; deal_id: string }>(await register(), 201)
      expect(second.contact_id).toBe(first.contact_id)
      expect(second.deal_id).not.toBe(first.deal_id)
      expect((await drain()).map((job) => job.id)).toEqual([first.contact_id])
      expect((await pairs()).filter((row) => row.entity_type === 'deal')).toEqual([
        pair('deal', first.deal_id, second.deal_id, 'open_deals'),
      ])
    })

    it('после слияния пара исчезает при следующем проходе; откат слияния её возвращает', async () => {
      const email = fakeEmail()
      const survivor = await ok<{ id: string }>(
        await call(admin, 'POST', '/v1/contacts', {
          firstName: uniqueName('Олег'),
          emails: [email],
        }),
        201,
      )
      const merged = await ok<{ id: string; possibleDuplicate: boolean }>(
        await call(admin, 'POST', '/v1/contacts', {
          firstName: uniqueName('Олег'),
          emails: [email],
        }),
        201,
      )
      expect(merged.possibleDuplicate).toBe(true)
      await drain()
      expect((await pairsOf(merged.id)).map((row) => row.reason)).toEqual(['email', 'mark'])
      const result = await ok<{ merge: { id: string } }>(
        await call(admin, 'POST', `/v1/contacts/${survivor.id}/merge`, {
          merge_contact_id: merged.id,
        }),
      )
      expect((await scanJobs()).map((job) => job.data.id).sort()).toEqual(
        [survivor.id, merged.id].sort(),
      )
      await drain()
      expect(await pairsOf(merged.id)).toEqual([])

      await ok(await call(admin, 'POST', `/v1/merges/${result.merge.id}/undo`, {}))
      expect((await scanJobs()).map((job) => job.data.id).sort()).toEqual(
        [survivor.id, merged.id].sort(),
      )
      await drain()
      expect((await pairsOf(merged.id)).map((row) => row.reason)).toContain('email')
    })

    it('ночной проход убирает пары, которые больше не совпадают', async () => {
      const phone = fakePhone()
      const x = await insertContact({ phones: [phone] })
      const y = await insertContact({ phones: [phone] })
      await scanAllDuplicates(h.appDb)
      expect(await pairsOf(x)).toEqual([pair('contact', x, y, 'phone')])
      const { found_at } = await h.owner
        .selectFrom('duplicate_pair')
        .select('found_at')
        .where('a_id', '=', sorted(x, y)[0])
        .executeTakeFirstOrThrow()
      // Повторный проход время находки не меняет.
      await scanAllDuplicates(h.appDb)
      expect(
        (
          await h.owner
            .selectFrom('duplicate_pair')
            .select('found_at')
            .where('a_id', '=', sorted(x, y)[0])
            .executeTakeFirstOrThrow()
        ).found_at,
      ).toEqual(found_at)
      // Телефон сменился мимо API (задачи нет) — пару убирает ночной проход.
      await h.owner
        .updateTable('contact_phone')
        .set({ phone: fakePhone() })
        .where('contact_id', '=', y)
        .execute()
      await scanAllDuplicates(h.appDb)
      expect(await pairsOf(x)).toEqual([])
    })
  })

  // ---- Запросы экрана ------------------------------------------------------------------------

  describe('экран «Дублі»', () => {
    it('группа — записи, связанные хотя бы одной парой, с причинами; курсор', async () => {
      const phone = fakePhone()
      const email = fakeEmail()
      const x = await insertContact({ phones: [phone] })
      const y = await insertContact({ phones: [phone], emails: [email] })
      const z = await insertContact({ emails: [email] })
      const other = fakePhone()
      const u = await insertContact({ phones: [other] })
      const v = await insertContact({ phones: [other] })
      await scanProject()
      const { data, next_cursor } = await groupsOf(admin, 'contact')
      expect(next_cursor).toBeNull()
      const three = data.find((group) => group.recordIds.includes(x))
      expect(three).toMatchObject({
        type: 'contact',
        id: [x, y, z].sort()[0],
        recordIds: [x, y, z].sort(),
        reasons: ['email', 'phone'],
      })
      expect(three?.pairs).toHaveLength(2)
      expect(three?.records.map((record) => record.id)).toEqual([x, y, z].sort())
      expect(three?.records.find((record) => record.id === y)).toMatchObject({
        phones: [phone],
        emails: [email],
      })
      expect(data).toHaveLength(2)

      const first = await groupsOf(admin, 'contact', '&limit=1')
      expect(first.data).toHaveLength(1)
      expect(first.next_cursor).not.toBeNull()
      const second = await groupsOf(admin, 'contact', `&limit=1&cursor=${first.next_cursor}`)
      expect(second.next_cursor).toBeNull()
      expect([...first.data, ...second.data].map((group) => group.id).sort()).toEqual(
        [[x, y, z].sort()[0], [u, v].sort()[0]].sort(),
      )
      expect(
        await ok<{ contact: number; deal: number }>(
          await call(admin, 'GET', '/v1/duplicates/count'),
        ),
      ).toEqual({
        contact: 2,
        deal: 0,
      })
      const bad = await call(admin, 'GET', '/v1/duplicates?type=lead')
      expect(bad.status).toBe(400)
      expect((await problemOf(bad)).code).toBe('INVALID_DUPLICATES')
    })

    it('права: без «контакты: изменять» групп контактов нет; группа с записью вне охвата скрыта', async () => {
      const phone = fakePhone()
      await insertContact({ phones: [phone] })
      await insertContact({ phones: [phone] })
      // Оба контакта созданы writeOwn — группа ему видна; второй чужой — нет.
      const ownPhone = fakePhone()
      const own1 = await insertContact({ phones: [ownPhone], createdBy: writeOwn.id })
      const own2 = await insertContact({ phones: [ownPhone], createdBy: writeOwn.id })
      const mixedPhone = fakePhone()
      await insertContact({ phones: [mixedPhone], createdBy: writeOwn.id })
      await insertContact({ phones: [mixedPhone] })
      const contact = await insertContact({ phones: [fakePhone()] })
      const p = await pipeline()
      const archived = await createDeal(contact, p)
      await h.owner
        .updateTable('deal')
        .set({ archived_at: sql`now()` })
        .where('id', '=', archived)
        .execute()
      await createDeal(contact, p)
      await scanProject()

      expect((await groupsOf(admin, 'contact')).data).toHaveLength(3)
      const denied = await call(dealsOnly, 'GET', '/v1/duplicates?type=contact')
      expect(denied.status).toBe(403)
      expect((await problemOf(denied)).code).toBe('PERMISSION_DENIED')
      expect((await groupsOf(dealsOnly, 'deal')).data).toHaveLength(1)
      expect(await ok(await call(dealsOnly, 'GET', '/v1/duplicates/count'))).toEqual({
        contact: null,
        deal: 1,
      })

      const own = await groupsOf(writeOwn, 'contact')
      expect(own.data.map((group) => group.recordIds)).toEqual([[own1, own2].sort()])
      expect(await ok(await call(writeOwn, 'GET', '/v1/duplicates/count'))).toEqual({
        contact: 1,
        deal: null,
      })
      expect((await call(writeOwn, 'GET', '/v1/duplicates?type=deal')).status).toBe(403)

      const notDuplicate = await call(dealsOnly, 'POST', '/v1/duplicates/not-duplicate', {
        type: 'contact',
        a_id: own1,
        b_id: own2,
      })
      expect(notDuplicate.status).toBe(403)
      expect((await problemOf(notDuplicate)).code).toBe('PERMISSION_DENIED')
    })

    /** Архивная и открытая сделки контакта в одной воронке — пара сделок. */
    async function dealPair(contact: string, p: { id: string; stageId: string }) {
      const archived = await createDeal(contact, p)
      await h.owner
        .updateTable('deal')
        .set({ archived_at: sql`now()` })
        .where('id', '=', archived)
        .execute()
      return { archived, open: await createDeal(contact, p) }
    }

    it('сделки: имя контакта вне охвата чтения контактов не отдаётся (как на доске)', async () => {
      const hidden = await insertContact({ firstName: 'Чужий', phones: [fakePhone()] })
      const own = await insertContact({
        firstName: 'Свій',
        lastName: 'Контакт',
        phones: [fakePhone()],
        createdBy: dealsContactsOwn.id,
      })
      const hiddenDeals = await dealPair(hidden, await pipeline())
      const ownDeals = await dealPair(own, await pipeline())
      await scanProject()

      const names = async (user: SignedInUser) =>
        new Map(
          (await groupsOf(user, 'deal')).data
            .flatMap((group) => group.records as DuplicateDealRecord[])
            .map((record) => [record.id, record.contactName]),
        )
      const limited = await names(dealsContactsOwn)
      expect(limited.get(hiddenDeals.open)).toBeNull()
      expect(limited.get(hiddenDeals.archived)).toBeNull()
      expect(limited.get(ownDeals.open)).toBe('Свій Контакт')
      expect((await names(admin)).get(hiddenDeals.open)).toBe('Чужий')
    })

    it('пара сделок с другой воронкой или другим основным контактом не показывается сразу', async () => {
      const contact = await insertContact({ phones: [fakePhone()] })
      const other = await insertContact({ phones: [fakePhone()] })
      const p = await pipeline()
      const { archived } = await dealPair(contact, p)
      await scanContact(contact)
      expect((await groupsOf(admin, 'deal')).data).toHaveLength(1)

      // Изменения мимо задачи поиска: строка пары остаётся до ночного прохода, экран её не показывает.
      const moved = await pipeline()
      const move = (values: Record<string, string>) =>
        h.owner.updateTable('deal').set(values).where('id', '=', archived).execute()
      await move({ pipeline_id: moved.id, stage_id: moved.stageId })
      expect((await groupsOf(admin, 'deal')).data).toEqual([])
      expect(await ok(await call(admin, 'GET', '/v1/duplicates/count'))).toMatchObject({ deal: 0 })
      await move({ pipeline_id: p.id, stage_id: p.stageId })
      expect((await groupsOf(admin, 'deal')).data).toHaveLength(1)
      await move({ primary_contact_id: other })
      expect((await groupsOf(admin, 'deal')).data).toEqual([])
      expect((await pairs()).filter((row) => row.entity_type === 'deal')).toHaveLength(1)
    })

    it('ключ API — 403 API_KEY_NOT_ALLOWED', async () => {
      const role = await createRole(h, projectA, {
        actions: { contacts: ['view', 'create', 'edit'], deals: ['view', 'create', 'edit'] },
        scopes: { contacts: { read: 'all', write: 'all' }, deals: { read: 'all', write: 'all' } },
      } as never)
      const key = await createApiKey(h, admin, projectA, role)
      for (const [method, path, body] of [
        ['GET', '/v1/duplicates?type=contact', undefined],
        ['GET', '/v1/duplicates/count', undefined],
        [
          'POST',
          '/v1/duplicates/not-duplicate',
          { type: 'contact', a_id: admin.id, b_id: admin.id },
        ],
      ] as const) {
        const res = await key.api(method, path, { project: projectA, ...(body ? { body } : {}) })
        expect(res.status, path).toBe(403)
        expect((await problemOf(res)).code).toBe('API_KEY_NOT_ALLOWED')
      }
    })

    it('«не дубль»: пара больше не предлагается ни по одной причине; пометка снята', async () => {
      const phone = fakePhone()
      const first = await insertContact({ phones: [phone] })
      const marked = await insertContact({ phones: [phone], duplicateOf: first })
      await scanContact(first)
      expect((await pairsOf(first)).map((row) => row.reason)).toEqual(['mark', 'phone'])

      const [a, b] = sorted(first, marked)
      const answer = await ok<{ type: string; aId: string; bId: string }>(
        await call(admin, 'POST', '/v1/duplicates/not-duplicate', {
          type: 'contact',
          a_id: b,
          b_id: a,
        }),
      )
      expect(answer).toMatchObject({ type: 'contact', aId: a, bId: b })
      expect(await pairsOf(first)).toEqual([])
      const row = await h.owner
        .selectFrom('contact')
        .select(['possible_duplicate', 'possible_duplicate_of'])
        .where('id', '=', marked)
        .executeTakeFirstOrThrow()
      expect(row).toEqual({ possible_duplicate: false, possible_duplicate_of: null })
      const history = await h.owner
        .selectFrom('change_log')
        .select(['entity_id', 'field', 'before', 'after', 'actor_id'])
        .where('entity_id', 'in', [first, marked])
        .orderBy('entity_id')
        .orderBy('field')
        .execute()
      expect(history).toEqual(
        [
          {
            entity_id: first,
            field: 'notDuplicateOf',
            before: null,
            after: marked,
            actor_id: admin.id,
          },
          {
            entity_id: marked,
            field: 'notDuplicateOf',
            before: null,
            after: first,
            actor_id: admin.id,
          },
          {
            entity_id: marked,
            field: 'possibleDuplicate',
            before: true,
            after: false,
            actor_id: admin.id,
          },
        ].sort((x, y) =>
          x.entity_id === y.entity_id
            ? x.field < y.field
              ? -1
              : 1
            : x.entity_id < y.entity_id
              ? -1
              : 1,
        ),
      )

      // Новые совпадения той же пары (email) — тоже не предлагаются.
      const email = fakeEmail()
      await h.owner
        .insertInto('contact_email')
        .values([
          { project_id: projectA, contact_id: first, email, is_primary: true },
          { project_id: projectA, contact_id: marked, email, is_primary: true },
        ])
        .execute()
      await scanContact(first)
      await scanAllDuplicates(h.appDb)
      expect(await pairsOf(first)).toEqual([])
      expect(
        (await groupsOf(admin, 'contact')).data.some((group) => group.recordIds.includes(first)),
      ).toBe(false)
      // Повтор отметки — тот же ответ, история не повторяется.
      await ok(
        await call(admin, 'POST', '/v1/duplicates/not-duplicate', {
          type: 'contact',
          a_id: a,
          b_id: b,
        }),
      )
      expect(
        await h.owner
          .selectFrom('change_log')
          .select('id')
          .where('entity_id', 'in', [first, marked])
          .execute(),
      ).toHaveLength(3)
    })

    it('объединение группы из трёх контактов: два слияния, каждое откатывается отдельно', async () => {
      const phone = fakePhone()
      const x = await insertContact({ phones: [phone] })
      const y = await insertContact({ phones: [phone] })
      const z = await insertContact({ phones: [phone] })
      await scanProject()
      const [group] = (await groupsOf(admin, 'contact')).data
      expect(group?.recordIds).toEqual([x, y, z].sort())

      // Экран: остаётся x, остальные — последовательными слияниями в него.
      const merges: string[] = []
      for (const merged of [y, z]) {
        const preview = await call(admin, 'POST', `/v1/contacts/${x}/merge/preview`, {
          merge_contact_id: merged,
        })
        expect(preview.status).toBe(200)
        const result = await ok<{ merge: { id: string } }>(
          await call(admin, 'POST', `/v1/contacts/${x}/merge`, { merge_contact_id: merged }),
        )
        merges.push(result.merge.id)
      }
      await drain()
      expect((await groupsOf(admin, 'contact')).data).toEqual([])

      // Откат — по одному, с последнего: первое слияние остаётся.
      const [first, second] = merges as [string, string]
      await ok(await call(admin, 'POST', `/v1/merges/${second}/undo`, {}))
      const mergedInto = async (id: string) =>
        (
          await h.owner
            .selectFrom('contact')
            .select('merged_into_id')
            .where('id', '=', id)
            .executeTakeFirstOrThrow()
        ).merged_into_id
      expect(await mergedInto(z)).toBeNull()
      expect(await mergedInto(y)).toBe(x)
      await ok(await call(admin, 'POST', `/v1/merges/${first}/undo`, {}))
      expect(await mergedInto(y)).toBeNull()
      await drain()
      expect((await groupsOf(admin, 'contact')).data.map((g) => g.recordIds)).toEqual([
        [x, y, z].sort(),
      ])
    })
  })

  // Последним: обработчик фоновых задач сам берёт задачи из очереди.
  it('фоновые задачи выполняют поставленный поиск', async () => {
    const phone = fakePhone()
    const existing = await insertContact({ phones: [phone] })
    const contact = await ok<{ id: string }>(
      await call(admin, 'POST', '/v1/contacts', { firstName: uniqueName('Тарас') }),
      201,
    )
    const jobs = await startJobs({
      connectionString: h.appUrl,
      db: h.appDb,
      bulkActions: NO_BULK_ACTIONS,
      trashPurgers: NO_TRASH_PURGERS,
      pollingIntervalSeconds: 0.5,
      schedule: false,
    })
    try {
      // Телефон через базу, мимо API: API не дал бы второй контакт с тем же телефоном.
      await withProject(h.appDb, projectA, (trx) =>
        replaceContactKeys({ db: trx, projectId: projectA, actorId: admin.id }, contact.id, {
          phones: [phone],
        }),
      )
      const deadline = Date.now() + 20_000
      while ((await pairsOf(existing)).length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      expect(await pairsOf(existing)).toEqual([pair('contact', existing, contact.id, 'phone')])
    } finally {
      await jobs.stop()
    }
  })
})
