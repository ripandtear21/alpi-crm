import type { ProductSummary } from '@alpi/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type ApiHarness,
  type Method,
  type SignedInUser,
  startApiHarness,
} from '../testing/api-harness.ts'

// Каталог товаров (тикет crm-deals/06): изоляция проектов, права (`products`), три цены,
// архив — на настоящем PostgreSQL, API ходит ролью приложения.

describe('каталог товаров', () => {
  let h: ApiHarness
  let admin: SignedInUser
  let manager: SignedInUser
  let noRights: SignedInUser
  let projectA: string
  let projectB: string

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_products')
    admin = await h.signIn('owner')
    projectA = (await h.createProject(admin, 'Товари А')).id
    projectB = (await h.createProject(admin, 'Товари Б')).id
    manager = await h.signIn()
    noRights = await h.signIn()
    await h.addMember(projectA, manager.id, 'manager')
    const { id: roleId } = await h.owner
      .insertInto('role')
      .values({ project_id: projectA, name: 'Без прав', permissions: JSON.stringify({}) })
      .returning('id')
      .executeTakeFirstOrThrow()
    await h.owner
      .insertInto('project_member')
      .values({ project_id: projectA, user_id: noRights.id, role_id: roleId })
      .execute()
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
    return (await res.json()) as ProductSummary
  }

  async function list(user: SignedInUser, project = projectA) {
    const res = await call(user, 'GET', '/v1/products', undefined, project)
    await expectStatus(res, 200)
    return (await res.json()) as ProductSummary[]
  }

  it('создаёт товар с тремя ценами, любая может быть пустой', async () => {
    const product = await createProduct({
      name: '  Курс «Старт»  ',
      prices: { EUR: 100, UAH: 4200.5, USD: null },
    })
    expect(product).toMatchObject({
      name: 'Курс «Старт»',
      prices: { EUR: 100, UAH: 4200.5, USD: null },
      archivedAt: null,
    })
    const empty = await createProduct({ name: 'Без цін' })
    expect(empty.prices).toEqual({ EUR: null, UAH: null, USD: null })
    expect((await list(admin)).map((p) => p.id)).toEqual(
      expect.arrayContaining([product.id, empty.id]),
    )
  })

  it('отклоняет неверное тело: пустое название, отрицательная цена, лишние поля и валюты', async () => {
    const bad = async (body: unknown, path: string) => {
      const res = await call(admin, 'POST', '/v1/products', body)
      await expectStatus(res, 400)
      expect(await res.json()).toEqual({ code: 'INVALID_PRODUCT', details: { path } })
    }
    await bad({ name: '   ' }, 'name')
    await bad({ name: 'x'.repeat(201) }, 'name')
    await bad({ name: 'Товар', prices: { EUR: -1 } }, 'prices.EUR')
    await bad({ name: 'Товар', prices: { EUR: 1.005 } }, 'prices.EUR')
    await bad({ name: 'Товар', prices: { PLN: 1 } }, 'prices.PLN')
    await bad({ name: 'Товар', prices: [] }, 'prices')
    await bad({ name: 'Товар', color: 'red' }, 'color')
  })

  it('изменяет название и цены; цены, которых нет в запросе, не меняются', async () => {
    const product = await createProduct({ name: 'Вебінар', prices: { EUR: 10, UAH: 400 } })
    const res = await call(admin, 'PUT', `/v1/products/${product.id}`, {
      name: 'Вебінар 2.0',
      prices: { EUR: null, USD: 12.3 },
    })
    await expectStatus(res, 200)
    expect(await res.json()).toMatchObject({
      id: product.id,
      name: 'Вебінар 2.0',
      prices: { EUR: null, UAH: 400, USD: 12.3 },
    })
    await expectStatus(await call(admin, 'PUT', `/v1/products/${product.id}`, {}), 400)
  })

  it('архивирует и возвращает из архива; архивный остаётся в списке с отметкой', async () => {
    const product = await createProduct({ name: 'Старий курс', prices: { EUR: 1 } })
    const archived = await call(admin, 'PUT', `/v1/products/${product.id}`, { archived: true })
    await expectStatus(archived, 200)
    const archivedAt = ((await archived.json()) as ProductSummary).archivedAt
    expect(archivedAt).not.toBeNull()
    expect((await list(admin)).find((p) => p.id === product.id)?.archivedAt).toBe(archivedAt)

    const back = await call(admin, 'PUT', `/v1/products/${product.id}`, { archived: false })
    await expectStatus(back, 200)
    expect(((await back.json()) as ProductSummary).archivedAt).toBeNull()
  })

  it('несуществующий или не-uuid товар — 404', async () => {
    const missing = '00000000-0000-4000-8000-000000000000'
    const res = await call(admin, 'PUT', `/v1/products/${missing}`, { name: 'Х' })
    await expectStatus(res, 404)
    expect(await res.json()).toEqual({ code: 'PRODUCT_NOT_FOUND' })
    await expectStatus(await call(admin, 'PUT', '/v1/products/abc', { name: 'Х' }), 404)
  })

  describe('изоляция проектов', () => {
    it('товары проекта A не видны и не меняются из проекта B', async () => {
      const inA = await createProduct({ name: 'Тільки в А' })
      const inB = await createProduct({ name: 'Тільки в Б' }, projectB)
      const listB = await list(admin, projectB)
      expect(listB.map((p) => p.id)).toContain(inB.id)
      expect(listB.map((p) => p.id)).not.toContain(inA.id)
      expect((await list(admin)).map((p) => p.id)).not.toContain(inB.id)

      const res = await call(admin, 'PUT', `/v1/products/${inA.id}`, { name: 'Злам' }, projectB)
      await expectStatus(res, 404)
      const row = await h.owner
        .selectFrom('product')
        .select('name')
        .where('id', '=', inA.id)
        .executeTakeFirstOrThrow()
      expect(row.name).toBe('Тільки в А')
    })
  })

  describe('права', () => {
    it('менеджер по шаблону видит каталог, но не меняет его (403)', async () => {
      const product = await createProduct({ name: 'Для менеджера', prices: { EUR: 5 } })
      expect((await list(manager)).map((p) => p.id)).toContain(product.id)

      const denied = async (res: Response) => {
        await expectStatus(res, 403)
        expect(await res.json()).toEqual({ code: 'PERMISSION_DENIED' })
      }
      await denied(await call(manager, 'POST', '/v1/products', { name: 'Мій товар' }))
      await denied(await call(manager, 'PUT', `/v1/products/${product.id}`, { name: 'Інша назва' }))
      await denied(await call(manager, 'PUT', `/v1/products/${product.id}`, { archived: true }))
    })

    it('без права products каталог не виден', async () => {
      await expectStatus(await call(noRights, 'GET', '/v1/products'), 403)
    })
  })
})
