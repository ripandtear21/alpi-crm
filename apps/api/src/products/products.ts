import type { Database } from '@alpi/db'
import {
  MAX_PRODUCT_NAME_LENGTH,
  PRODUCT_CURRENCIES,
  type ProductCurrency,
  type ProductPrices,
  type ProductSummary,
  type ProductsErrorCode,
} from '@alpi/shared'
import { Hono } from 'hono'
import { type Kysely, sql, type UpdateObject } from 'kysely'
import {
  type Ctx,
  fail,
  type Outcome,
  ok,
  readBody,
  refuse,
  requiredText,
  UUID,
} from '../contacts/http.ts'
import { type PermissionsEnv, requirePermission } from '../middleware/permissions.ts'

// Каталог товаров проекта (тикет crm-deals/06; spec.md MVP, раздел 3.2 — `product`):
// `/v1/products` (снаружи — /api/v1/products).
//
// - Права — часть системы `products`: смотреть каталог — `view` (у менеджеров по шаблону есть),
//   создать — `create`, изменить название, цены и архив — `edit`.
// - Цены в EUR, UAH и USD, любая может быть пустой. Без вариаций и скидок.
// - Товар не удаляется, а уходит в архив: архивный не ставится в новую строку сделки
//   (deals/lines.ts), старые строки с ним остаются. Список отдаёт и архивные — с отметкой.

/** numeric(14, 2): до триллиона без копейки. */
const MAX_PRICE = 999_999_999_999.99

/** Столбец цены товара для валюты. */
export const PRICE_COLUMN = {
  EUR: 'price_eur',
  UAH: 'price_uah',
  USD: 'price_usd',
} as const satisfies Record<ProductCurrency, keyof Database['product']>

type Result<T> = Outcome<T, ProductsErrorCode>

const invalid = (path: string) => refuse(400, 'INVALID_PRODUCT', { path })

/** Цена с копейками, не меньше нуля; иначе undefined. */
export function readPrice(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (value < 0 || value > MAX_PRICE) return undefined
  // Не больше двух знаков после запятой.
  return Math.abs(Math.round(value * 100) - value * 100) < 1e-6 ? value : undefined
}

function selectProducts(db: Kysely<Database>) {
  return db
    .selectFrom('product')
    .select(['id', 'name', 'price_eur', 'price_uah', 'price_usd', 'archived_at', 'created_at'])
}

type ProductRow = Awaited<ReturnType<ReturnType<typeof selectProducts>['executeTakeFirstOrThrow']>>

const priceOrNull = (value: string | null) => (value === null ? null : Number(value))

function productSummary(row: ProductRow): ProductSummary {
  return {
    id: row.id,
    name: row.name,
    prices: {
      EUR: priceOrNull(row.price_eur),
      UAH: priceOrNull(row.price_uah),
      USD: priceOrNull(row.price_usd),
    },
    archivedAt: row.archived_at === null ? null : new Date(row.archived_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
  }
}

/** Цены из тела: только названные валюты; null — убрать цену. */
function readPrices(value: unknown): Result<Partial<ProductPrices>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid('prices')
  const prices: Partial<ProductPrices> = {}
  for (const [key, raw] of Object.entries(value)) {
    const currency = PRODUCT_CURRENCIES.find((c) => c === key)
    if (currency === undefined) return invalid(`prices.${key}`)
    const price = raw === null ? null : readPrice(raw)
    if (price === undefined) return invalid(`prices.${key}`)
    prices[currency] = price
  }
  return ok(prices)
}

/** Что меняет запрос: столбцы товара. `create` — название обязательно, архива нет. */
function readProduct(
  body: Record<string, unknown> | null,
  create: boolean,
): Result<UpdateObject<Database, 'product'>> {
  if (!body) return invalid('')
  const allowed = create ? ['name', 'prices'] : ['name', 'prices', 'archived']
  const extra = Object.keys(body).find((key) => !allowed.includes(key))
  if (extra !== undefined) return invalid(extra)
  const set: UpdateObject<Database, 'product'> = {}
  if (create || body.name !== undefined) {
    const name = requiredText(body.name, MAX_PRODUCT_NAME_LENGTH)
    if (name === undefined) return invalid('name')
    set.name = name
  }
  if (body.prices !== undefined) {
    const prices = readPrices(body.prices)
    if (!prices.ok) return prices
    for (const currency of PRODUCT_CURRENCIES) {
      const price = prices.value[currency]
      if (price !== undefined) set[PRICE_COLUMN[currency]] = price
    }
  }
  if (body.archived !== undefined) {
    if (typeof body.archived !== 'boolean') return invalid('archived')
    // Повторная архивация не сдвигает отметку.
    set.archived_at = body.archived ? sql`coalesce(archived_at, now())` : null
  }
  if (Object.keys(set).length === 0) return invalid('')
  return ok(set)
}

async function createProduct(c: Ctx): Promise<Result<ProductSummary>> {
  const set = readProduct(await readBody(c), true)
  if (!set.ok) return set
  const db = c.get('db')
  const { id } = await db
    .insertInto('product')
    .values({
      ...(set.value as { name: string }),
      project_id: c.get('projectId'),
      created_by: c.get('session').user.id,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return ok(productSummary(await selectProducts(db).where('id', '=', id).executeTakeFirstOrThrow()))
}

async function updateProduct(c: Ctx, id: string): Promise<Result<ProductSummary>> {
  const set = readProduct(await readBody(c), false)
  if (!set.ok) return set
  if (!UUID.test(id)) return refuse(404, 'PRODUCT_NOT_FOUND')
  const db = c.get('db')
  const updated = await db
    .updateTable('product')
    .set({ ...set.value, updated_at: sql`now()` })
    .where('id', '=', id)
    .executeTakeFirst()
  if (updated.numUpdatedRows === 0n) return refuse(404, 'PRODUCT_NOT_FOUND')
  return ok(productSummary(await selectProducts(db).where('id', '=', id).executeTakeFirstOrThrow()))
}

/** Маршруты каталога товаров: `/v1/products`. */
export function productsRoutes() {
  const respond = <T>(c: Ctx, outcome: Result<T>, status: 200 | 201 = 200) =>
    outcome.ok ? c.json(outcome.value as object, status) : fail(c, outcome)
  return new Hono<PermissionsEnv>()
    .get('/', requirePermission('products', 'view'), async (c) => {
      const rows = await selectProducts(c.get('db')).orderBy('name').orderBy('id').execute()
      return c.json<ProductSummary[]>(rows.map(productSummary))
    })
    .post('/', requirePermission('products', 'create'), async (c) =>
      respond(c, await createProduct(c), 201),
    )
    .put('/:id', requirePermission('products', 'edit'), async (c) =>
      respond(c, await updateProduct(c, c.req.param('id'))),
    )
}
