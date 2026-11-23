import { randomUUID } from 'node:crypto'
import { applyProjectPreset, createProject, type Database, PROJECT_PRESETS } from '@alpi/db'
import { type Kysely, type SqlBool, sql, type Transaction } from 'kysely'
import type { ProjectPlan } from './plan.ts'

// Запись тестовых данных служебной ролью (владелец таблиц) — напрямую в таблицы, а не через
// API: 5 000 сделок запросами по одной шли бы минуты, а функции API принимают контекст запроса
// Hono. Правила, которые держит база (одна открытая сделка у человека в воронке, этап своей
// воронки, действующая причина проигрыша), проверяются при вставке; правила охвата — тест
// apps/api/src/cli/seed.test.ts читает созданное через API под менеджером.
//
// Каждая созданная запись помечена внешней ссылкой external_link с системой `seed` и ключом из
// плана: по ней повторный запуск находит созданное и досоздаёт только недостающее, а --reset
// удаляет только помеченное.

export const SEED_SOURCE = 'seed'

/** Строк за один INSERT: у PostgreSQL не больше 65 535 параметров на запрос. */
const CHUNK = 1000

type Db = Kysely<Database>
type Trx = Transaction<Database>

/** Таблицы помеченных записей: тип сущности в external_link — имя таблицы. */
type SeedTable =
  | 'project'
  | 'team'
  | 'project_member'
  | 'product'
  | 'organization'
  | 'contact'
  | 'deal'
  | 'deal_participant'
  | 'deal_product'

/** Помеченные записи, которые --reset удаляет сам (остальное уходит с проектом). */
const RESET_TABLES = [
  'deal',
  'deal_participant',
  'deal_product',
  'contact',
  'organization',
  'product',
] as const

/**
 * Ключ плана → id для записей типа `table` в проекте. Ссылки на записи, которых уже нет (их
 * удалили руками), стираются: такие записи будут созданы заново.
 */
async function seededIds(
  db: Trx,
  projectId: string,
  table: SeedTable,
): Promise<Map<string, string>> {
  await sql`
    delete from external_link l
    where l.project_id = ${projectId} and l.source = ${SEED_SOURCE} and l.entity_type = ${table}
      and not exists (select 1 from ${sql.table(table)} t where t.id::text = l.entity_id)
  `.execute(db)
  const rows = await db
    .selectFrom('external_link')
    .select(['external_id', 'entity_id'])
    .where('project_id', '=', projectId)
    .where('source', '=', SEED_SOURCE)
    .where('entity_type', '=', table)
    .execute()
  return new Map(rows.map((r) => [r.external_id, r.entity_id]))
}

async function link(
  db: Trx,
  projectId: string,
  table: SeedTable,
  rows: { id: string; key: string }[],
) {
  if (rows.length === 0) return
  await db
    .insertInto('external_link')
    .values(
      rows.map((r) => ({
        project_id: projectId,
        entity_type: table,
        entity_id: r.id,
        source: SEED_SOURCE,
        external_id: r.key,
      })),
    )
    .execute()
}

/**
 * Досоздаёт записи `items`, которых ещё нет (по ключу). `insert` вставляет порцию с готовыми id
 * и возвращает id реально вставленных (сделка, нарушающая правило базы, пропускается).
 */
async function ensure<T extends { key: string }>(
  db: Trx,
  projectId: string,
  table: SeedTable,
  items: readonly T[],
  insert: (rows: { id: string; item: T }[]) => Promise<string[]>,
): Promise<{ ids: Map<string, string>; created: number }> {
  const ids = await seededIds(db, projectId, table)
  const missing = items
    .filter((item) => !ids.has(item.key))
    .map((item) => ({ id: randomUUID(), item }))
  let created = 0
  for (let i = 0; i < missing.length; i += CHUNK) {
    const chunk = missing.slice(i, i + CHUNK)
    const inserted = new Set(await insert(chunk))
    const done = chunk.filter((r) => inserted.has(r.id))
    await link(
      db,
      projectId,
      table,
      done.map((r) => ({ id: r.id, key: r.item.key })),
    )
    for (const r of done) ids.set(r.item.key, r.id)
    created += done.length
  }
  return { ids, created }
}

/** Проект с кодом `code`, созданный seed; null — такого проекта нет. Чужой проект — ошибка. */
export async function findSeedProject(db: Db, code: string): Promise<string | null> {
  const row = await db
    .selectFrom('project as p')
    .leftJoin('external_link as l', (join) =>
      join
        .onRef('l.project_id', '=', 'p.id')
        .on('l.source', '=', SEED_SOURCE)
        .on('l.entity_type', '=', 'project'),
    )
    .select(['p.id', 'l.id as link_id'])
    .where('p.code', '=', code)
    .executeTakeFirst()
  if (!row) return null
  if (!row.link_id) {
    throw new Error(
      `проект с кодом «${code}» уже есть и создан не командой seed — seed его не трогает`,
    )
  }
  return row.id
}

export interface ProjectCounts {
  products: number
  organizations: number
  contacts: number
  deals: number
  /** Сделки плана, которые база не приняла: у человека уже есть открытая сделка в воронке. */
  skippedDeals: number
}

/**
 * Создаёт проект плана со стартовой настройкой, участниками, командами, товарами, организациями,
 * контактами и сделками — одной транзакцией. Уже созданное не дублируется.
 */
export async function writeProject(
  serviceDb: Db,
  plan: ProjectPlan,
  userIds: Map<string, string>,
  adminKey: string,
): Promise<ProjectCounts> {
  const userId = (key: string) => {
    const id = userIds.get(key)
    if (!id) throw new Error(`нет пользователя ${key}`)
    return id
  }
  const adminId = userId(adminKey)
  return serviceDb.transaction().execute(async (db) => {
    let projectId = await findSeedProject(db, plan.code)
    if (!projectId) {
      projectId = (await createProject(db, { code: plan.code, name: plan.name })).id
      await link(db, projectId, 'project', [{ id: projectId, key: plan.code }])
    }
    const pid = projectId
    await applyProjectPreset(db, pid, plan.preset)

    // Участники и команды. Тимлид команды — её участник (ключ базы проверяется в конце
    // транзакции), поэтому команда вставляется раньше участников.
    const roles = new Map(
      (
        await db
          .selectFrom('role')
          .select(['id', 'template_key'])
          .where('project_id', '=', pid)
          .where('template_key', 'is not', null)
          .execute()
      ).map((r) => [r.template_key, r.id]),
    )
    const roleId = (key: string) => {
      const id = roles.get(key)
      if (!id) throw new Error(`в проекте нет роли-шаблона ${key}`)
      return id
    }
    const teams = await ensure(db, pid, 'team', plan.teams, async (rows) => {
      const inserted = await db
        .insertInto('team')
        .values(
          rows.map(({ id, item }) => ({
            id,
            project_id: pid,
            name: item.name,
            lead_user_id: userId(item.leadKey),
            created_by: adminId,
          })),
        )
        .onConflict((oc) => oc.doNothing())
        .returning('id')
        .execute()
      if (inserted.length < rows.length) {
        throw new Error('команда с таким названием уже есть и создана не командой seed')
      }
      return inserted.map((r) => r.id)
    })
    const teamOf = new Map(
      plan.teams.flatMap((t) => t.memberKeys.map((key) => [key, teams.ids.get(t.key) ?? null])),
    )
    const members = [
      { key: adminKey, userKey: adminKey, role: 'admin' },
      ...plan.members.map((m) => ({ key: m.userKey, ...m })),
    ]
    await ensure(db, pid, 'project_member', members, async (rows) => {
      const inserted = await db
        .insertInto('project_member')
        .values(
          rows.map(({ id, item }) => ({
            id,
            project_id: pid,
            user_id: userId(item.userKey),
            role_id: roleId(item.role),
            team_id: teamOf.get(item.userKey) ?? null,
            created_by: adminId,
          })),
        )
        // Участник, добавленный руками раньше, остаётся как есть и ссылкой seed не помечается.
        .onConflict((oc) => oc.doNothing())
        .returning('id')
        .execute()
      return inserted.map((r) => r.id)
    })

    const products = await ensure(db, pid, 'product', plan.products, async (rows) => {
      await db
        .insertInto('product')
        .values(
          rows.map(({ id, item }) => ({
            id,
            project_id: pid,
            name: item.name,
            price_eur: item.prices.EUR,
            price_uah: item.prices.UAH,
            price_usd: item.prices.USD,
            created_by: adminId,
          })),
        )
        .execute()
      return rows.map((r) => r.id)
    })

    const organizations = await ensure(
      db,
      pid,
      'organization',
      plan.organizations,
      async (rows) => {
        await db
          .insertInto('organization')
          .values(
            rows.map(({ id, item }) => ({
              id,
              project_id: pid,
              name: item.name,
              address: item.address,
              website: item.website,
              created_by: adminId,
            })),
          )
          .execute()
        return rows.map((r) => r.id)
      },
    )
    const orgId = (key: string | null) => {
      if (key === null) return null
      const id = organizations.ids.get(key)
      if (!id) throw new Error(`нет организации ${key}`)
      return id
    }

    // Контакты: создатель — администратор (как при импорте), «свои» у менеджера — через сделки.
    const contacts = await ensure(db, pid, 'contact', plan.contacts, async (rows) => {
      await db
        .insertInto('contact')
        .values(
          rows.map(({ id, item }) => ({
            id,
            project_id: pid,
            first_name: item.firstName,
            last_name: item.lastName,
            language: item.language,
            organization_id: orgId(item.organizationKey),
            created_by: adminId,
          })),
        )
        .execute()
      await db
        .insertInto('contact_phone')
        .values(
          rows.map(({ id, item }) => ({
            project_id: pid,
            contact_id: id,
            phone: item.phone,
            is_primary: true,
          })),
        )
        .execute()
      const emails = rows.flatMap(({ id, item }) =>
        item.email === null
          ? []
          : [{ project_id: pid, contact_id: id, email: item.email, is_primary: true }],
      )
      if (emails.length > 0) await db.insertInto('contact_email').values(emails).execute()
      return rows.map((r) => r.id)
    })
    const contactId = (key: string) => {
      const id = contacts.ids.get(key)
      if (!id) throw new Error(`нет контакта ${key}`)
      return id
    }

    const pipelines = await db
      .selectFrom('pipeline')
      .select(['id', 'code'])
      .where('project_id', '=', pid)
      .execute()
    const stages = await db
      .selectFrom('stage')
      .select(['id', 'pipeline_id'])
      .where('project_id', '=', pid)
      .where('deleted_at', 'is', null)
      .orderBy('position')
      .execute()
    const stageIds = new Map(
      pipelines.map((p) => [p.code, stages.filter((s) => s.pipeline_id === p.id).map((s) => s.id)]),
    )
    const pipelineIds = new Map(pipelines.map((p) => [p.code, p.id]))
    const reasons = await db
      .selectFrom('lost_reason as r')
      .innerJoin('lost_reason_group as g', 'g.id', 'r.group_id')
      .select('r.id')
      .where('r.project_id', '=', pid)
      .where('r.archived_at', 'is', null)
      .where('g.archived_at', 'is', null)
      .orderBy('g.position')
      .orderBy('r.position')
      .execute()

    const deals = await ensure(db, pid, 'deal', plan.deals, async (rows) => {
      const inserted = await db
        .insertInto('deal')
        .values(
          rows.map(({ id, item }) => {
            const stageId = stageIds.get(item.pipelineCode)?.[item.stageIndex]
            const pipelineId = pipelineIds.get(item.pipelineCode)
            if (!stageId || !pipelineId) {
              throw new Error(`нет этапа ${item.stageIndex} воронки ${item.pipelineCode}`)
            }
            const reasonId =
              item.lostReasonIndex === null ? null : reasons[item.lostReasonIndex]?.id
            if (reasonId === undefined) throw new Error(`нет причины ${item.lostReasonIndex}`)
            const ownerId = item.ownerKey === null ? null : userId(item.ownerKey)
            return {
              id,
              project_id: pid,
              title: item.title,
              pipeline_id: pipelineId,
              stage_id: stageId,
              status: item.status,
              lost_reason_id: reasonId,
              amount: item.amount,
              currency: item.currency,
              owner_id: ownerId,
              primary_contact_id: contactId(item.contactKey),
              organization_id: orgId(item.organizationKey),
              won_at: item.status === 'won' ? item.closedAt : null,
              lost_at: item.status === 'lost' ? item.closedAt : null,
              stage_changed_at: item.stageChangedAt,
              archived_at: item.archived ? item.stageChangedAt : null,
              created_at: item.createdAt,
              updated_at: item.stageChangedAt,
              created_by: ownerId ?? adminId,
            }
          }),
        )
        // «Одна открытая сделка у человека в воронке» (индекс deal_one_open_per_contact): если
        // у контакта уже есть открытая сделка, созданная руками, сделка плана не создаётся.
        .onConflict((oc) => oc.doNothing())
        .returning('id')
        .execute()
      const done = new Set(inserted.map((r) => r.id))
      const kept = rows.filter((r) => done.has(r.id))
      // Участники и строки товаров тоже помечены: --reset отличает их от добавленных руками.
      const participants = kept.flatMap(({ id, item }) =>
        item.participants.map((p, n) => ({
          key: `${item.key}/participant-${n + 1}`,
          values: {
            id: randomUUID(),
            project_id: pid,
            deal_id: id,
            contact_id: contactId(p.contactKey),
            role: p.role,
            created_by: adminId,
          },
        })),
      )
      if (participants.length > 0) {
        await db
          .insertInto('deal_participant')
          .values(participants.map((p) => p.values))
          .execute()
        await link(
          db,
          pid,
          'deal_participant',
          participants.map((p) => ({ id: p.values.id, key: p.key })),
        )
      }
      const lines = kept.flatMap(({ id, item }) =>
        item.lines.map((line, n) => {
          const productId = products.ids.get(line.productKey)
          if (!productId) throw new Error(`нет товара ${line.productKey}`)
          return {
            key: `${item.key}/line-${n + 1}`,
            values: {
              id: randomUUID(),
              project_id: pid,
              deal_id: id,
              product_id: productId,
              quantity: line.quantity,
              unit_price: line.unitPrice,
              created_by: adminId,
            },
          }
        }),
      )
      if (lines.length > 0) {
        await db
          .insertInto('deal_product')
          .values(lines.map((l) => l.values))
          .execute()
        await link(
          db,
          pid,
          'deal_product',
          lines.map((l) => ({ id: l.values.id, key: l.key })),
        )
      }
      return [...done]
    })

    return {
      products: products.created,
      organizations: organizations.created,
      contacts: contacts.created,
      deals: deals.created,
      skippedDeals: plan.deals.length - deals.ids.size,
    }
  })
}

export interface ResetOutcome {
  /** Проекты, удалённые целиком: в них не осталось записей, созданных не командой. */
  deletedProjects: string[]
  /** Проекты, где удалены только записи seed: в них есть записи, созданные руками. */
  keptProjects: string[]
  deleted: Record<'products' | 'organizations' | 'contacts' | 'deals', number>
  /** Записи seed, оставленные потому, что на них ссылаются записи, созданные руками. */
  kept: Record<'deal' | 'contact' | 'organization' | 'product', number>
}

/**
 * Удаляет помеченные записи seed. Запись seed, на которую ссылается запись, созданная руками
 * (сделка, контакт, строка товара, участник сделки, заметка, файл), остаётся: каскад не уносит
 * ручное. Проект seed удаляется целиком, только если в нём не осталось ничего созданного не
 * командой — иначе остаются проект, его настройка, участники и команды.
 */
export async function resetProjects(serviceDb: Db): Promise<ResetOutcome> {
  const projects = await serviceDb
    .selectFrom('external_link as l')
    .innerJoin('project as p', 'p.id', 'l.project_id')
    .select(['p.id', 'p.name', 'p.code'])
    .distinct()
    .where('l.source', '=', SEED_SOURCE)
    .execute()
  const outcome: ResetOutcome = {
    deletedProjects: [],
    keptProjects: [],
    deleted: { products: 0, organizations: 0, contacts: 0, deals: 0 },
    kept: { deal: 0, contact: 0, organization: 0, product: 0 },
  }
  for (const project of projects) {
    await serviceDb.transaction().execute(async (db) => {
      const pid = project.id
      /** Строка `column` таблицы `table` помечена ссылкой seed. */
      const marked = (
        table: SeedTable,
        column: string,
      ) => sql<SqlBool>`${sql.raw(column)}::text in (
        select l.entity_id from external_link l
        where l.project_id = ${pid} and l.source = ${SEED_SOURCE} and l.entity_type = ${table}
      )`
      /** Строк, на которые ссылаются записи, созданные не командой: заметки, файлы, чужие строки. */
      const notes = (column: string, alias: string) => sql`
        not exists (select 1 from note n where n.${sql.raw(column)} = ${sql.raw(alias)}.id)
        and not exists (select 1 from file f where f.${sql.raw(column)} = ${sql.raw(alias)}.id)`
      const ids = (rows: { id: string }[]) => rows.map((r) => r.id)

      // Сделка seed остаётся, если к ней руками добавили заметку, файл, строку товара или
      // участника: иначе они ушли бы каскадом вместе со сделкой.
      const deals = await sql<{ id: string }>`
        delete from deal d
        where d.project_id = ${pid} and ${marked('deal', 'd.id')} and ${notes('deal_id', 'd')}
          and not exists (
            select 1 from deal_product x where x.deal_id = d.id and not ${marked('deal_product', 'x.id')}
          )
          and not exists (
            select 1 from deal_participant x
            where x.deal_id = d.id and not ${marked('deal_participant', 'x.id')}
          )
        returning d.id
      `.execute(db)
      const contacts = await sql<{ id: string }>`
        delete from contact c
        where c.project_id = ${pid} and ${marked('contact', 'c.id')} and ${notes('contact_id', 'c')}
          and not exists (select 1 from deal d where d.primary_contact_id = c.id)
          and not exists (select 1 from deal_participant p where p.contact_id = c.id)
        returning c.id
      `.execute(db)
      const organizations = await sql<{ id: string }>`
        delete from organization o
        where o.project_id = ${pid} and ${marked('organization', 'o.id')}
          and ${notes('organization_id', 'o')}
          and not exists (select 1 from deal d where d.organization_id = o.id)
          and not exists (select 1 from contact c where c.organization_id = o.id)
        returning o.id
      `.execute(db)
      const products = await sql<{ id: string }>`
        delete from product p
        where p.project_id = ${pid} and ${marked('product', 'p.id')}
          and not exists (select 1 from deal_product x where x.product_id = p.id)
        returning p.id
      `.execute(db)
      // История изменений, если записи seed меняли через API, уходит вместе с записями.
      const goneIds = [...ids(deals.rows), ...ids(contacts.rows), ...ids(organizations.rows)]
      if (goneIds.length > 0) {
        await db
          .deleteFrom('change_log')
          .where('project_id', '=', pid)
          .where('entity_id', 'in', goneIds)
          .execute()
      }
      // Ссылки на удалённые записи (и на строки и участников, ушедших каскадом со сделками).
      for (const table of RESET_TABLES) {
        await sql`
          delete from external_link l
          where l.project_id = ${pid} and l.source = ${SEED_SOURCE} and l.entity_type = ${table}
            and not exists (select 1 from ${sql.table(table)} t where t.id::text = l.entity_id)
        `.execute(db)
      }
      outcome.deleted.deals += deals.rows.length
      outcome.deleted.contacts += contacts.rows.length
      outcome.deleted.organizations += organizations.rows.length
      outcome.deleted.products += products.rows.length
      for (const table of ['deal', 'contact', 'organization', 'product'] as const) {
        const { rows } = await sql<{ n: number }>`
          select count(*)::int as n from external_link l
          where l.project_id = ${pid} and l.source = ${SEED_SOURCE} and l.entity_type = ${table}
        `.execute(db)
        outcome.kept[table] += rows[0]?.n ?? 0
      }

      if (await hasHandMadeData(db, pid)) {
        outcome.keptProjects.push(project.name)
      } else {
        await db.deleteFrom('project').where('id', '=', pid).execute()
        outcome.deletedProjects.push(project.name)
      }
    })
  }
  return outcome
}

/**
 * Есть ли в проекте записи, созданные не командой seed: сделки, контакты, организации, товары,
 * заметки, файлы, массовые операции; участники проекта, команды, строки товаров и участники
 * сделок без пометки seed; свои роли и воронки
 * не из стартовой настройки. Сам проект seed помечен ссылкой только тогда, когда его создал seed.
 */
async function hasHandMadeData(db: Trx, pid: string): Promise<boolean> {
  const projectLink = await db
    .selectFrom('external_link')
    .select('id')
    .where('project_id', '=', pid)
    .where('source', '=', SEED_SOURCE)
    .where('entity_type', '=', 'project')
    .executeTakeFirst()
  if (!projectLink) return true
  const presetCodes = Object.values(PROJECT_PRESETS).flatMap((p) => p.pipelines.map((x) => x.code))
  const unmarked = (table: 'project_member' | 'team' | 'deal_product' | 'deal_participant') => sql`
    exists (select 1 from ${sql.table(table)} t where t.project_id = ${pid} and not exists (
      select 1 from external_link l
      where l.project_id = ${pid} and l.source = ${SEED_SOURCE} and l.entity_type = ${table}
        and l.entity_id = t.id::text
    ))`
  const { found } = await sql<{ found: boolean }>`
    select (
      exists (select 1 from deal where project_id = ${pid})
      or exists (select 1 from contact where project_id = ${pid})
      or exists (select 1 from organization where project_id = ${pid})
      or exists (select 1 from product where project_id = ${pid})
      or exists (select 1 from note where project_id = ${pid})
      or exists (select 1 from file where project_id = ${pid})
      or exists (select 1 from bulk_job where project_id = ${pid})
      or exists (select 1 from role where project_id = ${pid} and template_key is null)
      or exists (
        select 1 from pipeline where project_id = ${pid} and not (code = any(${presetCodes}::text[]))
      )
      or ${unmarked('project_member')}
      or ${unmarked('team')}
      or ${unmarked('deal_product')}
      or ${unmarked('deal_participant')}
    ) as found
  `
    .execute(db)
    .then((r) => r.rows[0] ?? { found: true })
  return found
}
