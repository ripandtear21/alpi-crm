import { randomInt, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { withProject } from '@alpi/db'
import { type EventType, eventBodyProblem } from '@alpi/shared'
import { type RawBuilder, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import type { ContactView } from '../contacts/contacts.ts'
import type { DealHistoryEntry } from '../deals/deals.ts'
import type { DealView } from '../deals/store.ts'
import { localDiskStorage } from '../storage/storage.ts'
import {
  type ApiHarness,
  type Method,
  type SignedInUser,
  startApiHarness,
  type Target,
} from '../testing/api-harness.ts'
import { problemOf } from '../testing/problem.ts'
import type { TimelinePage } from '../timeline/timeline.ts'
import { DEAL_PURGER } from '../trash/purgers.ts'
import type { DealMergePreview, DealMergeResult, DealUndoResult } from './deals.ts'

// Слияние сделок с откатом (тикет crm-intake/02; ADR 0005): изоляция проектов, права, что
// переходит, скрытие слитой сделки, история, откат, события и журнал — и три гонки транзакций,
// которые расширенная проверка PR #39 (слияние контактов) нашла в этом устройстве, — на
// настоящем PostgreSQL, API ходит ролью приложения. Имена, телефоны и суммы — вымышленные.

const fakePhone = () => `+38067${randomInt(1_000_000, 9_999_999)}`

interface Pipeline {
  id: string
  stages: string[]
}

describe('слияние сделок', () => {
  let h: ApiHarness
  let app: ReturnType<typeof createApp>
  let base: string
  let admin: SignedInUser
  /** Сделки: смотреть все, менять свои. */
  let readAll: SignedInUser
  /** Сделки: только смотреть. */
  let viewer: SignedInUser
  let projectA: string
  let projectB: string
  let customCode: string
  let product: string
  let counter = 0

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_deal_merge')
    base = await mkdtemp(path.join(tmpdir(), 'alpi-merge-'))
    const root = path.join(base, 'storage')
    await mkdir(root)
    app = createApp({ auth: h.auth, db: h.appDb, storage: localDiskStorage(root) })
    admin = await h.signIn('owner')
    projectA = (await h.createProject(admin, 'Злиття А')).id
    projectB = (await h.createProject(admin, 'Злиття Б')).id
    readAll = await h.signIn()
    viewer = await h.signIn()
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
        {
          project_id: projectA,
          user_id: readAll.id,
          role_id: await role('Бачить усе, змінює своє', {
            actions: { deals: ['view', 'create', 'edit'], contacts: ['view', 'create', 'edit'] },
            scopes: { deals: { read: 'all', write: 'own' } },
          }),
        },
        {
          project_id: projectA,
          user_id: viewer.id,
          role_id: await role('Лише перегляд', {
            actions: { deals: ['view'], contacts: ['view'] },
            scopes: { deals: { read: 'all', write: 'all' } },
          }),
        },
      ])
      .execute()
    const group = await json<{ id: string }>(
      await call(admin, 'POST', '/v1/field-groups', { entity: 'deal', nameUk: 'Злиття' }),
      201,
    )
    customCode = 'dzherelo'
    await json(
      await call(admin, 'POST', '/v1/fields', {
        groupId: group.id,
        nameUk: 'Джерело',
        code: customCode,
        type: 'text',
      }),
      201,
    )
    product = (
      await h.owner
        .insertInto('product')
        .values({ project_id: projectA, name: 'Курс', price_eur: 10, price_usd: 12 })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
  })

  afterAll(async () => {
    await h?.stop()
    if (base) await rm(base, { recursive: true, force: true })
  })

  // ---- Помощники ---------------------------------------------------------------------------

  function call(
    user: SignedInUser,
    method: Method,
    url: string,
    body?: unknown,
    project = projectA,
  ) {
    return user.call(app, method, url, { project, ...(body === undefined ? {} : { body }) })
  }

  async function json<T>(res: Response, status = 200): Promise<T> {
    const body = await res.json().catch(() => null)
    expect(res.status, JSON.stringify(body)).toBe(status)
    return body as T
  }

  async function createPipeline(projectId = projectA): Promise<Pipeline> {
    counter += 1
    const { id } = await h.owner
      .insertInto('pipeline')
      .values({
        project_id: projectId,
        code: `m${counter}`,
        name: `Воронка ${counter}`,
        position: counter,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const stages: string[] = []
    for (const name of ['Новий', 'Переговори', 'Оплата']) {
      const stage = await h.owner
        .insertInto('stage')
        .values({ project_id: projectId, pipeline_id: id, name, position: stages.length + 1 })
        .returning('id')
        .executeTakeFirstOrThrow()
      stages.push(stage.id)
    }
    return { id, stages }
  }

  async function createContact(name: string, project = projectA, user = admin) {
    return json<ContactView>(
      await call(user, 'POST', '/v1/contacts', { firstName: name, phones: [fakePhone()] }, project),
      201,
    )
  }

  async function createDeal(body: Record<string, unknown>, project = projectA, user = admin) {
    return json<DealView>(
      await call(user, 'POST', '/v1/deals', { title: 'Угода', ...body }, project),
      201,
    )
  }

  /** Две открытые сделки разных контактов в одной воронке. */
  async function pair(extra: { survivor?: object; merged?: object } = {}) {
    const pipeline = await createPipeline()
    const survivor = await createDeal({
      pipelineId: pipeline.id,
      contactId: (await createContact('Ірина')).id,
      title: 'Оставшаяся',
      ...extra.survivor,
    })
    const merged = await createDeal({
      pipelineId: pipeline.id,
      contactId: (await createContact('Олег')).id,
      title: 'Слитая',
      ...extra.merged,
    })
    return { pipeline, survivor, merged }
  }

  const merge = (survivorId: string, mergedId: string, user = admin, project = projectA) =>
    call(user, 'POST', `/v1/deals/${survivorId}/merge`, { merge_deal_id: mergedId }, project)

  const undo = (mergeId: string, user = admin, project = projectA) =>
    call(user, 'POST', `/v1/merges/${mergeId}/undo`, undefined, project)

  async function addNote(dealId: string, text: string) {
    return json<{ id: string }>(
      await call(admin, 'POST', `/v1/deals/${dealId}/notes`, { text }),
      201,
    )
  }

  /** Файл без содержимого в хранилище: слиянию нужна только строка. */
  async function insertFile(dealId: string, name: string) {
    const id = randomUUID()
    await h.owner
      .insertInto('file')
      .values({
        id,
        project_id: projectA,
        deal_id: dealId,
        contact_id: null,
        organization_id: null,
        name,
        content_type: 'text/plain',
        size: 3,
        storage_key: `${projectA}/${id}`,
        author_id: admin.id,
      })
      .execute()
    return { id }
  }

  async function rowsOf(
    table: 'note' | 'file' | 'deal_product' | 'deal_participant',
    dealId: string,
  ): Promise<string[]> {
    const { rows } = await sql<{ id: string }>`
      select id from ${sql.table(table)} where deal_id = ${dealId} order by id
    `.execute(h.owner)
    return rows.map((row) => row.id)
  }

  async function events(type: EventType, dealId: string) {
    return h.owner
      .selectFrom('webhook_event')
      .select(['type', 'body'])
      .where('type', '=', type)
      .where('entity_id', '=', dealId)
      .execute()
  }

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

  // ---- Изоляция и права --------------------------------------------------------------------

  describe('изоляция проектов', () => {
    it('сделку A не слить со сделкой B; слияния A не видны в B без фильтра в коде', async () => {
      const { survivor, merged } = await pair()
      const pipelineB = await createPipeline(projectB)
      const dealB = await createDeal(
        { pipelineId: pipelineB.id, contactId: (await createContact('Чужий', projectB)).id },
        projectB,
      )
      const foreign = await merge(survivor.id, dealB.id)
      expect(foreign.status).toBe(404)
      expect(await problemOf(foreign)).toEqual({ code: 'DEAL_NOT_FOUND' })
      expect((await merge(dealB.id, survivor.id, admin, projectB)).status).toBe(404)

      const done = await json<DealMergeResult>(await merge(survivor.id, merged.id))
      const seenB = await withProject(h.appDb, projectB, async (trx) => ({
        records: await trx.selectFrom('merge_record').select('id').execute(),
        items: await trx.selectFrom('merge_moved_item').select('id').execute(),
      }))
      expect(seenB).toEqual({ records: [], items: [] })
      const seenA = await withProject(h.appDb, projectA, (trx) =>
        trx.selectFrom('merge_record').select('id').where('id', '=', done.merge.id).execute(),
      )
      expect(seenA).toHaveLength(1)
      const fromB = await undo(done.merge.id, admin, projectB)
      expect(fromB.status).toBe(404)
      expect(await problemOf(fromB)).toEqual({ code: 'MERGE_NOT_FOUND' })
    })
  })

  describe('права', () => {
    it('без «сделки: изменять» — 403; «свои», одна сделка чужая — 403; откат — те же проверки', async () => {
      const pipeline = await createPipeline()
      const own = await createDeal(
        {
          pipelineId: pipeline.id,
          contactId: (await createContact('Своя', projectA, readAll)).id,
          ownerId: readAll.id,
        },
        projectA,
        readAll,
      )
      const foreign = await createDeal({
        pipelineId: pipeline.id,
        contactId: (await createContact('Чужа')).id,
      })
      for (const url of ['merge', 'merge/preview']) {
        const denied = await call(viewer, 'POST', `/v1/deals/${own.id}/${url}`, {
          merge_deal_id: foreign.id,
        })
        expect(denied.status).toBe(403)
        const outOfScope = await call(readAll, 'POST', `/v1/deals/${own.id}/${url}`, {
          merge_deal_id: foreign.id,
        })
        expect(outOfScope.status).toBe(403)
        expect(await problemOf(outOfScope)).toEqual({ code: 'PERMISSION_DENIED' })
      }
      const done = await json<DealMergeResult>(await merge(own.id, foreign.id))
      expect((await undo(done.merge.id, viewer)).status).toBe(403)
      const undoOutOfScope = await undo(done.merge.id, readAll)
      expect(undoOutOfScope.status).toBe(403)
      expect(await problemOf(undoOutOfScope)).toEqual({ code: 'PERMISSION_DENIED' })
      // Отказы ничего не откатили.
      expect(
        await h.owner
          .selectFrom('merge_record')
          .select('undone_at')
          .where('id', '=', done.merge.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ undone_at: null })
    })

    it('сделку с самой собой, слитую или в корзине — нельзя', async () => {
      const { survivor, merged } = await pair()
      const same = await merge(survivor.id, survivor.id)
      expect(same.status).toBe(422)
      expect(await problemOf(same)).toEqual({ code: 'MERGE_SAME_DEAL' })
      await json(await merge(survivor.id, merged.id))
      const again = await merge(survivor.id, merged.id)
      expect(again.status).toBe(404)
      expect(await problemOf(again)).toMatchObject({
        code: 'DEAL_MERGED',
        details: { merged_into_id: survivor.id },
      })
      const third = await createDeal({
        pipelineId: (await createPipeline()).id,
        contactId: (await createContact('Кошик')).id,
      })
      expect((await call(admin, 'DELETE', `/v1/deals/${third.id}`)).status).toBe(204)
      expect((await merge(survivor.id, third.id)).status).toBe(404)
    })
  })

  // ---- Что переходит -----------------------------------------------------------------------

  describe('слияние', () => {
    it('этап, ответственный и заполненные поля — оставшейся; пустые — из второй; записи второй перешли', async () => {
      const organization = await h.owner
        .insertInto('organization')
        .values({ project_id: projectA, name: 'Вигадана компанія' })
        .returning('id')
        .executeTakeFirstOrThrow()
      const { pipeline, survivor, merged } = await pair()
      // Оставшаяся: второй этап, 100 EUR, участник, своя строка товара.
      await json(
        await call(admin, 'POST', `/v1/deals/${survivor.id}/stage`, {
          stageId: pipeline.stages[1],
        }),
      )
      await json(await call(admin, 'PUT', `/v1/deals/${survivor.id}`, { amount: 100 }))
      const keeper = await createContact('Залишається')
      await json(
        await call(admin, 'POST', `/v1/deals/${survivor.id}/participants`, {
          contactId: keeper.id,
        }),
        201,
      )
      // Вторая: 500 USD, организация, дата, пользовательское поле, участник, строка, заметка, файл.
      await json(
        await call(admin, 'PUT', `/v1/deals/${merged.id}`, {
          amount: 500,
          currency: 'USD',
          organizationId: organization.id,
          expectedCloseDate: '2027-03-01',
          custom: { [customCode]: 'Виставка' },
        }),
      )
      const moving = await createContact('Переходить')
      await json(
        await call(admin, 'POST', `/v1/deals/${merged.id}/participants`, {
          contactId: moving.id,
        }),
        201,
      )
      await json(
        await call(admin, 'POST', `/v1/deals/${merged.id}/products`, {
          productId: product,
          quantity: 3,
        }),
        201,
      )
      const note = await addNote(merged.id, 'Нотатка другої угоди')
      const file = await insertFile(merged.id, 'договір.txt')
      const linesBefore = await rowsOf('deal_product', merged.id)

      const previewed = await json<DealMergePreview>(
        await call(admin, 'POST', `/v1/deals/${survivor.id}/merge/preview`, {
          merge_deal_id: merged.id,
        }),
      )
      expect(previewed).toMatchObject({
        fields: expect.arrayContaining([
          { field: 'organizationId', value: organization.id },
          { field: 'expectedCloseDate', value: '2027-03-01' },
          { field: `custom.${customCode}`, value: 'Виставка' },
        ]),
        products: 1,
        convertedProducts: 1,
        participants: 1,
        primaryContactId: merged.primaryContactId,
        notes: 1,
        files: 1,
      })
      // Предпросмотр ничего не пишет.
      expect(await rowsOf('note', merged.id)).toEqual([note.id])

      const done = await json<DealMergeResult>(await merge(survivor.id, merged.id))
      const after = done.deal
      expect(after).toMatchObject({
        id: survivor.id,
        title: 'Оставшаяся',
        stageId: pipeline.stages[1],
        ownerId: admin.id,
        status: 'open',
        primaryContactId: survivor.primaryContactId,
        amount: 100,
        currency: 'EUR',
        organizationId: organization.id,
        expectedCloseDate: '2027-03-01',
        custom: { [customCode]: 'Виставка' },
      })
      // Строка второй — в оставшейся, по цене товара в EUR (10, а не 12 USD); сумма не пересчитана.
      expect(after.products).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: linesBefore[0], unitPrice: 10, quantity: 3 }),
        ]),
      )
      expect(after.productsTotal).toBe(30)
      expect(after.amount).toBe(100)
      expect(after.participants.map((p) => p.contactId).sort()).toEqual(
        [keeper.id, moving.id, merged.primaryContactId].sort(),
      )
      expect(await rowsOf('note', survivor.id)).toEqual([note.id])
      expect(await rowsOf('file', survivor.id)).toEqual([file.id])
      expect(await rowsOf('note', merged.id)).toEqual([])
      expect(done.merge).toMatchObject({
        entityType: 'deal',
        survivorId: survivor.id,
        mergedId: merged.id,
        mergedBy: { id: admin.id },
        undoneAt: null,
      })
      const hidden = await h.owner
        .selectFrom('deal')
        .select(['merged_into_id', 'amount', 'currency', 'stage_id', 'status'])
        .where('id', '=', merged.id)
        .executeTakeFirstOrThrow()
      expect(hidden).toMatchObject({
        merged_into_id: survivor.id,
        currency: 'USD',
        stage_id: pipeline.stages[0],
        status: 'open',
      })
    })

    it('пустая сумма (0): сумма и валюта — из второй; строки второй в той же валюте не меняются', async () => {
      const { survivor, merged } = await pair({ merged: { amount: 250, currency: 'USD' } })
      await json(
        await call(admin, 'POST', `/v1/deals/${merged.id}/products`, {
          productId: product,
          quantity: 1,
          unitPrice: 15,
        }),
        201,
      )
      const done = await json<DealMergeResult>(await merge(survivor.id, merged.id))
      expect(done.deal).toMatchObject({ amount: 250, currency: 'USD' })
      expect(done.deal.products.map((p) => p.unitPrice)).toEqual([15])
      const back = await json<DealUndoResult>(await undo(done.merge.id))
      expect(back.deal).toMatchObject({ amount: 0, currency: 'EUR', products: [] })
      expect(back.mergedDeal.products.map((p) => p.unitPrice)).toEqual([15])
      expect(back.skipped).toEqual([])
    })
  })

  // ---- Скрытие -----------------------------------------------------------------------------

  describe('скрытие', () => {
    it('слитой нет в канбане, списке, счётчике, поиске, корзине и агрегатах; GET — 404 DEAL_MERGED', async () => {
      const title = `Квазар ${randomInt(1e9)}`
      const { pipeline, survivor, merged } = await pair({
        survivor: { title: `${title} перша`, amount: 10 },
        merged: { title: `${title} друга`, amount: 40 },
      })
      const done = await json<DealMergeResult>(await merge(survivor.id, merged.id))

      const list = await json<{ data: { id: string }[] }>(
        await call(admin, 'GET', `/v1/deals?pipeline=${pipeline.id}`),
      )
      expect(list.data.map((d) => d.id)).toEqual([survivor.id])
      const kanban = await json<{ data: { id: string }[] }>(
        await call(admin, 'GET', `/v1/deals?pipeline=${pipeline.id}&view=kanban`),
      )
      expect(kanban.data.map((d) => d.id)).toEqual([survivor.id])
      expect(
        await json<{ count: number }>(
          await call(admin, 'GET', `/v1/deals/count?pipeline=${pipeline.id}`),
        ),
      ).toMatchObject({ count: 1 })
      const aggregates = await json<{ stages: { count: number; sums: object }[] }>(
        await call(admin, 'GET', `/v1/pipelines/${pipeline.id}/aggregates`),
      )
      expect(aggregates.stages).toEqual([
        { stageId: pipeline.stages[0], count: 1, sums: { EUR: 10 } },
      ])
      const found = await json<{ deals: { items: { id: string }[] } }>(
        await call(admin, 'GET', `/v1/search?q=${encodeURIComponent(title)}`),
      )
      expect(found.deals.items.map((d) => d.id)).toEqual([survivor.id])

      const direct = await call(admin, 'GET', `/v1/deals/${merged.id}`)
      expect(direct.status).toBe(404)
      expect(await problemOf(direct)).toEqual({
        code: 'DEAL_MERGED',
        details: {
          merged_into_id: survivor.id,
          merge_id: done.merge.id,
          undo_until: done.merge.undoUntil,
        },
      })
      // Изменить, добавить заметку или строку к скрытой — как несуществующей.
      expect((await call(admin, 'PUT', `/v1/deals/${merged.id}`, { title: 'Ні' })).status).toBe(404)
      expect(
        (await call(admin, 'POST', `/v1/deals/${merged.id}/notes`, { text: 'Ні' })).status,
      ).toBe(404)

      // Корзина: даже с отметкой корзины (её ставят только в обход API) слитой там нет.
      await h.owner
        .updateTable('deal')
        .set({ deleted_at: new Date() })
        .where('id', '=', merged.id)
        .execute()
      const trash = await json<{ data: { id: string }[] }>(
        await call(admin, 'GET', '/v1/trash?type=deal&limit=200'),
      )
      expect(trash.data.map((d) => d.id)).not.toContain(merged.id)
      await h.owner
        .updateTable('deal')
        .set({ deleted_at: null })
        .where('id', '=', merged.id)
        .execute()
    })

    it('после слияния у контакта второй сделки можно открыть новую в той же воронке', async () => {
      const { pipeline, survivor, merged } = await pair()
      const twin = await call(admin, 'POST', '/v1/deals', {
        title: 'Друга відкрита',
        pipelineId: pipeline.id,
        contactId: merged.primaryContactId,
      })
      expect(twin.status).toBe(409)
      await json(await merge(survivor.id, merged.id))
      await createDeal({ pipelineId: pipeline.id, contactId: merged.primaryContactId })
    })

    it('цепочка: A слита в B, B в C — 404 с id C', async () => {
      const pipeline = await createPipeline()
      const [a, b, c] = await Promise.all(
        ['Ланка А', 'Ланка Б', 'Ланка В'].map(async (name) =>
          createDeal({ pipelineId: pipeline.id, contactId: (await createContact(name)).id }),
        ),
      )
      if (!a || !b || !c) throw new Error('сделок нет')
      await json(await merge(b.id, a.id))
      await json(await merge(c.id, b.id))
      expect(await problemOf(await call(admin, 'GET', `/v1/deals/${a.id}`))).toMatchObject({
        code: 'DEAL_MERGED',
        details: { merged_into_id: c.id },
      })
    })
  })

  // ---- История -----------------------------------------------------------------------------

  describe('история', () => {
    it('лента и история оставшейся показывают записи второй с пометкой; после отката — только свои', async () => {
      const { survivor, merged } = await pair()
      await json(await call(admin, 'PUT', `/v1/deals/${merged.id}`, { title: 'Слитая нова' }))
      const done = await json<DealMergeResult>(await merge(survivor.id, merged.id))

      const timeline = await json<TimelinePage>(
        await call(admin, 'GET', `/v1/deals/${survivor.id}/timeline?type=change&limit=200`),
      )
      const fromMerged = timeline.data.filter((item) => item.change?.mergedDealId === merged.id)
      expect(fromMerged.map((item) => item.change?.field)).toEqual(
        expect.arrayContaining(['title', 'mergedIntoId']),
      )
      expect(timeline.data.some((item) => item.change?.field === 'mergedDealId')).toBe(true)
      const history = await json<DealHistoryEntry[]>(
        await call(admin, 'GET', `/v1/deals/${survivor.id}/history?limit=200`),
      )
      expect(history.find((e) => e.field === 'title')).toMatchObject({
        mergedDealId: merged.id,
        after: 'Слитая нова',
      })
      expect(history.find((e) => e.field === 'mergedDealId')).toMatchObject({
        mergedDealId: null,
        after: merged.id,
      })
      // Строки change_log не копируются: у оставшейся своих записей о названии нет.
      const own = await h.owner
        .selectFrom('change_log')
        .select('field')
        .where('entity_id', '=', survivor.id)
        .where('field', '=', 'title')
        .execute()
      expect(own).toEqual([])

      await json(await undo(done.merge.id))
      const later = await json<TimelinePage>(
        await call(admin, 'GET', `/v1/deals/${survivor.id}/timeline?type=change&limit=200`),
      )
      expect(later.data.filter((item) => item.change?.mergedDealId !== undefined)).toEqual([])
      const laterHistory = await json<DealHistoryEntry[]>(
        await call(admin, 'GET', `/v1/deals/${survivor.id}/history?limit=200`),
      )
      expect(laterHistory.filter((e) => e.mergedDealId !== null)).toEqual([])
    })
  })

  // ---- Откат -------------------------------------------------------------------------------

  describe('откат', () => {
    it('возвращает ровно перешедшее; добавленное после слияния остаётся; вторая — с прежними этапом, статусом и архивом', async () => {
      const organization = await h.owner
        .insertInto('organization')
        .values({ project_id: projectA, name: 'Ще одна компанія' })
        .returning('id')
        .executeTakeFirstOrThrow()
      const { pipeline, survivor, merged } = await pair({
        merged: { organizationId: organization.id, expectedCloseDate: '2027-05-05' },
      })
      await json(
        await call(admin, 'POST', `/v1/deals/${merged.id}/stage`, { stageId: pipeline.stages[2] }),
      )
      await json(await call(admin, 'POST', `/v1/deals/${merged.id}/win`, {}))
      await json(await call(admin, 'POST', `/v1/deals/${merged.id}/archive`, {}))
      const moving = await createContact('Учасник другої')
      await json(
        await call(admin, 'POST', `/v1/deals/${merged.id}/participants`, {
          contactId: moving.id,
        }),
        201,
      )
      await json(
        await call(admin, 'POST', `/v1/deals/${merged.id}/products`, {
          productId: product,
          quantity: 2,
          unitPrice: 9,
        }),
        201,
      )
      const note = await addNote(merged.id, 'Своя нотатка другої')
      const file = await insertFile(merged.id, 'рахунок.txt')
      const before = await json<DealView>(await call(admin, 'GET', `/v1/deals/${merged.id}`))

      const done = await json<DealMergeResult>(await merge(survivor.id, merged.id))
      const laterNote = await addNote(survivor.id, 'Після злиття')
      // Дату, поставленную слиянием, поменяли после него: откат её не трогает.
      await json(
        await call(admin, 'PUT', `/v1/deals/${survivor.id}`, { expectedCloseDate: '2027-06-06' }),
      )

      const back = await json<DealUndoResult>(await undo(done.merge.id))
      expect(back.skipped).toEqual([
        expect.objectContaining({ kind: 'field', field: 'expectedCloseDate', reason: 'changed' }),
      ])
      expect(back.mergedDeal).toEqual({ ...before, updatedAt: expect.any(String) })
      expect(back.deal).toMatchObject({
        organizationId: null,
        expectedCloseDate: '2027-06-06',
        products: [],
        participants: [],
      })
      expect(await rowsOf('note', survivor.id)).toEqual([laterNote.id])
      expect(await rowsOf('note', merged.id)).toEqual([note.id])
      expect(await rowsOf('file', merged.id)).toEqual([file.id])
      expect(back.merge.undoneAt).toEqual(expect.any(String))
      expect((await json<DealView>(await call(admin, 'GET', `/v1/deals/${merged.id}`))).id).toBe(
        merged.id,
      )
      const twice = await undo(done.merge.id)
      expect(twice.status).toBe(409)
      expect(await problemOf(twice)).toEqual({ code: 'MERGE_ALREADY_UNDONE' })
    })

    it('откат, который даёт вторую открытую сделку контакта в воронке, — 409', async () => {
      const { pipeline, survivor, merged } = await pair()
      const done = await json<DealMergeResult>(await merge(survivor.id, merged.id))
      const fresh = await createDeal({
        pipelineId: pipeline.id,
        contactId: merged.primaryContactId,
      })
      const refused = await undo(done.merge.id)
      expect(refused.status).toBe(409)
      expect(await problemOf(refused)).toEqual({
        code: 'MERGE_UNDO_DEAL_CONFLICT',
        details: { dealId: fresh.id },
      })
      // Отказ ничего не вернул.
      expect(
        await h.owner
          .selectFrom('deal')
          .select('merged_into_id')
          .where('id', '=', merged.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ merged_into_id: survivor.id })
    })

    it('оставшаяся в корзине — 409; после восстановления откат проходит', async () => {
      const { survivor, merged } = await pair()
      const done = await json<DealMergeResult>(await merge(survivor.id, merged.id))
      expect((await call(admin, 'DELETE', `/v1/deals/${survivor.id}`)).status).toBe(204)
      const refused = await undo(done.merge.id)
      expect(refused.status).toBe(409)
      expect(await problemOf(refused)).toEqual({ code: 'MERGE_UNDO_SURVIVOR_TRASHED' })
      await json(await call(admin, 'POST', `/v1/deals/${survivor.id}/restore`))
      await json(await undo(done.merge.id))
    })

    it('слияния в карточке оставшейся: можно откатить — в списке, откаченное — нет', async () => {
      const { survivor, merged } = await pair()
      const done = await json<DealMergeResult>(await merge(survivor.id, merged.id))
      const list = await json<{ id: string; mergedDeal: { id: string; title: string } }[]>(
        await call(admin, 'GET', `/v1/deals/${survivor.id}/merges`),
      )
      expect(list).toEqual([
        expect.objectContaining({
          id: done.merge.id,
          mergedDeal: { id: merged.id, title: 'Слитая' },
        }),
      ])
      await json(await undo(done.merge.id))
      expect(await json(await call(admin, 'GET', `/v1/deals/${survivor.id}/merges`))).toEqual([])
    })
  })

  // ---- События и журнал --------------------------------------------------------------------

  describe('события и журнал', () => {
    it('по одному deal.merged и deal.unmerged, тела проходят схему; журнал и история обеих сделок', async () => {
      const { survivor, merged } = await pair()
      const done = await json<DealMergeResult>(await merge(survivor.id, merged.id))
      await json(await undo(done.merge.id))
      for (const type of ['deal.merged', 'deal.unmerged'] as const) {
        const rows = await events(type, survivor.id)
        expect(rows).toHaveLength(1)
        const body = rows[0]?.body as { data: Record<string, unknown> }
        expect(eventBodyProblem(body)).toBeNull()
        expect(body.data).toMatchObject({ deal_id: survivor.id, merged_deal_id: merged.id })
      }
      const audit = await h.owner
        .selectFrom('audit_log')
        .select(['action', 'actor_id', 'details'])
        .where('entity_id', '=', survivor.id)
        .orderBy('occurred_at')
        .execute()
      expect(audit.map((a) => a.action)).toEqual(['deal.merged', 'deal.unmerged'])
      expect(audit[0]).toMatchObject({
        actor_id: admin.id,
        details: { mergeId: done.merge.id, mergedDealId: merged.id },
      })
      const history = async (id: string) =>
        (
          await h.owner
            .selectFrom('change_log')
            .select(['field', 'before', 'after'])
            .where('entity_id', '=', id)
            .where('field', 'in', ['mergedDealId', 'mergedIntoId'])
            .orderBy('occurred_at')
            .orderBy('id')
            .execute()
        ).map(({ field, before, after }) => ({ field, before, after }))
      expect(await history(survivor.id)).toEqual([
        { field: 'mergedDealId', before: null, after: merged.id },
        { field: 'mergedDealId', before: merged.id, after: null },
      ])
      expect(await history(merged.id)).toEqual([
        { field: 'mergedIntoId', before: null, after: survivor.id },
        { field: 'mergedIntoId', before: survivor.id, after: null },
      ])
    })

    it('упавшее слияние не оставляет ни переноса, ни записи слияния, ни события', async () => {
      const { survivor, merged } = await pair()
      const note = await addNote(merged.id, 'Лишається')
      await sql`
        create function test_fail_merge() returns trigger language plpgsql as $$
        begin raise exception 'слияние сломано тестом'; end $$
      `.execute(h.owner)
      await sql`
        create trigger fail_merge before insert on merge_record
          for each row execute function test_fail_merge()
      `.execute(h.owner)
      try {
        expect((await merge(survivor.id, merged.id)).status).toBe(500)
      } finally {
        await sql`drop trigger fail_merge on merge_record`.execute(h.owner)
        await sql`drop function test_fail_merge()`.execute(h.owner)
      }
      expect(await rowsOf('note', merged.id)).toEqual([note.id])
      expect(
        await h.owner
          .selectFrom('deal')
          .select('merged_into_id')
          .where('id', '=', merged.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ merged_into_id: null })
      expect(await events('deal.merged', survivor.id)).toEqual([])
      expect(
        await h.owner
          .selectFrom('merge_record')
          .select('id')
          .where('survivor_id', '=', survivor.id)
          .execute(),
      ).toEqual([])
    })
  })

  // ---- Окончательное удаление --------------------------------------------------------------

  describe('корзина', () => {
    it('окончательное удаление оставшейся удаляет и слитые в неё сделки, их историю и записи слияний', async () => {
      const pipeline = await createPipeline()
      const [s, m, deeper] = await Promise.all(
        ['Корінь', 'Злита', 'Глибше'].map(async (name) =>
          createDeal({ pipelineId: pipeline.id, contactId: (await createContact(name)).id }),
        ),
      )
      if (!s || !m || !deeper) throw new Error('сделок нет')
      await json(await merge(m.id, deeper.id))
      await json(await merge(s.id, m.id))
      expect((await call(admin, 'DELETE', `/v1/deals/${s.id}`)).status).toBe(204)
      expect((await call(admin, 'DELETE', `/v1/deals/${s.id}/permanent`)).status).toBe(204)
      const ids = [s.id, m.id, deeper.id]
      expect(
        await h.owner.selectFrom('deal').select('id').where('id', 'in', ids).execute(),
      ).toEqual([])
      expect(
        await h.owner
          .selectFrom('merge_record')
          .select('id')
          .where('survivor_id', 'in', ids)
          .execute(),
      ).toEqual([])
      expect(
        await h.owner
          .selectFrom('change_log')
          .select('id')
          .where('entity_type', '=', 'deal')
          .where('entity_id', 'in', ids)
          .execute(),
      ).toEqual([])
    })

    it('скрытую сделку напрямую не стереть: API отвечает 404', async () => {
      const { survivor, merged } = await pair()
      await json(await merge(survivor.id, merged.id))
      expect((await call(admin, 'DELETE', `/v1/deals/${merged.id}/permanent`)).status).toBe(404)
      expect((await call(admin, 'DELETE', `/v1/deals/${merged.id}`)).status).toBe(404)
    })
  })

  // ---- Гонки транзакций (расширенная проверка PR #39) ----------------------------------------

  describe('гонки транзакций', () => {
    it('цепочка слияний: оставшаяся слита позже — откат первого слияния 409, время слияний по порядку записи', async () => {
      const pipeline = await createPipeline()
      const deals = await Promise.all(
        ['Гонка 1', 'Гонка 2', 'Гонка 3'].map(async (name) =>
          createDeal({ pipelineId: pipeline.id, contactId: (await createContact(name)).id }),
        ),
      )
      // T — с наименьшим id: слияние «S в T» блокирует T первым и ждёт его, уже начав транзакцию.
      const [t, s, m] = deals.map((d) => d.id).sort()
      if (!t || !s || !m) throw new Error('сделок нет')
      const held = await holdLock(sql`select id from deal where id = ${t} for update`)
      const later = merge(t, s)
      await waitForWaiters(1, 'слияние S в T ждёт T')
      // Первое слияние (M в S) начинается позже, но записывается раньше.
      const first = await json<DealMergeResult>(await merge(s, m))
      await held.release()
      const second = await json<DealMergeResult>(await later)

      const refused = await undo(first.merge.id)
      expect(refused.status).toBe(409)
      expect(await problemOf(refused)).toEqual({
        code: 'MERGE_UNDO_BLOCKED',
        details: { mergeId: second.merge.id },
      })
      expect(Date.parse(second.merge.mergedAt)).toBeGreaterThan(Date.parse(first.merge.mergedAt))
      // Сначала позднее, потом первое — проходит.
      await json(await undo(second.merge.id))
      await json(await undo(first.merge.id))
    })

    it('фоновая очистка корзины не стирает сделку, которую в тот же момент восстановили', async () => {
      // В проекте B: в корзине A лежат сделки других проверок.
      const deal = await createDeal(
        {
          pipelineId: (await createPipeline(projectB)).id,
          contactId: (await createContact('Відновлена', projectB)).id,
        },
        projectB,
      )
      const note = await json<{ id: string }>(
        await call(admin, 'POST', `/v1/deals/${deal.id}/notes`, { text: 'Має вціліти' }, projectB),
        201,
      )
      expect(
        (await call(admin, 'DELETE', `/v1/deals/${deal.id}`, undefined, projectB)).status,
      ).toBe(204)
      // Восстановление встаёт на запись истории (таблица заблокирована), уже держа строку сделки.
      const held = await holdLock(sql`lock table change_log in exclusive mode`)
      const restoring = call(admin, 'POST', `/v1/deals/${deal.id}/restore`, undefined, projectB)
      await waitForWaiters(1, 'восстановление ждёт историю')
      const purging = withProject(h.appDb, projectB, (trx) =>
        DEAL_PURGER.purgeExpired(trx, new Date(Date.now() + 86_400_000)),
      ).then(
        () => null,
        (error: unknown) => error,
      )
      await waitForWaiters(2, 'очистка ждёт строку сделки')
      await held.release()
      await json(await restoring)
      expect(await purging).toMatchObject({ code: 'CL001' })
      expect(await rowsOf('note', deal.id)).toEqual([note.id])
      expect(
        (
          await json<DealView>(
            await call(admin, 'GET', `/v1/deals/${deal.id}`, undefined, projectB),
          )
        ).id,
      ).toBe(deal.id)
    })

    it('заметка, файл, строка товара и участник, добавленные ко второй сделке во время слияния, не остаются у скрытой', async () => {
      const { survivor, merged } = await pair()
      const participant = await createContact('Під час злиття')
      // Слияние встаёт на запись события (таблица заблокирована), уже держа обе сделки.
      const held = await holdLock(sql`lock table webhook_event in exclusive mode`)
      const merging = merge(survivor.id, merged.id)
      await waitForWaiters(1, 'слияние ждёт запись события')
      const uploader: Target = {
        request: (input, init) => {
          const headers = new Headers(init.headers)
          headers.set('content-type', 'application/octet-stream')
          return app.request(input, { ...init, headers, body: new TextEncoder().encode('abc') })
        },
      }
      const during = [
        call(admin, 'POST', `/v1/deals/${merged.id}/notes`, { text: 'Під час' }),
        admin.call(uploader, 'POST', `/v1/deals/${merged.id}/files?name=pid-chas.txt`, {
          project: projectA,
        }),
        call(admin, 'POST', `/v1/deals/${merged.id}/products`, { productId: product, quantity: 1 }),
        call(admin, 'POST', `/v1/deals/${merged.id}/participants`, {
          contactId: participant.id,
        }),
      ]
      await waitForWaiters(5, 'добавления ждут сделку')
      await held.release()
      await json(await merging)
      for (const res of await Promise.all(during)) {
        expect(res.status).toBe(404)
        expect(await problemOf(res)).toEqual({ code: 'DEAL_NOT_FOUND' })
      }
      for (const table of ['note', 'file', 'deal_product', 'deal_participant'] as const) {
        expect(await rowsOf(table, merged.id)).toEqual([])
      }
    })
  })
})
