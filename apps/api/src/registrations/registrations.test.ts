import {
  fullPermissions,
  type IntakeSourceWithKey,
  type Page,
  type RegistrationAccepted,
  type RolePermissions,
  type WebinarViewAccepted,
} from '@alpi/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ApiHarness, type SignedInUser, startApiHarness } from '../testing/api-harness.ts'
import { createApiKey, createRole, type KeyClient, keyRequest } from '../testing/api-key.ts'
import { problemOf } from '../testing/problem.ts'
import { RegistrationSchema } from './openapi.ts'
import type { RegistrationView } from './registrations.ts'

// Регистрации в API (тикет crm-intake/09) на настоящем PostgreSQL: API ходит ролью приложения,
// регистрации пишутся служебным подключением (их приём проверяет intake/registrations.test.ts).
// Изоляция проектов, право «сделки: смотреть» и охват, открытость ключу, порядок и курсор,
// слияние сделок, все поля ответа и описание OpenAPI. Имена, телефоны и email — выдуманные.

function permissions(change: (p: RolePermissions) => void = () => {}): RolePermissions {
  const p = fullPermissions()
  change(p)
  return p
}

let counter = 0
/** Время прихода регистраций: от базового момента по минутам, чтобы порядок был известен. */
const BASE = Date.parse('2026-11-10T08:00:00.000Z')
const at = (minutes: number) => new Date(BASE + minutes * 60_000)

describe('регистрации в API', () => {
  let h: ApiHarness
  let admin: SignedInUser
  /** Участник проекта A с ролью «сделки: свои». */
  let ownUser: SignedInUser
  let projectA: string
  let projectB: string
  let pipelineA: string
  let pipelineB: string
  /** Источник регистраций и его ключ (для настоящего приёма). */
  let sourceA: { id: string; name: string; key: string }
  let sourceB: { id: string; name: string; key: string }
  let full: KeyClient
  let noDeals: KeyClient
  /** Охват контактов «свои» (у ключа — созданные ключом), сделки — все. */
  let ownContacts: KeyClient
  let keyB: KeyClient

  async function json<T>(res: Response, status = 200): Promise<T> {
    const text = await res.text()
    expect(res.status, text).toBe(status)
    return JSON.parse(text) as T
  }

  async function createPipeline(projectId: string): Promise<string> {
    const n = ++counter
    const { id } = await h.owner
      .insertInto('pipeline')
      .values({ project_id: projectId, code: `rr${n}`, name: `Воронка ${n}`, position: 100 + n })
      .returning('id')
      .executeTakeFirstOrThrow()
    await h.owner
      .insertInto('stage')
      .values({ project_id: projectId, pipeline_id: id, name: 'Етап 1', position: 1 })
      .execute()
    return id
  }

  async function createSource(projectId: string, pipelineId: string) {
    const created = await json<IntakeSourceWithKey>(
      await admin.api('POST', '/v1/intake-sources', {
        project: projectId,
        body: { name: `Лендінг ${++counter}`, pipelineId },
      }),
      201,
    )
    return { ...created.source, key: created.key }
  }

  async function createContact(projectId = projectA) {
    return json<{ id: string }>(
      await admin.api('POST', '/v1/contacts', {
        project: projectId,
        body: { firstName: `Клієнт ${++counter}` },
      }),
      201,
    )
  }

  /** Сделка нового контакта; ответственный — `ownerId` (null — общая очередь). */
  async function createDeal({
    projectId = projectA,
    pipelineId = pipelineA,
    contactId,
    ownerId = admin.id,
  }: {
    projectId?: string
    pipelineId?: string
    contactId?: string
    ownerId?: string | null
  } = {}) {
    const contact = contactId ?? (await createContact(projectId)).id
    const deal = await json<{ id: string }>(
      await admin.api('POST', '/v1/deals', {
        project: projectId,
        body: { title: `Угода ${++counter}`, pipelineId, contactId: contact, ownerId },
      }),
      201,
    )
    return { id: deal.id, contactId: contact }
  }

  /** Регистрация служебным подключением: все поля пункта 12 и `extra`. */
  async function insertRegistration({
    projectId = projectA,
    sourceId = sourceA.id,
    contactId,
    dealId,
    createdAt,
    fields = {},
  }: {
    projectId?: string
    sourceId?: string
    contactId: string
    dealId: string | null
    createdAt: Date
    fields?: Record<string, string | null>
  }): Promise<string> {
    const n = ++counter
    const { id } = await h.owner
      .insertInto('registration')
      .values({
        project_id: projectId,
        intake_source_id: sourceId,
        event_id: `evt-${n}`,
        contact_id: contactId,
        deal_id: dealId,
        created_at: createdAt,
        name: `Олена ${n}`,
        phone: '+380670000001',
        email: `olena-${n}@example.test`,
        webinar: 'Вебінар 12 листопада',
        extra: JSON.stringify({ misto: 'Київ', n }),
        ...fields,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return id
  }

  /** Все страницы выдачи `path` по `limit`: id по порядку и число запросов. */
  async function walk(key: KeyClient, path: string, limit: number) {
    const ids: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const query = new URLSearchParams({ limit: String(limit) })
      if (cursor !== null) query.set('cursor', cursor)
      const page: Page<RegistrationView> = await json(await key.api('GET', `${path}?${query}`))
      ids.push(...page.data.map((r) => r.id))
      cursor = page.next_cursor
      pages++
    } while (cursor !== null && pages < 20)
    return { ids, pages }
  }

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_registrations_read')
    admin = await h.signIn('owner')
    ownUser = await h.signIn()
    projectA = (await h.createProject(admin, 'Проєкт А')).id
    projectB = (await h.createProject(admin, 'Проєкт Б')).id
    await h.addMember(projectA, ownUser.id)
    const ownRole = await createRole(
      h,
      projectA,
      permissions((p) => {
        p.scopes.deals = { read: 'own', write: 'own' }
      }),
    )
    await h.owner
      .updateTable('project_member')
      .set({ role_id: ownRole })
      .where('project_id', '=', projectA)
      .where('user_id', '=', ownUser.id)
      .execute()
    pipelineA = await createPipeline(projectA)
    pipelineB = await createPipeline(projectB)
    sourceA = await createSource(projectA, pipelineA)
    sourceB = await createSource(projectB, pipelineB)

    const key = async (projectId: string, p: RolePermissions) =>
      createApiKey(h, admin, projectId, await createRole(h, projectId, p))
    full = await key(projectA, permissions())
    noDeals = await key(
      projectA,
      permissions((p) => {
        p.actions.deals = []
      }),
    )
    ownContacts = await key(
      projectA,
      permissions((p) => {
        p.scopes.contacts = { read: 'own', write: 'own' }
      }),
    )
    keyB = await key(projectB, permissions())
  }, 180_000)

  afterAll(async () => {
    await h?.stop()
  })

  describe('изоляция проектов', () => {
    it('регистрация проекта A по id в контексте B — 404; списки B её не содержат', async () => {
      const dealA = await createDeal()
      const regA = await insertRegistration({
        contactId: dealA.contactId,
        dealId: dealA.id,
        createdAt: at(1),
      })
      const dealB = await createDeal({ projectId: projectB, pipelineId: pipelineB })
      const regB = await insertRegistration({
        projectId: projectB,
        sourceId: sourceB.id,
        contactId: dealB.contactId,
        dealId: dealB.id,
        createdAt: at(1),
      })

      const byId = await keyB.api('GET', `/v1/registrations/${regA}`)
      expect(byId.status).toBe(404)
      expect((await problemOf(byId)).code).toBe('REGISTRATION_NOT_FOUND')
      // Сделка и контакт A из проекта B не видны вовсе.
      expect((await keyB.api('GET', `/v1/deals/${dealA.id}/registrations`)).status).toBe(404)
      expect((await keyB.api('GET', `/v1/contacts/${dealA.contactId}/registrations`)).status).toBe(
        404,
      )
      // Сессия администратора обоих проектов в контексте B тоже не получает регистрацию A.
      expect(
        (await admin.api('GET', `/v1/registrations/${regA}`, { project: projectB })).status,
      ).toBe(404)

      const listB = await json<Page<RegistrationView>>(
        await keyB.api('GET', `/v1/deals/${dealB.id}/registrations`),
      )
      expect(listB.data.map((r) => r.id)).toEqual([regB])
      const listA = await json<Page<RegistrationView>>(
        await full.api('GET', `/v1/deals/${dealA.id}/registrations`),
      )
      expect(listA.data.map((r) => r.id)).toEqual([regA])
      expect((await full.api('GET', `/v1/registrations/${regB}`)).status).toBe(404)
    })
  })

  describe('права и охват', () => {
    it('ключ без «сделки: смотреть» — 403 на всех трёх маршрутах', async () => {
      const deal = await createDeal()
      const reg = await insertRegistration({
        contactId: deal.contactId,
        dealId: deal.id,
        createdAt: at(2),
      })
      for (const path of [
        `/v1/registrations/${reg}`,
        `/v1/deals/${deal.id}/registrations`,
        `/v1/contacts/${deal.contactId}/registrations`,
      ]) {
        const res = await noDeals.api('GET', path)
        expect([path, res.status]).toEqual([path, 403])
        expect((await problemOf(res)).code).toBe('PERMISSION_DENIED')
      }
    })

    it('маршруты открыты ключу: нет API_KEY_NOT_ALLOWED', async () => {
      const deal = await createDeal()
      const reg = await insertRegistration({
        contactId: deal.contactId,
        dealId: deal.id,
        createdAt: at(3),
      })
      for (const path of [
        `/v1/registrations/${reg}`,
        `/v1/deals/${deal.id}/registrations`,
        `/v1/contacts/${deal.contactId}/registrations`,
      ]) {
        const res = await full.api('GET', path)
        expect([path, res.status]).toEqual([path, 200])
      }
    })

    it('охват «свои»: регистрация чужой сделки — 404, своей — видна', async () => {
      const mine = await createDeal({ ownerId: ownUser.id })
      const foreign = await createDeal({ ownerId: admin.id })
      const regMine = await insertRegistration({
        contactId: mine.contactId,
        dealId: mine.id,
        createdAt: at(4),
      })
      const regForeign = await insertRegistration({
        contactId: foreign.contactId,
        dealId: foreign.id,
        createdAt: at(4),
      })
      const get = (path: string) => ownUser.api('GET', path, { project: projectA })

      const own = await json<RegistrationView>(await get(`/v1/registrations/${regMine}`))
      expect(own.id).toBe(regMine)
      const page = await json<Page<RegistrationView>>(
        await get(`/v1/deals/${mine.id}/registrations`),
      )
      expect(page.data.map((r) => r.id)).toEqual([regMine])

      const hidden = await get(`/v1/registrations/${regForeign}`)
      expect(hidden.status).toBe(404)
      expect((await problemOf(hidden)).code).toBe('REGISTRATION_NOT_FOUND')
      expect((await get(`/v1/deals/${foreign.id}/registrations`)).status).toBe(404)
      // Контакт чужой сделки виден (охват контактов — все), но регистрации его чужой сделки — нет.
      const contactPage = await json<Page<RegistrationView>>(
        await get(`/v1/contacts/${foreign.contactId}/registrations`),
      )
      expect(contactPage.data).toEqual([])
    })

    it('регистрация без сделки видна только с охватом сделок «все»', async () => {
      const contact = await createContact()
      const reg = await insertRegistration({
        contactId: contact.id,
        dealId: null,
        createdAt: at(5),
      })
      const view = await json<RegistrationView>(await full.api('GET', `/v1/registrations/${reg}`))
      expect(view.dealId).toBeNull()
      expect(view.dealTitle).toBeNull()
      expect(
        (
          await json<Page<RegistrationView>>(
            await full.api('GET', `/v1/contacts/${contact.id}/registrations`),
          )
        ).data.map((r) => r.id),
      ).toEqual([reg])
      expect(
        (await ownUser.api('GET', `/v1/registrations/${reg}`, { project: projectA })).status,
      ).toBe(404)
    })

    it('контакт вне охвата чтения контактов: имя, телефон и email — null, остальное видно', async () => {
      const deal = await createDeal()
      const reg = await insertRegistration({
        contactId: deal.contactId,
        dealId: deal.id,
        createdAt: at(6),
        fields: { phone_raw: '067 000', dial_code: '+380', form: 'Форма' },
      })
      const view = await json<RegistrationView>(
        await ownContacts.api('GET', `/v1/registrations/${reg}`),
      )
      expect(view).toMatchObject({
        id: reg,
        name: null,
        phone: null,
        phoneRaw: null,
        dialCode: null,
        email: null,
        form: 'Форма',
        webinar: 'Вебінар 12 листопада',
      })
      // Контакт вне охвата — и список его регистраций 404, как у несуществующего.
      expect(
        (await ownContacts.api('GET', `/v1/contacts/${deal.contactId}/registrations`)).status,
      ).toBe(404)
    })

    it('контакт вне охвата: extra, адрес страницы и referrer тоже скрыты (телефон массивом лёг в extra)', async () => {
      // Настоящий приём: телефон массивом — не той формы, поэтому уходит в extra.phone;
      // неизвестный ключ — тоже в extra; адрес страницы и referrer несут email и телефон.
      const accepted = await json<RegistrationAccepted>(
        await keyRequest(h.app, sourceA.key, 'POST', '/intake/registrations', {
          body: {
            event_id: `evt-pd-${++counter}`,
            email: `pd-${counter}@example.test`,
            phone: ['+380671112299'],
            telegram: '@olena_vyhadana',
            page_url: 'https://example.test/kurs?email=olena%40example.test',
            referrer: 'https://example.test/form?phone=380671112299',
          },
        }),
        201,
      )
      const id = accepted.registration_id ?? ''
      const open = await json<RegistrationView>(await full.api('GET', `/v1/registrations/${id}`))
      expect(open.extra).toEqual({ phone: ['+380671112299'], telegram: '@olena_vyhadana' })
      expect(open.pageUrl).toBe('https://example.test/kurs?email=olena%40example.test')
      expect(open.referrer).toBe('https://example.test/form?phone=380671112299')

      // Контакт создан приёмом (не ключом), а сделку берёт администратор (без ответственного она
      // в общей очереди и открыла бы контакт): для охвата контактов «свои» контакт чужой.
      await h.owner
        .updateTable('deal')
        .set({ owner_id: admin.id })
        .where('id', '=', accepted.deal_id ?? '')
        .execute()
      const hidden = await json<RegistrationView>(
        await ownContacts.api('GET', `/v1/registrations/${id}`),
      )
      expect(hidden.extra).toEqual({})
      expect(hidden).toMatchObject({
        id,
        email: null,
        phone: null,
        phoneRaw: null,
        extra: {},
        pageUrl: null,
        referrer: null,
      })
      const page = await json<Page<RegistrationView>>(
        await ownContacts.api('GET', `/v1/deals/${accepted.deal_id}/registrations`),
      )
      expect(page.data.map((r) => [r.id, r.extra, r.pageUrl, r.referrer])).toEqual([
        [id, {}, null, null],
      ])
    })

    it('регистрация сделки в корзине — 404 по id и нет в списке контакта', async () => {
      const contact = await createContact()
      const live = await createDeal({ contactId: contact.id })
      const trashed = await createDeal({
        contactId: contact.id,
        pipelineId: await createPipeline(projectA),
      })
      const regLive = await insertRegistration({
        contactId: contact.id,
        dealId: live.id,
        createdAt: at(7),
      })
      const regTrashed = await insertRegistration({
        contactId: contact.id,
        dealId: trashed.id,
        createdAt: at(8),
      })
      const removed = await admin.api('DELETE', `/v1/deals/${trashed.id}`, { project: projectA })
      expect(removed.status, await removed.text()).toBeLessThan(300)

      const byId = await full.api('GET', `/v1/registrations/${regTrashed}`)
      expect(byId.status).toBe(404)
      expect((await problemOf(byId)).code).toBe('REGISTRATION_NOT_FOUND')
      const list = await json<Page<RegistrationView>>(
        await full.api('GET', `/v1/contacts/${contact.id}/registrations`),
      )
      expect(list.data.map((r) => r.id)).toEqual([regLive])
    })
  })

  describe('списки', () => {
    it('новые сверху; курсор отдаёт все регистрации без повторов и пропусков', async () => {
      const contact = await createContact()
      const first = await createDeal({ contactId: contact.id })
      // Вторая сделка того же контакта — в другой воронке (одна открытая сделка на воронку).
      const second = await createDeal({
        contactId: contact.id,
        pipelineId: await createPipeline(projectA),
      })
      // Семь регистраций: две — в одно и то же время (порядок между ними — по id), и они стоят
      // третьей и четвёртой — на границе первой страницы по 3: курсор без id потерял бы вторую.
      const minutes = [10, 11, 12, 13, 13, 14, 15]
      const rows: { id: string; minute: number; deal: string }[] = []
      for (const [i, minute] of minutes.entries()) {
        const dealId = i % 2 === 0 ? first.id : second.id
        rows.push({
          id: await insertRegistration({ contactId: contact.id, dealId, createdAt: at(minute) }),
          minute,
          deal: dealId,
        })
      }
      const order = (list: typeof rows) =>
        [...list]
          .sort((a, b) => b.minute - a.minute || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0))
          .map((r) => r.id)

      const contactWalk = await walk(full, `/v1/contacts/${contact.id}/registrations`, 3)
      expect(contactWalk.ids).toEqual(order(rows))
      expect(contactWalk.pages).toBe(3)
      expect(new Set(contactWalk.ids).size).toBe(rows.length)

      const dealWalk = await walk(full, `/v1/deals/${first.id}/registrations`, 2)
      expect(dealWalk.ids).toEqual(order(rows.filter((r) => r.deal === first.id)))

      const all = await json<Page<RegistrationView>>(
        await full.api('GET', `/v1/contacts/${contact.id}/registrations`),
      )
      expect(all.next_cursor).toBeNull()
      // Карточка контакта ссылается на сделку: у каждой строки — её название.
      expect(all.data.every((r) => typeof r.dealTitle === 'string')).toBe(true)

      const bad = await full.api('GET', `/v1/deals/${first.id}/registrations?cursor=nonsense`)
      expect(bad.status).toBe(400)
      expect((await full.api('GET', `/v1/deals/${first.id}/registrations?limit=0`)).status).toBe(
        400,
      )
    })

    it('после слияния сделок регистрации второй — в списке оставшейся', async () => {
      const survivor = await createDeal()
      const merged = await createDeal()
      const own = await insertRegistration({
        contactId: survivor.contactId,
        dealId: survivor.id,
        createdAt: at(20),
      })
      const moved = await insertRegistration({
        contactId: merged.contactId,
        dealId: merged.id,
        createdAt: at(21),
      })
      await json(
        await admin.api('POST', `/v1/deals/${survivor.id}/merge`, {
          project: projectA,
          body: { merge_deal_id: merged.id },
        }),
      )
      const page = await json<Page<RegistrationView>>(
        await full.api('GET', `/v1/deals/${survivor.id}/registrations`),
      )
      expect(page.data.map((r) => r.id)).toEqual([moved, own])
      expect(page.data[0]?.dealId).toBe(survivor.id)
      // Слитая сделка скрыта: её список — 404, регистрация по id — у оставшейся.
      expect((await full.api('GET', `/v1/deals/${merged.id}/registrations`)).status).toBe(404)
      const view = await json<RegistrationView>(await full.api('GET', `/v1/registrations/${moved}`))
      expect(view.dealId).toBe(survivor.id)
    })
  })

  describe('ответ и описание API', () => {
    it('просмотр вебинара (тикет 08) приходит в регистрации; вне охвата контактов его extra скрыт', async () => {
      const email = `view-${++counter}@example.test`
      const webinar = 'Вебінар 26 листопада'
      const accepted = await json<RegistrationAccepted>(
        await keyRequest(h.app, sourceA.key, 'POST', '/intake/registrations', {
          body: { event_id: `evt-reg-${counter}`, email, webinar },
        }),
        201,
      )
      const id = accepted.registration_id ?? ''
      // До просмотра — null.
      expect(
        (await json<RegistrationView>(await full.api('GET', `/v1/registrations/${id}`))).view,
      ).toBeNull()

      const watched = await json<WebinarViewAccepted>(
        await keyRequest(h.app, sourceA.key, 'POST', '/intake/webinar-views', {
          body: {
            event_id: `evt-view-${counter}`,
            email,
            webinar,
            started_at: '2026-11-26T18:00:00.000Z',
            finished_at: '2026-11-26T19:05:00.000Z',
            minutes: 65,
            vidsotok: 90,
          },
        }),
      )
      expect(watched).toMatchObject({ matched: true, registration_id: id })

      const raw = await json<Record<string, unknown>>(
        await full.api('GET', `/v1/registrations/${id}`),
      )
      const view = RegistrationSchema.parse(raw)
      expect(view.view).toEqual({
        startedAt: '2026-11-26T18:00:00.000Z',
        finishedAt: '2026-11-26T19:05:00.000Z',
        minutes: 65,
        extra: { vidsotok: 90 },
        updatedAt: expect.any(String),
      })
      const listed = await json<Page<RegistrationView>>(
        await full.api('GET', `/v1/deals/${accepted.deal_id}/registrations`),
      )
      expect(listed.data[0]?.view).toEqual(view.view)

      // Контакт вне охвата «свои»: время и минуты видны, лишние ключи платформы — нет.
      await h.owner
        .updateTable('deal')
        .set({ owner_id: admin.id })
        .where('id', '=', accepted.deal_id ?? '')
        .execute()
      const hidden = await json<RegistrationView>(
        await ownContacts.api('GET', `/v1/registrations/${id}`),
      )
      expect(hidden.view).toEqual({ ...view.view, extra: null })
    })

    it('все поля пункта 12, extra и просмотр приходят и совпадают со схемой описания', async () => {
      const deal = await createDeal()
      const fields = {
        name: 'Олена Вигадана',
        phone: '+380671112233',
        phone_raw: '+38 (067) 111-22-33',
        dial_code: '+380',
        email: 'olena.vyhadana@example.test',
        form: 'Форма на головній',
        webinar: 'Вебінар 12 листопада',
        plan_name: 'Базовий',
        page_url: 'https://example.test/course',
        referrer: 'https://www.google.com/',
        utm_source: 'facebook',
        utm_medium: 'cpc',
        utm_campaign: 'osin',
        utm_term: 'kurs',
        utm_content: 'banner',
        ad_id: 'ad-1',
        gclid: 'g-1',
        gbraid: 'gb-1',
        wbraid: 'wb-1',
        fbclid: 'fb-1',
        fbp: 'fbp-1',
        fbc: 'fbc-1',
        user_agent: 'Mozilla/5.0 (test)',
        registered_at: at(29).toISOString(),
      }
      const reg = await insertRegistration({
        contactId: deal.contactId,
        dealId: deal.id,
        createdAt: at(30),
        fields,
      })
      const raw = await json<Record<string, unknown>>(
        await full.api('GET', `/v1/registrations/${reg}`),
      )
      // Ответ — ровно схема описания: строгая схема не пропускает ни лишних, ни недостающих полей.
      const view = RegistrationSchema.parse(raw)
      expect(view).toEqual({
        id: reg,
        sourceId: sourceA.id,
        sourceName: sourceA.name,
        contactId: deal.contactId,
        dealId: deal.id,
        dealTitle: expect.stringMatching(/^Угода /),
        eventId: expect.stringMatching(/^evt-/),
        createdAt: at(30).toISOString(),
        registeredAt: at(29).toISOString(),
        name: fields.name,
        phone: fields.phone,
        phoneRaw: fields.phone_raw,
        dialCode: fields.dial_code,
        email: fields.email,
        form: fields.form,
        webinar: fields.webinar,
        planName: fields.plan_name,
        pageUrl: fields.page_url,
        referrer: fields.referrer,
        utmSource: fields.utm_source,
        utmMedium: fields.utm_medium,
        utmCampaign: fields.utm_campaign,
        utmTerm: fields.utm_term,
        utmContent: fields.utm_content,
        adId: fields.ad_id,
        gclid: fields.gclid,
        gbraid: fields.gbraid,
        wbraid: fields.wbraid,
        fbclid: fields.fbclid,
        fbp: fields.fbp,
        fbc: fields.fbc,
        userAgent: fields.user_agent,
        extra: { misto: 'Київ', n: expect.any(Number) },
        view: null,
      })

      // Описание: три маршрута в /api/v1/openapi.json, схема Registration — те же поля, что в ответе.
      type Operation = { responses: Record<string, { content?: Record<string, unknown> }> }
      const doc = await json<{
        paths: Record<string, Record<string, Operation>>
        components: { schemas: Record<string, { properties?: Record<string, unknown> }> }
      }>(await full.api('GET', '/v1/openapi.json'))
      for (const path of [
        '/registrations/{id}',
        '/deals/{id}/registrations',
        '/contacts/{id}/registrations',
      ]) {
        expect([path, doc.paths[path]?.get?.responses['200']?.content]).toEqual([
          path,
          expect.objectContaining({ 'application/json': expect.anything() }),
        ])
      }
      expect(Object.keys(doc.components.schemas.Registration?.properties ?? {}).sort()).toEqual(
        Object.keys(raw).sort(),
      )
      expect(Object.keys(doc.components.schemas.RegistrationView?.properties ?? {}).sort()).toEqual(
        ['extra', 'finishedAt', 'minutes', 'startedAt', 'updatedAt'],
      )
    })
  })
})
