import { randomInt } from 'node:crypto'
import { withProject } from '@alpi/db'
import type { ProductSummary } from '@alpi/shared'
import { type Kysely, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ContactView } from '../contacts/contacts.ts'
import {
  type ApiHarness,
  type Method,
  type SignedInUser,
  startApiHarness,
} from '../testing/api-harness.ts'
import type { DealView } from './store.ts'

// Строки товаров в сделке и «підставити» (тикет crm-deals/06): строки сумму сделки не меняют
// (ответ владельца 13.0.4), «сума по товарах» в ответе сделки, цена из каталога в валюте сделки,
// архивный товар, изоляция проектов, права и охват, история — на настоящем PostgreSQL.
// Имена и телефоны — вымышленные.

const fakePhone = () => `+38067${randomInt(1_000_000, 9_999_999)}`

describe('строки товаров в сделке', () => {
  let h: ApiHarness
  let admin: SignedInUser
  let manager: SignedInUser
  let otherManager: SignedInUser
  /** Сделки видит все, меняет только свои. */
  let readAll: SignedInUser
  let noRights: SignedInUser
  let projectA: string
  let projectB: string
  let pipelineA: string
  let pipelineB: string
  let course: ProductSummary
  let webinar: ProductSummary
  let euroOnly: ProductSummary
  let productB: ProductSummary

  async function createPipeline(projectId: string): Promise<string> {
    const { id } = await h.owner
      .insertInto('pipeline')
      .values({ project_id: projectId, code: `p${randomInt(1e9)}`, name: 'Воронка', position: 1 })
      .returning('id')
      .executeTakeFirstOrThrow()
    await h.owner
      .insertInto('stage')
      .values({ project_id: projectId, pipeline_id: id, name: 'Новий', position: 1 })
      .execute()
    return id
  }

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_deal_lines')
    admin = await h.signIn('owner')
    projectA = (await h.createProject(admin, 'Рядки А')).id
    projectB = (await h.createProject(admin, 'Рядки Б')).id
    pipelineA = await createPipeline(projectA)
    pipelineB = await createPipeline(projectB)
    manager = await h.signIn()
    otherManager = await h.signIn()
    readAll = await h.signIn()
    noRights = await h.signIn()
    await h.addMember(projectA, manager.id, 'manager')
    await h.addMember(projectA, otherManager.id, 'manager')
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
            actions: { deals: ['view', 'create', 'edit'], contacts: ['view'], products: ['view'] },
            scopes: { deals: { read: 'all', write: 'own' } },
          }),
        },
      ])
      .execute()
    course = await createProduct({ name: 'Курс', prices: { EUR: 100, UAH: 4000 } })
    webinar = await createProduct({ name: 'Вебінар', prices: { EUR: 50.5 } })
    euroOnly = await createProduct({ name: 'Тільки EUR', prices: { EUR: 7 } })
    productB = await createProduct({ name: 'Товар Б', prices: { EUR: 1 } }, projectB)
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

  async function createProduct(body: Record<string, unknown>, project = projectA) {
    const res = await call(admin, 'POST', '/v1/products', body, project)
    await expectStatus(res, 201)
    return json<ProductSummary>(res)
  }

  async function createDeal(
    user: SignedInUser,
    body: Record<string, unknown> = {},
    project = projectA,
  ): Promise<DealView> {
    const contactRes = await call(
      user,
      'POST',
      '/v1/contacts',
      { firstName: 'Ірина', lastName: 'Вигадана', phones: [fakePhone()] },
      project,
    )
    await expectStatus(contactRes, 201)
    const contact = await json<ContactView>(contactRes)
    const res = await call(
      user,
      'POST',
      '/v1/deals',
      {
        title: 'Угода',
        pipelineId: project === projectA ? pipelineA : pipelineB,
        contactId: contact.id,
        ...body,
      },
      project,
    )
    await expectStatus(res, 201)
    return json<DealView>(res)
  }

  async function addLine(
    user: SignedInUser,
    dealId: string,
    body: Record<string, unknown>,
    status = 201,
  ) {
    const res = await call(user, 'POST', `/v1/deals/${dealId}/products`, body)
    await expectStatus(res, status)
    return res
  }

  async function history(dealId: string) {
    return h.owner
      .selectFrom('change_log')
      .select(['field', 'before', 'after'])
      .where('entity_type', '=', 'deal')
      .where('entity_id', '=', dealId)
      .orderBy('occurred_at')
      .orderBy('id')
      .execute()
  }

  /** Запрос ролью приложения в контексте проекта, как его делает API. */
  const inProject = <T>(projectId: string, fn: (trx: Kysely<never>) => Promise<T>) =>
    withProject(h.appDb, projectId, (trx) => fn(trx as unknown as Kysely<never>))

  describe('сумма сделки и «сума по товарах»', () => {
    it('строки не меняют сумму; «сума по товарах» = 2 × 100 + 1 × 50,50 = 250,50', async () => {
      const deal = await createDeal(manager, { amount: 777 })
      expect(deal).toMatchObject({ amount: 777, products: [], productsTotal: 0 })

      const first = await json<DealView>(
        await addLine(manager, deal.id, { productId: course.id, quantity: 2 }),
      )
      const second = await json<DealView>(
        await addLine(manager, deal.id, { productId: webinar.id, quantity: 1 }),
      )
      expect(first.products).toEqual([
        {
          id: expect.any(String),
          productId: course.id,
          name: 'Курс',
          quantity: 2,
          unitPrice: 100,
          total: 200,
        },
      ])
      expect(second).toMatchObject({ amount: 777, productsTotal: 250.5 })
      expect(second.products.map((line) => [line.productId, line.total])).toEqual([
        [course.id, 200],
        [webinar.id, 50.5],
      ])

      const read = await json<DealView>(await call(manager, 'GET', `/v1/deals/${deal.id}`))
      expect(read).toMatchObject({ amount: 777, productsTotal: 250.5 })

      const lineId = second.products[1]?.id
      const changed = await call(manager, 'PUT', `/v1/deals/${deal.id}/products/${lineId}`, {
        quantity: 3,
        unitPrice: 40,
      })
      await expectStatus(changed, 200)
      expect(await changed.json()).toMatchObject({ amount: 777, productsTotal: 320 })

      const removed = await call(manager, 'DELETE', `/v1/deals/${deal.id}/products/${lineId}`)
      await expectStatus(removed, 204)
      const after = await json<DealView>(await call(manager, 'GET', `/v1/deals/${deal.id}`))
      expect(after).toMatchObject({ amount: 777, productsTotal: 200 })
      expect(after.products).toHaveLength(1)

      // Каждое изменение строк — запись истории products «было → стало», суммы — ни одной.
      const log = await history(deal.id)
      expect(log.filter((e) => e.field === 'amount')).toEqual([])
      const lines = log.filter((e) => e.field === 'products')
      expect(lines).toHaveLength(4)
      expect(lines[0]).toMatchObject({ before: [], after: [{ productId: course.id, quantity: 2 }] })
      expect(lines[2]?.after).toEqual(
        expect.arrayContaining([expect.objectContaining({ quantity: 3, unitPrice: 40 })]),
      )
      expect(lines[3]?.after).toEqual([expect.objectContaining({ productId: course.id })])
    })

    it('«підставити» записывает сумму строк в сумму сделки и в историю «было → стало»', async () => {
      const deal = await createDeal(manager, { amount: 10 })
      await addLine(manager, deal.id, { productId: course.id, quantity: 2 })
      await addLine(manager, deal.id, { productId: webinar.id, quantity: 1 })

      const res = await call(manager, 'POST', `/v1/deals/${deal.id}/apply-products-total`, {})
      await expectStatus(res, 200)
      expect(await res.json()).toMatchObject({ amount: 250.5, productsTotal: 250.5 })
      const amount = (await history(deal.id)).filter((e) => e.field === 'amount')
      expect(amount).toEqual([{ field: 'amount', before: 10, after: 250.5 }])

      // Повторно — сумма уже равна: ничего не меняется, новой записи нет.
      await expectStatus(
        await call(manager, 'POST', `/v1/deals/${deal.id}/apply-products-total`, {}),
        200,
      )
      expect((await history(deal.id)).filter((e) => e.field === 'amount')).toHaveLength(1)
    })

    it('«підставити» без строк — 422, сумма не обнуляется', async () => {
      const deal = await createDeal(manager, { amount: 99 })
      const res = await call(manager, 'POST', `/v1/deals/${deal.id}/apply-products-total`, {})
      await expectStatus(res, 422)
      expect(await res.json()).toEqual({ code: 'DEAL_HAS_NO_PRODUCTS' })
      const read = await json<DealView>(await call(manager, 'GET', `/v1/deals/${deal.id}`))
      expect(read.amount).toBe(99)
    })
  })

  describe('цена строки', () => {
    it('берётся из каталога в валюте сделки', async () => {
      const deal = await createDeal(manager, { currency: 'UAH' })
      const view = await json<DealView>(
        await addLine(manager, deal.id, { productId: course.id, quantity: 1 }),
      )
      expect(view.products[0]).toMatchObject({ unitPrice: 4000, total: 4000 })
      expect(view.productsTotal).toBe(4000)
    })

    it('нет цены в валюте сделки и цена не введена — 422; введённая цена принимается', async () => {
      const deal = await createDeal(manager, { currency: 'USD' })
      const refused = await addLine(manager, deal.id, { productId: euroOnly.id, quantity: 1 }, 422)
      expect(await refused.json()).toEqual({ code: 'PRICE_REQUIRED' })

      const view = await json<DealView>(
        await addLine(manager, deal.id, { productId: euroOnly.id, quantity: 2, unitPrice: 8.25 }),
      )
      expect(view.products[0]).toMatchObject({ unitPrice: 8.25, total: 16.5 })
    })

    it('введённая цена важнее каталожной', async () => {
      const deal = await createDeal(manager)
      const view = await json<DealView>(
        await addLine(manager, deal.id, { productId: course.id, quantity: 1, unitPrice: 90 }),
      )
      expect(view.products[0]?.unitPrice).toBe(90)
    })

    it('смена валюты сделки цены строк не пересчитывает', async () => {
      const deal = await createDeal(manager)
      await addLine(manager, deal.id, { productId: course.id, quantity: 1 })
      const res = await call(manager, 'PUT', `/v1/deals/${deal.id}`, { currency: 'UAH' })
      await expectStatus(res, 200)
      expect(await res.json()).toMatchObject({
        currency: 'UAH',
        productsTotal: 100,
        products: [expect.objectContaining({ unitPrice: 100 })],
      })
    })

    it('архивный товар в новую строку — 422; старая строка с ним остаётся и меняется', async () => {
      const product = await createProduct({ name: 'Скоро в архів', prices: { EUR: 20 } })
      const deal = await createDeal(manager)
      const before = await json<DealView>(
        await addLine(manager, deal.id, { productId: product.id, quantity: 1 }),
      )
      await expectStatus(
        await call(admin, 'PUT', `/v1/products/${product.id}`, { archived: true }),
        200,
      )
      const refused = await addLine(manager, deal.id, { productId: product.id, quantity: 1 }, 422)
      expect(await refused.json()).toEqual({ code: 'PRODUCT_ARCHIVED' })

      const lineId = before.products[0]?.id
      const changed = await call(manager, 'PUT', `/v1/deals/${deal.id}/products/${lineId}`, {
        quantity: 5,
      })
      await expectStatus(changed, 200)
      expect(await changed.json()).toMatchObject({
        products: [expect.objectContaining({ productId: product.id, quantity: 5, total: 100 })],
      })
    })

    it('архивный товар не встаёт в строку и в обход API (триггер базы)', async () => {
      const product = await createProduct({ name: 'Архівний', prices: { EUR: 1 } })
      await expectStatus(
        await call(admin, 'PUT', `/v1/products/${product.id}`, { archived: true }),
        200,
      )
      const deal = await createDeal(manager)
      await expect(
        inProject(projectA, (trx) =>
          sql`insert into deal_product (project_id, deal_id, product_id, quantity, unit_price)
            values (${projectA}, ${deal.id}, ${product.id}, 1, 1)`.execute(trx),
        ),
      ).rejects.toThrow(/товар в архиве/)
    })

    it('неверное тело и неизвестная строка', async () => {
      const deal = await createDeal(manager)
      const bad = async (body: Record<string, unknown>, path: string) => {
        const res = await addLine(manager, deal.id, body, 400)
        expect(await res.json()).toEqual({ code: 'INVALID_DEAL', details: { path } })
      }
      await bad({ productId: course.id, quantity: 0 }, 'quantity')
      await bad({ productId: course.id, quantity: 1.5 }, 'quantity')
      await bad({ productId: course.id }, 'quantity')
      await bad({ productId: 'abc', quantity: 1 }, 'productId')
      await bad({ productId: course.id, quantity: 1, unitPrice: -1 }, 'unitPrice')
      await bad({ productId: course.id, quantity: 1, discount: 5 }, 'discount')

      const missing = '00000000-0000-4000-8000-000000000000'
      const noProduct = await addLine(manager, deal.id, { productId: missing, quantity: 1 }, 404)
      expect(await noProduct.json()).toEqual({ code: 'PRODUCT_NOT_FOUND' })
      const noLine = await call(manager, 'PUT', `/v1/deals/${deal.id}/products/${missing}`, {
        quantity: 2,
      })
      await expectStatus(noLine, 404)
      expect(await noLine.json()).toEqual({ code: 'LINE_NOT_FOUND' })
      await expectStatus(await call(manager, 'DELETE', `/v1/deals/${deal.id}/products/abc`), 404)
    })
  })

  describe('корзина', () => {
    it('окончательное удаление сделки уносит её строки; товар остаётся', async () => {
      const deal = await createDeal(admin)
      await addLine(admin, deal.id, { productId: course.id, quantity: 1 })
      await expectStatus(
        await call(admin, 'DELETE', `/v1/contacts/${deal.primaryContactId}?confirm=${deal.id}`),
        204,
      )
      await expectStatus(
        await call(admin, 'DELETE', `/v1/contacts/${deal.primaryContactId}/permanent`),
        204,
      )
      const left = await h.owner
        .selectFrom('deal_product')
        .select('id')
        .where('deal_id', '=', deal.id)
        .execute()
      expect(left).toEqual([])
      const product = await h.owner
        .selectFrom('product')
        .select('id')
        .where('id', '=', course.id)
        .execute()
      expect(product).toHaveLength(1)
    })
  })

  describe('изоляция проектов', () => {
    it('товар проекта B нельзя добавить в сделку проекта A', async () => {
      const deal = await createDeal(manager)
      const res = await addLine(manager, deal.id, { productId: productB.id, quantity: 1 }, 404)
      expect(await res.json()).toEqual({ code: 'PRODUCT_NOT_FOUND' })
    })

    it('строки проекта A не видны в B', async () => {
      const deal = await createDeal(manager)
      await addLine(manager, deal.id, { productId: course.id, quantity: 1 })
      const inB = await createDeal(admin, {}, projectB)
      await call(
        admin,
        'POST',
        `/v1/deals/${inB.id}/products`,
        { productId: productB.id, quantity: 1 },
        projectB,
      )

      const linesInB = await inProject(projectB, (trx) =>
        sql<{ deal_id: string }>`select deal_id from deal_product`.execute(trx),
      )
      expect(linesInB.rows.map((r) => r.deal_id)).toEqual([inB.id])
      await expectStatus(await call(admin, 'GET', `/v1/deals/${deal.id}`, undefined, projectB), 404)
      await expectStatus(
        await call(
          admin,
          'POST',
          `/v1/deals/${deal.id}/products`,
          { productId: productB.id, quantity: 1 },
          projectB,
        ),
        404,
      )
    })
  })

  describe('права и охват', () => {
    it('строку в сделке вне охвата на изменение добавить нельзя', async () => {
      const deal = await createDeal(otherManager)
      // Вне охвата чтения — как несуществующая.
      await addLine(manager, deal.id, { productId: course.id, quantity: 1 }, 404)
      // Видит, но менять не может.
      const denied = await addLine(readAll, deal.id, { productId: course.id, quantity: 1 }, 403)
      expect(await denied.json()).toEqual({ code: 'PERMISSION_DENIED' })
      await expectStatus(
        await call(readAll, 'POST', `/v1/deals/${deal.id}/apply-products-total`, {}),
        403,
      )
      await addLine(noRights, deal.id, { productId: course.id, quantity: 1 }, 403)

      const own = await json<DealView>(
        await addLine(otherManager, deal.id, { productId: course.id, quantity: 1 }),
      )
      const lineId = own.products[0]?.id
      await expectStatus(
        await call(readAll, 'PUT', `/v1/deals/${deal.id}/products/${lineId}`, { quantity: 2 }),
        403,
      )
      await expectStatus(
        await call(readAll, 'DELETE', `/v1/deals/${deal.id}/products/${lineId}`),
        403,
      )
      const read = await json<DealView>(await call(readAll, 'GET', `/v1/deals/${deal.id}`))
      expect(read.products).toEqual([expect.objectContaining({ quantity: 1 })])
    })
  })
})
