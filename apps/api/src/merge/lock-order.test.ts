import { randomInt } from 'node:crypto'
import { withProject } from '@alpi/db'
import { type RawBuilder, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ContactView } from '../contacts/contacts.ts'
import type { DealView } from '../deals/store.ts'
import {
  type ApiHarness,
  type Method,
  type SignedInUser,
  startApiHarness,
} from '../testing/api-harness.ts'
import { problemOf } from '../testing/problem.ts'
import { CONTACT_PURGER } from '../trash/purgers.ts'
import type { DealMergeResult } from './deal-core.ts'

// Порядок блокировок слияния (тикет crm-intake/12) на настоящем PostgreSQL. Слияние и откат
// контактов держат контакты FOR UPDATE и потом пишут в их сделки и заметки; пути, которые брали
// сделку или заметку раньше контакта, сцеплялись с ними (40P01) — одна транзакция откатывалась,
// API отвечал 500. Каждая проверка ставит запросы в тот порядок, в котором прежний код
// сцеплялся: служебная транзакция держит строку, на которой первый запрос встаёт, уже взяв свои
// блокировки, — остальные успевают взять свои. Имена и телефоны — вымышленные.

const fakePhone = () => `+38067${randomInt(1_000_000, 9_999_999)}`

describe('порядок блокировок слияния', () => {
  let h: ApiHarness
  let admin: SignedInUser
  let project: string
  let counter = 0

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_merge_locks')
    admin = await h.signIn('owner')
    project = (await h.createProject(admin, 'Злиття блокування')).id
  })

  afterAll(async () => {
    await h?.stop()
  })

  const call = (method: Method, path: string, body?: unknown) =>
    admin.api(method, path, { project, ...(body === undefined ? {} : { body }) })

  async function json<T>(res: Response, status = 200): Promise<T> {
    const body = await res.json().catch(() => null)
    expect(res.status, JSON.stringify(body)).toBe(status)
    return body as T
  }

  const createContact = async (name: string) =>
    json<ContactView>(
      await call('POST', '/v1/contacts', { firstName: name, phones: [fakePhone()] }),
      201,
    )

  async function pipeline(): Promise<string> {
    counter += 1
    const { id } = await h.owner
      .insertInto('pipeline')
      .values({
        project_id: project,
        code: `l${counter}`,
        name: `Воронка ${counter}`,
        position: counter,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await h.owner
      .insertInto('stage')
      .values({ project_id: project, pipeline_id: id, name: 'Новий', position: 1 })
      .execute()
    return id
  }

  const createDeal = async (contactId: string, title: string) =>
    json<DealView>(
      await call('POST', '/v1/deals', { title, pipelineId: await pipeline(), contactId }),
      201,
    )

  const mergeDeals = async (survivorId: string, mergedId: string) =>
    json<DealMergeResult>(
      await call('POST', `/v1/deals/${survivorId}/merge`, { merge_deal_id: mergedId }),
    )

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

  it('слияние контактов одновременно с правкой заметки, добавлением участника и откатом слияния сделок того же человека — без 500', async () => {
    const survivor = await createContact('Залишиться')
    const merged = await createContact('Злитий')
    const note = await json<{ id: string }>(
      await call('POST', `/v1/contacts/${merged.id}/notes`, { text: 'Було' }),
      201,
    )
    // Сделки второго контакта: две слиты одна в другую (откат — ниже), к третьей добавляют
    // участником оставшегося. Слияние контактов переносит все три.
    const kept = await createDeal(merged.id, 'Залишиться')
    const hidden = await createDeal(merged.id, 'Злита')
    const dealMerge = await mergeDeals(kept.id, hidden.id)
    const third = await createDeal(merged.id, 'Третя')

    // Слияние встаёт на переносе телефона второго контакта, уже держа оба контакта.
    const held = await holdLock(
      sql`select id from contact_phone where contact_id = ${merged.id} for update`,
    )
    const merging = call('POST', `/v1/contacts/${survivor.id}/merge`, {
      merge_contact_id: merged.id,
    })
    await waitForWaiters(1, 'слияние ждёт телефон')
    const editing = call('PATCH', `/v1/contacts/${merged.id}/notes/${note.id}`, { text: 'Стало' })
    const adding = call('POST', `/v1/deals/${third.id}/participants`, { contactId: survivor.id })
    const undoing = call('POST', `/v1/merges/${dealMerge.merge.id}/undo`)
    await waitForWaiters(4, 'заметка, участник и откат ждут контакт')
    await held.release()

    const [merge, edit, add, undo] = await Promise.all([merging, editing, adding, undoing])
    const statuses = [merge.status, edit.status, add.status, undo.status]
    expect(statuses, JSON.stringify(statuses)).not.toContain(500)
    await json(merge)
    // Заметка ждала слияния и потом не нашла скрытый контакт; сделка уже у оставшегося — он её
    // основной; откат слияния сделок прошёл после слияния контактов.
    expect(edit.status).toBe(404)
    expect(await problemOf(edit)).toEqual({ code: 'CONTACT_NOT_FOUND' })
    expect(add.status).toBe(409)
    expect(await problemOf(add)).toEqual({ code: 'CONTACT_IS_PRIMARY' })
    await json(undo)

    const note_ = await h.owner
      .selectFrom('note')
      .select(['contact_id', 'text'])
      .where('id', '=', note.id)
      .executeTakeFirstOrThrow()
    expect(note_).toEqual({ contact_id: survivor.id, text: 'Було' })
    const deals = await h.owner
      .selectFrom('deal')
      .select(['id', 'primary_contact_id', 'merged_into_id'])
      .where('id', 'in', [kept.id, hidden.id, third.id])
      .orderBy('id')
      .execute()
    expect(deals).toEqual(
      [kept.id, hidden.id, third.id].sort().map((id) => ({
        id,
        primary_contact_id: survivor.id,
        merged_into_id: null,
      })),
    )
  })

  it('откат слияния сделок одновременно с окончательным удалением оставшейся — без 500', async () => {
    const contact = await createContact('Видалення')
    const kept = await createDeal(contact.id, 'Залишиться')
    const hidden = await createDeal(contact.id, 'Злита')
    const dealMerge = await mergeDeals(kept.id, hidden.id)
    expect((await call('DELETE', `/v1/deals/${kept.id}`)).status).toBe(204)

    // Удаление встаёт на строке оставшейся; откат приходит следом.
    const held = await holdLock(sql`select id from deal where id = ${kept.id} for update`)
    const purging = call('DELETE', `/v1/deals/${kept.id}/permanent`)
    await waitForWaiters(1, 'удаление ждёт сделку')
    const undoing = call('POST', `/v1/merges/${dealMerge.merge.id}/undo`)
    await waitForWaiters(2, 'откат ждёт сделку')
    await held.release()

    const [purge, undo] = await Promise.all([purging, undoing])
    expect([purge.status, undo.status]).not.toContain(500)
    expect(purge.status).toBe(204)
    // Удаление стёрло обе сделки и запись их слияния: откатывать нечего.
    expect(undo.status).toBe(404)
    expect(await problemOf(undo)).toEqual({ code: 'MERGE_NOT_FOUND' })
    expect(
      await h.owner
        .selectFrom('deal')
        .select('id')
        .where('id', 'in', [kept.id, hidden.id])
        .execute(),
    ).toEqual([])
  })

  it('фоновая очистка корзины одновременно с окончательным удалением того же контакта вручную — без 500', async () => {
    // Скрытая сделка контакта (слита в сделку другого) — очистка блокирует её вместе с ним.
    const owner = await createContact('Інший')
    const contact = await createContact('Кошик')
    const survivorDeal = await createDeal(owner.id, 'Залишиться')
    const hiddenDeal = await createDeal(contact.id, 'Злита')
    await mergeDeals(survivorDeal.id, hiddenDeal.id)
    expect((await call('DELETE', `/v1/contacts/${contact.id}`)).status).toBe(204)

    // Очистка встаёт на скрытой сделке; ручное удаление приходит следом.
    const held = await holdLock(sql`select id from deal where id = ${hiddenDeal.id} for update`)
    const purging = withProject(h.appDb, project, (trx) =>
      CONTACT_PURGER.purgeExpired(trx, new Date(Date.now() + 86_400_000)),
    ).then(
      (count) => ({ count, error: null }),
      (error: unknown) => ({ count: null, error }),
    )
    await waitForWaiters(1, 'очистка ждёт скрытую сделку')
    const manual = call('DELETE', `/v1/contacts/${contact.id}/permanent`)
    await waitForWaiters(2, 'ручное удаление ждёт контакт')
    await held.release()

    const [background, res] = await Promise.all([purging, manual])
    expect(background.error).toBeNull()
    expect(background.count).toBeGreaterThanOrEqual(1)
    // Контакт стёрла очистка; ручное удаление его уже не нашло.
    expect(res.status).toBe(404)
    expect(await problemOf(res)).toEqual({ code: 'CONTACT_NOT_FOUND' })
    expect(
      await h.owner.selectFrom('contact').select('id').where('id', '=', contact.id).execute(),
    ).toEqual([])
    expect(
      await h.owner.selectFrom('deal').select('id').where('id', '=', hiddenDeal.id).execute(),
    ).toEqual([])
  })

  it('взаимоблокировка, которую порядок не покрыл, — 409 MERGE_RETRY без изменений, а не 500', async () => {
    const survivor = await createContact('Повтор')
    const merged = await createContact('Повтор злитий')
    const deal = await createDeal(merged.id, 'Угода')
    // Служебная транзакция держит сделку второго контакта, а когда слияние (уже с обоими
    // контактами) встанет на ней, просит оставшийся контакт — цикл. Её собственная проверка
    // взаимоблокировок — через минуту: жертвой база выбирает слияние.
    let resume = () => {}
    const resumed = new Promise<void>((resolve) => {
      resume = resolve
    })
    let locked = () => {}
    const dealLocked = new Promise<void>((resolve) => {
      locked = resolve
    })
    const service = h.owner.transaction().execute(async (trx) => {
      await sql`set local deadlock_timeout = '60s'`.execute(trx)
      await sql`select id from deal where id = ${deal.id} for update`.execute(trx)
      locked()
      await resumed
      await sql`select id from contact where id = ${survivor.id} for share`.execute(trx)
    })
    await dealLocked
    const merging = call('POST', `/v1/contacts/${survivor.id}/merge`, {
      merge_contact_id: merged.id,
    })
    await waitForWaiters(1, 'слияние ждёт сделку')
    resume()
    const res = await merging
    await service
    expect(res.status).toBe(409)
    expect(await problemOf(res)).toEqual({ code: 'MERGE_RETRY' })
    const row = await h.owner
      .selectFrom('contact')
      .select('merged_into_id')
      .where('id', '=', merged.id)
      .executeTakeFirstOrThrow()
    expect(row.merged_into_id).toBeNull()
    expect(
      await h.owner
        .selectFrom('merge_record')
        .select('id')
        .where('merged_id', '=', merged.id)
        .execute(),
    ).toEqual([])
    // Повтор проходит.
    await json(
      await call('POST', `/v1/contacts/${survivor.id}/merge`, { merge_contact_id: merged.id }),
    )
  })
})
