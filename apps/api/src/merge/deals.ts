import { can } from '@alpi/shared'
import { Hono } from 'hono'
import { type Ctx, fail, type Outcome, ok, readBody, refuse, UUID } from '../contacts/http.ts'
import { ownerAllowed } from '../deals/scope.ts'
import { type DealView, dealView } from '../deals/store.ts'
import { type PermissionsEnv, requestAccess, requirePermission } from '../middleware/permissions.ts'
import { undoContactMerge } from './contacts.ts'
import {
  checkedDealPair,
  type DealMergeContext,
  type DealResult,
  mergeDeals,
  undoDealMerge,
} from './deal-core.ts'
import { DEAL_MERGE_REGISTRY, type MovedAmount } from './deal-registry.ts'
import { mergedRefusal } from './merged.ts'
import { planAll } from './registry.ts'
import {
  deadlockRefusal,
  type MergeView,
  mergeContext,
  mergeViews,
  previewFields,
  readMergedId,
  undoableMerges,
} from './store.ts'

// Слияние сделок с откатом (тикет crm-intake/02; пункты 26, 29, 30, 36; ADR 0005). Только по
// сессии: ключу API маршруты закрыты (403 API_KEY_NOT_ALLOWED).
//
// - `POST /v1/deals/:id/merge` с `{ merge_deal_id }` — `:id` остаётся, вторая скрывается с
//   отметкой «слита с :id». Что переходит — реестр merge/deal-registry.ts. Одной транзакцией:
//   перенос, merge_record и merge_moved_item, история обеих сделок, журнал проекта
//   (`deal.merged`), событие `deal.merged`.
// - `POST /v1/deals/:id/merge/preview` — то же без записи: что перейдёт и какие поля заполнятся.
// - `GET /v1/deals/:id/merges` — слияния в эту сделку, которые ещё можно откатить.
// - `POST /v1/merges/:id/undo` — откат (общий маршрут слияний, ветка по типу записи): возвращает
//   ровно записанное в merge_moved_item.
//
// Обе сделки — своего проекта, не в корзине, не слиты, разные; статус и воронка любые. Право —
// «сделки: изменять» и обе сделки в охвате изменения (пункт 26): вне охвата чтения — 404, как
// несуществующая, в охвате чтения, но не изменения — 403. Откат проверяет то же право на эти две
// сделки сейчас (тот, кто может их объединить).
//
// Гонки (расширенная проверка PR #39, тикет crm-intake/01):
// - Обе сделки блокируются FOR UPDATE в одном порядке до первого чтения. Добавление заметки,
//   файла (timeline/entity.ts, FOR SHARE), строки товара и участника (deals/store.ts,
//   writableDeal, FOR UPDATE) ждёт слияния и потом не находит скрытую сделку.
// - Порядок блокировок (тикет crm-intake/12) — «контакт, потом сделка и заметка», как у слияния
//   контактов: основные контакты сделок — FOR SHARE до сделок (deals/store.ts, lockDeals), запись
//   слияния при откате — после сделок (merge/store.ts, lockedMerge). Взаимоблокировка, которую
//   порядок не покрыл, — 409 MERGE_RETRY (merge/store.ts, deadlockRefusal).
// - Время слияния — clock_timestamp() после блокировок (merge/store.ts, insertMerge). Откат
//   отказывает, если оставшаяся сама уже слита с другой: иначе перешедшее к ней осталось бы у
//   скрытой сделки.
//
// Проверки пары, слияние и откат — merge/deal-core.ts (общие со слиянием контактов, тикет
// crm-intake/04); контекст, тело, поля предпросмотра и список слияний — merge/store.ts (общие с
// контактами, тикет crm-intake/12). Слияние сделок, сделанное вместе со слиянием контактов,
// отдельно не откатывается (409 MERGE_UNDO_NESTED) и в списке слияний сделки не показывается.

type Result<T> = DealResult<T>

// ---- Слияние ---------------------------------------------------------------------------------

/** Что перейдёт при слиянии — ответ предпросмотра. */
export interface DealMergePreview {
  survivor: DealView
  merged: DealView
  /**
   * Пустые поля оставшейся, которые заполнятся: имя поля в API и значение. У суммы значение —
   * `{ amount, currency }`.
   */
  fields: { field: string; value: unknown }[]
  products: number
  /** Сколько строк товаров получат цену товара в валюте оставшейся сделки. */
  convertedProducts: number
  participants: number
  /** Основной контакт слитой, который станет участником оставшейся; null — не станет. */
  primaryContactId: string | null
  notes: number
  files: number
}

/** Слияние в ответе вместе с названием слитой сделки: список в карточке оставшейся. */
export interface DealMergeListItem extends MergeView {
  mergedDeal: { id: string; title: string }
}

async function preview(
  ctx: DealMergeContext,
  survivorId: string,
  mergedId: string,
): Promise<Result<DealMergePreview>> {
  const checked = await checkedDealPair(ctx, survivorId, mergedId)
  if (!checked.ok) return checked
  const { pair, survivor, merged } = checked.value
  const items = await planAll(DEAL_MERGE_REGISTRY, ctx, pair)
  const of = (kind: string) => items.filter((item) => item.kind === kind)
  const primary = of('primary_participant')[0]
  return ok({
    survivor: await dealView(ctx, survivor),
    merged: await dealView(ctx, merged),
    fields: (await previewFields(ctx, 'deal', items)).map((item) => {
      if (item.field !== 'amount') return { field: item.field ?? '', value: item.value }
      const { amount, currency } = item.value as MovedAmount
      return { field: 'amount', value: { amount: Number(amount), currency } }
    }),
    products: of('deal_product').length,
    convertedProducts: of('deal_product').filter(
      (item) => (item.value as { convertedPrice: string | null }).convertedPrice !== null,
    ).length,
    participants: of('deal_participant').length,
    primaryContactId: primary ? (primary.value as { contactId: string }).contactId : null,
    notes: of('note').length,
    files: of('file').length,
  })
}

/** Слияния в сделку `id`, которые ещё можно откатить: новые сверху. */
async function dealMerges(ctx: DealMergeContext, id: string): Promise<Result<DealMergeListItem[]>> {
  if (!UUID.test(id)) return refuse(404, 'DEAL_NOT_FOUND')
  const deal = await ctx.db
    .selectFrom('deal')
    .select(['id', 'owner_id', 'deleted_at', 'merged_into_id'])
    .where('id', '=', id.toLowerCase())
    .executeTakeFirst()
  if (!deal || !ownerAllowed(deal.owner_id, ctx.scope.read, ctx.viewer)) {
    return refuse(404, 'DEAL_NOT_FOUND')
  }
  if (deal.merged_into_id !== null) {
    return (
      (await mergedRefusal(ctx.db, 'deal', deal.id, ctx.scope.read, ctx.viewer)) ??
      refuse(404, 'DEAL_NOT_FOUND')
    )
  }
  const rows = await undoableMerges(ctx.db, 'deal', deal.id)
  const views = await mergeViews(ctx.db, rows)
  const titles =
    rows.length === 0
      ? []
      : await ctx.db
          .selectFrom('deal')
          .select(['id', 'title'])
          .where(
            'id',
            'in',
            rows.map((row) => row.merged_id),
          )
          .execute()
  const byId = new Map(titles.map((row) => [row.id, row.title]))
  return ok(
    views.flatMap((view) => {
      const title = byId.get(view.mergedId)
      return title === undefined ? [] : [{ ...view, mergedDeal: { id: view.mergedId, title } }]
    }),
  )
}

// ---- Маршруты --------------------------------------------------------------------------------

function respond<T, Code extends string>(c: Ctx, outcome: Outcome<T, Code>) {
  return outcome.ok ? c.json(outcome.value as object) : fail(c, outcome)
}

/** Маршруты слияния сделок: `/v1/deals/:id/merge…` (только сессия). */
export function dealMergeRoutes() {
  const edit = requirePermission('deals', 'edit')
  return new Hono<PermissionsEnv>()
    .get('/:id/merges', requirePermission('deals', 'view'), async (c) =>
      respond(c, await dealMerges(await mergeContext(c, 'deal'), c.req.param('id'))),
    )
    .post('/:id/merge/preview', edit, async (c) => {
      const mergedId = readMergedId(await readBody(c), 'deal')
      if (!mergedId.ok) return fail(c, mergedId)
      const ctx = await mergeContext(c, 'deal')
      return respond(
        c,
        await deadlockRefusal(ctx.db, () => preview(ctx, c.req.param('id'), mergedId.value)),
      )
    })
    .post('/:id/merge', edit, async (c) => {
      const mergedId = readMergedId(await readBody(c), 'deal')
      if (!mergedId.ok) return fail(c, mergedId)
      const ctx = await mergeContext(c, 'deal')
      return respond(
        c,
        await deadlockRefusal(ctx.db, () => mergeDeals(ctx, c.req.param('id'), mergedId.value)),
      )
    })
}

/**
 * Откат слияния: `/v1/merges/:id/undo` (только сессия). Ветка — по типу записей слияния, право
 * — «изменять» их часть системы (сделки — «сделки: изменять», контакты — «контакты: изменять»,
 * merge/contacts.ts, undoContactMerge); охват проверяет ветка.
 */
export function mergesRoutes() {
  return new Hono<PermissionsEnv>().post('/:id/undo', async (c) => {
    const raw = c.req.param('id')
    if (!UUID.test(raw)) return fail(c, refuse(404, 'MERGE_NOT_FOUND'))
    const id = raw.toLowerCase()
    const record = await c
      .get('db')
      .selectFrom('merge_record')
      .select('entity_type')
      .where('id', '=', id)
      .executeTakeFirst()
    const access = await requestAccess(c)
    if (!access) return fail(c, refuse(403, 'PERMISSION_DENIED'))
    switch (record?.entity_type) {
      // Тикет crm-intake/01: право «контакты: изменять» проверяет ветка контакта.
      case 'contact':
        return undoContactMerge(c, id)
      case 'deal': {
        if (!can(access.permissions, 'deals', 'edit')) {
          return fail(c, refuse(403, 'PERMISSION_DENIED'))
        }
        const ctx = await mergeContext(c, 'deal')
        return respond(c, await deadlockRefusal(ctx.db, () => undoDealMerge(ctx, id)))
      }
      default:
        return fail(c, refuse(404, 'MERGE_NOT_FOUND'))
    }
  })
}
