import { randomInt, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { withProject } from '@alpi/db'
import { eventBodyProblem } from '@alpi/shared'
import { type RawBuilder, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import type { ContactView } from '../contacts/contacts.ts'
import { findContactMatch } from '../contacts/match.ts'
import { SNIFF_BYTES } from '../files/sniff.ts'
import type { SearchResponse } from '../search/search.ts'
import { localDiskStorage } from '../storage/storage.ts'
import {
  type ApiHarness,
  type Method,
  type SignedInUser,
  startApiHarness,
  type Target,
} from '../testing/api-harness.ts'
import { createApiKey, createRole } from '../testing/api-key.ts'
import { problemOf } from '../testing/problem.ts'
import { CONTACT_PURGER } from '../trash/purgers.ts'
import type { ContactMergeView, MergePreview, MergeResult, UndoResult } from './contacts.ts'

// Слияние контактов с откатом (тикет crm-intake/01; ADR 0005) на настоящем PostgreSQL: API
// ходит ролью приложения, проверки — служебным подключением. Имена, телефоны и email —
// вымышленные.

const fakePhone = () => `+38067${randomInt(1_000_000, 9_999_999)}`
let emailCounter = 0
const fakeEmail = () => `merge-${++emailCounter}-${randomInt(1e9)}@example.test`
/** Имя, которое найдётся поиском только у одного контакта. */
const uniqueName = (prefix: string) => `${prefix}${randomInt(1e9).toString(36)}`

describe('слияние контактов с откатом', () => {
  let h: ApiHarness
  let admin: SignedInUser
  let projectA: string
  let projectB: string
  let manager1: SignedInUser
  let manager2: SignedInUser
  /** Контакты — только смотреть. */
  let viewer: SignedInUser
  /** Контакты: читать все, изменять свои. */
  let readAllWriteOwn: SignedInUser
  /** Контакты — все; сделки — только свои: часть сделок вне его охвата. */
  let dealsOwn: SignedInUser
  let pipelineCounter = 0

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_merge')
    admin = await h.signIn('owner')
    projectA = (await h.createProject(admin, 'Злиття А')).id
    projectB = (await h.createProject(admin, 'Злиття Б')).id
    manager1 = await h.signIn()
    manager2 = await h.signIn()
    viewer = await h.signIn()
    readAllWriteOwn = await h.signIn()
    dealsOwn = await h.signIn()
    await h.addMember(projectA, manager1.id, 'manager')
    await h.addMember(projectA, manager2.id, 'manager')
    const member = async (user: SignedInUser, permissions: unknown) => {
      const role = await createRole(h, projectA, permissions as never)
      await h.owner
        .insertInto('project_member')
        .values({ project_id: projectA, user_id: user.id, role_id: role })
        .execute()
    }
    await member(viewer, { actions: { contacts: ['view'] }, scopes: {} })
    await member(readAllWriteOwn, {
      actions: { contacts: ['view', 'create', 'edit'], deals: ['view'] },
      scopes: { contacts: { read: 'all', write: 'own' } },
    })
    await member(dealsOwn, {
      actions: { contacts: ['view', 'create', 'edit'], deals: ['view', 'create', 'edit'] },
      scopes: { contacts: { read: 'all', write: 'all' }, deals: { read: 'own', write: 'own' } },
    })
  })

  afterAll(async () => {
    await h?.stop()
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

  async function createContact(
    body: Record<string, unknown>,
    user = admin,
    project = projectA,
  ): Promise<ContactView> {
    return ok<ContactView>(
      await call(
        user,
        'POST',
        '/v1/contacts',
        { firstName: uniqueName('Клієнт'), ...body },
        project,
      ),
      201,
    )
  }

  async function pipeline(): Promise<{ id: string; stageId: string }> {
    const { id } = await h.owner
      .insertInto('pipeline')
      .values({
        project_id: projectA,
        code: `m${++pipelineCounter}`,
        name: `Воронка злиття ${pipelineCounter}`,
        is_upsell: false,
        position: 100 + pipelineCounter,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const stage = await h.owner
      .insertInto('stage')
      .values({ project_id: projectA, pipeline_id: id, name: 'Новий', position: 1 })
      .returning('id')
      .executeTakeFirstOrThrow()
    return { id, stageId: stage.id }
  }

  async function createDeal(contactId: string, ownerId: string | null = null) {
    const { id: pipelineId, stageId } = await pipeline()
    const deal = await ok<{ id: string }>(
      await call(admin, 'POST', '/v1/deals', { title: 'Угода', pipelineId, stageId, contactId }),
      201,
    )
    await h.owner.updateTable('deal').set({ owner_id: ownerId }).where('id', '=', deal.id).execute()
    return { id: deal.id, pipelineId, stageId }
  }

  async function addParticipant(dealId: string, contactId: string, role: string | null = null) {
    await h.owner
      .insertInto('deal_participant')
      .values({ project_id: projectA, deal_id: dealId, contact_id: contactId, role })
      .execute()
  }

  async function addNote(contactId: string, text = 'Нотатка') {
    const { id } = await h.owner
      .insertInto('note')
      .values({ project_id: projectA, contact_id: contactId, text, author_id: admin.id })
      .returning('id')
      .executeTakeFirstOrThrow()
    return id
  }

  async function addFile(contactId: string) {
    const id = randomUUID()
    await h.owner
      .insertInto('file')
      .values({
        id,
        project_id: projectA,
        contact_id: contactId,
        name: 'договір.pdf',
        content_type: 'application/pdf',
        size: 10,
        storage_key: `${projectA}/${id}`,
        author_id: admin.id,
      })
      .execute()
    return id
  }

  const merge = (user: SignedInUser, survivorId: string, mergedId: string, project = projectA) =>
    call(user, 'POST', `/v1/contacts/${survivorId}/merge`, { merge_contact_id: mergedId }, project)

  const undo = (user: SignedInUser, mergeId: string) =>
    call(user, 'POST', `/v1/merges/${mergeId}/undo`)

  async function merged(survivorId: string, mergedId: string, user = admin) {
    return ok<MergeResult>(await merge(user, survivorId, mergedId))
  }

  const contactRow = (id: string) =>
    h.owner.selectFrom('contact').selectAll().where('id', '=', id).executeTakeFirst()

  const noteOwner = async (id: string) =>
    (await h.owner.selectFrom('note').select('contact_id').where('id', '=', id).executeTakeFirst())
      ?.contact_id
  const fileOwner = async (id: string) =>
    (await h.owner.selectFrom('file').select('contact_id').where('id', '=', id).executeTakeFirst())
      ?.contact_id

  const events = (type: string, contactId: string) =>
    h.owner
      .selectFrom('webhook_event')
      .select(['body'])
      .where('type', '=', type)
      .where('entity_id', '=', contactId)
      .execute()

  describe('изоляция проектов', () => {
    it('merge_record и merge_moved_item проекта A не видны в контексте B без фильтра', async () => {
      const survivor = await createContact({ phones: [fakePhone()] })
      const second = await createContact({ phones: [fakePhone()] })
      await addNote(second.id)
      const result = await merged(survivor.id, second.id)
      const inB = await withProject(h.appDb, projectB, async (trx) => ({
        records: await sql`select * from merge_record`.execute(trx),
        items: await sql`select * from merge_moved_item`.execute(trx),
      }))
      expect(inB.records.rows).toEqual([])
      expect(inB.items.rows).toEqual([])
      const inA = await withProject(h.appDb, projectA, (trx) =>
        sql<{ id: string }>`select id from merge_record`.execute(trx),
      )
      expect(inA.rows.map((row) => row.id)).toContain(result.merge.id)
    })

    it('контакт проекта A не слить с контактом проекта B — 404', async () => {
      const inA = await createContact({})
      const inB = await createContact({}, admin, projectB)
      const res = await merge(admin, inA.id, inB.id)
      expect(res.status).toBe(404)
      expect((await problemOf(res)).code).toBe('CONTACT_NOT_FOUND')
      const fromB = await merge(admin, inB.id, inA.id, projectB)
      expect(fromB.status).toBe(404)
      expect((await contactRow(inB.id))?.merged_into_id).toBeNull()
    })
  })

  describe('права', () => {
    it('без «контакты: изменять» — 403; на откат — тоже', async () => {
      const a = await createContact({})
      const b = await createContact({})
      const res = await merge(viewer, a.id, b.id)
      expect(res.status).toBe(403)
      expect((await problemOf(res)).code).toBe('PERMISSION_DENIED')
      const { merge: record } = await merged(a.id, b.id)
      expect((await undo(viewer, record.id)).status).toBe(403)
      expect((await contactRow(b.id))?.merged_into_id).toBe(a.id)
    })

    it('охват изменения «свои», один контакт чужой — 403; откат — те же проверки', async () => {
      const own = await createContact({}, readAllWriteOwn)
      const foreign = await createContact({}, manager2)
      const res = await merge(readAllWriteOwn, own.id, foreign.id)
      expect(res.status).toBe(403)
      expect((await problemOf(res)).code).toBe('PERMISSION_DENIED')
      const reversed = await merge(readAllWriteOwn, foreign.id, own.id)
      expect(reversed.status).toBe(403)

      const { merge: record } = await merged(own.id, foreign.id)
      const refused = await undo(readAllWriteOwn, record.id)
      expect(refused.status).toBe(403)
      expect((await contactRow(foreign.id))?.merged_into_id).toBe(own.id)
    })

    it('свои контакты менеджер сливает и откатывает сам', async () => {
      const a = await createContact({}, manager1)
      const b = await createContact({}, manager1)
      const { merge: record } = await merged(a.id, b.id, manager1)
      await ok<UndoResult>(await undo(manager1, record.id))
      expect((await contactRow(b.id))?.merged_into_id).toBeNull()
    })
  })

  describe('слияние', () => {
    it('заполненные поля не меняются, пустые заполняются; ключи без повторов; всё перешло', async () => {
      const shared = fakePhone()
      const own = fakePhone()
      const fresh = fakePhone()
      const [e1, e2] = [fakeEmail(), fakeEmail()]
      const group = await ok<{ id: string }>(
        await call(admin, 'POST', '/v1/field-groups', { entity: 'contact', nameUk: 'Злиття' }),
        201,
      )
      const code = `dzh${randomInt(1e6)}`
      await ok(
        await call(admin, 'POST', '/v1/fields', {
          groupId: group.id,
          nameUk: 'Джерело',
          code,
          type: 'text',
        }),
        201,
      )
      const survivor = await createContact({
        lastName: 'Залишена',
        phones: [shared, own],
        emails: [e1],
      })
      const second = await createContact({
        lastName: 'Друга',
        language: 'ru',
        phones: [fresh],
        emails: [e2],
        custom: { [code]: 'Сайт' },
      })
      // Один номер у двух контактов: так бывает у дублей из приёма — API такого не создаёт.
      await h.owner
        .insertInto('contact_phone')
        .values({ project_id: projectA, contact_id: second.id, phone: shared, is_primary: false })
        .execute()
      const primaryDeal = await createDeal(second.id, manager2.id)
      const otherContact = await createContact({})
      const foreignDeal = await createDeal(otherContact.id, manager2.id)
      await addParticipant(foreignDeal.id, second.id, 'Батько')
      const note = await addNote(second.id)
      const file = await addFile(second.id)

      const preview = await ok<MergePreview>(
        await call(dealsOwn, 'POST', `/v1/contacts/${survivor.id}/merge/preview`, {
          merge_contact_id: second.id,
        }),
      )
      expect(preview).toMatchObject({
        fields: [
          { field: 'language', value: 'ru' },
          { field: `custom.${code}`, value: 'Сайт' },
        ],
        phones: [fresh],
        emails: [e2],
        deals: 1,
        participations: 1,
        notes: 1,
        files: 1,
        dealsOutOfScope: 2,
      })
      // Предпросмотр ничего не пишет.
      expect((await contactRow(second.id))?.merged_into_id).toBeNull()
      expect(await noteOwner(note)).toBe(second.id)

      const result = await ok<MergeResult>(await merge(dealsOwn, survivor.id, second.id))
      expect(result.contact).toMatchObject({
        id: survivor.id,
        lastName: 'Залишена',
        language: 'ru',
        phones: [shared, ...[own, fresh].sort()],
        emails: [e1, e2],
        custom: { [code]: 'Сайт' },
      })
      expect(result.merge).toMatchObject({
        entityType: 'contact',
        survivorId: survivor.id,
        mergedId: second.id,
        undoneAt: null,
      })
      const deal = await h.owner
        .selectFrom('deal')
        .select('primary_contact_id')
        .where('id', '=', primaryDeal.id)
        .executeTakeFirstOrThrow()
      expect(deal.primary_contact_id).toBe(survivor.id)
      const participants = await h.owner
        .selectFrom('deal_participant')
        .select(['contact_id', 'role'])
        .where('deal_id', '=', foreignDeal.id)
        .execute()
      expect(participants).toEqual([{ contact_id: survivor.id, role: 'Батько' }])
      expect(await noteOwner(note)).toBe(survivor.id)
      expect(await fileOwner(file)).toBe(survivor.id)
      const hidden = await contactRow(second.id)
      expect(hidden?.merged_into_id).toBe(survivor.id)
      // Совпавший телефон остался у скрытого, его значения полей — тоже.
      const hiddenPhones = await h.owner
        .selectFrom('contact_phone')
        .select('phone')
        .where('contact_id', '=', second.id)
        .execute()
      expect(hiddenPhones.map((p) => p.phone)).toEqual([shared])
      expect(hidden?.last_name).toBe('Друга')
    })

    it('контакт с собой, слитый и в корзине — отказы', async () => {
      const a = await createContact({})
      const self = await merge(admin, a.id, a.id)
      expect(self.status).toBe(422)
      expect((await problemOf(self)).code).toBe('MERGE_SAME_CONTACT')
      const bad = await call(admin, 'POST', `/v1/contacts/${a.id}/merge`, { merge_contact_id: 'x' })
      expect(bad.status).toBe(400)
      const b = await createContact({})
      await merged(a.id, b.id)
      const again = await merge(admin, a.id, b.id)
      expect(again.status).toBe(404)
      expect((await problemOf(again)).code).toBe('CONTACT_MERGED')
      const trashed = await createContact({})
      expect((await call(admin, 'DELETE', `/v1/contacts/${trashed.id}`)).status).toBe(204)
      expect((await merge(admin, a.id, trashed.id)).status).toBe(404)
    })

    it('два одновременных слияния одного контакта: проходит одно, второе — 404 CONTACT_MERGED', async () => {
      // Строку слитого контакта держит транзакция теста, пока оба запроса не встанут в
      // ожидание блокировки: так оба начинают раньше, чем любой закончит. С блокировкой
      // контактов (lockContacts, FOR UPDATE) второй после ожидания видит уже слитый контакт;
      // без неё оба прочитали бы его неслитым и слили бы дважды.
      const left = await createContact({})
      const right = await createContact({})
      const contested = await createContact({ phones: [fakePhone()] })
      const lockWaiters = async () => {
        const { rows } = await sql<{ count: string }>`
          select count(*) from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
        `.execute(h.owner)
        return Number(rows[0]?.count)
      }

      let pending: Promise<Response[]> | undefined
      // Транзакция теста завершается раньше запросов: только тогда они получат блокировку.
      await h.owner.transaction().execute(async (trx) => {
        await trx
          .selectFrom('contact')
          .select('id')
          .where('id', '=', contested.id)
          .forUpdate()
          .execute()
        pending = Promise.all([
          merge(admin, left.id, contested.id),
          merge(admin, right.id, contested.id),
        ])
        const deadline = Date.now() + 10_000
        while ((await lockWaiters()) < 2) {
          if (Date.now() > deadline) throw new Error('слияния не встали в ожидание блокировки')
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      })
      const responses = await (pending ?? Promise.reject(new Error('запросы не начаты')))

      const statuses = responses.map((res) => res.status).sort()
      expect(statuses).toEqual([200, 404])
      const refused = responses.find((res) => res.status === 404)
      expect(refused && (await problemOf(refused)).code).toBe('CONTACT_MERGED')
      const records = await h.owner
        .selectFrom('merge_record')
        .select('survivor_id')
        .where('merged_id', '=', contested.id)
        .execute()
      expect(records).toHaveLength(1)
      expect((await contactRow(contested.id))?.merged_into_id).toBe(records[0]?.survivor_id)
    })
  })

  describe('скрытый контакт', () => {
    it('не находится списком, поиском, findContactMatch и в корзине; GET — 404 CONTACT_MERGED', async () => {
      const name = uniqueName('Прихований')
      const email = fakeEmail()
      const survivor = await createContact({ firstName: uniqueName('Лишився') })
      const second = await createContact({ firstName: name, emails: [email] })
      await merged(survivor.id, second.id)

      const list = await ok<ContactView[]>(
        await call(admin, 'GET', `/v1/contacts?q=${encodeURIComponent(name)}`),
      )
      expect(list).toEqual([])
      const search = await ok<SearchResponse>(
        await call(admin, 'GET', `/v1/search?q=${encodeURIComponent(name)}`),
      )
      expect(search.contacts.items).toEqual([])
      const match = await withProject(h.appDb, projectA, (trx) =>
        findContactMatch(trx, { phones: [], emails: [email] }, { excludeId: survivor.id }),
      )
      expect(match).toBeNull()
      const byEmail = await ok<{ data: ContactView[] }>(
        await call(admin, 'GET', `/v1/contacts?email=${encodeURIComponent(email)}`),
      )
      expect(byEmail.data.map((c) => c.id)).toEqual([survivor.id])

      expect((await call(admin, 'DELETE', `/v1/contacts/${survivor.id}`)).status).toBe(204)
      const trash = await ok<unknown>(await call(admin, 'GET', '/v1/trash?type=contact'))
      expect(JSON.stringify(trash)).toContain(survivor.id)
      expect(JSON.stringify(trash)).not.toContain(second.id)
      await call(admin, 'POST', `/v1/contacts/${survivor.id}/restore`)

      const res = await call(admin, 'GET', `/v1/contacts/${second.id}`)
      expect(res.status).toBe(404)
      const problem = await problemOf(res)
      expect(problem).toMatchObject({
        code: 'CONTACT_MERGED',
        details: { merged_into_id: survivor.id, merge_id: expect.any(String) },
      })
      const patch = await call(admin, 'PATCH', `/v1/contacts/${second.id}`, { lastName: 'Ні' })
      expect(patch.status).toBe(404)
      expect((await problemOf(patch)).code).toBe('CONTACT_MERGED')

      const keyRole = await createRole(h, projectA, {
        actions: { contacts: ['view'] },
        scopes: { contacts: { read: 'all', write: 'all' } },
      } as never)
      const key = await createApiKey(h, admin, projectA, keyRole)
      const byKey = await key.api('GET', `/v1/contacts/${second.id}`)
      expect(byKey.status).toBe(404)
      expect((await problemOf(byKey)).details).toMatchObject({ merged_into_id: survivor.id })
      // Слияние — только по сессии.
      expect(
        (
          await key.api('POST', `/v1/contacts/${survivor.id}/merge`, {
            body: { merge_contact_id: second.id },
          })
        ).status,
      ).toBe(403)
    })

    it('в цепочке слияний — id последнего оставшегося', async () => {
      const first = await createContact({})
      const middle = await createContact({})
      const last = await createContact({})
      await merged(middle.id, first.id)
      await merged(last.id, middle.id)
      const res = await call(admin, 'GET', `/v1/contacts/${first.id}`)
      expect(res.status).toBe(404)
      expect((await problemOf(res)).details).toMatchObject({ merged_into_id: last.id })
    })

    it('окончательное удаление оставшегося удаляет и слитые в него', async () => {
      const survivor = await createContact({})
      const second = await createContact({})
      const third = await createContact({})
      await merged(second.id, third.id)
      const { merge: record } = await merged(survivor.id, second.id)
      expect((await call(admin, 'DELETE', `/v1/contacts/${survivor.id}`)).status).toBe(204)
      const refused = await undo(admin, record.id)
      expect(refused.status).toBe(409)
      expect((await problemOf(refused)).code).toBe('MERGE_UNDO_SURVIVOR_TRASHED')
      expect((await call(admin, 'DELETE', `/v1/contacts/${survivor.id}/permanent`)).status).toBe(
        204,
      )
      for (const id of [survivor.id, second.id, third.id])
        expect(await contactRow(id)).toBeUndefined()
      const records = await h.owner
        .selectFrom('merge_record')
        .select('id')
        .where('survivor_id', 'in', [survivor.id, second.id])
        .execute()
      expect(records).toEqual([])
      const history = await h.owner
        .selectFrom('change_log')
        .select('id')
        .where('entity_id', 'in', [second.id, third.id])
        .execute()
      expect(history).toEqual([])
    })
  })

  describe('откат', () => {
    it('возвращает ровно перешедшее; появившееся после слияния остаётся; изменённое поле — в итоге', async () => {
      const own = fakePhone()
      const movedPhone = fakePhone()
      const later = fakePhone()
      const survivor = await createContact({ phones: [own] })
      const second = await createContact({ language: 'ru', phones: [movedPhone] })
      const deal = await createDeal(second.id)
      const otherDeal = await createDeal((await createContact({})).id)
      await addParticipant(otherDeal.id, second.id, 'Мати')
      const note = await addNote(second.id)
      const file = await addFile(second.id)
      const { merge: record } = await merged(survivor.id, second.id)

      const laterNote = await addNote(survivor.id, 'Після злиття')
      await ok(
        await call(admin, 'PATCH', `/v1/contacts/${survivor.id}`, {
          language: 'uk',
          phones: [own, movedPhone, later],
        }),
      )

      const list = await ok<ContactMergeView[]>(
        await call(admin, 'GET', `/v1/contacts/${survivor.id}/merges`),
      )
      expect(list.map((m) => [m.id, m.mergedContact.id])).toEqual([[record.id, second.id]])

      const result = await ok<UndoResult>(await undo(admin, record.id))
      expect(result.skipped).toEqual([
        { kind: 'field', itemId: null, field: 'language', value: 'ru', reason: 'changed' },
      ])
      expect(result.contact).toMatchObject({ language: 'uk', phones: [own, later] })
      expect(result.mergedContact).toMatchObject({ id: second.id, phones: [movedPhone] })
      expect(await noteOwner(note)).toBe(second.id)
      expect(await fileOwner(file)).toBe(second.id)
      expect(await noteOwner(laterNote)).toBe(survivor.id)
      const back = await h.owner
        .selectFrom('deal')
        .select('primary_contact_id')
        .where('id', '=', deal.id)
        .executeTakeFirstOrThrow()
      expect(back.primary_contact_id).toBe(second.id)
      const participants = await h.owner
        .selectFrom('deal_participant')
        .select('contact_id')
        .where('deal_id', '=', otherDeal.id)
        .execute()
      expect(participants).toEqual([{ contact_id: second.id }])
      const got = await ok<ContactView>(await call(admin, 'GET', `/v1/contacts/${second.id}`))
      expect(got.language).toBe('ru')
      expect(
        await ok<ContactMergeView[]>(
          await call(admin, 'GET', `/v1/contacts/${survivor.id}/merges`),
        ),
      ).toEqual([])
      const twice = await undo(admin, record.id)
      expect(twice.status).toBe(409)
      expect((await problemOf(twice)).code).toBe('MERGE_ALREADY_UNDONE')
    })

    it('сделка, ушедшая в корзину после слияния, возвращается в корзине', async () => {
      const survivor = await createContact({})
      const second = await createContact({})
      const deal = await createDeal(second.id)
      const { merge: record } = await merged(survivor.id, second.id)
      expect((await call(admin, 'DELETE', `/v1/deals/${deal.id}`)).status).toBe(204)
      await ok(await undo(admin, record.id))
      const row = await h.owner
        .selectFrom('deal')
        .select(['primary_contact_id', 'deleted_at'])
        .where('id', '=', deal.id)
        .executeTakeFirstOrThrow()
      expect(row.primary_contact_id).toBe(second.id)
      expect(row.deleted_at).not.toBeNull()
    })

    it('удалённое окончательно после слияния не возвращается и есть в итоге как gone', async () => {
      const survivor = await createContact({})
      const movedPhone = fakePhone()
      const second = await createContact({ phones: [movedPhone] })
      const deal = await createDeal(second.id)
      const note = await addNote(second.id)
      const { merge: record } = await merged(survivor.id, second.id)

      // Телефон убран из карточки оставшегося; сделка и заметка удалены мимо корзины.
      await ok(await call(admin, 'PATCH', `/v1/contacts/${survivor.id}`, { phones: [] }))
      await h.owner.deleteFrom('deal').where('id', '=', deal.id).execute()
      await h.owner.deleteFrom('note').where('id', '=', note).execute()

      const result = await ok<UndoResult>(await undo(admin, record.id))
      const gone = result.skipped
        .filter((skip) => skip.reason === 'gone')
        .map((skip) => [skip.kind, skip.itemId])
        .sort()
      expect(gone).toEqual(
        [
          ['deal', deal.id],
          ['note', note],
          ['phone', null],
        ].sort(),
      )
      expect(result.mergedContact).toMatchObject({ id: second.id, phones: [] })
      expect((await contactRow(second.id))?.merged_into_id).toBeNull()
    })
  })

  describe('отказы', () => {
    it('открытые сделки обоих в одной воронке — 409 MERGE_DEAL_CONFLICT со списком пар', async () => {
      const survivor = await createContact({})
      const second = await createContact({})
      const { id: pipelineId, stageId } = await pipeline()
      const create = async (contactId: string) =>
        ok<{ id: string }>(
          await call(admin, 'POST', '/v1/deals', {
            title: 'Угода',
            pipelineId,
            stageId,
            contactId,
          }),
          201,
        )
      const s = await create(survivor.id)
      const m = await create(second.id)
      const res = await merge(admin, survivor.id, second.id)
      expect(res.status).toBe(409)
      expect(await problemOf(res)).toMatchObject({
        code: 'MERGE_DEAL_CONFLICT',
        details: { pairs: [{ pipelineId, survivorDealId: s.id, mergedDealId: m.id }] },
      })
      expect((await contactRow(second.id))?.merged_into_id).toBeNull()
    })

    it('через 31 день — 409 MERGE_UNDO_EXPIRED', async () => {
      const { merge: record } = await merged(
        (await createContact({})).id,
        (await createContact({})).id,
      )
      await h.owner
        .updateTable('merge_record')
        .set({
          merged_at: sql`merged_at - interval '31 days'`,
          undo_until: sql`undo_until - interval '31 days'`,
        })
        .where('id', '=', record.id)
        .execute()
      const res = await undo(admin, record.id)
      expect(res.status).toBe(409)
      expect((await problemOf(res)).code).toBe('MERGE_UNDO_EXPIRED')
    })

    it('после более позднего слияния — 409 MERGE_UNDO_BLOCKED со ссылкой на него', async () => {
      const a = await createContact({})
      const b = await createContact({})
      const c = await createContact({})
      const { merge: first } = await merged(a.id, b.id)
      const { merge: second } = await merged(c.id, a.id)
      const res = await undo(admin, first.id)
      expect(res.status).toBe(409)
      expect(await problemOf(res)).toMatchObject({
        code: 'MERGE_UNDO_BLOCKED',
        details: { mergeId: second.id },
      })
      await ok(await undo(admin, second.id))
      await ok(await undo(admin, first.id))
    })

    it('открытая сделка слитого в воронке возвращаемой — 409 MERGE_UNDO_DEAL_CONFLICT', async () => {
      const survivor = await createContact({})
      const second = await createContact({})
      const returning = await createDeal(second.id)
      const { merge: record } = await merged(survivor.id, second.id)
      // Открытая сделка у скрытого слитого контакта в той же воронке (API такую не создаст —
      // ставим служебным подключением): после отката у него было бы две открытые.
      const other = await ok<{ id: string }>(
        await call(admin, 'POST', '/v1/deals', {
          title: 'Угода',
          pipelineId: returning.pipelineId,
          stageId: returning.stageId,
          contactId: (await createContact({})).id,
        }),
        201,
      )
      await h.owner
        .updateTable('deal')
        .set({ primary_contact_id: second.id })
        .where('id', '=', other.id)
        .execute()

      const res = await undo(admin, record.id)
      expect(res.status).toBe(409)
      expect(await problemOf(res)).toMatchObject({
        code: 'MERGE_UNDO_DEAL_CONFLICT',
        details: { dealIds: [returning.id, other.id].sort() },
      })
      expect((await contactRow(second.id))?.merged_into_id).toBe(survivor.id)
    })
  })

  describe('события, журнал и история', () => {
    it('одно contact.merged и одно contact.unmerged; журнал проекта и история обоих', async () => {
      const survivor = await createContact({})
      const second = await createContact({})
      const { merge: record } = await merged(survivor.id, second.id)
      const mergedEvents = await events('contact.merged', survivor.id)
      expect(mergedEvents).toHaveLength(1)
      const body = mergedEvents[0]?.body as { data: Record<string, unknown> }
      expect(eventBodyProblem(body)).toBeNull()
      expect(body.data).toMatchObject({ contact_id: survivor.id, merged_contact_id: second.id })

      const auditRows = await h.owner
        .selectFrom('audit_log')
        .select(['action', 'entity_id', 'details'])
        .where('entity_id', '=', survivor.id)
        .orderBy('occurred_at')
        .execute()
      expect(auditRows).toEqual([
        {
          action: 'contact.merged',
          entity_id: survivor.id,
          details: { mergeId: record.id, mergedContactId: second.id },
        },
      ])
      const history = async (id: string) =>
        (
          await h.owner
            .selectFrom('change_log')
            .select('field')
            .where('entity_id', '=', id)
            .execute()
        ).map((row) => row.field)
      expect(await history(survivor.id)).toContain('mergedContactId')
      expect(await history(second.id)).toContain('mergedIntoId')

      await ok(await undo(admin, record.id))
      const unmerged = await events('contact.unmerged', survivor.id)
      expect(unmerged).toHaveLength(1)
      expect(eventBodyProblem(unmerged[0]?.body)).toBeNull()
      expect(await events('contact.merged', survivor.id)).toHaveLength(1)
      const actions = await h.owner
        .selectFrom('audit_log')
        .select('action')
        .where('entity_id', '=', survivor.id)
        .execute()
      expect(actions.map((a) => a.action).sort()).toEqual(['contact.merged', 'contact.unmerged'])
      expect((await history(second.id)).filter((f) => f === 'mergedIntoId')).toHaveLength(2)
    })

    it('слияние, упавшее посередине, не оставляет ни переноса, ни события', async () => {
      const survivor = await createContact({})
      const second = await createContact({})
      const note = await addNote(second.id)
      await sql
        .raw(`
          create function merge_test_fail() returns trigger language plpgsql as $$
          begin
            if new.field = 'mergedIntoId' then raise exception 'збій посередині злиття'; end if;
            return new;
          end $$;
          create trigger merge_test_fail before insert on change_log
            for each row execute function merge_test_fail();
        `)
        .execute(h.owner)
      try {
        const res = await merge(admin, survivor.id, second.id)
        expect(res.status).toBe(500)
      } finally {
        await sql
          .raw('drop trigger merge_test_fail on change_log; drop function merge_test_fail();')
          .execute(h.owner)
      }
      expect(await noteOwner(note)).toBe(second.id)
      expect((await contactRow(second.id))?.merged_into_id).toBeNull()
      expect(await events('contact.merged', survivor.id)).toEqual([])
      const records = await h.owner
        .selectFrom('merge_record')
        .select('id')
        .where('merged_id', '=', second.id)
        .execute()
      expect(records).toEqual([])
    })
  })

  describe('отметка «возможный дубль»', () => {
    it('после слияния пары — без отметки, после отката — снова с отметкой и ссылкой', async () => {
      const email = fakeEmail()
      const first = await createContact({ emails: [email] })
      const duplicate = await createContact({ emails: [email] })
      expect(duplicate).toMatchObject({ possibleDuplicate: true, possibleDuplicateOf: first.id })

      const { merge: record, contact } = await merged(duplicate.id, first.id)
      expect(contact).toMatchObject({ possibleDuplicate: false, possibleDuplicateOf: null })

      const result = await ok<UndoResult>(await undo(admin, record.id))
      expect(result.contact).toMatchObject({
        id: duplicate.id,
        possibleDuplicate: true,
        possibleDuplicateOf: first.id,
      })
    })
  })

  // ---- Скрытые сделки (тикет crm-intake/02) --------------------------------------------------

  describe('скрытые сделки', () => {
    it('скрытые сделки второго контакта в тех же воронках не мешают ни слиянию, ни откату', async () => {
      const survivor = await createContact({})
      const second = await createContact({})
      const other = await createContact({})
      const first = await pipeline()
      const next = await pipeline()
      const deal = async (contactId: string, { id: pipelineId, stageId } = first) =>
        ok<{ id: string }>(
          await call(admin, 'POST', '/v1/deals', {
            title: 'Угода',
            pipelineId,
            stageId,
            contactId,
          }),
          201,
        )
      const hide = async (keeperId: string, hiddenId: string) =>
        ok(await call(admin, 'POST', `/v1/deals/${keeperId}/merge`, { merge_deal_id: hiddenId }))
      // Воронка 1: у оставшегося открытая сделка, у второго — скрытая открытая (слита в сделку
      // третьего контакта). Воронка 2: у второго скрытая и видимая открытые — вернутся обе.
      await deal(survivor.id)
      const hiddenDeal = await deal(second.id)
      const keeper = await deal(other.id)
      await hide(keeper.id, hiddenDeal.id)
      const hiddenNext = await deal(second.id, next)
      await hide((await deal(other.id, next)).id, hiddenNext.id)
      await deal(second.id, next)
      const { merge: record } = await merged(survivor.id, second.id)
      const moved = await h.owner
        .selectFrom('deal')
        .select(['primary_contact_id', 'merged_into_id'])
        .where('id', '=', hiddenDeal.id)
        .executeTakeFirstOrThrow()
      expect(moved).toEqual({ primary_contact_id: survivor.id, merged_into_id: keeper.id })
      await ok<UndoResult>(await undo(admin, record.id))
      expect(
        (
          await h.owner
            .selectFrom('deal')
            .select('primary_contact_id')
            .where('id', '=', hiddenDeal.id)
            .executeTakeFirstOrThrow()
        ).primary_contact_id,
      ).toBe(second.id)
    })
  })

  // ---- Гонки транзакций (расширенная проверка PR #39) ----------------------------------------

  describe('гонки транзакций', () => {
    let base: string
    /** Каталог хранилища файлов. */
    let root: string
    /** API с хранилищем файлов на диске: загрузка файла. */
    let app: ReturnType<typeof createApp>

    beforeAll(async () => {
      base = await mkdtemp(path.join(tmpdir(), 'alpi-contact-merge-'))
      root = path.join(base, 'storage')
      await mkdir(root)
      app = createApp({ auth: h.auth, db: h.appDb, storage: localDiskStorage(root) })
    })

    afterAll(async () => {
      if (base) await rm(base, { recursive: true, force: true })
    })

    /** Сколько запросов к базе сейчас ждут блокировку. */
    async function lockWaiters(): Promise<number> {
      const { rows } = await sql<{ n: string }>`
        select count(*) as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
      `.execute(h.owner)
      return Number(rows[0]?.n ?? 0)
    }

    async function waitForWaiters(n: number, what: string) {
      for (let i = 0; i < 500; i++) {
        if ((await lockWaiters()) >= n) return
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error(`не дождались ${n} ожидающих блокировку: ${what}`)
    }

    /**
     * Служебная транзакция держит блокировку `lock`, пока не вызван `release` — запросы API,
     * которым она нужна, ждут.
     */
    async function holdLock(lock: RawBuilder<unknown>) {
      let release = () => {}
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      let locked = () => {}
      const isLocked = new Promise<void>((resolve) => {
        locked = resolve
      })
      const done = h.owner.transaction().execute(async (trx) => {
        await lock.execute(trx)
        locked()
        await released
      })
      await isLocked
      return {
        async release() {
          release()
          await done
        },
      }
    }

    /** Файлы в хранилище — пути от его корня. */
    async function storedFiles(): Promise<string[]> {
      const entries = await readdir(root, { recursive: true, withFileTypes: true })
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
        .sort()
    }

    const rowsOf = async (table: 'note' | 'file', contactId: string) =>
      (
        await h.owner
          .selectFrom(table)
          .select('id')
          .where('contact_id', '=', contactId)
          .orderBy('id')
          .execute()
      ).map((row) => row.id)

    /** Загрузка файла к контакту с телом `body` (поток или байты). */
    function upload(
      contactId: string,
      name: string,
      body: ReadableStream<Uint8Array> | Uint8Array,
    ) {
      const target: Target = {
        request: (input, init) => {
          const headers = new Headers(init.headers)
          headers.set('content-type', 'application/octet-stream')
          // Тело-поток в Node требует duplex: 'half'.
          return app.request(input, { ...init, headers, body, duplex: 'half' } as RequestInit)
        },
      }
      return admin.call(target, 'POST', `/v1/contacts/${contactId}/files?name=${name}`, {
        project: projectA,
      })
    }

    /**
     * Загрузка файла, тело которой встаёт после первых SNIFF_BYTES байт, пока не вызван `resume`.
     * `reading` — обработчик прочёл начало и ждёт остаток: проверка записи на входе уже прошла.
     */
    function pausedUpload(contactId: string, name: string) {
      let resume = () => {}
      const resumed = new Promise<void>((resolve) => {
        resume = resolve
      })
      let paused = () => {}
      const reading = new Promise<void>((resolve) => {
        paused = resolve
      })
      let step = 0
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          step += 1
          // Первый pull — при создании потока; второй — когда обработчик забрал начало.
          if (step === 1) return controller.enqueue(new Uint8Array(SNIFF_BYTES).fill(0x61))
          paused()
          await resumed
          controller.enqueue(new Uint8Array(16).fill(0x62))
          controller.close()
        },
      })
      return { response: upload(contactId, name, body), reading, resume }
    }

    /** Ответ `pending` или null, если его нет дольше `ms`. */
    async function within(pending: Promise<Response>, ms: number): Promise<Response | null> {
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms)
      })
      try {
        return await Promise.race([pending, late])
      } finally {
        clearTimeout(timer)
      }
    }

    it('цепочка слияний: оставшийся слит позже — откат первого слияния 409, время слияний по порядку записи', async () => {
      const contacts = [await createContact({}), await createContact({}), await createContact({})]
      // T — с наименьшим id: слияние «S в T» блокирует T первым и ждёт его, уже начав транзакцию.
      const [t, s, m] = contacts.map((contact) => contact.id).sort()
      if (!t || !s || !m) throw new Error('контактов нет')
      const held = await holdLock(sql`select id from contact where id = ${t} for update`)
      const later = merge(admin, t, s)
      await waitForWaiters(1, 'слияние S в T ждёт T')
      // Первое слияние (M в S) начинается позже, но записывается раньше.
      const first = await ok<MergeResult>(await merge(admin, s, m))
      await held.release()
      const second = await ok<MergeResult>(await later)

      expect(Date.parse(second.merge.mergedAt)).toBeGreaterThan(Date.parse(first.merge.mergedAt))
      // Отметка на самом контакте — тоже время записи, а не начала транзакции.
      const hiddenS = await contactRow(s)
      expect(new Date(hiddenS?.merged_at ?? 0).getTime()).toBeGreaterThan(
        Date.parse(first.merge.mergedAt),
      )
      const refused = await undo(admin, first.merge.id)
      expect(refused.status).toBe(409)
      expect(await problemOf(refused)).toEqual({
        code: 'MERGE_UNDO_BLOCKED',
        details: { mergeId: second.merge.id },
      })
      // Даже если время позднего слияния записано раньше (слияния до этой правки), откат
      // смотрит, не слит ли сам оставшийся.
      await h.owner
        .updateTable('merge_record')
        .set({ merged_at: new Date(Date.parse(first.merge.mergedAt) - 60_000) })
        .where('id', '=', second.merge.id)
        .execute()
      const stillRefused = await undo(admin, first.merge.id)
      expect(stillRefused.status).toBe(409)
      expect(await problemOf(stillRefused)).toEqual({
        code: 'MERGE_UNDO_BLOCKED',
        details: { mergeId: second.merge.id },
      })
      await h.owner
        .updateTable('merge_record')
        .set({ merged_at: new Date(second.merge.mergedAt) })
        .where('id', '=', second.merge.id)
        .execute()
      // Сначала позднее, потом первое — проходит.
      await ok(await undo(admin, second.merge.id))
      await ok(await undo(admin, first.merge.id))
      expect((await contactRow(m))?.merged_into_id).toBeNull()
    })

    it('фоновая очистка корзины не стирает контакт, который в тот же момент восстановили', async () => {
      // Отдельный проект: в корзине A лежат контакты других проверок.
      const project = (await h.createProject(admin, 'Злиття гонка кошика')).id
      const restored = await createContact({}, admin, project)
      // В восстанавливаемый контакт слит другой: цепочка тоже должна уцелеть.
      const hidden = await createContact({}, admin, project)
      await ok(await merge(admin, restored.id, hidden.id, project))
      const note = await ok<{ id: string }>(
        await call(
          admin,
          'POST',
          `/v1/contacts/${restored.id}/notes`,
          { text: 'Має вціліти' },
          project,
        ),
        201,
      )
      expect(
        (await call(admin, 'DELETE', `/v1/contacts/${restored.id}`, undefined, project)).status,
      ).toBe(204)
      // Восстановление встаёт на запись истории (таблица заблокирована), уже держа строку контакта.
      const held = await holdLock(sql`lock table change_log in exclusive mode`)
      const restoring = call(
        admin,
        'POST',
        `/v1/contacts/${restored.id}/restore`,
        undefined,
        project,
      )
      await waitForWaiters(1, 'восстановление ждёт историю')
      const purging = withProject(h.appDb, project, (trx) =>
        CONTACT_PURGER.purgeExpired(trx, new Date(Date.now() + 86_400_000)),
      ).then(
        () => null,
        (error: unknown) => error,
      )
      await waitForWaiters(2, 'очистка ждёт строку контакта')
      await held.release()
      await ok(await restoring)
      expect(await purging).toMatchObject({ code: 'CL001' })
      expect(await contactRow(restored.id)).toMatchObject({ deleted_at: null })
      expect(await contactRow(hidden.id)).toMatchObject({ merged_into_id: restored.id })
      expect(await rowsOf('note', restored.id)).toEqual([note.id])
      expect(
        await h.owner
          .selectFrom('merge_record')
          .select('merged_id')
          .where('survivor_id', '=', restored.id)
          .execute(),
      ).toEqual([{ merged_id: hidden.id }])
    })

    it('фоновая очистка корзины стирает контакт вместе со слитыми в него', async () => {
      const project = (await h.createProject(admin, 'Злиття очистка ланцюжка')).id
      const survivor = await createContact({}, admin, project)
      const second = await createContact({}, admin, project)
      const third = await createContact({}, admin, project)
      await ok(await merge(admin, second.id, third.id, project))
      await ok(await merge(admin, survivor.id, second.id, project))
      expect(
        (await call(admin, 'DELETE', `/v1/contacts/${survivor.id}`, undefined, project)).status,
      ).toBe(204)
      const deleted = await withProject(h.appDb, project, (trx) =>
        CONTACT_PURGER.purgeExpired(trx, new Date(Date.now() + 86_400_000)),
      )
      expect(deleted).toBe(1)
      for (const id of [survivor.id, second.id, third.id]) {
        expect(await contactRow(id)).toBeUndefined()
      }
      expect(
        await h.owner
          .selectFrom('merge_record')
          .select('id')
          .where('project_id', '=', project)
          .execute(),
      ).toEqual([])
    })

    it('заметка и файл, добавленные ко второму контакту во время слияния, не остаются у скрытого', async () => {
      const survivor = await createContact({})
      const second = await createContact({})
      const storedBefore = await storedFiles()
      // Слияние встаёт на запись события (таблица заблокирована), уже держа оба контакта.
      const held = await holdLock(sql`lock table webhook_event in exclusive mode`)
      const merging = merge(admin, survivor.id, second.id)
      await waitForWaiters(1, 'слияние ждёт запись события')
      const during = [
        call(admin, 'POST', `/v1/contacts/${second.id}/notes`, { text: 'Під час' }),
        upload(second.id, 'pid-chas.txt', new TextEncoder().encode('abc')),
      ]
      await waitForWaiters(3, 'добавления ждут контакт')
      await held.release()
      await ok(await merging)
      for (const res of await Promise.all(during)) {
        expect(res.status).toBe(404)
        expect(await problemOf(res)).toEqual({ code: 'CONTACT_NOT_FOUND' })
      }
      expect(await rowsOf('note', second.id)).toEqual([])
      expect(await rowsOf('file', second.id)).toEqual([])
      // Загрузка положила тело в хранилище до повторной проверки — после отказа его там нет.
      expect(await storedFiles()).toEqual(storedBefore)
    })

    it('правка контакта не ждёт загрузку файла, пока идёт тело: файл после правки — 201', async () => {
      const contact = await createContact({})
      const pending = pausedUpload(contact.id, 'potik.txt')
      await pending.reading
      const edit = call(admin, 'PATCH', `/v1/contacts/${contact.id}`, { lastName: 'Завантаження' })
      try {
        // Ранняя блокировка FOR SHARE держала бы правку (FOR UPDATE) до конца потока.
        const edited = await within(edit, 5_000)
        expect(edited, 'правка контакта ждала конца потока файла').not.toBeNull()
        expect((await ok<ContactView>(edited as Response)).lastName).toBe('Завантаження')
      } finally {
        pending.resume()
        await Promise.allSettled([edit, pending.response])
      }
      const file = await ok<{ id: string; size: number }>(await pending.response, 201)
      expect(file.size).toBe(SNIFF_BYTES + 16)
      expect(await rowsOf('file', contact.id)).toEqual([file.id])
    })
  })
})
