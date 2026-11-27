import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import type { ChangeAuthor } from '../change-log/record.ts'
import type { DealCurrency } from '../deals/store.ts'
import { PRICE_COLUMN } from '../products/products.ts'
import {
  canonical,
  type MergeRegistry,
  type MergeRegistryRow,
  type MovedItem,
  moved,
  skipped,
  type UndoSkip,
} from './registry.ts'

// Что переходит при слиянии сделок (тикет crm-intake/02; пункт 30; ADR 0005). Вторая сделка
// («слитая») скрывается, всё перечисленное ниже — у оставшейся:
//
// 1. Этап, статус, воронка, ответственный, название и заполненные поля — оставшейся. Пустые поля
//    (организация, ожидаемая дата закрытия, пользовательские поля) заполняются из слитой. Пустая
//    сумма — 0: тогда сумма и валюта берутся из слитой (решено без владельца — подтвердить). У
//    слитой значения остаются.
// 2. Строки товаров. При разной валюте строка получает цену товара в каталоге в валюте
//    оставшейся сделки (после слияния; решено без владельца — подтвердить); у товара нет цены в
//    этой валюте — цена строки остаётся прежней. Сумма сделки строками не пересчитывается
//    (ADR 0003).
// 3. Участники, кроме тех, кто у оставшейся уже основной контакт или участник (они остаются у
//    слитой и вернутся с ней). Основной контакт слитой, если он другой, становится участником
//    оставшейся (решено без владельца — подтвердить); контакт в корзине — нет.
// 4. Заметки и файлы.
//
// История слитой сделки не переносится строками (change_log только добавляется): лента и
// история оставшейся показывают её с пометкой (deals/store.ts, mergedDealIds).
//
// Откат возвращает ровно записанное: перешедшее, которого у оставшейся уже нет (удалено или
// изменено после слияния), и поле, изменённое после слияния, пропускаются и показываются в итоге.
//
// Новая сущность, связанная со сделкой (регистрации — тикет 06, платежи, задачи), добавляет
// сюда свою строку — иначе её записи останутся у скрытой сделки (ADR 0005, «Последствия»).

/** Строка сделки, нужная реестру. */
async function dealRow(actor: ChangeAuthor, id: string) {
  return actor.db
    .selectFrom('deal')
    .select([
      'organization_id',
      'amount',
      'currency',
      'primary_contact_id',
      'custom',
      sql<string | null>`to_char(expected_close_date, 'YYYY-MM-DD')`.as('expected_close_date'),
    ])
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
}

type DealRegistryRow = Awaited<ReturnType<typeof dealRow>>

/** Сумма берётся из слитой: у оставшейся 0, у слитой нет. */
const takesAmount = (survivor: DealRegistryRow, merged: DealRegistryRow) =>
  Number(survivor.amount) === 0 && Number(merged.amount) > 0

/** Валюта оставшейся после слияния. */
function currencyAfter(survivor: DealRegistryRow, merged: DealRegistryRow): DealCurrency {
  return (takesAmount(survivor, merged) ? merged.currency : survivor.currency) as DealCurrency
}

// ---- 1. Поля ---------------------------------------------------------------------------------

/** Поля сделки, которые слияние заполняет: имя в API → столбец. */
const PLAIN_FIELDS = {
  organizationId: 'organization_id',
  expectedCloseDate: 'expected_close_date',
} as const

type PlainField = keyof typeof PLAIN_FIELDS

const isPlain = (field: string): field is PlainField => Object.hasOwn(PLAIN_FIELDS, field)

/** Сумма из слитой: сумма и валюта, которые поставило слияние, и прежняя валюта оставшейся. */
export interface MovedAmount {
  amount: string
  currency: string
  wasCurrency: string
}

const FIELDS: MergeRegistryRow = {
  kinds: ['field'],
  async plan(actor, pair) {
    const survivor = await dealRow(actor, pair.survivorId)
    const merged = await dealRow(actor, pair.mergedId)
    const items: MovedItem[] = []
    for (const [field, column] of Object.entries(PLAIN_FIELDS)) {
      if (survivor[column] !== null || merged[column] === null) continue
      items.push(moved('field', { field, value: merged[column] }))
    }
    // Организация в корзине не переносится: живую сделку к ней не привязать.
    const organization = items.find((item) => item.field === 'organizationId')
    if (organization) {
      const live = await actor.db
        .selectFrom('organization')
        .select('id')
        .where('id', '=', organization.value as string)
        .where('deleted_at', 'is', null)
        .executeTakeFirst()
      if (!live) items.splice(items.indexOf(organization), 1)
    }
    if (takesAmount(survivor, merged)) {
      items.push(
        moved('field', {
          field: 'amount',
          value: {
            amount: merged.amount,
            currency: merged.currency,
            wasCurrency: survivor.currency,
          } satisfies MovedAmount,
        }),
      )
    }
    // Пользовательские поля — только действующие (не в архиве, не удаляются, тип не меняется).
    const codes = Object.keys(merged.custom).filter(
      (code) => survivor.custom[code] === undefined && merged.custom[code] !== null,
    )
    if (codes.length > 0) {
      const live = await actor.db
        .selectFrom('field_definition')
        .select('code')
        .where('entity', '=', 'deal')
        .where('code', 'in', codes)
        .where('archived_at', 'is', null)
        .where('purge_requested_at', 'is', null)
        .where('converting_to', 'is', null)
        .orderBy('code')
        .forKeyShare()
        .execute()
      for (const { code } of live) {
        items.push(moved('field', { field: `custom.${code}`, value: merged.custom[code] }))
      }
    }
    return items
  },
  async apply(actor, pair, items) {
    if (items.length === 0) return
    const plain: Partial<Record<(typeof PLAIN_FIELDS)[PlainField], string>> = {}
    const custom: Record<string, unknown> = {}
    let amount: MovedAmount | null = null
    for (const item of items) {
      const field = item.field ?? ''
      if (isPlain(field)) plain[PLAIN_FIELDS[field]] = item.value as string
      else if (field === 'amount') amount = item.value as MovedAmount
      else custom[field.slice('custom.'.length)] = item.value
    }
    await actor.db
      .updateTable('deal')
      .set({
        ...plain,
        ...(amount ? { amount: amount.amount, currency: amount.currency } : {}),
        ...(Object.keys(custom).length > 0
          ? { custom: sql<string>`custom || ${JSON.stringify(custom)}::jsonb` }
          : {}),
        updated_at: sql`now()`,
      })
      .where('id', '=', pair.survivorId)
      .execute()
  },
  async restore(actor, pair, items) {
    if (items.length === 0) return []
    const survivor = await dealRow(actor, pair.survivorId)
    const skips: UndoSkip[] = []
    const plain: Partial<Record<(typeof PLAIN_FIELDS)[PlainField], null>> = {}
    const removed: string[] = []
    let amount: { amount: number; currency: string } | null = null
    for (const item of items) {
      const field = item.field ?? ''
      // Изменённое после слияния не трогается: его поставило уже не слияние.
      if (field === 'amount') {
        const value = item.value as MovedAmount
        if (
          Number(survivor.amount) !== Number(value.amount) ||
          survivor.currency !== value.currency
        ) {
          skips.push(skipped(item, 'changed'))
        } else {
          amount = { amount: 0, currency: value.wasCurrency }
        }
        continue
      }
      const current = isPlain(field)
        ? survivor[PLAIN_FIELDS[field]]
        : survivor.custom[field.slice('custom.'.length)]
      if (canonical(current) !== canonical(item.value)) {
        skips.push(skipped(item, 'changed'))
        continue
      }
      if (isPlain(field)) plain[PLAIN_FIELDS[field]] = null
      else removed.push(field.slice('custom.'.length))
    }
    if (Object.keys(plain).length > 0 || removed.length > 0 || amount) {
      await actor.db
        .updateTable('deal')
        .set({
          ...plain,
          ...(amount ?? {}),
          ...(removed.length > 0 ? { custom: sql<string>`custom - ${removed}::text[]` } : {}),
          updated_at: sql`now()`,
        })
        .where('id', '=', pair.survivorId)
        .execute()
    }
    return skips
  },
}

// ---- 2. Строки товаров -----------------------------------------------------------------------

/** Строка товара: цена до слияния и цена в валюте оставшейся (null — не пересчитана). */
interface MovedLine {
  unitPrice: string
  convertedPrice: string | null
}

const PRODUCTS: MergeRegistryRow = {
  kinds: ['deal_product'],
  async plan(actor, pair) {
    const survivor = await dealRow(actor, pair.survivorId)
    const merged = await dealRow(actor, pair.mergedId)
    const target = currencyAfter(survivor, merged)
    const lines = await actor.db
      .selectFrom('deal_product as l')
      .innerJoin('product as p', 'p.id', 'l.product_id')
      .select(['l.id', 'l.unit_price', 'p.price_eur', 'p.price_uah', 'p.price_usd'])
      .where('l.deal_id', '=', pair.mergedId)
      .orderBy('l.id')
      .execute()
    return lines.map((line) => {
      const price = merged.currency === target ? null : line[PRICE_COLUMN[target]]
      return moved('deal_product', {
        itemId: line.id,
        value: { unitPrice: line.unit_price, convertedPrice: price } satisfies MovedLine,
      })
    })
  },
  async apply(actor, pair, items) {
    for (const item of items) {
      const { convertedPrice } = item.value as MovedLine
      await actor.db
        .updateTable('deal_product')
        .set({
          deal_id: pair.survivorId,
          ...(convertedPrice === null
            ? {}
            : { unit_price: convertedPrice, updated_at: sql`now()` }),
        })
        .where('id', '=', item.itemId ?? '')
        .where('deal_id', '=', pair.mergedId)
        .execute()
    }
  },
  async restore(actor, pair, items) {
    const skips: UndoSkip[] = []
    for (const item of items) {
      const { unitPrice, convertedPrice } = item.value as MovedLine
      const line = await actor.db
        .selectFrom('deal_product')
        .select(['deal_id', 'unit_price'])
        .where('id', '=', item.itemId ?? '')
        .forUpdate()
        .executeTakeFirst()
      if (!line) {
        skips.push(skipped(item, 'gone'))
        continue
      }
      // Строка ушла в другую сделку или цену, поставленную слиянием, поменяли — не трогаем.
      if (
        line.deal_id !== pair.survivorId ||
        (convertedPrice !== null && Number(line.unit_price) !== Number(convertedPrice))
      ) {
        skips.push(skipped(item, 'changed'))
        continue
      }
      await actor.db
        .updateTable('deal_product')
        .set({
          deal_id: pair.mergedId,
          ...(convertedPrice === null ? {} : { unit_price: unitPrice, updated_at: sql`now()` }),
        })
        .where('id', '=', item.itemId ?? '')
        .execute()
    }
    return skips
  },
}

// ---- 3. Участники ----------------------------------------------------------------------------

/** Основной контакт слитой стал участником оставшейся: строка участника с этим id. */
interface MovedPrimary {
  contactId: string
}

const PARTICIPANTS: MergeRegistryRow = {
  kinds: ['deal_participant', 'primary_participant'],
  async plan(actor, pair) {
    const survivor = await dealRow(actor, pair.survivorId)
    const merged = await dealRow(actor, pair.mergedId)
    const present = await actor.db
      .selectFrom('deal_participant')
      .select('contact_id')
      .where('deal_id', '=', pair.survivorId)
      .execute()
    const taken = new Set([survivor.primary_contact_id, ...present.map((p) => p.contact_id)])
    const participants = await actor.db
      .selectFrom('deal_participant')
      .select(['id', 'contact_id'])
      .where('deal_id', '=', pair.mergedId)
      .orderBy('created_at')
      .orderBy('id')
      .execute()
    const items = participants
      .filter((p) => !taken.has(p.contact_id))
      .map((p) => moved('deal_participant', { itemId: p.id }))
    if (!taken.has(merged.primary_contact_id)) {
      // FOR SHARE: контакт не уйдёт в корзину, пока строка участника не записана.
      const live = await actor.db
        .selectFrom('contact')
        .select('id')
        .where('id', '=', merged.primary_contact_id)
        .where('deleted_at', 'is', null)
        .forShare()
        .executeTakeFirst()
      if (live) {
        items.push(
          moved('primary_participant', {
            itemId: randomUUID(),
            value: { contactId: merged.primary_contact_id } satisfies MovedPrimary,
          }),
        )
      }
    }
    return items
  },
  async apply(actor, pair, items) {
    const participants = items.filter((item) => item.kind === 'deal_participant')
    if (participants.length > 0) {
      await actor.db
        .updateTable('deal_participant')
        .set({ deal_id: pair.survivorId })
        .where(
          'id',
          'in',
          participants.map((item) => item.itemId ?? ''),
        )
        .where('deal_id', '=', pair.mergedId)
        .execute()
    }
    for (const item of items.filter((i) => i.kind === 'primary_participant')) {
      await actor.db
        .insertInto('deal_participant')
        .values({
          id: item.itemId ?? '',
          project_id: actor.projectId,
          deal_id: pair.survivorId,
          contact_id: (item.value as MovedPrimary).contactId,
          role: null,
          created_by: actor.actorId,
        })
        .execute()
    }
  },
  async restore(actor, pair, items) {
    const skips: UndoSkip[] = []
    for (const item of items) {
      const back =
        item.kind === 'deal_participant'
          ? await actor.db
              .updateTable('deal_participant')
              .set({ deal_id: pair.mergedId })
              .where('id', '=', item.itemId ?? '')
              .where('deal_id', '=', pair.survivorId)
              .returning('id')
              .executeTakeFirst()
          : await actor.db
              .deleteFrom('deal_participant')
              .where('id', '=', item.itemId ?? '')
              .where('deal_id', '=', pair.survivorId)
              .returning('id')
              .executeTakeFirst()
      if (back) continue
      skips.push(skipped(item, (await participantExists(actor, item)) ? 'changed' : 'gone'))
    }
    return skips
  },
}

async function participantExists(actor: ChangeAuthor, item: MovedItem): Promise<boolean> {
  const row = await actor.db
    .selectFrom('deal_participant')
    .select('id')
    .where('id', '=', item.itemId ?? '')
    .executeTakeFirst()
  return row !== undefined
}

// ---- 4. Заметки, файлы и регистрации ---------------------------------------------------------

/** Регистрации (тикет crm-intake/06) переходят и возвращаются так же, как заметки и файлы. */
function attachedRow(kind: 'note' | 'file' | 'registration'): MergeRegistryRow {
  return {
    kinds: [kind],
    async plan(actor, pair) {
      const rows = await actor.db
        .selectFrom(kind)
        .select('id')
        .where('deal_id', '=', pair.mergedId)
        .orderBy('id')
        .execute()
      return rows.map((row) => moved(kind, { itemId: row.id }))
    },
    async apply(actor, pair, items) {
      if (items.length === 0) return
      await actor.db
        .updateTable(kind)
        .set({ deal_id: pair.survivorId })
        .where(
          'id',
          'in',
          items.map((item) => item.itemId ?? ''),
        )
        .where('deal_id', '=', pair.mergedId)
        .execute()
    },
    async restore(actor, pair, items) {
      if (items.length === 0) return []
      const back = await actor.db
        .updateTable(kind)
        .set({ deal_id: pair.mergedId })
        .where(
          'id',
          'in',
          items.map((item) => item.itemId ?? ''),
        )
        .where('deal_id', '=', pair.survivorId)
        .returning('id')
        .execute()
      const returned = new Set(back.map((row) => row.id))
      const missing = items.filter((item) => !returned.has(item.itemId ?? ''))
      if (missing.length === 0) return []
      const exists = await actor.db
        .selectFrom(kind)
        .select('id')
        .where(
          'id',
          'in',
          missing.map((item) => item.itemId ?? ''),
        )
        .execute()
      const alive = new Set(exists.map((row) => row.id))
      return missing.map((item) => skipped(item, alive.has(item.itemId ?? '') ? 'changed' : 'gone'))
    },
  }
}

/** Реестр слияния сделок. Порядок — порядок слияния; откат идёт в обратном. */
export const DEAL_MERGE_REGISTRY: MergeRegistry = [
  FIELDS,
  PRODUCTS,
  PARTICIPANTS,
  attachedRow('note'),
  attachedRow('file'),
  attachedRow('registration'),
]
