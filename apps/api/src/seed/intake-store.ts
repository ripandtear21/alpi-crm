import { type Database, withProject } from '@alpi/db'
import type { RegistrationAccepted } from '@alpi/shared'
import { type Kysely, sql } from 'kysely'
import { syncDuplicatePairs } from '../duplicates/finder.ts'
import type { IntakeSource } from '../intake/auth.ts'
import { handleRegistration } from '../intake/journal.ts'
import { hashIntakeKey, issueIntakeKey } from '../intake/key.ts'
import { handleWebinarView } from '../intake/webinar.ts'
import { mergeContacts } from '../merge/contacts.ts'
import type { MergeContext } from '../merge/store.ts'
import { loadMemberAccess } from '../roles/access.ts'
import { PROJECT_TEAMS, resolveViewer } from '../roles/scope.ts'
import type { PlannedMerge } from './intake-plan.ts'
import type { ProjectPlan } from './plan.ts'
import { ensure, findSeedProject, link, seededIds, type Trx } from './store.ts'
import type { SourceKey } from './users.ts'

// Запись данных приёма pnpm seed (тикет crm-intake/10) после людей и сделок проекта (store.ts):
//
// - Источники — напрямую, с ключом из issueIntakeKey; ключ уходит только в файл учётных данных.
//   Источник, чей ключ в файле потерян, получает новый ключ (в базе — только отпечаток).
// - Регистрации сделок плана — напрямую порциями, с событием приёма (intake_event) и
//   просмотром: их тысячи, а функция приёма на каждую тратит десятки запросов и не умеет
//   привязать регистрацию к уже закрытой сделке. Правила базы (сделка и контакт своего проекта,
//   единственность event_id) проверяются при вставке.
// - Журнал входящих — функциями приёма (handleRegistration, handleWebinarView), как запрос
//   источника: те же разбор, поиск контакта, сделка, события и строка журнала. Ответ сверяется
//   с ожидаемым; время получения затем сдвигается в прошлое (последние 30 дней).
// - Слияния — функцией слияния контактов (mergeContacts) от имени администратора seed; старое —
//   сдвигается на 40 дней назад, его откат уже недоступен.
// - Отметки «не дубль» — напрямую; в конце — проход надсмотрщика по проекту, чтобы «Дублі» и
//   счётчик в шапке сразу были не пустыми.
// Повторный запуск досоздаёт недостающее: источники, строки журнала, слияния и созданные
// приёмом контакты и сделки помечены ссылкой seed, регистрации — уникальным event_id.
//
// Функции приложения (приём, слияние, надсмотрщик) работают подключением ролью приложения
// (`appDb`, как API): изоляцию проектов в них держит row-level security, а на служебную роль —
// владельца таблиц — политики не действуют, и поиск контакта или пар дублей видел бы чужой
// проект. Прямые вставки, пометки seed и сдвиг времени в прошлое — служебной ролью (`serviceDb`):
// у роли приложения нет прав менять время получения, слияния и создания.

/** Строк за один INSERT регистраций: ~30 параметров на строку, предел PostgreSQL — 65 535. */
const CHUNK = 1000

export interface IntakeCounts {
  sources: number
  registrations: number
  inbound: number
  merges: number
  /** Пар дублей в проекте после прохода надсмотрщика. */
  pairs: number
}

/**
 * Пишет данные приёма проекта `plan` (проект уже создан writeProject). `knownKeys` — ключи
 * источников из файла учётных данных; возвращает ключи всех источников seed проекта.
 */
export async function writeIntake(
  serviceDb: Kysely<Database>,
  appDb: Kysely<Database>,
  plan: ProjectPlan,
  adminId: string,
  knownKeys: readonly SourceKey[],
): Promise<{ counts: IntakeCounts; keys: SourceKey[] }> {
  const pid = await findSeedProject(serviceDb, plan.code)
  if (!pid) throw new Error(`проект ${plan.code} не создан`)
  const { sources, keys, created } = await serviceDb
    .transaction()
    .execute((trx) => writeSources(trx, pid, plan, adminId, knownKeys))
  const registrations = await serviceDb
    .transaction()
    .execute((trx) => writeRegistrations(trx, pid, plan, sources))
  let merges = 0
  for (const merge of plan.intake.merges) {
    if (await writeMerge(serviceDb, appDb, pid, adminId, merge)) merges++
  }
  const inbound = await writeJournal(serviceDb, appDb, pid, plan, sources)
  await serviceDb.transaction().execute(async (trx) => {
    const contacts = await seededIds(trx, pid, 'contact')
    for (const pair of plan.intake.notDuplicates) {
      // Пара — в порядке id, как у надсмотрщика (check a_id < b_id).
      const [aId, bId] = [contacts.get(pair.aKey), contacts.get(pair.bKey)].sort()
      if (!aId || !bId) continue
      await trx
        .insertInto('not_duplicate')
        .values({
          project_id: pid,
          entity_type: 'contact',
          a_id: aId,
          b_id: bId,
          marked_by: adminId,
        })
        .onConflict((oc) => oc.doNothing())
        .execute()
    }
  })
  // Надсмотрщик: тот же пересчёт пар проекта, что ночной проход.
  await withProject(appDb, pid, (trx) => syncDuplicatePairs(trx, pid, null))
  const { n } = await serviceDb
    .selectFrom('duplicate_pair')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('project_id', '=', pid)
    .executeTakeFirstOrThrow()
  const pairs = Number(n)
  return { counts: { sources: created, registrations, inbound, merges, pairs }, keys }
}

async function writeSources(
  trx: Trx,
  pid: string,
  plan: ProjectPlan,
  adminId: string,
  knownKeys: readonly SourceKey[],
) {
  const pipelines = new Map(
    (
      await trx
        .selectFrom('pipeline')
        .select(['id', 'code'])
        .where('project_id', '=', pid)
        .execute()
    ).map((p) => [p.code, p.id]),
  )
  const pipelineOf = (code: string) => {
    const id = pipelines.get(code)
    if (!id) throw new Error(`нет воронки ${code}`)
    return id
  }
  const keys: SourceKey[] = []
  const ensured = await ensure(trx, pid, 'intake_source', plan.intake.sources, async (rows) => {
    const issued = rows.map((row) => ({ ...row, issued: issueIntakeKey() }))
    const inserted = await trx
      .insertInto('intake_source')
      .values(
        issued.map(({ id, item, issued }) => ({
          id,
          project_id: pid,
          name: item.name,
          pipeline_id: pipelineOf(item.pipelineCode),
          key_hash: issued.hash,
          key_prefix: issued.shownPrefix,
          created_by: adminId,
          disabled_at: item.disabledAt,
          disabled_by: item.disabledAt === null ? null : adminId,
        })),
      )
      // Источник с тем же названием, созданный руками, остаётся; источник плана не создаётся.
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .execute()
    const done = new Set(inserted.map((r) => r.id))
    for (const { id, item, issued: key } of issued) {
      if (done.has(id))
        keys.push({ project: plan.code, name: item.name, sourceId: id, key: key.key })
    }
    return [...done]
  })

  // Источники прошлых запусков: ключ из файла, если он подходит; иначе — новый ключ.
  const issuedNow = new Set(keys.map((k) => k.sourceId))
  for (const item of plan.intake.sources) {
    const id = ensured.ids.get(item.key)
    if (!id || issuedNow.has(id)) continue
    const { rows } = await sql<{ key_hash: string }>`
      select key_hash from intake_source where id = ${id}
    `.execute(trx)
    const known = knownKeys.find(
      (k) => k.sourceId === id && hashIntakeKey(k.key) === rows[0]?.key_hash,
    )
    if (known) {
      keys.push(known)
      continue
    }
    const issued = issueIntakeKey()
    await trx
      .updateTable('intake_source')
      .set({ key_hash: issued.hash, key_prefix: issued.shownPrefix })
      .where('id', '=', id)
      .execute()
    keys.push({ project: plan.code, name: item.name, sourceId: id, key: issued.key })
  }

  const sources = new Map<string, IntakeSource>()
  for (const item of plan.intake.sources) {
    const id = ensured.ids.get(item.key)
    if (id) sources.set(item.key, { id, projectId: pid, pipelineId: pipelineOf(item.pipelineCode) })
  }
  return { sources, keys, created: ensured.created }
}

/** Регистрации сделок плана, их события приёма и просмотры; возвращает число созданных. */
async function writeRegistrations(
  trx: Trx,
  pid: string,
  plan: ProjectPlan,
  sources: Map<string, IntakeSource>,
): Promise<number> {
  const dealIds = await seededIds(trx, pid, 'deal')
  const contactOf = new Map(
    (
      await trx
        .selectFrom('deal')
        .select(['id', 'primary_contact_id'])
        .where('project_id', '=', pid)
        .execute()
    ).map((d) => [d.id, d.primary_contact_id]),
  )
  const planned = plan.intake.registrations.flatMap((reg) => {
    const dealId = dealIds.get(reg.dealKey)
    const source = sources.get(reg.sourceKey)
    const contactId = dealId === undefined ? undefined : contactOf.get(dealId)
    if (!dealId || !source || !contactId) return []
    return [{ reg, sourceId: source.id, dealId, contactId }]
  })
  let created = 0
  for (let i = 0; i < planned.length; i += CHUNK) {
    const chunk = planned.slice(i, i + CHUNK)
    const inserted = await trx
      .insertInto('registration')
      .values(
        chunk.map(({ reg, sourceId, dealId, contactId }) => ({
          project_id: pid,
          intake_source_id: sourceId,
          event_id: reg.eventId,
          contact_id: contactId,
          deal_id: dealId,
          created_at: reg.registeredAt,
          ...reg.text,
          phone: reg.phone,
          phone_raw: reg.phoneRaw,
          email: reg.email,
          registered_at: reg.registeredAt,
          extra: JSON.stringify(reg.extra),
        })),
      )
      .onConflict((oc) => oc.columns(['project_id', 'intake_source_id', 'event_id']).doNothing())
      .returning(['id', 'intake_source_id', 'event_id', 'created_at'])
      .execute()
    if (inserted.length === 0) continue
    created += inserted.length
    await trx
      .insertInto('intake_event')
      .values(
        inserted.map((r) => ({
          project_id: pid,
          intake_source_id: r.intake_source_id,
          kind: 'registration',
          event_id: r.event_id,
          registration_id: r.id,
          created_at: r.created_at,
        })),
      )
      .onConflict((oc) =>
        oc.columns(['project_id', 'intake_source_id', 'kind', 'event_id']).doNothing(),
      )
      .execute()
    const byEvent = new Map(chunk.map(({ reg, sourceId }) => [`${sourceId}/${reg.eventId}`, reg]))
    const viewed = inserted.flatMap((r) => {
      const view = byEvent.get(`${r.intake_source_id}/${r.event_id}`)?.view
      return view ? [{ id: r.id, ...view }] : []
    })
    if (viewed.length > 0) {
      await sql`
        update registration r
        set view_started_at = v.started_at, view_finished_at = v.finished_at,
          view_minutes = v.minutes, view_updated_at = v.finished_at
        from (values ${sql.join(
          viewed.map(
            (v) =>
              sql`(${v.id}::uuid, ${v.startedAt}::timestamptz, ${v.finishedAt}::timestamptz, ${v.minutes}::int)`,
          ),
        )}) as v (id, started_at, finished_at, minutes)
        where r.id = v.id
      `.execute(trx)
    }
  }
  return created
}

/** Контекст слияния от имени администратора seed — как у маршрута слияния (mergeContext). */
async function adminMergeContext(trx: Trx, pid: string, adminId: string): Promise<MergeContext> {
  const access = await loadMemberAccess(trx, adminId)
  if (!access) throw new Error('администратор seed не участник проекта')
  return {
    db: trx,
    projectId: pid,
    actorId: adminId,
    actorApiKeyId: null,
    ip: null,
    permissions: access.permissions,
    viewer: await resolveViewer(trx, adminId, PROJECT_TEAMS),
    scope: access.permissions.scopes.contacts,
  }
}

/**
 * Слияние плана; false — уже сделано прошлым запуском или контакта нет. Слияние — функцией
 * приложения ролью приложения; пометка и сдвиг времени — следующей транзакцией служебной ролью.
 * Если запуск оборвался между ними, повторный находит слияние по паре и только помечает его.
 */
async function writeMerge(
  serviceDb: Kysely<Database>,
  appDb: Kysely<Database>,
  pid: string,
  adminId: string,
  merge: PlannedMerge,
): Promise<boolean> {
  const found = await serviceDb.transaction().execute(async (trx) => {
    if ((await seededIds(trx, pid, 'merge_record')).has(merge.key)) return null
    const contacts = await seededIds(trx, pid, 'contact')
    const survivorId = contacts.get(merge.survivorKey)
    const mergedId = contacts.get(merge.mergedKey)
    if (!survivorId || !mergedId) return null
    const earlier = await trx
      .selectFrom('merge_record')
      .select('id')
      .where('project_id', '=', pid)
      .where('entity_type', '=', 'contact')
      .where('survivor_id', '=', survivorId)
      .where('merged_id', '=', mergedId)
      .where('undone_at', 'is', null)
      .executeTakeFirst()
    return { survivorId, mergedId, earlierId: earlier?.id ?? null }
  })
  if (!found) return false
  let mergeId = found.earlierId
  if (mergeId === null) {
    const result = await withProject(appDb, pid, async (trx) =>
      mergeContacts(await adminMergeContext(trx, pid, adminId), found.survivorId, {
        mergedId: found.mergedId,
        keepDealIds: [],
      }),
    )
    if (!result.ok) throw new Error(`слияние ${merge.key}: отказ ${result.code}`)
    mergeId = result.value.merge.id
  }
  const id = mergeId
  await serviceDb.transaction().execute(async (trx) => {
    if (merge.ageDays > 0) {
      // Старое слияние: время слияния и срок отката — в прошлом, вместе с вложенными слияниями
      // сделок и отметкой скрытых записей.
      const shift = sql`make_interval(days => ${merge.ageDays})`
      await sql`
        update deal set merged_at = merged_at - ${shift}
        where id in (select merged_id from merge_record where parent_id = ${id})
      `.execute(trx)
      await sql`
        update merge_record set merged_at = merged_at - ${shift}, undo_until = undo_until - ${shift}
        where id = ${id} or parent_id = ${id}
      `.execute(trx)
      await sql`
        update contact set merged_at = merged_at - ${shift} where id = ${found.mergedId}
      `.execute(trx)
    }
    await link(trx, pid, 'merge_record', [{ id, key: merge.key }])
  })
  return true
}

/** Журнал входящих: запросы плана через функции приёма; возвращает число новых строк. */
async function writeJournal(
  serviceDb: Kysely<Database>,
  appDb: Kysely<Database>,
  pid: string,
  plan: ProjectPlan,
  sources: Map<string, IntakeSource>,
): Promise<number> {
  const done = await serviceDb
    .transaction()
    .execute((trx) => seededIds(trx, pid, 'inbound_request'))
  let created = 0
  for (const entry of plan.intake.inbound) {
    const source = sources.get(entry.sourceKey)
    if (done.has(entry.key) || !source) continue
    const raw = JSON.stringify(entry.body)
    const answer =
      entry.channel === 'registration'
        ? await handleRegistration(appDb, source, raw)
        : await handleWebinarView(appDb, source, raw)
    if (answer.status !== entry.expected.status || answer.outcome !== entry.expected.outcome) {
      throw new Error(
        `запрос журнала ${entry.key}: ответ ${answer.status} ${answer.outcome}, ожидался ${entry.expected.status} ${entry.expected.outcome}`,
      )
    }
    const at = entry.receivedAt
    await serviceDb.transaction().execute(async (trx) => {
      await sql`update inbound_request set received_at = ${at} where id = ${answer.journalId}`.execute(
        trx,
      )
      await link(trx, pid, 'inbound_request', [{ id: answer.journalId, key: entry.key }])
      if (entry.channel !== 'registration' || answer.outcome !== 'accepted') return
      // Созданное приёмом помечено как seed (--reset его удаляет) и получено тогда же, когда запрос.
      const body = answer.body as RegistrationAccepted
      await sql`update registration set created_at = ${at} where id = ${body.registration_id}`.execute(
        trx,
      )
      if (body.contact_created && body.contact_id !== null) {
        await link(trx, pid, 'contact', [{ id: body.contact_id, key: `${entry.key}/contact` }])
        await sql`
          update contact set created_at = ${at}, updated_at = ${at} where id = ${body.contact_id}
        `.execute(trx)
      }
      if (body.deal_created && body.deal_id !== null) {
        await link(trx, pid, 'deal', [{ id: body.deal_id, key: `${entry.key}/deal` }])
        await sql`
          update deal set created_at = ${at}, updated_at = ${at}, stage_changed_at = ${at}
          where id = ${body.deal_id}
        `.execute(trx)
      }
    })
    created++
  }
  await sql`
      update intake_source s
      set last_used_at = (select max(i.received_at) from inbound_request i where i.intake_source_id = s.id)
      where s.project_id = ${pid} and s.disabled_at is null
        and exists (select 1 from inbound_request i where i.intake_source_id = s.id)
    `.execute(serviceDb)
  return created
}
