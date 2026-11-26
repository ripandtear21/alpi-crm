import { sql } from 'kysely'
import { type ChangeAuthor, recordChanges } from '../change-log/record.ts'
import {
  canonical,
  type MergeRegistry,
  type MergeRegistryRow,
  type MovedItem,
  moved,
  skipped,
  type UndoSkip,
} from './registry.ts'

// Что переходит при слиянии контактов (тикет crm-intake/01; пункты 23, 29; ADR 0005). Второй
// контакт («слитый») скрывается, всё перечисленное ниже — у оставшегося:
//
// 1. Пустые поля оставшегося (фамилия, язык, организация, пользовательские поля) заполняются
//    из слитого; заполненные не меняются. У слитого значения остаются.
// 2. Телефоны и email слитого, которых нет у оставшегося, переходят к нему не основными
//    (у оставшегося без телефонов первый перешедший становится основным). Совпавшие остаются у
//    слитого.
// 3. Сделки, где слитый основной, и его участие в сделках — все, в том числе вне охвата
//    пользователя (решено без владельца — подтвердить). Участие, которое повторило бы
//    оставшегося в той же сделке, снимается; участие оставшегося в сделке, где он стал основным,
//    — тоже (основной контакт участником не бывает).
// 4. Заметки и файлы.
// 5. Отметка «возможный дубль», которая связывает эти два контакта, снимается (решено без
//    владельца — подтвердить).
//
// Откат возвращает ровно записанное: перешедшее, которого у оставшегося уже нет (удалено
// окончательно или передано дальше), и поле, изменённое после слияния, пропускаются и
// показываются в итоге. Сделка, ушедшая в корзину после слияния, возвращается в корзине — у неё
// меняется только основной контакт.

// ---- 1. Поля ---------------------------------------------------------------------------------

/** Поля контакта, которые слияние заполняет: имя в API → столбец. */
const PLAIN_FIELDS = {
  lastName: 'last_name',
  language: 'language',
  organizationId: 'organization_id',
} as const

type PlainField = keyof typeof PLAIN_FIELDS

const isPlain = (field: string): field is PlainField => Object.hasOwn(PLAIN_FIELDS, field)

async function contactRow(actor: ChangeAuthor, id: string) {
  return actor.db
    .selectFrom('contact')
    .select(['last_name', 'language', 'organization_id', 'custom'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
}

const FIELDS: MergeRegistryRow = {
  kinds: ['field'],
  async plan(actor, pair) {
    const survivor = await contactRow(actor, pair.survivorId)
    const merged = await contactRow(actor, pair.mergedId)
    const items: MovedItem[] = []
    for (const [field, column] of Object.entries(PLAIN_FIELDS)) {
      if (survivor[column] !== null || merged[column] === null) continue
      items.push(moved('field', { field, value: merged[column] }))
    }
    // Организация в корзине не переносится: живой контакт к ней не привязать.
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
    // Пользовательские поля — только действующие (не в архиве, не удаляются, тип не меняется).
    const codes = Object.keys(merged.custom).filter(
      (code) => survivor.custom[code] === undefined && merged.custom[code] !== null,
    )
    if (codes.length > 0) {
      const live = await actor.db
        .selectFrom('field_definition')
        .select('code')
        .where('entity', '=', 'contact')
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
    for (const item of items) {
      const field = item.field ?? ''
      if (isPlain(field)) plain[PLAIN_FIELDS[field]] = item.value as string
      else custom[field.slice('custom.'.length)] = item.value
    }
    await actor.db
      .updateTable('contact')
      .set({
        ...plain,
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
    const survivor = await contactRow(actor, pair.survivorId)
    const skips: UndoSkip[] = []
    const plain: Partial<Record<(typeof PLAIN_FIELDS)[PlainField], null>> = {}
    const removed: string[] = []
    for (const item of items) {
      const field = item.field ?? ''
      const current = isPlain(field)
        ? survivor[PLAIN_FIELDS[field]]
        : survivor.custom[field.slice('custom.'.length)]
      // Изменённое после слияния не трогается: его поставил уже не слияние.
      if (canonical(current) !== canonical(item.value)) {
        skips.push(skipped(item, 'changed'))
        continue
      }
      if (isPlain(field)) plain[PLAIN_FIELDS[field]] = null
      else removed.push(field.slice('custom.'.length))
    }
    if (Object.keys(plain).length > 0 || removed.length > 0) {
      await actor.db
        .updateTable('contact')
        .set({
          ...plain,
          ...(removed.length > 0 ? { custom: sql<string>`custom - ${removed}::text[]` } : {}),
          updated_at: sql`now()`,
        })
        .where('id', '=', pair.survivorId)
        .execute()
    }
    return skips
  },
}

// ---- 2. Телефоны и email ---------------------------------------------------------------------

/** Телефон или email, перешедший к оставшемуся: сам ключ и отметки «основной». */
interface MovedKey {
  key: string
  /** Был основным у слитого. */
  primary: boolean
  /** Стал основным у оставшегося (у того ключей этого вида не было). */
  survivorPrimary: boolean
}

function keysRow(kind: 'phone' | 'email'): MergeRegistryRow {
  const table = kind === 'phone' ? 'contact_phone' : 'contact_email'
  const column = kind === 'phone' ? 'phone' : 'email'
  const keysOf = async (actor: ChangeAuthor, contactId: string) => {
    const rows = await actor.db
      .selectFrom(table)
      .select([`${column} as key`, 'is_primary'])
      .where('contact_id', '=', contactId)
      .orderBy('is_primary', 'desc')
      .orderBy(column)
      .execute()
    return rows as { key: string; is_primary: boolean }[]
  }
  return {
    kinds: [kind],
    async plan(actor, pair) {
      const survivor = new Set((await keysOf(actor, pair.survivorId)).map((row) => row.key))
      const fresh = (await keysOf(actor, pair.mergedId)).filter((row) => !survivor.has(row.key))
      return fresh.map((row, index) =>
        moved(kind, {
          value: {
            key: row.key,
            primary: row.is_primary,
            survivorPrimary: survivor.size === 0 && index === 0,
          } satisfies MovedKey,
        }),
      )
    },
    async apply(actor, pair, items) {
      for (const item of items) {
        const { key, survivorPrimary } = item.value as MovedKey
        await actor.db
          .updateTable(table)
          .set({ contact_id: pair.survivorId, is_primary: survivorPrimary })
          .where('contact_id', '=', pair.mergedId)
          .where(column, '=', key)
          .execute()
      }
    },
    async restore(actor, pair, items) {
      const skips: UndoSkip[] = []
      for (const item of items) {
        const { key, primary } = item.value as MovedKey
        const row = await actor.db
          .deleteFrom(table)
          .where('contact_id', '=', pair.survivorId)
          .where(column, '=', key)
          .returning('is_primary')
          .executeTakeFirst()
        if (!row) {
          skips.push(skipped(item, 'gone'))
          continue
        }
        if (row.is_primary) await promoteFirst(actor, table, column, pair.survivorId)
        await actor.db
          .insertInto(table)
          .values({
            project_id: actor.projectId,
            contact_id: pair.mergedId,
            [column]: key,
            is_primary: primary,
          } as never)
          .execute()
      }
      return skips
    },
  }
}

/** Основным становится первый по порядку ключ контакта: прежний основной ушёл. */
async function promoteFirst(
  actor: ChangeAuthor,
  table: 'contact_phone' | 'contact_email',
  column: 'phone' | 'email',
  contactId: string,
) {
  const first = await actor.db
    .selectFrom(table)
    .select('id')
    .where('contact_id', '=', contactId)
    .orderBy(column)
    .limit(1)
    .executeTakeFirst()
  if (first) {
    await actor.db.updateTable(table).set({ is_primary: true }).where('id', '=', first.id).execute()
  }
}

// ---- 3. Сделки и участие в них ---------------------------------------------------------------

/** Участник в истории сделки — как в ответе API (deals/store.ts, dealViews). */
async function participantsOf(actor: ChangeAuthor, dealId: string) {
  const rows = await actor.db
    .selectFrom('deal_participant')
    .select(['contact_id', 'role'])
    .where('deal_id', '=', dealId)
    .orderBy('created_at')
    .orderBy('contact_id')
    .execute()
  return rows.map((p) => ({ contactId: p.contact_id, role: p.role }))
}

/** Участие слитого в сделке: роль и снято ли оно (повторило бы оставшегося). */
interface MovedParticipant {
  role: string | null
  dropped: boolean
}

/**
 * Пишет историю сделок `dealIds` вокруг `change`: основной контакт и участники «было → стало».
 */
async function withDealHistory(
  actor: ChangeAuthor,
  dealIds: readonly string[],
  change: () => Promise<void>,
) {
  const ids = [...new Set(dealIds)].sort()
  const before = new Map<string, { primaryContactId: string; participants: unknown }>()
  for (const id of ids) {
    const deal = await actor.db
      .selectFrom('deal')
      .select('primary_contact_id')
      .where('id', '=', id)
      .executeTakeFirst()
    if (deal) {
      before.set(id, {
        primaryContactId: deal.primary_contact_id,
        participants: await participantsOf(actor, id),
      })
    }
  }
  await change()
  for (const [id, was] of before) {
    const deal = await actor.db
      .selectFrom('deal')
      .select('primary_contact_id')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    const participants = await participantsOf(actor, id)
    const changes = []
    if (deal.primary_contact_id !== was.primaryContactId) {
      changes.push({
        field: 'primaryContactId',
        before: was.primaryContactId,
        after: deal.primary_contact_id,
      })
    }
    if (canonical(participants) !== canonical(was.participants)) {
      changes.push({ field: 'participants', before: was.participants, after: participants })
    }
    await recordChanges(actor, { type: 'deal', id }, changes)
  }
}

const DEALS: MergeRegistryRow = {
  kinds: ['deal', 'deal_participant', 'survivor_participant'],
  async plan(actor, pair) {
    // Все сделки, в том числе в корзине и вне охвата: иначе они остались бы у скрытого контакта.
    const primary = await actor.db
      .selectFrom('deal')
      .select('id')
      .where('primary_contact_id', '=', pair.mergedId)
      .orderBy('id')
      .execute()
    const primaryIds = new Set(primary.map((deal) => deal.id))
    const survivorRoles = await actor.db
      .selectFrom('deal_participant')
      .select(['deal_id', 'role'])
      .where('contact_id', '=', pair.survivorId)
      .orderBy('deal_id')
      .execute()
    const survivorPrimary = await actor.db
      .selectFrom('deal')
      .select('id')
      .where('primary_contact_id', '=', pair.survivorId)
      .execute()
    const survivorIn = new Set([
      ...survivorRoles.map((p) => p.deal_id),
      ...survivorPrimary.map((deal) => deal.id),
      ...primaryIds,
    ])
    const participation = await actor.db
      .selectFrom('deal_participant')
      .select(['deal_id', 'role'])
      .where('contact_id', '=', pair.mergedId)
      .orderBy('deal_id')
      .execute()
    return [
      ...primary.map((deal) => moved('deal', { itemId: deal.id })),
      ...participation.map((p) =>
        moved('deal_participant', {
          itemId: p.deal_id,
          value: { role: p.role, dropped: survivorIn.has(p.deal_id) } satisfies MovedParticipant,
        }),
      ),
      // Оставшийся — участник сделки, где основным был слитый: основным он станет сам.
      ...survivorRoles
        .filter((p) => primaryIds.has(p.deal_id))
        .map((p) => moved('survivor_participant', { itemId: p.deal_id, value: { role: p.role } })),
    ]
  },
  async apply(actor, pair, items) {
    const dealIds = items.flatMap((item) => (item.itemId ? [item.itemId] : []))
    await withDealHistory(actor, dealIds, async () => {
      for (const item of items) {
        const dealId = item.itemId ?? ''
        if (item.kind === 'survivor_participant') {
          await removeParticipant(actor, dealId, pair.survivorId)
        } else if (item.kind === 'deal_participant') {
          if ((item.value as MovedParticipant).dropped) {
            await removeParticipant(actor, dealId, pair.mergedId)
          } else {
            await actor.db
              .updateTable('deal_participant')
              .set({ contact_id: pair.survivorId })
              .where('deal_id', '=', dealId)
              .where('contact_id', '=', pair.mergedId)
              .execute()
          }
        }
      }
      const primary = items.filter((item) => item.kind === 'deal').map((item) => item.itemId ?? '')
      if (primary.length > 0) {
        await actor.db
          .updateTable('deal')
          .set({ primary_contact_id: pair.survivorId, updated_at: sql`now()` })
          .where('id', 'in', primary)
          .where('primary_contact_id', '=', pair.mergedId)
          .execute()
      }
    })
  },
  async restore(actor, pair, items) {
    const skips: UndoSkip[] = []
    const dealIds = items.flatMap((item) => (item.itemId ? [item.itemId] : []))
    await withDealHistory(actor, dealIds, async () => {
      // Сначала основной контакт: от него зависит, вернётся ли участие.
      for (const item of items.filter((i) => i.kind === 'deal')) {
        const deal = await actor.db
          .selectFrom('deal')
          .select('primary_contact_id')
          .where('id', '=', item.itemId ?? '')
          .forUpdate()
          .executeTakeFirst()
        if (!deal) skips.push(skipped(item, 'gone'))
        else if (deal.primary_contact_id !== pair.survivorId) skips.push(skipped(item, 'changed'))
        else {
          await actor.db
            .updateTable('deal')
            .set({ primary_contact_id: pair.mergedId, updated_at: sql`now()` })
            .where('id', '=', item.itemId ?? '')
            .execute()
        }
      }
      for (const item of items.filter((i) => i.kind !== 'deal')) {
        const dealId = item.itemId ?? ''
        const deal = await actor.db
          .selectFrom('deal')
          .select('primary_contact_id')
          .where('id', '=', dealId)
          .executeTakeFirst()
        if (!deal) {
          skips.push(skipped(item, 'gone'))
          continue
        }
        const contactId = item.kind === 'survivor_participant' ? pair.survivorId : pair.mergedId
        const role = (item.value as { role: string | null }).role
        if (
          deal.primary_contact_id === contactId ||
          (await isParticipant(actor, dealId, contactId))
        ) {
          skips.push(skipped(item, 'changed'))
          continue
        }
        if (item.kind === 'deal_participant' && !(item.value as MovedParticipant).dropped) {
          // Перешедшее участие возвращается, только если оно ещё у оставшегося.
          const back = await actor.db
            .updateTable('deal_participant')
            .set({ contact_id: pair.mergedId })
            .where('deal_id', '=', dealId)
            .where('contact_id', '=', pair.survivorId)
            .returning('id')
            .executeTakeFirst()
          if (!back) skips.push(skipped(item, 'gone'))
          continue
        }
        await actor.db
          .insertInto('deal_participant')
          .values({
            project_id: actor.projectId,
            deal_id: dealId,
            contact_id: contactId,
            role,
            created_by: actor.actorId,
          })
          .execute()
      }
    })
    return skips
  },
}

async function removeParticipant(actor: ChangeAuthor, dealId: string, contactId: string) {
  await actor.db
    .deleteFrom('deal_participant')
    .where('deal_id', '=', dealId)
    .where('contact_id', '=', contactId)
    .execute()
}

async function isParticipant(actor: ChangeAuthor, dealId: string, contactId: string) {
  const row = await actor.db
    .selectFrom('deal_participant')
    .select('id')
    .where('deal_id', '=', dealId)
    .where('contact_id', '=', contactId)
    .executeTakeFirst()
  return row !== undefined
}

// ---- 4. Заметки и файлы ----------------------------------------------------------------------

function attachedRow(kind: 'note' | 'file'): MergeRegistryRow {
  return {
    kinds: [kind],
    async plan(actor, pair) {
      const rows = await actor.db
        .selectFrom(kind)
        .select('id')
        .where('contact_id', '=', pair.mergedId)
        .orderBy('id')
        .execute()
      return rows.map((row) => moved(kind, { itemId: row.id }))
    },
    async apply(actor, pair, items) {
      if (items.length === 0) return
      await actor.db
        .updateTable(kind)
        .set({ contact_id: pair.survivorId })
        .where(
          'id',
          'in',
          items.map((item) => item.itemId ?? ''),
        )
        .where('contact_id', '=', pair.mergedId)
        .execute()
    },
    async restore(actor, pair, items) {
      if (items.length === 0) return []
      const back = await actor.db
        .updateTable(kind)
        .set({ contact_id: pair.mergedId })
        .where(
          'id',
          'in',
          items.map((item) => item.itemId ?? ''),
        )
        .where('contact_id', '=', pair.survivorId)
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

// ---- 5. Отметка «возможный дубль» ------------------------------------------------------------

const POSSIBLE_DUPLICATE: MergeRegistryRow = {
  kinds: ['possible_duplicate'],
  async plan(actor, pair) {
    const rows = await actor.db
      .selectFrom('contact')
      .select(['id', 'possible_duplicate_of'])
      .where('possible_duplicate', '=', true)
      .where((eb) =>
        eb.or([
          eb.and([eb('id', '=', pair.survivorId), eb('possible_duplicate_of', '=', pair.mergedId)]),
          eb.and([eb('id', '=', pair.mergedId), eb('possible_duplicate_of', '=', pair.survivorId)]),
        ]),
      )
      .orderBy('id')
      .execute()
    return rows.map((row) =>
      moved('possible_duplicate', { itemId: row.id, value: { of: row.possible_duplicate_of } }),
    )
  },
  async apply(actor, _pair, items) {
    if (items.length === 0) return
    await actor.db
      .updateTable('contact')
      .set({ possible_duplicate: false, possible_duplicate_of: null, updated_at: sql`now()` })
      .where(
        'id',
        'in',
        items.map((item) => item.itemId ?? ''),
      )
      .execute()
  },
  async restore(actor, _pair, items) {
    const skips: UndoSkip[] = []
    for (const item of items) {
      const back = await actor.db
        .updateTable('contact')
        .set({
          possible_duplicate: true,
          possible_duplicate_of: (item.value as { of: string }).of,
          updated_at: sql`now()`,
        })
        .where('id', '=', item.itemId ?? '')
        .where('possible_duplicate', '=', false)
        .returning('id')
        .executeTakeFirst()
      if (!back) skips.push(skipped(item, 'changed'))
    }
    return skips
  },
}

/** Реестр слияния контактов. Порядок — порядок слияния; откат идёт в обратном. */
export const CONTACT_MERGE_REGISTRY: MergeRegistry = [
  FIELDS,
  keysRow('phone'),
  keysRow('email'),
  DEALS,
  attachedRow('note'),
  attachedRow('file'),
  POSSIBLE_DUPLICATE,
]

/** Перешедшие сделки (основной контакт и участие) — для охвата и предпросмотра. */
export function movedDealIds(items: readonly MovedItem[]): string[] {
  return [
    ...new Set(
      items
        .filter((item) => item.kind === 'deal' || item.kind === 'deal_participant')
        .flatMap((item) => (item.itemId ? [item.itemId] : [])),
    ),
  ]
}
