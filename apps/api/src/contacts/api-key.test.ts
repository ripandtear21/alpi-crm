import {
  type FieldGroupSummary,
  fullPermissions,
  type ProjectUser,
  type RolePermissions,
  type TeamSummary,
} from '@alpi/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DealView } from '../deals/store.ts'
import type { NoteView } from '../notes/notes.ts'
import type { OrganizationView } from '../organizations/organizations.ts'
import {
  type ApiHarness,
  type Method,
  type SignedInUser,
  startApiHarness,
} from '../testing/api-harness.ts'
import { createApiKey, createRole, type KeyClient } from '../testing/api-key.ts'
import { problemOf } from '../testing/problem.ts'
import type { TimelinePage } from '../timeline/timeline.ts'
import type { ContactSearchPage, ContactView } from './contacts.ts'

// Контакты, организации, заметки и справочники по ключу API (тикет crm-api/04) на настоящем
// PostgreSQL, API ходит ролью приложения: изоляция проектов, права роли ключа, поиск по
// телефону и email с «чужим клиентом», правила дублей, охват «свои» у ключа, автор-ключ заметок
// и истории, закрытые для ключа маршруты, описание OpenAPI. Имена, телефоны и email — выдуманные.

/** Полные права, кроме того, что меняет `change`. */
function permissions(change: (p: RolePermissions) => void = () => {}): RolePermissions {
  const p = fullPermissions()
  change(p)
  return p
}

const PHONE = '+380671234567'
const EMAIL = 'olena.vyhadana@example.test'

describe('контакты, организации, заметки и справочники по ключу API', () => {
  let h: ApiHarness
  let admin: SignedInUser
  let manager: SignedInUser
  let disabledMember: SignedInUser
  let memberB: SignedInUser
  let projectA: string
  let projectB: string
  let pipelineA: string
  let contactA: string
  let contactB: string
  /** Ключи проекта A: все права; только смотреть; без «сделок»; без «пользователей и ролей». */
  let full: KeyClient
  let otherFull: KeyClient
  let viewOnly: KeyClient
  let noDeals: KeyClient
  let noUsersView: KeyClient
  /** Охват контактов «свои» (и сделок «свои»): только созданное ключом и общая очередь. */
  let own: KeyClient
  let hiddenFields: KeyClient
  let keyB: KeyClient
  let counter = 0

  async function json<T>(res: Response, status = 200): Promise<T> {
    const text = await res.text()
    expect(res.status, text).toBe(status)
    return JSON.parse(text) as T
  }

  async function createPipeline(projectId: string): Promise<string> {
    const n = ++counter
    const { id } = await h.owner
      .insertInto('pipeline')
      .values({ project_id: projectId, code: `ref${n}`, name: `Воронка ${n}`, position: n })
      .returning('id')
      .executeTakeFirstOrThrow()
    await h.owner
      .insertInto('stage')
      .values({ project_id: projectId, pipeline_id: id, name: `Етап ${n}`, position: 1 })
      .execute()
    return id
  }

  /** Контакт по сессии `user` (создатель — он). */
  async function sessionContact(
    user: SignedInUser,
    projectId: string,
    body: Record<string, unknown>,
  ): Promise<ContactView> {
    return json<ContactView>(
      await user.api('POST', '/v1/contacts', { project: projectId, body }),
      201,
    )
  }

  const search = (key: KeyClient, query: Record<string, string>) =>
    key.api('GET', `/v1/contacts?${new URLSearchParams(query)}`)

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_contacts_api_key')
    admin = await h.signIn('owner')
    manager = await h.signIn()
    disabledMember = await h.signIn()
    memberB = await h.signIn()
    projectA = (await h.createProject(admin, 'Проєкт А')).id
    projectB = (await h.createProject(admin, 'Проєкт Б')).id
    await h.addMember(projectA, manager.id)
    await h.addMember(projectA, disabledMember.id)
    await h.owner
      .updateTable('project_member')
      .set({ disabled_at: new Date() })
      .where('project_id', '=', projectA)
      .where('user_id', '=', disabledMember.id)
      .execute()
    await h.addMember(projectB, memberB.id)
    pipelineA = await createPipeline(projectA)
    // Воронка B — для проверки, что справочник ключа A её не отдаёт.
    await createPipeline(projectB)

    // Тот же телефон и email в проектах A и B: ключ одного проекта не находит контакт другого.
    contactA = (
      await sessionContact(admin, projectA, {
        firstName: 'Олена',
        lastName: 'Вигадана',
        phones: [PHONE],
        emails: [EMAIL],
      })
    ).id
    contactB = (
      await sessionContact(admin, projectB, {
        firstName: 'Олена',
        lastName: 'Вигадана',
        phones: [PHONE],
        emails: [EMAIL],
      })
    ).id

    const key = async (projectId: string, p: RolePermissions, name?: string) =>
      createApiKey(h, admin, projectId, await createRole(h, projectId, p), name)
    full = await key(projectA, permissions(), 'Інтеграція n8n')
    otherFull = await key(projectA, permissions(), 'Інша інтеграція')
    viewOnly = await key(
      projectA,
      permissions((p) => {
        p.actions.contacts = ['view']
        p.actions.organizations = ['view']
      }),
    )
    noDeals = await key(
      projectA,
      permissions((p) => {
        p.actions.deals = []
      }),
    )
    noUsersView = await key(
      projectA,
      permissions((p) => {
        p.actions.users_roles = []
      }),
    )
    own = await key(
      projectA,
      permissions((p) => {
        p.scopes.contacts = { read: 'own', write: 'own' }
        p.scopes.deals = { read: 'own', write: 'own' }
      }),
    )
    keyB = await key(projectB, permissions())

    // Пользовательские поля контактов A: открытая группа и скрытая для ключа hiddenFields.
    const group = async (nameUk: string) =>
      json<FieldGroupSummary>(
        await admin.api('POST', '/v1/field-groups', {
          project: projectA,
          body: { entity: 'contact', nameUk },
        }),
        201,
      )
    const field = async (groupId: string, code: string) =>
      json(
        await admin.api('POST', '/v1/fields', {
          project: projectA,
          body: { groupId, nameUk: `Поле ${code}`, code, type: 'text' },
        }),
        201,
      )
    const openGroup = await group('Відкрита')
    const secretGroup = await group('Таємна')
    await field(openGroup.id, 'dzherelo')
    await field(secretGroup.id, 'sekret')
    hiddenFields = await key(
      projectA,
      permissions((p) => {
        p.fieldGroups = { [secretGroup.id]: 'hidden' }
      }),
    )
  }, 180_000)

  afterAll(async () => {
    await h?.stop()
  })

  describe('поиск контакта по телефону и email', () => {
    it('«067 123 45 67», «+380671234567» и «(067) 123-45-67» находят один контакт; email — в другом регистре', async () => {
      for (const phone of ['067 123 45 67', PHONE, '(067) 123-45-67']) {
        const page = await json<ContactSearchPage>(await search(full, { phone }))
        expect(
          page.data.map((c) => c.id),
          phone,
        ).toEqual([contactA])
        expect(page.next_cursor).toBeNull()
        expect(page.outOfScope).toBeNull()
      }
      const byEmail = await json<ContactSearchPage>(
        await search(full, { email: EMAIL.toUpperCase() }),
      )
      expect(byEmail.data.map((c) => c.id)).toEqual([contactA])
      expect(byEmail.data[0]).toMatchObject({ phones: [PHONE], emails: [EMAIL] })
      const both = await json<ContactSearchPage>(
        await search(full, { phone: '0671234567', email: 'Olena.Vyhadana@Example.Test' }),
      )
      expect(both.data.map((c) => c.id)).toEqual([contactA])
      expect(
        (await json<ContactSearchPage>(await search(full, { phone: '+380670000999' }))).data,
      ).toEqual([])
    })

    it('ключ проекта B не находит контакт проекта A с теми же данными — только свой', async () => {
      for (const query of [{ phone: PHONE }, { email: EMAIL }]) {
        const page = await json<ContactSearchPage>(await search(keyB, query))
        expect(page).toEqual({
          data: [expect.objectContaining({ id: contactB })],
          next_cursor: null,
          outOfScope: null,
        })
      }
      const res = await keyB.api('GET', `/v1/contacts/${contactA}`)
      expect(res.status).toBe(404)
      expect(await problemOf(res)).toEqual({ code: 'CONTACT_NOT_FOUND' })
    })

    it('контакт вне охвата ключа — «чужой клиент» без имени, телефона, email и id', async () => {
      const managerName = (
        await h.owner
          .selectFrom('user')
          .select('name')
          .where('id', '=', manager.id)
          .executeTakeFirstOrThrow()
      ).name
      // Контакт в работе у менеджера: создал менеджер, открытая сделка — его.
      const foreign = await sessionContact(manager, projectA, {
        firstName: 'Таємна',
        lastName: 'Клієнтка',
        phones: ['+380509990011'],
        emails: ['tayemna.kliyentka@example.test'],
      })
      await h.owner
        .insertInto('deal')
        .values({
          project_id: projectA,
          title: 'Угода менеджера',
          pipeline_id: pipelineA,
          stage_id: (
            await h.owner
              .selectFrom('stage')
              .select('id')
              .where('pipeline_id', '=', pipelineA)
              .executeTakeFirstOrThrow()
          ).id,
          primary_contact_id: foreign.id,
          owner_id: manager.id,
        })
        .execute()
      for (const query of [
        { phone: '050 999 00 11' },
        { email: 'TAYEMNA.KLIYENTKA@example.test' },
      ]) {
        const res = await search(own, query)
        const text = await res.text()
        expect(res.status, text).toBe(200)
        expect(JSON.parse(text)).toEqual({
          data: [],
          next_cursor: null,
          outOfScope: { managerName },
        })
        for (const secret of [foreign.id, 'Таємна', 'Клієнтка', '380509990011', 'tayemna']) {
          expect(text).not.toContain(secret)
        }
      }
      // Ключ со всеми правами видит его как обычно.
      const visible = await json<ContactSearchPage>(await search(full, { phone: '0509990011' }))
      expect(visible.data.map((c) => c.id)).toEqual([foreign.id])
    })

    it('неразбираемый телефон — 422; без телефона и email — 400; прежняя выдача ключу закрыта', async () => {
      const bad = await search(full, { phone: 'не телефон' })
      expect(bad.status).toBe(422)
      expect((await problemOf(bad)).code).toBe('INVALID_PHONE')
      const none = await full.api('GET', '/v1/contacts?q=Олена')
      expect(none.status).toBe(400)
      expect((await problemOf(none)).code).toBe('INVALID_CONTACT')
    })
  })

  describe('создание и изменение контакта ключом', () => {
    it('телефон видимого контакта — 409 со ссылкой; совпал только email — «возможный дубль»', async () => {
      const taken = await full.api('POST', '/v1/contacts', {
        body: { firstName: 'Двійник', phones: ['(067) 123-45-67'] },
      })
      expect(taken.status).toBe(409)
      expect(await problemOf(taken)).toEqual({
        code: 'CONTACT_EXISTS',
        details: { contactId: contactA },
      })

      const duplicate = await json<ContactView>(
        await full.api('POST', '/v1/contacts', {
          body: { firstName: 'Ольга', emails: [EMAIL.toUpperCase()], language: 'uk' },
        }),
        201,
      )
      expect(duplicate).toMatchObject({
        firstName: 'Ольга',
        possibleDuplicate: true,
        emails: [EMAIL],
        createdBy: null,
      })
      const row = await h.owner
        .selectFrom('contact')
        .select(['created_by', 'created_by_api_key_id'])
        .where('id', '=', duplicate.id)
        .executeTakeFirstOrThrow()
      expect(row).toEqual({ created_by: null, created_by_api_key_id: full.id })
    })

    it('PATCH меняет переданные поля, история — с автором-ключом; телефон приводится к E.164', async () => {
      const created = await json<ContactView>(
        await full.api('POST', '/v1/contacts', {
          body: { firstName: 'Марта', phones: ['063 111 22 33'] },
        }),
        201,
      )
      expect(created.phones).toEqual(['+380631112233'])
      const patched = await json<ContactView>(
        await full.api('PATCH', `/v1/contacts/${created.id}`, {
          body: { lastName: 'Вигадана', language: 'ru' },
        }),
      )
      expect(patched).toMatchObject({ firstName: 'Марта', lastName: 'Вигадана', language: 'ru' })
      const log = await h.owner
        .selectFrom('change_log')
        .select(['field', 'actor_id', 'actor_api_key_id'])
        .where('entity_id', '=', created.id)
        .orderBy('field')
        .execute()
      expect(log).toEqual([
        { field: 'language', actor_id: null, actor_api_key_id: full.id },
        { field: 'lastName', actor_id: null, actor_api_key_id: full.id },
      ])
      const invalid = await full.api('PATCH', `/v1/contacts/${created.id}`, {
        body: { phones: ['123'] },
      })
      expect(invalid.status).toBe(422)
      expect((await problemOf(invalid)).code).toBe('INVALID_PHONE')
      const unknown = await full.api('PATCH', `/v1/contacts/${created.id}`, {
        body: { owner: 'x' },
      })
      expect(unknown.status).toBe(400)
      expect((await problemOf(unknown)).code).toBe('INVALID_CONTACT')
    })

    it('охват контактов «свои»: ключ видит созданный им контакт и создаёт сделку с новым контактом', async () => {
      const mine = await json<ContactView>(
        await own.api('POST', '/v1/contacts', {
          body: { firstName: 'Власна', phones: ['+380931234500'] },
        }),
        201,
      )
      expect((await own.api('GET', `/v1/contacts/${mine.id}`)).status).toBe(200)
      expect(
        (await json<ContactSearchPage>(await search(own, { phone: '093 123 45 00' }))).data.map(
          (c) => c.id,
        ),
      ).toEqual([mine.id])
      // Чужой ключ того же проекта с тем же охватом контакт не видит.
      const otherOwn = await createApiKey(
        h,
        admin,
        projectA,
        await createRole(
          h,
          projectA,
          permissions((p) => {
            p.scopes.contacts = { read: 'own', write: 'own' }
          }),
        ),
      )
      expect((await otherOwn.api('GET', `/v1/contacts/${mine.id}`)).status).toBe(404)
      // Долг тикета 03: сделка с новым контактом у ключа с охватом контактов «свои».
      const deal = await json<DealView>(
        await own.api('POST', '/v1/deals', {
          body: {
            title: 'Угода ключа',
            pipelineId: pipelineA,
            contact: { firstName: 'Новий', phones: ['+380931234501'] },
          },
        }),
        201,
      )
      expect(deal.ownerId).toBeNull()
      expect((await own.api('GET', `/v1/contacts/${deal.primaryContactId}`)).status).toBe(200)
    })

    it('пользовательские поля: скрытая для роли ключа группа не отдаётся', async () => {
      const contact = await sessionContact(admin, projectA, {
        firstName: 'Поля',
        custom: { dzherelo: 'Сайт', sekret: 'Таємне' },
      })
      const seen = await json<ContactView>(
        await hiddenFields.api('GET', `/v1/contacts/${contact.id}`),
      )
      expect(seen.custom).toEqual({ dzherelo: 'Сайт' })
      expect(
        (await json<ContactView>(await full.api('GET', `/v1/contacts/${contact.id}`))).custom,
      ).toEqual({ dzherelo: 'Сайт', sekret: 'Таємне' })
    })

    it('без «контакты: создавать / изменять» — 403', async () => {
      const create = await viewOnly.api('POST', '/v1/contacts', { body: { firstName: 'Ні' } })
      expect(create.status).toBe(403)
      expect(await problemOf(create)).toEqual({ code: 'PERMISSION_DENIED' })
      const patch = await viewOnly.api('PATCH', `/v1/contacts/${contactA}`, {
        body: { lastName: 'Ні' },
      })
      expect(patch.status).toBe(403)
      expect(await problemOf(patch)).toEqual({ code: 'PERMISSION_DENIED' })
      expect((await viewOnly.api('GET', `/v1/contacts/${contactA}`)).status).toBe(200)
    })

    it('удаление контакта и организации, восстановление и PUT по ключу — 403 API_KEY_NOT_ALLOWED', async () => {
      const organization = await json<OrganizationView>(
        await full.api('POST', '/v1/organizations', { body: { name: 'Під видалення' } }),
        201,
      )
      const closed: [Method, string][] = [
        ['DELETE', `/v1/contacts/${contactA}`],
        ['POST', `/v1/contacts/${contactA}/restore`],
        ['DELETE', `/v1/contacts/${contactA}/permanent`],
        ['PUT', `/v1/contacts/${contactA}`],
        ['DELETE', `/v1/organizations/${organization.id}`],
        ['POST', `/v1/organizations/${organization.id}/restore`],
        ['PUT', `/v1/organizations/${organization.id}`],
        ['GET', '/v1/contacts/list'],
        ['GET', `/v1/contacts/${contactA}/files`],
      ]
      for (const [method, path] of closed) {
        const res = await full.api(method, path, method === 'GET' ? {} : { body: { name: 'x' } })
        expect([method, path, res.status]).toEqual([method, path, 403])
        expect(await problemOf(res)).toEqual({ code: 'API_KEY_NOT_ALLOWED' })
      }
      const row = await h.owner
        .selectFrom('contact')
        .select('deleted_at')
        .where('id', '=', contactA)
        .executeTakeFirstOrThrow()
      expect(row.deleted_at).toBeNull()
    })
  })

  describe('организации', () => {
    it('создать, прочитать, изменить и найти по названию с курсором', async () => {
      const names = ['Вигадана школа Альфа', 'Вигадана школа Бета', 'Вигадана школа Гама']
      const created: OrganizationView[] = []
      for (const name of names) {
        created.push(
          await json<OrganizationView>(
            await full.api('POST', '/v1/organizations', { body: { name } }),
            201,
          ),
        )
      }
      const first = created[0] as OrganizationView
      expect(first).toMatchObject({ name: names[0], createdBy: null })
      expect(
        (await json<OrganizationView>(await full.api('GET', `/v1/organizations/${first.id}`))).name,
      ).toBe(names[0])
      const patched = await json<OrganizationView>(
        await full.api('PATCH', `/v1/organizations/${first.id}`, {
          body: { website: 'https://alfa.example.test' },
        }),
      )
      expect(patched).toMatchObject({ name: names[0], website: 'https://alfa.example.test' })
      const log = await h.owner
        .selectFrom('change_log')
        .select(['field', 'actor_api_key_id'])
        .where('entity_id', '=', first.id)
        .execute()
      expect(log).toEqual([{ field: 'website', actor_api_key_id: full.id }])

      const page1 = await json<{ data: OrganizationView[]; next_cursor: string | null }>(
        await full.api(
          'GET',
          `/v1/organizations?${new URLSearchParams({ name: 'вигадана ШКОЛА', limit: '2' })}`,
        ),
      )
      expect(page1.data.map((o) => o.name)).toEqual(names.slice(0, 2))
      expect(page1.next_cursor).not.toBeNull()
      const page2 = await json<{ data: OrganizationView[]; next_cursor: string | null }>(
        await full.api(
          'GET',
          `/v1/organizations?${new URLSearchParams({ name: 'вигадана ШКОЛА', limit: '2', cursor: page1.next_cursor ?? '' })}`,
        ),
      )
      expect(page2).toEqual({
        data: [expect.objectContaining({ name: names[2] })],
        next_cursor: null,
      })
      // Ключ проекта B организаций A не находит.
      expect(
        (
          await json<{ data: OrganizationView[] }>(
            await keyB.api('GET', '/v1/organizations?name=Вигадана'),
          )
        ).data,
      ).toEqual([])
      expect((await keyB.api('GET', `/v1/organizations/${first.id}`)).status).toBe(404)
      const noName = await full.api('GET', '/v1/organizations')
      expect(noName.status).toBe(400)
      expect(
        await viewOnly.api('POST', '/v1/organizations', { body: { name: 'Ні' } }),
      ).toHaveProperty('status', 403)
    })
  })

  describe('заметки по ключу', () => {
    it('ключ создаёт заметку — автор ключ; свою меняет и удаляет, чужую — 403', async () => {
      const created = await json<NoteView>(
        await full.api('POST', `/v1/contacts/${contactA}/notes`, {
          body: { text: 'Клієнтка просить передзвонити' },
        }),
        201,
      )
      expect(created).toMatchObject({
        text: 'Клієнтка просить передзвонити',
        authorId: null,
        authorApiKeyId: full.id,
        authorName: 'Інтеграція n8n',
      })
      const list = await json<{ data: NoteView[]; next_cursor: string | null }>(
        await full.api('GET', `/v1/contacts/${contactA}/notes`),
      )
      expect(list.data.map((n) => n.id)).toContain(created.id)

      // Лента записи в интерфейсе: автор — название ключа и его id.
      const timeline = await json<TimelinePage>(
        await admin.api('GET', `/v1/contacts/${contactA}/timeline?type=note`, {
          project: projectA,
        }),
      )
      expect(timeline.data.find((i) => i.id === created.id)).toMatchObject({
        actorId: null,
        actorApiKeyId: full.id,
        actorName: 'Інтеграція n8n',
      })

      // Чужая для ключа заметка — пользователя или другого ключа.
      const byUser = await json<NoteView>(
        await admin.api('POST', `/v1/contacts/${contactA}/notes`, {
          project: projectA,
          body: { text: 'Нотатка адміністратора' },
        }),
        201,
      )
      for (const note of [byUser.id, created.id]) {
        const client = note === created.id ? otherFull : full
        const patch = await client.api('PATCH', `/v1/contacts/${contactA}/notes/${note}`, {
          body: { text: 'Чуже' },
        })
        expect(patch.status).toBe(403)
        expect(await problemOf(patch)).toEqual({ code: 'PERMISSION_DENIED' })
        const remove = await client.api('DELETE', `/v1/contacts/${contactA}/notes/${note}`)
        expect(remove.status).toBe(403)
      }
      // Пользователь с правом «удалять» не меняет заметку ключа (только автор), но удалить может.
      expect(
        (
          await admin.api('PUT', `/v1/contacts/${contactA}/notes/${created.id}`, {
            project: projectA,
            body: { text: 'Адмін' },
          })
        ).status,
      ).toBe(403)

      const edited = await json<NoteView>(
        await full.api('PATCH', `/v1/contacts/${contactA}/notes/${created.id}`, {
          body: { text: 'Передзвонити завтра' },
        }),
      )
      expect(edited).toMatchObject({ text: 'Передзвонити завтра', authorApiKeyId: full.id })
      expect(
        (await full.api('DELETE', `/v1/contacts/${contactA}/notes/${created.id}`)).status,
      ).toBe(204)
      expect(
        await h.owner.selectFrom('note').select('id').where('id', '=', created.id).execute(),
      ).toEqual([])
    })

    it('заметки организации и сделки по ключу; файлы ключу закрыты; чужой проект — 404', async () => {
      const organization = await json<OrganizationView>(
        await full.api('POST', '/v1/organizations', { body: { name: 'Нотатки ТОВ' } }),
        201,
      )
      await json(
        await full.api('POST', `/v1/organizations/${organization.id}/notes`, {
          body: { text: 'Про організацію' },
        }),
        201,
      )
      const deal = await json<DealView>(
        await full.api('POST', '/v1/deals', {
          body: { title: 'Угода з нотаткою', pipelineId: pipelineA, contactId: contactA },
        }),
        201,
      )
      await json(
        await full.api('POST', `/v1/deals/${deal.id}/notes`, { body: { text: 'Про угоду' } }),
        201,
      )
      expect(
        (await json<{ data: NoteView[] }>(await full.api('GET', `/v1/deals/${deal.id}/notes`)))
          .data,
      ).toEqual([expect.objectContaining({ text: 'Про угоду', authorApiKeyId: full.id })])
      const files = await full.api('GET', `/v1/deals/${deal.id}/files`)
      expect(files.status).toBe(403)
      expect(await problemOf(files)).toEqual({ code: 'API_KEY_NOT_ALLOWED' })
      expect((await keyB.api('GET', `/v1/contacts/${contactA}/notes`)).status).toBe(404)
      expect(
        (await keyB.api('POST', `/v1/contacts/${contactA}/notes`, { body: { text: 'x' } })).status,
      ).toBe(404)
    })
  })

  describe('справочники', () => {
    it('воронки, этапы, причины, участники и команды — только своего проекта', async () => {
      const ids = async <T extends { id: string }>(key: KeyClient, path: string) =>
        (await json<T[]>(await key.api('GET', path))).map((row) => row.id).sort()
      const projectPipelines = async (projectId: string) =>
        (
          await h.owner
            .selectFrom('pipeline')
            .select('id')
            .where('project_id', '=', projectId)
            .execute()
        )
          .map((r) => r.id)
          .sort()
      expect(await ids(full, '/v1/pipelines')).toEqual(await projectPipelines(projectA))
      expect(await ids(keyB, '/v1/pipelines')).toEqual(await projectPipelines(projectB))
      expect((await ids(full, `/v1/pipelines/${pipelineA}/stages`)).length).toBe(1)
      expect((await keyB.api('GET', `/v1/pipelines/${pipelineA}/stages`)).status).toBe(404)

      const reasonA = await h.owner
        .insertInto('lost_reason_group')
        .values({ project_id: projectA, name: 'Ціна', position: 99 })
        .returning('id')
        .executeTakeFirstOrThrow()
      await h.owner
        .insertInto('lost_reason')
        .values({
          project_id: projectA,
          group_id: reasonA.id,
          name: 'Дорого',
          archived_at: new Date(),
        })
        .execute()
      const groupsA = await json<{ id: string; reasons: { archivedAt: string | null }[] }[]>(
        await full.api('GET', '/v1/lost-reasons'),
      )
      expect(groupsA.find((g) => g.id === reasonA.id)?.reasons).toEqual([
        expect.objectContaining({ archivedAt: expect.any(String) }),
      ])
      const groupsB = await json<{ id: string }[]>(await keyB.api('GET', '/v1/lost-reasons'))
      expect(groupsB.map((g) => g.id)).not.toContain(reasonA.id)

      const usersA = await json<ProjectUser[]>(await full.api('GET', '/v1/users'))
      expect(usersA.map((u) => u.id).sort()).toEqual(
        [admin.id, manager.id, disabledMember.id].sort(),
      )
      expect(usersA.find((u) => u.id === disabledMember.id)).toMatchObject({ active: false })
      expect(usersA.find((u) => u.id === manager.id)).toEqual({
        id: manager.id,
        name: expect.any(String),
        teamId: null,
        active: true,
        email: manager.email,
      })
      const usersB = await json<ProjectUser[]>(await keyB.api('GET', '/v1/users'))
      expect(usersB.map((u) => u.id).sort()).toEqual([admin.id, memberB.id].sort())

      const team = await json<TeamSummary>(
        await admin.api('POST', '/teams', {
          project: projectA,
          body: { name: 'Команда Схід', leadUserId: manager.id },
        }),
        201,
      )
      const teamsA = await json<TeamSummary[]>(await full.api('GET', '/v1/teams'))
      expect(teamsA).toEqual([
        { id: team.id, name: 'Команда Схід', leadUserId: manager.id, memberUserIds: [manager.id] },
      ])
      expect(await json<TeamSummary[]>(await keyB.api('GET', '/v1/teams'))).toEqual([])
      expect(
        (await json<ProjectUser[]>(await full.api('GET', '/v1/users'))).find(
          (u) => u.id === manager.id,
        )?.teamId,
      ).toBe(team.id)
    })

    it('email участников — только с «пользователи и роли: смотреть»; без «сделки: смотреть» — 403', async () => {
      const users = await json<ProjectUser[]>(await noUsersView.api('GET', '/v1/users'))
      expect(users.length).toBeGreaterThan(0)
      for (const user of users) {
        expect(Object.keys(user).sort()).toEqual(['active', 'id', 'name', 'teamId'])
      }
      for (const path of [
        '/v1/pipelines',
        `/v1/pipelines/${pipelineA}/stages`,
        '/v1/lost-reasons',
        '/v1/users',
        '/v1/teams',
      ]) {
        const res = await noDeals.api('GET', path)
        expect([path, res.status]).toEqual([path, 403])
        expect(await problemOf(res)).toEqual({ code: 'PERMISSION_DENIED' })
      }
      // Изменение справочников ключу не открыто.
      const change = await full.api('POST', '/v1/pipelines', { body: { name: 'Нова' } })
      expect(change.status).toBe(403)
      expect(await problemOf(change)).toEqual({ code: 'API_KEY_NOT_ALLOWED' })
    })
  })

  describe('описание OpenAPI', () => {
    it('содержит все маршруты тикета с выдуманными примерами', async () => {
      type Operation = {
        responses: Record<string, { content?: Record<string, { example?: unknown }> }>
        requestBody?: { content: Record<string, { example?: unknown }> }
      }
      const doc = await json<{ paths: Record<string, Record<string, Operation>> }>(
        await h.request('GET', '/v1/openapi.json'),
      )
      const expected = [
        'get /contacts',
        'post /contacts',
        'get /contacts/{id}',
        'patch /contacts/{id}',
        'get /organizations',
        'post /organizations',
        'get /organizations/{id}',
        'patch /organizations/{id}',
        'get /pipelines',
        'get /pipelines/{id}/stages',
        'get /lost-reasons',
        'get /users',
        'get /teams',
        ...['deals', 'contacts', 'organizations'].flatMap((entity) => [
          `get /${entity}/{id}/notes`,
          `post /${entity}/{id}/notes`,
          `patch /${entity}/{id}/notes/{noteId}`,
          `delete /${entity}/{id}/notes/{noteId}`,
        ]),
      ]
      const found: string[] = []
      for (const [path, methods] of Object.entries(doc.paths)) {
        for (const [method, operation] of Object.entries(methods)) {
          const route = `${method} ${path}`
          if (!expected.includes(route)) continue
          found.push(route)
          if (method === 'delete') continue
          const success = operation.responses['200'] ?? operation.responses['201']
          expect([route, success?.content?.['application/json']?.example]).toEqual([
            route,
            expect.anything(),
          ])
          if (operation.requestBody) {
            expect([route, operation.requestBody.content['application/json']?.example]).toEqual([
              route,
              expect.anything(),
            ])
          }
        }
      }
      expect(found.sort()).toEqual([...expected].sort())
      // Закрытые ключу маршруты в описание не попадают.
      expect(doc.paths['/contacts/{id}']?.delete).toBeUndefined()
      expect(doc.paths['/contacts/{id}']?.put).toBeUndefined()
      expect(doc.paths['/organizations/{id}']?.delete).toBeUndefined()
    })
  })
})
