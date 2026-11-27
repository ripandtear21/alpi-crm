import { randomInt } from 'node:crypto'
import type { IntakeSourceWithKey, RegistrationAccepted, WebinarViewAccepted } from '@alpi/shared'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type ApiHarness,
  ORIGIN,
  type SignedInUser,
  startApiHarness,
} from '../testing/api-harness.ts'
import { createApiKey, createRole } from '../testing/api-key.ts'
import { problemOf } from '../testing/problem.ts'
import { replayInbound } from './replay.ts'

// Просмотры вебинара (тикет crm-intake/08) на настоящем PostgreSQL: API ходит ролью приложения,
// проверки — служебным подключением. Источник шлёт запрос с одним заголовком Authorization, как
// внешний сервис. Имена, телефоны и email — выдуманные.

const fakePhone = () => `+38063${randomInt(1_000_000, 9_999_999)}`
let counter = 0
const fakeEmail = () => `view-${++counter}-${randomInt(1e9)}@example.test`
const eventId = () => `view-${++counter}-${randomInt(1e9)}`
const webinarName = () => `Вебінар ${++counter}`

describe('просмотры вебинара', () => {
  let h: ApiHarness
  let admin: SignedInUser
  let projectA: string
  let projectB: string
  let pipelineA: string
  let pipelineB: string
  let source: IntakeSourceWithKey
  let sourceB: IntakeSourceWithKey

  function post(path: string, body: unknown, key: string | null) {
    const headers = new Headers({ origin: ORIGIN, 'content-type': 'application/json' })
    if (key !== null) headers.set('authorization', `Bearer ${key}`)
    return h.app.request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  }

  const view = (body: unknown, key: string | null = source.key) =>
    post('/intake/webinar-views', body, key)

  async function viewed(res: Response): Promise<WebinarViewAccepted> {
    const body = await res.json()
    expect(res.status, JSON.stringify(body)).toBe(200)
    return body as WebinarViewAccepted
  }

  async function register(body: Record<string, unknown>, key = source.key) {
    const res = await post('/intake/registrations', { event_id: eventId(), ...body }, key)
    const answer = await res.json()
    expect(res.status, JSON.stringify(answer)).toBe(201)
    return answer as RegistrationAccepted
  }

  async function createPipeline(projectId: string) {
    const n = ++counter
    const { id } = await h.owner
      .insertInto('pipeline')
      .values({ project_id: projectId, code: `view${n}`, name: `Воронка ${n}`, position: 100 + n })
      .returning('id')
      .executeTakeFirstOrThrow()
    await h.owner
      .insertInto('stage')
      .values({ project_id: projectId, pipeline_id: id, name: 'Новий', position: 1 })
      .execute()
    return id
  }

  async function createSource(projectId = projectA, pipelineId = pipelineA) {
    const res = await admin.api('POST', '/v1/intake-sources', {
      project: projectId,
      body: { name: `Вебінари ${++counter}`, pipelineId },
    })
    expect(res.status).toBe(201)
    return (await res.json()) as IntakeSourceWithKey
  }

  const viewOf = (id: string) =>
    h.owner
      .selectFrom('registration')
      .select([
        'view_started_at',
        'view_finished_at',
        'view_minutes',
        'view_extra',
        'view_updated_at',
      ])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()

  const journalOf = (sourceId: string, eventIdValue: string) =>
    h.owner
      .selectFrom('inbound_request')
      .select(['channel', 'outcome', 'status_code', 'error_code', 'result', 'replay_of'])
      .where('intake_source_id', '=', sourceId)
      .where('event_id', '=', eventIdValue)
      .orderBy('received_at')
      .orderBy('id')
      .execute()

  const historyOf = (registrationId: string) =>
    h.owner
      .selectFrom('change_log')
      .select(['field', 'before', 'after', 'actor_id', 'actor_intake_source_id'])
      .where('entity_type', '=', 'registration')
      .where('entity_id', '=', registrationId)
      .orderBy('occurred_at')
      .orderBy('field')
      .execute()

  const countOf = async (table: 'contact' | 'registration' | 'deal') =>
    Number(
      (
        await h.owner
          .selectFrom(table)
          .select(sql<string>`count(*)`.as('n'))
          .executeTakeFirstOrThrow()
      ).n,
    )

  /** Момент «после всего, что уже пришло» по часам базы, с точностью API (миллисекунды). */
  async function databaseMoment(): Promise<string> {
    const { rows } = await sql<{ t: Date }>`
      select date_trunc('milliseconds', clock_timestamp()) + interval '1 millisecond' as t,
        pg_sleep(0.002)
    `.execute(h.owner)
    return new Date(rows[0]?.t ?? '').toISOString()
  }

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_webinar_views')
    admin = await h.signIn('owner')
    projectA = (await h.createProject(admin, 'Перегляди А')).id
    projectB = (await h.createProject(admin, 'Перегляди Б')).id
    pipelineA = await createPipeline(projectA)
    pipelineB = await createPipeline(projectB)
    source = await createSource()
    sourceB = await createSource(projectB, pipelineB)
  })

  afterAll(async () => {
    await h?.stop()
  })

  describe('запись в регистрацию', () => {
    it('по телефону — в последнюю регистрацию контакта на этот вебинар, не в регистрацию на другой; второй просмотр заменяет значения; история — с автором-источником', async () => {
      const phone = fakePhone()
      const webinar = webinarName()
      const older = await register({ phone, webinar })
      const latest = await register({ phone, webinar })
      const other = await register({ phone, webinar: webinarName() })
      expect(new Set([older.contact_id, latest.contact_id, other.contact_id]).size).toBe(1)

      const firstEvent = eventId()
      const first = await viewed(
        await view({
          event_id: firstEvent,
          phone: phone.slice(3),
          webinar,
          started_at: '2026-11-27T18:02:00Z',
          finished_at: '2026-11-27T18:40:00Z',
          minutes: 38,
          percent: 40,
        }),
      )
      expect(first).toEqual({ registration_id: latest.registration_id, matched: true })
      const afterFirst = await viewOf(latest.registration_id ?? '')
      expect(afterFirst).toMatchObject({
        view_started_at: new Date('2026-11-27T18:02:00Z'),
        view_finished_at: new Date('2026-11-27T18:40:00Z'),
        view_minutes: 38,
        view_extra: { percent: 40 },
      })
      expect(afterFirst.view_updated_at).toBeInstanceOf(Date)
      for (const id of [older.registration_id, other.registration_id]) {
        expect(await viewOf(id ?? '')).toEqual({
          view_started_at: null,
          view_finished_at: null,
          view_minutes: null,
          view_extra: null,
          view_updated_at: null,
        })
      }

      // Второй просмотр: последние значения заменяют прежние, не присланное — пусто.
      const second = await viewed(
        await view({
          event_id: eventId(),
          phone,
          webinar,
          started_at: '2026-11-27T18:05:00Z',
          minutes: 80.6,
          buttons: ['купити'],
        }),
      )
      expect(second).toEqual({ registration_id: latest.registration_id, matched: true })
      expect(await viewOf(latest.registration_id ?? '')).toMatchObject({
        view_started_at: new Date('2026-11-27T18:05:00Z'),
        view_finished_at: null,
        view_minutes: 81,
        view_extra: { buttons: ['купити'] },
      })

      const history = await historyOf(latest.registration_id ?? '')
      expect(history.every((row) => row.actor_intake_source_id === source.source.id)).toBe(true)
      expect(history.every((row) => row.actor_id === null)).toBe(true)
      expect(history.map((row) => [row.field, row.before, row.after])).toEqual([
        ['viewExtra', null, { percent: 40 }],
        ['viewFinishedAt', null, '2026-11-27T18:40:00.000Z'],
        ['viewMinutes', null, 38],
        ['viewStartedAt', null, '2026-11-27T18:02:00.000Z'],
        ['viewExtra', { percent: 40 }, { buttons: ['купити'] }],
        ['viewFinishedAt', '2026-11-27T18:40:00.000Z', null],
        ['viewMinutes', 38, 81],
        ['viewStartedAt', '2026-11-27T18:02:00.000Z', '2026-11-27T18:05:00.000Z'],
      ])
      expect(await journalOf(source.source.id, firstEvent)).toEqual([
        {
          channel: 'intake.webinar_view',
          outcome: 'accepted',
          status_code: 200,
          error_code: null,
          result: { registration_id: latest.registration_id, matched: true },
          replay_of: null,
        },
      ])
    })

    it('по email находит контакт без телефона', async () => {
      const email = fakeEmail()
      const webinar = webinarName()
      const reg = await register({ email, webinar })
      const phones = await h.owner
        .selectFrom('contact_phone')
        .select('phone')
        .where('contact_id', '=', reg.contact_id ?? '')
        .execute()
      expect(phones).toEqual([])

      const answer = await viewed(
        await view({ event_id: eventId(), email: email.toUpperCase(), webinar, minutes: 12 }),
      )
      expect(answer).toEqual({ registration_id: reg.registration_id, matched: true })
      expect((await viewOf(reg.registration_id ?? '')).view_minutes).toBe(12)
    })
  })

  describe('без регистрации', () => {
    it('нет контакта — 200 matched: false, строка журнала «без регистрации», контакт не создан; есть контакт без регистрации на этот вебинар — тоже', async () => {
      const before = {
        contacts: await countOf('contact'),
        registrations: await countOf('registration'),
        deals: await countOf('deal'),
      }
      const phone = fakePhone()
      const unknownEvent = eventId()
      const answer = await viewed(
        await view({ event_id: unknownEvent, phone, webinar: webinarName(), minutes: 5 }),
      )
      expect(answer).toEqual({ registration_id: null, matched: false })
      expect(await journalOf(source.source.id, unknownEvent)).toEqual([
        {
          channel: 'intake.webinar_view',
          outcome: 'unmatched',
          status_code: 200,
          error_code: null,
          result: { registration_id: null, matched: false },
          replay_of: null,
        },
      ])
      expect({
        contacts: await countOf('contact'),
        registrations: await countOf('registration'),
        deals: await countOf('deal'),
      }).toEqual(before)
      const withPhone = await h.owner
        .selectFrom('contact_phone')
        .select('contact_id')
        .where('phone', '=', phone)
        .execute()
      expect(withPhone).toEqual([])

      // Контакт есть, но регистрация — на другой вебинар.
      const known = fakePhone()
      const reg = await register({ phone: known, webinar: webinarName() })
      const otherWebinar = await viewed(
        await view({ event_id: eventId(), phone: known, webinar: webinarName(), minutes: 7 }),
      )
      expect(otherWebinar).toEqual({ registration_id: null, matched: false })
      expect((await viewOf(reg.registration_id ?? '')).view_minutes).toBeNull()
    })
  })

  describe('повтор и «провести заново»', () => {
    it('тот же event_id — 200 с тем же ответом, значения не меняются; повтор просмотра без регистрации — тоже matched: false', async () => {
      const phone = fakePhone()
      const webinar = webinarName()
      const reg = await register({ phone, webinar })
      const body = { event_id: eventId(), phone, webinar, minutes: 30 }
      const first = await viewed(await view(body))
      const stored = await viewOf(reg.registration_id ?? '')
      const history = await historyOf(reg.registration_id ?? '')
      const again = await viewed(await view({ ...body, minutes: 99, started_at: '2026-11-27' }))
      expect(again).toEqual(first)
      expect(await viewOf(reg.registration_id ?? '')).toEqual(stored)
      expect(await historyOf(reg.registration_id ?? '')).toEqual(history)
      expect((await journalOf(source.source.id, body.event_id)).map((r) => r.outcome)).toEqual([
        'accepted',
        'repeat',
      ])

      const lonely = { event_id: eventId(), phone: fakePhone(), webinar }
      expect(await viewed(await view(lonely))).toEqual({ registration_id: null, matched: false })
      expect(await viewed(await view(lonely))).toEqual({ registration_id: null, matched: false })
    })

    it('«провести заново» с момента до двух просмотров оставляет значения второго — и когда просмотры на месте, и после отката базы', async () => {
      const own = await createSource()
      const phone = fakePhone()
      const webinar = webinarName()
      const since = await databaseMoment()
      const reg = await register({ phone, webinar }, own.key)
      const firstView = { event_id: eventId(), phone, webinar, minutes: 10, step: 'перший' }
      const secondView = { event_id: eventId(), phone, webinar, minutes: 20, step: 'другий' }
      await viewed(await view(firstView, own.key))
      await viewed(await view(secondView, own.key))
      const expected = { view_minutes: 20, view_extra: { step: 'другий' } }
      expect(await viewOf(reg.registration_id ?? '')).toMatchObject(expected)

      const message = { projectId: projectA, initiatorId: admin.id, since, until: '' }
      message.until = await databaseMoment()
      // Просмотры на месте: оба — повторы, первый не возвращает свои значения поверх второго.
      const counts = await replayInbound(h.appDb, message)
      expect(counts).toEqual({ accepted: 0, repeat: 3, error: 0, unmatched: 0 })
      expect(await viewOf(reg.registration_id ?? '')).toMatchObject(expected)

      // «Откат базы» после T: регистрация и оба просмотра пропали — проведение заново идёт по
      // времени прихода: регистрация, затем первый просмотр, затем второй.
      await h.owner
        .deleteFrom('intake_event')
        .where('intake_source_id', '=', own.source.id)
        .execute()
      await h.owner
        .deleteFrom('registration')
        .where('id', '=', reg.registration_id ?? '')
        .execute()
      const afterRollback = await replayInbound(h.appDb, message)
      expect(afterRollback).toEqual({ accepted: 3, repeat: 0, error: 0, unmatched: 0 })
      const back = await h.owner
        .selectFrom('registration')
        .select('id')
        .where('intake_source_id', '=', own.source.id)
        .executeTakeFirstOrThrow()
      expect(await viewOf(back.id)).toMatchObject(expected)
      const replayed = (await journalOf(own.source.id, secondView.event_id)).filter(
        (row) => row.replay_of !== null,
      )
      expect(replayed.map((row) => [row.channel, row.outcome])).toEqual([
        ['intake.webinar_view', 'repeat'],
        ['intake.webinar_view', 'accepted'],
      ])
    })
  })

  describe('проверка тела', () => {
    it('без event_id, без телефона и email, без webinar, не объект — 400 со строкой журнала; лишние ключи и неверные значения — в view_extra', async () => {
      const phone = fakePhone()
      const webinar = webinarName()
      const reg = await register({ phone, webinar })
      const keyless = eventId()
      const cases: [unknown, string][] = [
        [{ phone, webinar }, 'INVALID_EVENT_ID'],
        [{ event_id: keyless, webinar }, 'CONTACT_KEYS_REQUIRED'],
        [
          { event_id: eventId(), phone: 'не телефон', email: 'не email', webinar },
          'CONTACT_KEYS_REQUIRED',
        ],
        [{ event_id: eventId(), phone }, 'WEBINAR_REQUIRED'],
        [{ event_id: eventId(), phone, webinar: '  ' }, 'WEBINAR_REQUIRED'],
        ['[1, 2]', 'INVALID_WEBINAR_VIEW'],
      ]
      for (const [body, code] of cases) {
        const res = await view(body)
        expect(res.status, code).toBe(400)
        expect(await problemOf(res)).toEqual({ code })
      }
      expect(await journalOf(source.source.id, keyless)).toEqual([
        {
          channel: 'intake.webinar_view',
          outcome: 'error',
          status_code: 400,
          error_code: 'CONTACT_KEYS_REQUIRED',
          result: null,
          replay_of: null,
        },
      ])
      expect((await viewOf(reg.registration_id ?? '')).view_updated_at).toBeNull()

      const answer = await viewed(
        await view({
          event_id: eventId(),
          phone,
          webinar,
          started_at: 'вчора',
          finished_at: '2026-11-27T19:00:00+02:00',
          minutes: 'багато',
          percent: 75,
          clicks: { buy: 2 },
        }),
      )
      expect(answer.matched).toBe(true)
      expect(await viewOf(reg.registration_id ?? '')).toMatchObject({
        view_started_at: null,
        view_finished_at: new Date('2026-11-27T17:00:00Z'),
        view_minutes: null,
        view_extra: { started_at: 'вчора', minutes: 'багато', percent: 75, clicks: { buy: 2 } },
      })
    })
  })

  describe('права и изоляция', () => {
    it('неизвестный и отключённый ключ источника — 401; ключ API — 401; без ключа — 401', async () => {
      const off = await createSource()
      const disabled = await admin.api('POST', `/v1/intake-sources/${off.source.id}/disable`, {
        project: projectA,
      })
      expect(disabled.status).toBe(200)
      const apiKey = await createApiKey(
        h,
        admin,
        projectA,
        await createRole(h, projectA, { actions: { deals: ['view'] }, scopes: {} } as never),
      )
      const phone = fakePhone()
      const webinar = webinarName()
      const reg = await register({ phone, webinar })
      const body = { event_id: eventId(), phone, webinar, minutes: 3 }
      for (const key of [`alpi_src_${'B'.repeat(43)}`, off.key, apiKey.secret, null]) {
        const res = await view(body, key)
        expect(res.status).toBe(401)
        expect(await problemOf(res)).toEqual({ code: 'INTAKE_KEY_INVALID' })
      }
      expect((await viewOf(reg.registration_id ?? '')).view_updated_at).toBeNull()
      expect(await journalOf(source.source.id, body.event_id)).toEqual([])
    })

    it('просмотр с ключом проекта A не находит контакт и регистрацию проекта B с тем же телефоном', async () => {
      const phone = fakePhone()
      const webinar = webinarName()
      const inB = await register({ phone, webinar }, sourceB.key)
      const answer = await viewed(await view({ event_id: eventId(), phone, webinar, minutes: 9 }))
      expect(answer).toEqual({ registration_id: null, matched: false })
      expect((await viewOf(inB.registration_id ?? '')).view_updated_at).toBeNull()

      // Ключ B находит свою регистрацию: дело в проекте, а не в данных.
      const own = await viewed(
        await view({ event_id: eventId(), phone, webinar, minutes: 9 }, sourceB.key),
      )
      expect(own).toEqual({ registration_id: inB.registration_id, matched: true })
    })
  })

  describe('окончательное удаление', () => {
    it('контакт удалён из корзины навсегда — регистрация и её история просмотров удалены; повтор просмотра — matched: false', async () => {
      const phone = fakePhone()
      const webinar = webinarName()
      const reg = await register({ phone, webinar })
      const body = { event_id: eventId(), phone, webinar, minutes: 15 }
      await viewed(await view(body))
      expect((await historyOf(reg.registration_id ?? '')).length).toBeGreaterThan(0)

      const trash = await admin.api(
        'DELETE',
        `/v1/contacts/${reg.contact_id}?confirm=${reg.deal_id}`,
        { project: projectA },
      )
      expect(trash.status).toBe(204)
      const purge = await admin.api('DELETE', `/v1/contacts/${reg.contact_id}/permanent`, {
        project: projectA,
      })
      expect(purge.status).toBe(204)
      expect(await historyOf(reg.registration_id ?? '')).toEqual([])
      expect(await viewed(await view(body))).toEqual({ registration_id: null, matched: false })
    })
  })
})
