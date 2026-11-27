import { randomInt } from 'node:crypto'
import { withProject } from '@alpi/db'
import {
  eventBodyProblem,
  formatPhone,
  type IntakeSourceWithKey,
  type RegistrationAccepted,
} from '@alpi/shared'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import {
  type ApiHarness,
  type Method,
  ORIGIN,
  type SignedInUser,
  startApiHarness,
  type Target,
} from '../testing/api-harness.ts'
import { createApiKey, createRole } from '../testing/api-key.ts'
import { problemOf } from '../testing/problem.ts'

// Приём регистраций (тикет crm-intake/06) на настоящем PostgreSQL: API ходит ролью приложения,
// проверки — служебным подключением. Источник шлёт запрос с одним заголовком Authorization, как
// внешний сервис. Имена, телефоны и email — выдуманные.

const fakePhone = () => `+38067${randomInt(1_000_000, 9_999_999)}`
let counter = 0
const fakeEmail = () => `reg-${++counter}-${randomInt(1e9)}@example.test`
const eventId = () => `evt-${++counter}-${randomInt(1e9)}`

describe('приём регистраций', () => {
  let h: ApiHarness
  let admin: SignedInUser
  let manager: SignedInUser
  let projectA: string
  let projectB: string
  /** Воронка источника и её этапы: первый и второй. */
  let pipeline: { id: string; first: string; second: string }
  let source: IntakeSourceWithKey

  /** Запрос с одним заголовком Authorization, без cookie: так ходит внешний сервис. */
  function bearer(
    target: Target,
    key: string | null,
    method: Method,
    path: string,
    body?: unknown,
  ) {
    const headers = new Headers({ origin: ORIGIN })
    if (key !== null) headers.set('authorization', `Bearer ${key}`)
    if (body !== undefined) headers.set('content-type', 'application/json')
    return target.request(`${ORIGIN}${path}`, {
      method,
      headers,
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    })
  }

  const register = async (body: unknown, key = source.key): Promise<Response> =>
    bearer(h.app, key, 'POST', '/intake/registrations', body)

  async function accepted(res: Response, status = 201): Promise<RegistrationAccepted> {
    const body = await res.json()
    expect(res.status, JSON.stringify(body)).toBe(status)
    return body as RegistrationAccepted
  }

  async function createPipeline(projectId: string, stages = 2) {
    const n = ++counter
    const { id } = await h.owner
      .insertInto('pipeline')
      .values({ project_id: projectId, code: `reg${n}`, name: `Воронка ${n}`, position: 100 + n })
      .returning('id')
      .executeTakeFirstOrThrow()
    const ids: string[] = []
    for (let position = 1; position <= stages; position++) {
      const stage = await h.owner
        .insertInto('stage')
        .values({ project_id: projectId, pipeline_id: id, name: `Етап ${position}`, position })
        .returning('id')
        .executeTakeFirstOrThrow()
      ids.push(stage.id)
    }
    return { id, first: ids[0] ?? '', second: ids[1] ?? '' }
  }

  async function createSource(projectId = projectA, pipelineId = pipeline.id, name?: string) {
    const res = await admin.api('POST', '/v1/intake-sources', {
      project: projectId,
      body: { name: name ?? `Лендінг ${++counter}`, pipelineId },
    })
    expect(res.status).toBe(201)
    return (await res.json()) as IntakeSourceWithKey
  }

  async function createContact(body: Record<string, unknown>, project = projectA) {
    const res = await admin.api('POST', '/v1/contacts', {
      project,
      body: { firstName: `Клієнт ${++counter}`, ...body },
    })
    expect(res.status).toBe(201)
    return (await res.json()) as { id: string }
  }

  async function createDeal(contactId: string, stageId = pipeline.first, ownerId?: string | null) {
    const res = await admin.api('POST', '/v1/deals', {
      project: projectA,
      body: {
        title: `Угода ${++counter}`,
        pipelineId: pipeline.id,
        stageId,
        contactId,
        ...(ownerId === undefined ? {} : { ownerId }),
      },
    })
    expect(res.status).toBe(201)
    return (await res.json()) as { id: string }
  }

  const contactRow = (id: string) =>
    h.owner.selectFrom('contact').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
  const dealRow = (id: string) =>
    h.owner.selectFrom('deal').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
  const registrationRow = (id: string) =>
    h.owner.selectFrom('registration').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
  const keysOf = async (id: string) => ({
    phones: (
      await h.owner
        .selectFrom('contact_phone')
        .select('phone')
        .where('contact_id', '=', id)
        .orderBy('is_primary', 'desc')
        .execute()
    ).map((r) => r.phone),
    emails: (
      await h.owner
        .selectFrom('contact_email')
        .select('email')
        .where('contact_id', '=', id)
        .orderBy('is_primary', 'desc')
        .execute()
    ).map((r) => r.email),
  })
  const contactsWithPhone = async (phone: string) =>
    (
      await h.owner
        .selectFrom('contact_phone')
        .select('contact_id')
        .where('phone', '=', phone)
        .execute()
    ).map((r) => r.contact_id)
  const contactsWithEmail = async (email: string) =>
    (
      await h.owner
        .selectFrom('contact_email')
        .select('contact_id')
        .where('email', '=', email)
        .execute()
    ).map((r) => r.contact_id)
  const countOf = async (table: 'registration' | 'deal' | 'contact' | 'webhook_event') =>
    Number(
      (
        await h.owner
          .selectFrom(table)
          .select(sql<string>`count(*)`.as('n'))
          .executeTakeFirstOrThrow()
      ).n,
    )

  /** Ждёт, пока чей-то запрос к базе встанет в ожидание блокировки строки. */
  async function waitForLockWait() {
    for (let i = 0; i < 400; i++) {
      const { rows } = await sql<{ n: number }>`
        select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock'
      `.execute(h.owner)
      if ((rows[0]?.n ?? 0) > 0) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error('запрос не дошёл до ожидания блокировки')
  }

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_registrations')
    admin = await h.signIn('owner')
    manager = await h.signIn()
    projectA = (await h.createProject(admin, 'Реєстрації А')).id
    projectB = (await h.createProject(admin, 'Реєстрації Б')).id
    await h.addMember(projectA, manager.id, 'manager')
    pipeline = await createPipeline(projectA)
    source = await createSource()
  })

  afterAll(async () => {
    await h?.stop()
  })

  describe('новый человек', () => {
    it('201: новый контакт и сделка «<имя> · <форма>» на первом этапе воронки источника без ответственного; регистрация со всеми полями, неизвестные ключи — в extra', async () => {
      const phone = fakePhone()
      const email = fakeEmail()
      const id = eventId()
      const body = {
        event_id: id,
        name: 'Олена Вигадана',
        phone: phone.slice(3),
        dial_code: '+380',
        email: email.toUpperCase(),
        form: 'Вебінар з продажів',
        webinar: 'Продажі 2027',
        plan_name: 'VIP',
        page_url: 'https://example.com/landing?x=1',
        referrer: 'https://example.com/',
        utm_source: 'facebook',
        utm_medium: 'cpc',
        utm_campaign: 'autumn',
        utm_term: 'crm',
        utm_content: 'banner',
        ad_id: 'ad-1',
        gclid: 'g-1',
        gbraid: 'gb-1',
        wbraid: 'wb-1',
        fbclid: 'fb-1',
        fbp: 'fbp-1',
        fbc: 'fbc-1',
        registered_at: '2026-11-27T09:15:00Z',
        user_agent: 'Mozilla/5.0',
        quiz: { answer: 'так' },
        utm_id: 42,
      }
      const answer = await accepted(await register(body))
      expect(answer).toEqual({
        registration_id: expect.any(String),
        contact_id: expect.any(String),
        deal_id: expect.any(String),
        deal_created: true,
        contact_created: true,
        warnings: [],
      })

      const contact = await contactRow(answer.contact_id ?? '')
      expect(contact.first_name).toBe('Олена Вигадана')
      expect(contact.created_by).toBeNull()
      expect(await keysOf(contact.id)).toEqual({ phones: [phone], emails: [email] })

      const deal = await dealRow(answer.deal_id ?? '')
      expect(deal).toMatchObject({
        title: 'Олена Вигадана · Вебінар з продажів',
        pipeline_id: pipeline.id,
        stage_id: pipeline.first,
        owner_id: null,
        status: 'open',
        primary_contact_id: contact.id,
      })

      const registration = await registrationRow(answer.registration_id ?? '')
      expect(registration).toMatchObject({
        project_id: projectA,
        intake_source_id: source.source.id,
        event_id: id,
        contact_id: contact.id,
        deal_id: deal.id,
        name: 'Олена Вигадана',
        phone,
        phone_raw: phone.slice(3),
        dial_code: '+380',
        email,
        form: 'Вебінар з продажів',
        webinar: 'Продажі 2027',
        plan_name: 'VIP',
        page_url: 'https://example.com/landing?x=1',
        referrer: 'https://example.com/',
        utm_source: 'facebook',
        utm_medium: 'cpc',
        utm_campaign: 'autumn',
        utm_term: 'crm',
        utm_content: 'banner',
        ad_id: 'ad-1',
        gclid: 'g-1',
        gbraid: 'gb-1',
        wbraid: 'wb-1',
        fbclid: 'fb-1',
        fbp: 'fbp-1',
        fbc: 'fbc-1',
        user_agent: 'Mozilla/5.0',
        extra: { quiz: { answer: 'так' }, utm_id: 42 },
      })
      expect(registration.registered_at?.toISOString()).toBe('2026-11-27T09:15:00.000Z')
    })

    it('без имени — имя контакта из телефона в международном виде, без телефона — email; без формы — сделка «… · <источник>»', async () => {
      const phone = fakePhone()
      const byPhone = await accepted(await register({ event_id: eventId(), phone }))
      expect((await contactRow(byPhone.contact_id ?? '')).first_name).toBe(formatPhone(phone))
      expect((await dealRow(byPhone.deal_id ?? '')).title).toBe(
        `${formatPhone(phone)} · ${source.source.name}`,
      )
      const email = fakeEmail()
      const byEmail = await accepted(await register({ event_id: eventId(), email }))
      expect((await contactRow(byEmail.contact_id ?? '')).first_name).toBe(email)
    })
  })

  describe('проверка тела', () => {
    it('без event_id — 400; без верного телефона и email — 400; неверный телефон при верном email — 201 с PHONE_INVALID и исходным телефоном', async () => {
      const before = await countOf('registration')
      const noEvent = await register({ phone: fakePhone() })
      expect(noEvent.status).toBe(400)
      expect(await problemOf(noEvent)).toEqual({ code: 'INVALID_EVENT_ID' })
      const longEvent = await register({ event_id: 'x'.repeat(256), phone: fakePhone() })
      expect(await problemOf(longEvent)).toEqual({ code: 'INVALID_EVENT_ID' })
      const noKeys = await register({ event_id: eventId(), phone: '12', email: 'не email' })
      expect(noKeys.status).toBe(400)
      expect(await problemOf(noKeys)).toEqual({ code: 'CONTACT_KEYS_REQUIRED' })
      const notJson = await register('{"event_id": ')
      expect(await problemOf(notJson)).toEqual({ code: 'INVALID_REGISTRATION' })
      expect(await countOf('registration')).toBe(before)

      const email = fakeEmail()
      const answer = await accepted(
        await register({ event_id: eventId(), phone: '067-12', email, name: 'Петро' }),
      )
      expect(answer.warnings).toEqual(['PHONE_INVALID'])
      const registration = await registrationRow(answer.registration_id ?? '')
      expect([registration.phone, registration.phone_raw, registration.email]).toEqual([
        null,
        '067-12',
        email,
      ])
      expect(await keysOf(answer.contact_id ?? '')).toEqual({ phones: [], emails: [email] })
    })

    it('601-й запрос источника в минуту — 429 с Retry-After, в журнал не пишется', async () => {
      const now = 9_000_000
      const app = createApp({ auth: h.auth, db: h.appDb, rateLimit: { now: () => now } })
      const busy = await createSource()
      for (let i = 0; i < 600; i++) {
        const res = await bearer(app, busy.key, 'POST', '/intake/unknown', {})
        expect(res.status).toBe(404)
      }
      const limited = await bearer(app, busy.key, 'POST', '/intake/registrations', {
        event_id: eventId(),
        phone: fakePhone(),
      })
      expect(limited.status).toBe(429)
      expect(limited.headers.get('retry-after')).toBe('60')
      const journal = await h.owner
        .selectFrom('inbound_request')
        .select('id')
        .where('intake_source_id', '=', busy.source.id)
        .execute()
      expect(journal).toEqual([])
    })
  })

  describe('повтор event_id', () => {
    it('тот же event_id — 200 с теми же id, ничего не создано и событий нет; у другого источника — новая регистрация', async () => {
      const body = { event_id: eventId(), phone: fakePhone(), name: 'Іван', form: 'Форма' }
      const first = await accepted(await register(body))
      const counts = async () => ({
        registrations: await countOf('registration'),
        deals: await countOf('deal'),
        contacts: await countOf('contact'),
        events: await countOf('webhook_event'),
      })
      const before = await counts()
      const again = await accepted(await register({ ...body, name: 'Інше ім’я' }), 200)
      expect(again).toEqual({ ...first, deal_created: false, contact_created: false })
      expect(await counts()).toEqual(before)

      const other = await createSource()
      const elsewhere = await accepted(await register(body, other.key))
      expect(elsewhere.registration_id).not.toBe(first.registration_id)
      // Тот же человек в той же воронке: контакт и открытая сделка — те же.
      expect([elsewhere.contact_id, elsewhere.deal_id]).toEqual([first.contact_id, first.deal_id])
    })

    it('два одновременных одинаковых запроса — одна регистрация: второй ждёт первый и получает 200 с теми же id', async () => {
      for (let round = 0; round < 3; round++) {
        const body = { event_id: eventId(), phone: fakePhone(), email: fakeEmail() }
        const answers = await Promise.all([register(body), register(body)])
        const statuses = answers.map((res) => res.status).sort()
        expect(statuses).toEqual([200, 201])
        const [a, b] = (await Promise.all(answers.map((res) => res.json()))) as [
          RegistrationAccepted,
          RegistrationAccepted,
        ]
        expect(a.registration_id).toBe(b.registration_id)
        const rows = await h.owner
          .selectFrom('registration')
          .select('id')
          .where('event_id', '=', body.event_id)
          .execute()
        expect(rows).toHaveLength(1)
      }
    })
  })

  describe('одновременные регистрации одного человека', () => {
    it('один новый телефон в двух запросах сразу — один контакт и одна сделка', async () => {
      for (let round = 0; round < 3; round++) {
        const phone = fakePhone()
        const answers = await Promise.all(
          [0, 1, 2].map(() => register({ event_id: eventId(), phone })),
        )
        const bodies = await Promise.all(answers.map((res) => accepted(res)))
        expect(await contactsWithPhone(phone)).toHaveLength(1)
        expect(new Set(bodies.map((b) => b.contact_id)).size).toBe(1)
        expect(new Set(bodies.map((b) => b.deal_id)).size).toBe(1)
      }
    })

    it('один новый email в двух запросах сразу — один контакт', async () => {
      for (let round = 0; round < 3; round++) {
        const email = fakeEmail()
        const answers = await Promise.all(
          [0, 1, 2].map(() => register({ event_id: eventId(), email })),
        )
        const bodies = await Promise.all(answers.map((res) => accepted(res)))
        expect(await contactsWithEmail(email)).toHaveLength(1)
        expect(new Set(bodies.map((b) => b.contact_id)).size).toBe(1)
      }
    })
  })

  describe('поиск контакта', () => {
    it('найден по телефону, email ни у кого: регистрация в него, email добавлен; имя из телефона заменено именем, заполненное имя не тронуто', async () => {
      const phone = fakePhone()
      const first = await accepted(await register({ event_id: eventId(), phone }))
      const email = fakeEmail()
      const second = await accepted(
        await register({ event_id: eventId(), phone, email, name: 'Марія' }),
      )
      expect(second.contact_id).toBe(first.contact_id)
      expect(second.contact_created).toBe(false)
      const contact = await contactRow(first.contact_id ?? '')
      expect(contact.first_name).toBe('Марія')
      expect(await keysOf(contact.id)).toEqual({ phones: [phone], emails: [email] })
      // История — с автором-источником.
      const history = await h.owner
        .selectFrom('change_log')
        .select(['field', 'actor_id', 'actor_intake_source_id'])
        .where('entity_id', '=', contact.id)
        .orderBy('field')
        .execute()
      expect(history).toEqual([
        { field: 'emails', actor_id: null, actor_intake_source_id: source.source.id },
        { field: 'firstName', actor_id: null, actor_intake_source_id: source.source.id },
      ])

      await accepted(await register({ event_id: eventId(), phone, name: 'Інша' }))
      expect((await contactRow(contact.id)).first_name).toBe('Марія')

      const named = await createContact({ firstName: 'Справжнє', phones: [fakePhone()] })
      const namedPhone = (await keysOf(named.id)).phones[0] ?? ''
      await accepted(await register({ event_id: eventId(), phone: namedPhone, name: 'Нове' }))
      expect((await contactRow(named.id)).first_name).toBe('Справжнє')
    })

    it('телефон — у А, email — у Б: регистрация в А, у А «возможный дубль» со ссылкой на Б; чужой email и телефон не добавлены', async () => {
      const phoneA = fakePhone()
      const emailB = fakeEmail()
      const a = await createContact({ phones: [phoneA] })
      const b = await createContact({ phones: [fakePhone()], emails: [emailB] })
      const answer = await accepted(
        await register({ event_id: eventId(), phone: phoneA, email: emailB }),
      )
      expect(answer.contact_id).toBe(a.id)
      const rowA = await contactRow(a.id)
      expect([rowA.possible_duplicate, rowA.possible_duplicate_of]).toEqual([true, b.id])
      expect((await keysOf(a.id)).emails).toEqual([])
      expect((await keysOf(b.id)).phones).not.toContain(phoneA)
      const marked = await h.owner
        .selectFrom('webhook_event')
        .select(['actor_type', 'actor_id'])
        .where('type', '=', 'contact.possible_duplicate')
        .where('entity_id', '=', a.id)
        .execute()
      expect(marked).toEqual([{ actor_type: 'intake_source', actor_id: source.source.id }])
    })

    it('телефон передан и не найден, email — у А: новый контакт с телефоном и email, «возможный дубль» со ссылкой на А', async () => {
      const email = fakeEmail()
      const a = await createContact({ emails: [email] })
      const phone = fakePhone()
      const answer = await accepted(await register({ event_id: eventId(), phone, email }))
      expect(answer.contact_created).toBe(true)
      expect(answer.contact_id).not.toBe(a.id)
      const created = await contactRow(answer.contact_id ?? '')
      expect([created.possible_duplicate, created.possible_duplicate_of]).toEqual([true, a.id])
      expect(await keysOf(created.id)).toEqual({ phones: [phone], emails: [email] })
    })

    it('телефона нет, email — у А: регистрация в А', async () => {
      const email = fakeEmail()
      const a = await createContact({ emails: [email] })
      const answer = await accepted(await register({ event_id: eventId(), email }))
      expect([answer.contact_id, answer.contact_created]).toEqual([a.id, false])
      expect((await contactRow(a.id)).possible_duplicate).toBe(false)
    })

    it('контакт в корзине и слитый не находятся: новый контакт', async () => {
      const phone = fakePhone()
      const trashed = await createContact({ phones: [phone] })
      await h.owner
        .updateTable('contact')
        .set({ deleted_at: sql`now()` })
        .where('id', '=', trashed.id)
        .execute()
      const answer = await accepted(await register({ event_id: eventId(), phone }))
      expect(answer.contact_created).toBe(true)
      expect(answer.contact_id).not.toBe(trashed.id)
    })

    it('найденный контакт слили, пока приём ждал его блокировку: регистрация — в оставшийся, не в скрытый', async () => {
      const phone = fakePhone()
      const merged = await createContact({ phones: [phone] })
      const survivor = await createContact({ phones: [fakePhone()] })
      let pending: Promise<Response> | undefined
      // Слияние держит строку контакта (FOR UPDATE), как merge/contacts.ts, и переносит телефон;
      // приём в это время находит контакт по телефону и ждёт его блокировку.
      await h.owner.transaction().execute(async (trx) => {
        await trx
          .selectFrom('contact')
          .select('id')
          .where('id', '=', merged.id)
          .forUpdate()
          .execute()
        pending = register({ event_id: eventId(), phone })
        await waitForLockWait()
        await trx
          .updateTable('contact_phone')
          .set({ contact_id: survivor.id, is_primary: false })
          .where('contact_id', '=', merged.id)
          .execute()
        await trx
          .updateTable('contact')
          .set({ merged_into_id: survivor.id, merged_at: sql`now()` })
          .where('id', '=', merged.id)
          .execute()
      })
      const answer = await accepted(await (pending as Promise<Response>))
      expect([answer.contact_id, answer.contact_created]).toEqual([survivor.id, false])
    })
  })

  describe('сделка и ADR 0003', () => {
    it('открытая сделка получает регистрацию: этап, статус и ответственный не меняются, задач нет', async () => {
      const phone = fakePhone()
      const contact = await createContact({ phones: [phone] })
      const deal = await createDeal(contact.id, pipeline.second, manager.id)
      const before = await dealRow(deal.id)
      const answer = await accepted(
        await register({ event_id: eventId(), phone, owner_email: admin.email }),
      )
      expect([answer.deal_id, answer.deal_created, answer.warnings]).toEqual([deal.id, false, []])
      const after = await dealRow(deal.id)
      expect({
        stage: after.stage_id,
        status: after.status,
        owner: after.owner_id,
        updated: after.updated_at,
      }).toEqual({
        stage: before.stage_id,
        status: before.status,
        owner: before.owner_id,
        updated: before.updated_at,
      })
      const events = await h.owner
        .selectFrom('webhook_event')
        .select('type')
        .where('entity_id', '=', deal.id)
        .where('actor_type', '=', 'intake_source')
        .execute()
      expect(events).toEqual([])
    })

    it('только архивная или закрытая сделка — новая сделка на первом этапе', async () => {
      const phone = fakePhone()
      const contact = await createContact({ phones: [phone] })
      const archived = await createDeal(contact.id)
      await h.owner
        .updateTable('deal')
        .set({ archived_at: sql`now()` })
        .where('id', '=', archived.id)
        .execute()
      const first = await accepted(await register({ event_id: eventId(), phone }))
      expect(first.deal_created).toBe(true)
      expect(first.deal_id).not.toBe(archived.id)

      await h.owner
        .updateTable('deal')
        .set({ status: 'won', won_at: sql`now()` } as never)
        .where('id', '=', first.deal_id ?? '')
        .execute()
      const second = await accepted(await register({ event_id: eventId(), phone }))
      expect(second.deal_created).toBe(true)
      expect(second.deal_id).not.toBe(first.deal_id)
      expect((await dealRow(second.deal_id ?? '')).stage_id).toBe(pipeline.first)
    })

    it('ответственный по owner_email — только в новую сделку; неизвестный и отключённый — без ответственного и OWNER_NOT_FOUND', async () => {
      const owned = await accepted(
        await register({
          event_id: eventId(),
          phone: fakePhone(),
          owner_email: manager.email.toUpperCase(),
        }),
      )
      expect(owned.warnings).toEqual([])
      expect((await dealRow(owned.deal_id ?? '')).owner_id).toBe(manager.id)

      const unknown = await accepted(
        await register({ event_id: eventId(), phone: fakePhone(), owner_email: fakeEmail() }),
      )
      expect(unknown.warnings).toEqual(['OWNER_NOT_FOUND'])
      expect((await dealRow(unknown.deal_id ?? '')).owner_id).toBeNull()

      const outsider = await h.signIn()
      const foreign = await accepted(
        await register({ event_id: eventId(), phone: fakePhone(), owner_email: outsider.email }),
      )
      expect(foreign.warnings).toEqual(['OWNER_NOT_FOUND'])

      const disabled = await h.signIn()
      await h.addMember(projectA, disabled.id, 'manager')
      await h.owner
        .updateTable('project_member')
        .set({ disabled_at: sql`now()`, disabled_by: admin.id })
        .where('user_id', '=', disabled.id)
        .execute()
      const off = await accepted(
        await register({ event_id: eventId(), phone: fakePhone(), owner_email: disabled.email }),
      )
      expect(off.warnings).toEqual(['OWNER_NOT_FOUND'])
      expect((await dealRow(off.deal_id ?? '')).owner_id).toBeNull()
    })

    it('воронка источника без этапов — 422, ничего не записано, строка журнала с ошибкой есть', async () => {
      const empty = await createPipeline(projectA, 0)
      const lonely = await createSource(projectA, empty.id)
      const phone = fakePhone()
      const res = await register({ event_id: eventId(), phone }, lonely.key)
      expect(res.status).toBe(422)
      expect(await problemOf(res)).toEqual({ code: 'PIPELINE_HAS_NO_STAGES' })
      expect(await contactsWithPhone(phone)).toEqual([])
      const journal = await h.owner
        .selectFrom('inbound_request')
        .select(['outcome', 'status_code', 'error_code'])
        .where('intake_source_id', '=', lonely.source.id)
        .execute()
      expect(journal).toEqual([
        { outcome: 'error', status_code: 422, error_code: 'PIPELINE_HAS_NO_STAGES' },
      ])
    })
  })

  describe('события', () => {
    it('новый человек — registration.created, contact.created, deal.created с автором-источником; тела проходят схему и без имён, телефонов, email', async () => {
      const phone = fakePhone()
      const email = fakeEmail()
      const answer = await accepted(
        await register({ event_id: eventId(), phone, email, name: 'Тарас Вигаданий', form: 'Ф' }),
      )
      const events = await h.owner
        .selectFrom('webhook_event')
        .select(['type', 'body', 'actor_type', 'actor_id'])
        .where('entity_id', 'in', [
          answer.registration_id ?? '',
          answer.contact_id ?? '',
          answer.deal_id ?? '',
        ])
        .orderBy('created_at')
        .execute()
      expect(events.map((e) => [e.type, e.actor_type, e.actor_id]).sort()).toEqual(
        [
          ['contact.created', 'intake_source', source.source.id],
          ['deal.created', 'intake_source', source.source.id],
          ['registration.created', 'intake_source', source.source.id],
        ].sort(),
      )
      for (const event of events) {
        expect(eventBodyProblem(event.body)).toBeNull()
        const text = JSON.stringify(event.body)
        for (const secret of ['Тарас', phone, email]) expect(text).not.toContain(secret)
      }
      const registration = events.find((e) => e.type === 'registration.created')
      expect((registration?.body as { data: unknown } | undefined)?.data).toMatchObject({
        registration_id: answer.registration_id,
        contact_id: answer.contact_id,
        deal_id: answer.deal_id,
        source_id: source.source.id,
        form: 'Ф',
        deal_created: true,
        contact_created: true,
      })
    })
  })

  describe('права и изоляция', () => {
    it('неизвестный, отключённый и старый после смены ключ — одинаковый 401; ключ API на /api/intake — 401; ключ источника на /api/v1 — 401', async () => {
      const reissued = await createSource()
      const fresh = await admin.api(
        'POST',
        `/v1/intake-sources/${reissued.source.id}/reissue-key`,
        {
          project: projectA,
        },
      )
      expect(fresh.status).toBe(200)
      const off = await createSource()
      expect(
        (
          await admin.api('POST', `/v1/intake-sources/${off.source.id}/disable`, {
            project: projectA,
          })
        ).status,
      ).toBe(200)
      const apiKey = await createApiKey(
        h,
        admin,
        projectA,
        await createRole(h, projectA, { actions: { deals: ['view'] }, scopes: {} } as never),
      )
      const body = { event_id: eventId(), phone: fakePhone() }
      const answers = await Promise.all(
        [`alpi_src_${'A'.repeat(43)}`, off.key, reissued.key, apiKey.secret, null].map((key) =>
          register(body, key as string),
        ),
      )
      for (const res of answers) {
        expect(res.status).toBe(401)
        expect(await problemOf(res)).toEqual({ code: 'INTAKE_KEY_INVALID' })
      }
      const onV1 = await bearer(h.app, source.key, 'GET', '/v1/deals')
      expect(onV1.status).toBe(401)
      expect(await contactsWithPhone(body.phone)).toEqual([])
    })

    it('ключ источника проекта A пишет только в проект A и воронку источника; регистрации и журнал A не видны в контексте B без фильтра в коде', async () => {
      const pipelineB = await createPipeline(projectB)
      const sourceB = await createSource(projectB, pipelineB.id)
      const phone = fakePhone()
      const inA = await accepted(await register({ event_id: eventId(), phone }))
      const inB = await accepted(await register({ event_id: eventId(), phone }, sourceB.key))
      expect(inB.contact_id).not.toBe(inA.contact_id)
      expect((await dealRow(inA.deal_id ?? '')).project_id).toBe(projectA)
      expect((await dealRow(inB.deal_id ?? '')).pipeline_id).toBe(pipelineB.id)

      const seen = async (projectId: string) =>
        withProject(h.appDb, projectId, async (trx) => ({
          registrations: (await trx.selectFrom('registration').select('id').execute()).map(
            (r) => r.id,
          ),
          journal: (await trx.selectFrom('inbound_request').select('project_id').execute()).map(
            (r) => r.project_id,
          ),
          events: (await trx.selectFrom('intake_event').select('project_id').execute()).map(
            (r) => r.project_id,
          ),
        }))
      const b = await seen(projectB)
      expect(b.registrations).toEqual([inB.registration_id])
      expect(new Set([...b.journal, ...b.events])).toEqual(new Set([projectB]))
      const a = await seen(projectA)
      expect(a.registrations).toContain(inA.registration_id)
      expect(a.registrations).not.toContain(inB.registration_id)
      expect(new Set([...a.journal, ...a.events])).toEqual(new Set([projectA]))
    })
  })

  describe('слияние', () => {
    it('слияние контактов переносит регистрации, откат возвращает', async () => {
      const phone = fakePhone()
      const first = await accepted(await register({ event_id: eventId(), phone }))
      const other = await createContact({ phones: [fakePhone()] })
      const merged = await admin.api('POST', `/v1/contacts/${other.id}/merge`, {
        project: projectA,
        body: { merge_contact_id: first.contact_id },
      })
      expect(merged.status).toBe(200)
      const { merge } = (await merged.json()) as { merge: { id: string } }
      expect((await registrationRow(first.registration_id ?? '')).contact_id).toBe(other.id)
      const undone = await admin.api('POST', `/v1/merges/${merge.id}/undo`, { project: projectA })
      expect(undone.status).toBe(200)
      expect((await registrationRow(first.registration_id ?? '')).contact_id).toBe(first.contact_id)
    })

    it('слияние сделок переносит регистрации, откат возвращает', async () => {
      const first = await accepted(await register({ event_id: eventId(), phone: fakePhone() }))
      const contact = await createContact({ phones: [fakePhone()] })
      const survivor = await createDeal(contact.id)
      const merged = await admin.api('POST', `/v1/deals/${survivor.id}/merge`, {
        project: projectA,
        body: { merge_deal_id: first.deal_id },
      })
      expect(merged.status).toBe(200)
      const { merge } = (await merged.json()) as { merge: { id: string } }
      expect((await registrationRow(first.registration_id ?? '')).deal_id).toBe(survivor.id)
      const undone = await admin.api('POST', `/v1/merges/${merge.id}/undo`, { project: projectA })
      expect(undone.status).toBe(200)
      expect((await registrationRow(first.registration_id ?? '')).deal_id).toBe(first.deal_id)
    })
  })

  describe('окончательное удаление', () => {
    it('контакт удалён из корзины навсегда — его регистрации удалены; повтор event_id — 200 без id, RECORDS_DELETED, ничего не создано', async () => {
      const body = { event_id: eventId(), phone: fakePhone() }
      const first = await accepted(await register(body))
      const trash = await admin.api(
        'DELETE',
        `/v1/contacts/${first.contact_id}?confirm=${first.deal_id}`,
        { project: projectA },
      )
      expect(trash.status).toBe(204)
      const purge = await admin.api('DELETE', `/v1/contacts/${first.contact_id}/permanent`, {
        project: projectA,
      })
      expect(purge.status).toBe(204)
      expect(
        await h.owner
          .selectFrom('registration')
          .select('id')
          .where('id', '=', first.registration_id ?? '')
          .execute(),
      ).toEqual([])

      const before = { contacts: await countOf('contact'), deals: await countOf('deal') }
      const again = await accepted(await register(body), 200)
      expect(again).toEqual({
        registration_id: null,
        contact_id: null,
        deal_id: null,
        deal_created: false,
        contact_created: false,
        warnings: ['RECORDS_DELETED'],
      })
      expect({ contacts: await countOf('contact'), deals: await countOf('deal') }).toEqual(before)
    })
  })
})
