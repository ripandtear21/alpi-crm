import type { Database } from '@alpi/db'
import type { UpdateObject } from 'kysely'
import { sql } from 'kysely'
import { diffFields, recordChanges } from '../change-log/record.ts'
import { type Ctx, ok, readBody, refuse, UUID } from '../contacts/http.ts'
import { PRICE_COLUMN, readPrice } from '../products/products.ts'
import {
  type DealContext,
  type DealCurrency,
  type DealRow,
  type DealView,
  dealView,
  type Result,
  writableDeal,
} from './store.ts'

// Строки товаров в сделке (тикет crm-deals/06; spec.md MVP, раздел 3.2 — `deal_product`; ответ
// владельца 13.0.4): `/v1/deals/:id/products` и «підставити» — `/v1/deals/:id/apply-products-total`.
//
// - Права — «сделки: изменять» и сделка в охвате изменения (как участники, writableDeal).
// - Строки сумму сделки не меняют. Ответ сделки несёт «сума по товарах» (store.ts, dealViews);
//   «підставити» — отдельное действие, оно записывает эту сумму в сумму сделки и в историю
//   (deals.ts, changeDeal). Ничего не пересчитывается само (ADR 0003): смена валюты сделки цены
//   строк не пересчитывает (решено без владельца — подтвердить).
// - Цена новой строки — введённая, иначе из каталога в валюте сделки; нет и её — 422.
// - Архивный товар в новую строку — 422; старые строки с ним остаются и меняются.
// - Каждое изменение строк пишется в историю сделки полем products: «было → стало» всем списком.

/** Наибольшее количество в строке. */
const MAX_QUANTITY = 1_000_000
/** numeric(14, 2) суммы сделки: до триллиона без копейки. */
const MAX_AMOUNT = 999_999_999_999.99

const invalid = (path: string) => refuse(400, 'INVALID_DEAL', { path })

function readQuantity(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_QUANTITY
    ? (value as number)
    : undefined
}

/** Тело строки: только `allowed` ключи; строка — какое поле неверно. */
async function readLine(
  c: Ctx,
  allowed: readonly string[],
): Promise<Result<{ productId?: string; quantity?: number; unitPrice?: number }>> {
  const body = await readBody(c)
  if (!body) return invalid('')
  const extra = Object.keys(body).find((key) => !allowed.includes(key))
  if (extra !== undefined) return invalid(extra)
  const line: { productId?: string; quantity?: number; unitPrice?: number } = {}
  if (body.productId !== undefined) {
    if (typeof body.productId !== 'string' || !UUID.test(body.productId)) {
      return invalid('productId')
    }
    line.productId = body.productId.toLowerCase()
  }
  if (body.quantity !== undefined) {
    const quantity = readQuantity(body.quantity)
    if (quantity === undefined) return invalid('quantity')
    line.quantity = quantity
  }
  if (body.unitPrice !== undefined) {
    const unitPrice = readPrice(body.unitPrice)
    if (unitPrice === undefined) return invalid('unitPrice')
    line.unitPrice = unitPrice
  }
  return ok(line)
}

/** Изменение строк сделки: «было → стало» всем списком (поле products). */
async function changeLines(
  ctx: DealContext,
  id: string,
  change: (row: DealRow) => Promise<Result<unknown>>,
): Promise<Result<DealView>> {
  const found = await writableDeal(ctx, id)
  if (!found.ok) return found
  const before = await dealView(ctx.db, found.value)
  const changed = await change(found.value)
  if (!changed.ok) return changed
  const after = await dealView(ctx.db, found.value)
  await recordChanges(ctx, { type: 'deal', id }, diffFields(before, after, ['products']))
  return ok(after)
}

export async function addLine(c: Ctx, ctx: DealContext, id: string): Promise<Result<DealView>> {
  const line = await readLine(c, ['productId', 'quantity', 'unitPrice'])
  if (!line.ok) return line
  const { productId, quantity, unitPrice } = line.value
  if (productId === undefined) return invalid('productId')
  if (quantity === undefined) return invalid('quantity')
  return changeLines(ctx, id, async (row) => {
    // FOR SHARE: товар не уйдёт в архив, пока строка не записана (тот же замок берёт триггер
    // deal_product_active в migrations/0011_products.ts).
    const product = await ctx.db
      .selectFrom('product')
      .select(['archived_at', 'price_eur', 'price_uah', 'price_usd'])
      .where('id', '=', productId)
      .forShare()
      .executeTakeFirst()
    if (!product) return refuse(404, 'PRODUCT_NOT_FOUND')
    if (product.archived_at !== null) return refuse(422, 'PRODUCT_ARCHIVED')
    const price = unitPrice ?? product[PRICE_COLUMN[row.currency as DealCurrency]]
    if (price === null) return refuse(422, 'PRICE_REQUIRED')
    await ctx.db
      .insertInto('deal_product')
      .values({
        project_id: ctx.projectId,
        deal_id: row.id,
        product_id: productId,
        quantity,
        unit_price: price,
        created_by: ctx.actorId,
      })
      .execute()
    return ok(null)
  })
}

export async function updateLine(
  c: Ctx,
  ctx: DealContext,
  id: string,
  lineId: string,
): Promise<Result<DealView>> {
  const line = await readLine(c, ['quantity', 'unitPrice'])
  if (!line.ok) return line
  const { quantity, unitPrice } = line.value
  if (quantity === undefined && unitPrice === undefined) return invalid('')
  return changeLines(ctx, id, async (row) => {
    const updated = UUID.test(lineId)
      ? await ctx.db
          .updateTable('deal_product')
          .set({
            ...(quantity === undefined ? {} : { quantity }),
            ...(unitPrice === undefined ? {} : { unit_price: unitPrice }),
            updated_at: sql`now()`,
          })
          .where('id', '=', lineId)
          .where('deal_id', '=', row.id)
          .executeTakeFirst()
      : undefined
    return updated && updated.numUpdatedRows > 0n ? ok(null) : refuse(404, 'LINE_NOT_FOUND')
  })
}

export async function removeLine(
  ctx: DealContext,
  id: string,
  lineId: string,
): Promise<Result<DealView>> {
  return changeLines(ctx, id, async (row) => {
    const removed = UUID.test(lineId)
      ? await ctx.db
          .deleteFrom('deal_product')
          .where('id', '=', lineId)
          .where('deal_id', '=', row.id)
          .executeTakeFirst()
      : undefined
    return removed && removed.numDeletedRows > 0n ? ok(null) : refuse(404, 'LINE_NOT_FOUND')
  })
}

/**
 * «Підставити»: сумма строк сделки `row` (уже заблокированной) как новая сумма сделки; null —
 * она уже такая. Строк нет — 422: нажатие не должно обнулить сумму.
 */
export async function productsTotalChange(
  ctx: DealContext,
  row: DealRow,
): Promise<Result<UpdateObject<Database, 'deal'> | null>> {
  const { total } = await ctx.db
    .selectFrom('deal_product')
    .select(sql<string | null>`sum(quantity * unit_price)`.as('total'))
    .where('deal_id', '=', row.id)
    .executeTakeFirstOrThrow()
  if (total === null) return refuse(422, 'DEAL_HAS_NO_PRODUCTS')
  if (Number(total) > MAX_AMOUNT) return refuse(422, 'PRODUCTS_TOTAL_TOO_LARGE')
  return Number(total) === Number(row.amount) ? ok(null) : ok({ amount: total })
}
