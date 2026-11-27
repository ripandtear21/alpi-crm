import { randomInt } from 'node:crypto'
import type {
  InboundReplayQueued,
  InboundRequestView,
  IntakeSourceWithKey,
  Page,
  RegistrationAccepted,
} from '@alpi/shared'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { purgeInboundJournal } from '../jobs/inbound-purge.ts'
import {
  type ApiHarness,
  ORIGIN,
  type SignedInUser,
  startApiHarness,
  type Target,
} from '../testing/api-harness.ts'
import { createApiKey, createRole } from '../testing/api-key.ts'
import { problemOf } from '../testing/problem.ts'
import { handleRegistration } from './journal.ts'
import { type InboundReplayMessage, replayInbound } from './replay.ts'

// Журнал входящих и «провести заново» (тикет crm-intake/06; ADR 0006) на настоящем PostgreSQL.
// Очередь «провести заново» в тесте — список: задача выполняется вызовом replayInbound после
// ответа на запуск, как её выполнил бы pg-boss. Имена, телефоны и email — выдуманные.

const fakePhone = () => `+38050${randomInt(1_000_000, 9_999_999)}`
let counter = 0
const eventId = () => `journal-${++counter}-${randomInt(1e9)}`

describe('журнал входящих', () => {
  let h: ApiHarness
  let app: Target
  let admin: SignedInUser
  let manager: SignedInUser
  let projectA: string
  let pipelineId: string
  let source: IntakeSourceWithKey
  const queued: InboundReplayMessage[] = []

  function register(body: unknown, key = source.key) {
    return app.request(`${ORIGIN}/intake/registrations`, {
      method: 'POST',
      headers: { origin: ORIGIN, authorization: `Bearer ${key}` },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  }

  async function accepted(res: Response, status = 201): Promise<RegistrationAccepted> {
    const body = await res.json()
    expect(res.status, JSON.stringify(body)).toBe(status)
    return body as RegistrationAccepted
  }

  const journalOf = (sourceId: string) =>
    h.owner
      .selectFrom('inbound_request')
      .select([
        'channel',
        'outcome',
        'status_code',
        'error_code',
        'event_id',
        'body',
        'result',
        'warnings',
        'replay_of',
      ])
      .where('intake_source_id', '=', sourceId)
      .orderBy('received_at')
      .orderBy('id')
      .execute()

  async function createSource(): Promise<IntakeSourceWithKey> {
    const res = await admin.api('POST', '/v1/intake-sources', {
      project: projectA,
      body: { name: `Форма ${++counter}`, pipelineId },
    })
    expect(res.status).toBe(201)
    return (await res.json()) as IntakeSourceWithKey
  }

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_inbound_journal')
    app = createApp({
      auth: h.auth,
      db: h.appDb,
      inbound: {
        async enqueueReplay(_trx, message) {
          queued.push(message)
        },
      },
    })
    admin = await h.signIn('owner')
    manager = await h.signIn()
    projectA = (await h.createProject(admin, 'Журнал А')).id
    await h.addMember(projectA, manager.id, 'manager')
    const pipeline = await h.owner
      .insertInto('pipeline')
      .values({ project_id: projectA, code: 'journal', name: 'Воронка журналу', position: 50 })
      .returning('id')
      .executeTakeFirstOrThrow()
    pipelineId = pipeline.id
    await h.owner
      .insertInto('stage')
      .values({ project_id: projectA, pipeline_id: pipelineId, name: 'Новий', position: 1 })
      .execute()
    source = await createSource()
  })

  afterAll(async () => {
    await h?.stop()
  })

  describe('строки журнала', () => {
    it('принятый запрос, повтор и ошибка — по строке с сырым телом, итогом и id', async () => {
      const own = await createSource()
      const raw = `{"event_id":"${eventId()}",  "phone":"${fakePhone()}", "lead":"так"}`
      const first = await accepted(await register(raw, own.key))
      await accepted(await register(raw, own.key), 200)
      const broken = '{"phone": '
      expect((await register(broken, own.key)).status).toBe(400)
      const event = (JSON.parse(raw) as { event_id: string }).event_id
      const ids = {
        registration_id: first.registration_id,
        contact_id: first.contact_id,
        deal_id: first.deal_id,
      }
      expect(await journalOf(own.source.id)).toEqual([
        {
          channel: 'intake.registration',
          outcome: 'accepted',
          status_code: 201,
          error_code: null,
          event_id: event,
          body: raw,
          result: ids,
          warnings: [],
          replay_of: null,
        },
        {
          channel: 'intake.registration',
          outcome: 'repeat',
          status_code: 200,
          error_code: null,
          event_id: event,
          body: raw,
          result: ids,
          warnings: [],
          replay_of: null,
        },
        {
          channel: 'intake.registration',
          outcome: 'error',
          status_code: 400,
          error_code: 'INVALID_REGISTRATION',
          event_id: null,
          body: broken,
          result: null,
          warnings: [],
          replay_of: null,
        },
      ])
    })

    it('event_id не строкой и с NUL: у строки журнала и регистрации один event_id, проведение строки заново — повтор с теми же id', async () => {
      const own = await createSource()
      const padded = `${eventId()}${'x'.repeat(220)}`.slice(0, 250)
      const bodies = [
        { event_id: true, phone: fakePhone() },
        `{"event_id":"${padded}${'\\u0000'.repeat(10)}","phone":"${fakePhone()}"}`,
      ]
      for (const body of bodies) {
        const answer = await accepted(await register(body, own.key))
        const registration = await h.owner
          .selectFrom('registration')
          .select('event_id')
          .where('id', '=', answer.registration_id ?? '')
          .executeTakeFirstOrThrow()
        const row = await h.owner
          .selectFrom('inbound_request')
          .select(['id', 'event_id', 'body'])
          .where('intake_source_id', '=', own.source.id)
          .orderBy('received_at', 'desc')
          .orderBy('id', 'desc')
          .executeTakeFirstOrThrow()
        expect(row.event_id, row.body).toBe(registration.event_id)

        const again = await handleRegistration(
          h.appDb,
          { id: own.source.id, projectId: projectA, pipelineId },
          row.body,
          { replayOf: row.id },
        )
        expect([again.status, again.outcome]).toEqual([200, 'repeat'])
        expect(again.body).toMatchObject({
          registration_id: answer.registration_id,
          contact_id: answer.contact_id,
          deal_id: answer.deal_id,
        })
      }
      expect((await journalOf(own.source.id)).map((row) => [row.outcome, row.event_id])).toEqual([
        ['accepted', 'true'],
        ['repeat', 'true'],
        ['accepted', padded],
        ['repeat', padded],
      ])
    })

    it('сбой обработки (500) не оставляет данных, но оставляет строку журнала с ошибкой и телом', async () => {
      const own = await createSource()
      // Сбой на последнем шаге обработки: контакт и сделка уже записаны в той же транзакции.
      await sql`
        create function fail_registration() returns trigger language plpgsql as $$
        begin
          if new.event_id like 'boom-%' then raise exception 'сбой для теста'; end if;
          return new;
        end $$
      `.execute(h.owner)
      await sql`
        create trigger fail_registration before insert on registration
          for each row execute function fail_registration()
      `.execute(h.owner)
      try {
        const phone = fakePhone()
        const body = { event_id: `boom-${++counter}`, phone, name: 'Збій' }
        const res = await register(body, own.key)
        expect(res.status).toBe(500)
        expect(await problemOf(res)).toEqual({ code: 'INTERNAL' })
        const contacts = await h.owner
          .selectFrom('contact_phone')
          .select('contact_id')
          .where('phone', '=', phone)
          .execute()
        expect(contacts).toEqual([])
        const events = await h.owner
          .selectFrom('intake_event')
          .select('event_id')
          .where('event_id', '=', body.event_id)
          .execute()
        expect(events).toEqual([])
        expect(await journalOf(own.source.id)).toEqual([
          expect.objectContaining({
            outcome: 'error',
            status_code: 500,
            error_code: 'INTERNAL',
            event_id: body.event_id,
            body: JSON.stringify(body),
          }),
        ])
      } finally {
        await sql`drop trigger fail_registration on registration`.execute(h.owner)
        await sql`drop function fail_registration()`.execute(h.owner)
      }
    })

    it('строки старше 30 дней удаляет ночная очистка; младше — остаются', async () => {
      const own = await createSource()
      await accepted(await register({ event_id: eventId(), phone: fakePhone() }, own.key))
      await accepted(await register({ event_id: eventId(), phone: fakePhone() }, own.key))
      const [old] = await h.owner
        .selectFrom('inbound_request')
        .select('id')
        .where('intake_source_id', '=', own.source.id)
        .orderBy('received_at')
        .execute()
      await sql`
        update inbound_request set received_at = now() - interval '31 days' where id = ${old?.id}
      `.execute(h.owner)
      expect(await purgeInboundJournal(h.appDb)).toBeGreaterThanOrEqual(1)
      const left = await journalOf(own.source.id)
      expect(left).toHaveLength(1)
      // Регистрации и пары «источник, event_id» очистка не трогает.
      const registrations = await h.owner
        .selectFrom('registration')
        .select('id')
        .where('intake_source_id', '=', own.source.id)
        .execute()
      expect(registrations).toHaveLength(2)
    })
  })

  describe('журнал источника в API', () => {
    it('новые сверху, с телом; фильтр по итогу и курсор; без «интеграции: смотреть» — 403', async () => {
      const own = await createSource()
      const bodies = [0, 1, 2].map(() => ({ event_id: eventId(), phone: fakePhone() }))
      for (const body of bodies) await accepted(await register(body, own.key))
      await register({ event_id: eventId() }, own.key)
      const path = `/v1/intake-sources/${own.source.id}/requests`
      const get = (query: string, user = admin) =>
        user.call(app, 'GET', `${path}${query}`, { project: projectA })

      const first = await get('?limit=2')
      expect(first.status).toBe(200)
      const page1 = (await first.json()) as Page<InboundRequestView>
      expect(page1.data.map((row) => row.outcome)).toEqual(['error', 'accepted'])
      expect(page1.data[1]?.body).toBe(JSON.stringify(bodies[2]))
      expect(page1.next_cursor).not.toBeNull()
      const page2 = (await (
        await get(`?limit=2&cursor=${page1.next_cursor}`)
      ).json()) as Page<InboundRequestView>
      expect(page2.data.map((row) => row.eventId)).toEqual([
        bodies[1]?.event_id,
        bodies[0]?.event_id,
      ])
      expect(page2.next_cursor).toBeNull()

      const errors = (await (await get('?outcome=error')).json()) as Page<InboundRequestView>
      expect(errors.data.map((row) => [row.outcome, row.errorCode])).toEqual([
        ['error', 'CONTACT_KEYS_REQUIRED'],
      ])
      expect((await get('?outcome=nope')).status).toBe(400)
      expect((await get('?cursor=xyz')).status).toBe(400)

      const blind = await h.signIn()
      await h.owner
        .insertInto('project_member')
        .values({
          project_id: projectA,
          user_id: blind.id,
          role_id: await createRole(h, projectA, {
            actions: { deals: ['view'] },
            scopes: {},
          } as never),
        })
        .execute()
      const denied = await get('', blind)
      expect(denied.status).toBe(403)
      expect(await problemOf(denied)).toEqual({ code: 'PERMISSION_DENIED' })
      const unknown = await admin.call(
        app,
        'GET',
        '/v1/intake-sources/00000000-0000-4000-8000-000000000000/requests',
        { project: projectA },
      )
      expect(unknown.status).toBe(404)
    })
  })

  describe('провести заново', () => {
    const replay = (user: SignedInUser, body: unknown) =>
      user.call(app, 'POST', '/v1/inbound/replay', { project: projectA, body })

    it('базу откатили (регистрации после T удалены) — провели заново с T: регистрации вернулись с теми же event_id, остальное не задвоилось', async () => {
      const own = await createSource()
      const earlier = { event_id: eventId(), phone: fakePhone() }
      await accepted(await register(earlier, own.key))
      // T — после первой регистрации: её проведение заново не касается. API принимает T с
      // точностью до миллисекунды — округляем вверх и ждём, пока часы базы его пройдут.
      const { rows } = await sql<{ t: Date }>`
        select date_trunc('milliseconds', clock_timestamp()) + interval '1 millisecond' as t,
          pg_sleep(0.002)
      `.execute(h.owner)
      const since = new Date(rows[0]?.t ?? '').toISOString()
      const kept = { event_id: eventId(), phone: fakePhone(), name: 'Лишилась' }
      const lost = { event_id: eventId(), phone: fakePhone(), name: 'Зникла', form: 'Ф' }
      await accepted(await register(kept, own.key))
      const lostAnswer = await accepted(await register(lost, own.key))
      await accepted(await register(kept, own.key), 200)
      await register({ event_id: eventId() }, own.key)

      // «Откат базы» после T: регистрация `lost` и её пара «источник, event_id» пропали.
      await h.owner.deleteFrom('intake_event').where('event_id', '=', lost.event_id).execute()
      await h.owner
        .deleteFrom('registration')
        .where('id', '=', lostAnswer.registration_id ?? '')
        .execute()

      const started = await replay(admin, { since })
      expect(started.status).toBe(202)
      const queuedAnswer = (await started.json()) as InboundReplayQueued
      expect(queuedAnswer.since).toBe(since)
      const message = queued.at(-1)
      expect(message).toMatchObject({ projectId: projectA, initiatorId: admin.id, since })

      const counts = await replayInbound(h.appDb, message as InboundReplayMessage)
      expect(counts).toEqual({ accepted: 1, repeat: 2, error: 1 })

      const registrations = await h.owner
        .selectFrom('registration')
        .select(['event_id', 'contact_id', 'deal_id'])
        .where('intake_source_id', '=', own.source.id)
        .execute()
      expect(registrations.map((r) => r.event_id).sort()).toEqual(
        [earlier.event_id, kept.event_id, lost.event_id].sort(),
      )
      const back = registrations.find((r) => r.event_id === lost.event_id)
      expect([back?.contact_id, back?.deal_id]).toEqual([lostAnswer.contact_id, lostAnswer.deal_id])
      const replayed = (await journalOf(own.source.id)).filter((row) => row.replay_of !== null)
      expect(replayed.map((row) => row.outcome).sort()).toEqual(
        ['accepted', 'error', 'repeat', 'repeat'].sort(),
      )
      // Строки самих повторных проведений второй раз не проводятся.
      const again = await replayInbound(h.appDb, message as InboundReplayMessage)
      expect(again.accepted).toBe(0)

      const audit = await h.owner
        .selectFrom('audit_log')
        .select(['action', 'actor_id', 'details'])
        .where('project_id', '=', projectA)
        .where('action', 'in', ['inbound.replay_started', 'inbound.replay_finished'])
        .orderBy('occurred_at')
        .execute()
      expect(audit[0]).toMatchObject({
        action: 'inbound.replay_started',
        actor_id: admin.id,
        details: { since },
      })
      expect(audit[1]).toMatchObject({
        action: 'inbound.replay_finished',
        actor_id: admin.id,
        details: { since, accepted: counts.accepted, repeats: counts.repeat, errors: counts.error },
      })
    })

    it('источник, отключённый после приёма, не мешает провести заново', async () => {
      const own = await createSource()
      const { rows } = await sql<{ t: string }>`select clock_timestamp()::text as t`.execute(
        h.owner,
      )
      const since = new Date(rows[0]?.t ?? '').toISOString()
      const body = { event_id: eventId(), phone: fakePhone() }
      const first = await accepted(await register(body, own.key))
      const off = await admin.call(app, 'POST', `/v1/intake-sources/${own.source.id}/disable`, {
        project: projectA,
      })
      expect(off.status).toBe(200)
      await h.owner.deleteFrom('intake_event').where('event_id', '=', body.event_id).execute()
      await h.owner
        .deleteFrom('registration')
        .where('id', '=', first.registration_id ?? '')
        .execute()
      expect((await replay(admin, { since })).status).toBe(202)
      await replayInbound(h.appDb, queued.at(-1) as InboundReplayMessage)
      const back = await h.owner
        .selectFrom('registration')
        .select('contact_id')
        .where('event_id', '=', body.event_id)
        .execute()
      expect(back).toEqual([{ contact_id: first.contact_id }])
    })

    it('T старше 30 дней — 422; неверное тело — 400; не администратор — 403; ключ API — 403', async () => {
      const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
      const tooOld = await replay(admin, { since: old })
      expect(tooOld.status).toBe(422)
      expect(await problemOf(tooOld)).toEqual({ code: 'REPLAY_TOO_OLD' })
      const invalid = await replay(admin, { since: 'вчора' })
      expect(invalid.status).toBe(400)
      const notAdmin = await replay(manager, { since: new Date().toISOString() })
      expect(notAdmin.status).toBe(403)
      expect(await problemOf(notAdmin)).toEqual({ code: 'PERMISSION_DENIED' })

      const key = await createApiKey(
        h,
        admin,
        projectA,
        await createRole(h, projectA, { actions: { deals: ['view'] }, scopes: {} } as never),
      )
      const byKey = await key.call(app, 'POST', '/v1/inbound/replay', {
        body: { since: new Date().toISOString() },
      })
      expect(byKey.status).toBe(403)
      expect(await problemOf(byKey)).toEqual({ code: 'API_KEY_NOT_ALLOWED' })
    })
  })
})
