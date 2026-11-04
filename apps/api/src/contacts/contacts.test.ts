import { randomInt } from 'node:crypto'
import { withProject } from '@alpi/db'
import { type Kysely, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import type { OrganizationView } from '../organizations/organizations.ts'
import {
  type ApiHarness,
  type Method,
  type SignedInUser,
  startApiHarness,
} from '../testing/api-harness.ts'
import type { ContactView } from './contacts.ts'
import type { ContactDependents } from './dependents.ts'
import { findContactMatch } from './match.ts'

// Контакты и организации (тикет crm-deals/03): изоляция проектов, права и охват, «чужой
// клиент», поиск совпадения, журнал изменений, корзина — на настоящем PostgreSQL, API ходит
// ролью приложения. Имена, телефоны и email — вымышленные.

/** Вымышленный украинский мобильный: девять цифр после +380. */
function fakePhone(): { e164: string; national: string; spaced: string } {
  const rest = String(randomInt(1_000_000, 9_999_999))
  const e164 = `+38067${rest}`
  return {
    e164,
    national: `067${rest}`,
    spaced: `(067) ${rest.slice(0, 3)}-${rest.slice(3, 5)}-${rest.slice(5)}`,
  }
}

let emailCounter = 0
const fakeEmail = () => `client-${++emailCounter}-${randomInt(1e9)}@example.test`

describe('контакты и организации', () => {
  let h: ApiHarness
  let admin: SignedInUser
  let projectA: string
  let projectB: string
  let managerA1: SignedInUser
  let managerA2: SignedInUser
  let head: SignedInUser
  let noRights: SignedInUser
  /** Корзина «смотреть, восстанавливать», контакты — только свои. */
  let ownRestorer: SignedInUser

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_contacts')
    admin = await h.signIn('owner')
    projectA = (await h.createProject(admin, 'Контакти А')).id
    projectB = (await h.createProject(admin, 'Контакти Б')).id
    managerA1 = await h.signIn()
    managerA2 = await h.signIn()
    head = await h.signIn()
    noRights = await h.signIn()
    ownRestorer = await h.signIn()
    await h.addMember(projectA, managerA1.id, 'manager')
    await h.addMember(projectA, managerA2.id, 'manager')
    await h.addMember(projectA, head.id, 'head')
    const { id: emptyRole } = await h.owner
      .insertInto('role')
      .values({ project_id: projectA, name: 'Без прав', permissions: JSON.stringify({}) })
      .returning('id')
      .executeTakeFirstOrThrow()
    await h.owner
      .insertInto('project_member')
      .values({ project_id: projectA, user_id: noRights.id, role_id: emptyRole })
      .execute()
    const { id: restorerRole } = await h.owner
      .insertInto('role')
      .values({
        project_id: projectA,
        name: 'Свої з кошиком',
        permissions: JSON.stringify({
          actions: { contacts: ['view', 'create', 'edit', 'delete'], trash: ['view', 'edit'] },
          scopes: { contacts: { read: 'own', write: 'own' } },
        }),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await h.owner
      .insertInto('project_member')
      .values({ project_id: projectA, user_id: ownRestorer.id, role_id: restorerRole })
      .execute()
  })

  afterAll(async () => {
    await h?.stop()
  })

  const call = (
    user: SignedInUser,
    method: Method,
    path: string,
    body?: unknown,
    project = projectA,
  ) => user.api(method, path, { project, ...(body === undefined ? {} : { body }) })

  async function json<T>(res: Response): Promise<T> {
    return (await res.json()) as T
  }

  async function createContact(
    user: SignedInUser,
    body: Record<string, unknown>,
    project = projectA,
  ): Promise<ContactView> {
    const res = await call(user, 'POST', '/v1/contacts', body, project)
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201)
    return json<ContactView>(res)
  }

  async function createOrganization(name: string, project = projectA): Promise<OrganizationView> {
    const res = await call(admin, 'POST', '/v1/organizations', { name }, project)
    expect(res.status).toBe(201)
    return json<OrganizationView>(res)
  }

  /** Запрос ролью приложения в контексте проекта, как его делает API. */
  const inProject = <T>(projectId: string, fn: (trx: Kysely<never>) => Promise<T>) =>
    withProject(h.appDb, projectId, (trx) => fn(trx as unknown as Kysely<never>))

  describe('создание и выдача', () => {
    it('телефоны в E.164, email в нижнем регистре, первый — основной', async () => {
      const p1 = fakePhone()
      const p2 = fakePhone()
      const contact = await createContact(admin, {
        firstName: 'Тарас',
        lastName: 'Вигаданий',
        language: 'uk',
        phones: [p1.spaced, p2.national],
        emails: ['Taras.Test@Example.TEST'],
      })
      expect(contact).toMatchObject({
        firstName: 'Тарас',
        lastName: 'Вигаданий',
        language: 'uk',
        organizationId: null,
        possibleDuplicate: false,
        phones: [p1.e164, p2.e164],
        emails: ['taras.test@example.test'],
        createdBy: admin.id,
      })
      const primary = await h.owner
        .selectFrom('contact_phone')
        .select(['phone', 'is_primary'])
        .where('contact_id', '=', contact.id)
        .orderBy('phone')
        .execute()
      expect(primary.find((r) => r.is_primary)?.phone).toBe(p1.e164)
      expect(primary.filter((r) => r.is_primary)).toHaveLength(1)

      const got = await call(admin, 'GET', `/v1/contacts/${contact.id}`)
      expect(got.status).toBe(200)
      expect(await json<ContactView>(got)).toEqual(contact)

      const byPhone = await call(
        admin,
        'GET',
        `/v1/contacts?phone=${encodeURIComponent(p2.spaced)}`,
      )
      expect((await json<ContactView[]>(byPhone)).map((c) => c.id)).toEqual([contact.id])
    })

    it('неразбираемый телефон — 422 INVALID_PHONE с указанием поля', async () => {
      const res = await call(admin, 'POST', '/v1/contacts', {
        firstName: 'Мусор',
        phones: [fakePhone().e164, 'не телефон'],
      })
      expect(res.status).toBe(422)
      expect(await res.json()).toEqual({ code: 'INVALID_PHONE', details: { path: 'phones.1' } })
    })

    it('без имени и с неизвестным полем — 400', async () => {
      expect((await call(admin, 'POST', '/v1/contacts', { lastName: 'Без імені' })).status).toBe(
        400,
      )
      const unknown = await call(admin, 'POST', '/v1/contacts', { firstName: 'Х', owner: 'x' })
      expect(unknown.status).toBe(400)
    })
  })

  describe('изоляция проектов', () => {
    it('контакты, телефоны, email, организации и журнал A не видны в B; тот же телефон в B — не совпадение', async () => {
      const phone = fakePhone()
      const email = fakeEmail()
      const orgA = await createOrganization('Організація А')
      const inA = await createContact(admin, {
        firstName: 'Олена',
        phones: [phone.e164],
        emails: [email],
        organizationId: orgA.id,
      })
      // Запись в журнал изменений A.
      expect(
        (await call(admin, 'PUT', `/v1/contacts/${inA.id}`, { firstName: 'Олена Нова' })).status,
      ).toBe(200)

      const inB = await createContact(
        admin,
        { firstName: 'Олена', phones: [phone.national], emails: [email] },
        projectB,
      )
      expect(inB.possibleDuplicate).toBe(false)
      expect(inB.id).not.toBe(inA.id)

      expect((await call(admin, 'GET', `/v1/contacts/${inA.id}`, undefined, projectB)).status).toBe(
        404,
      )
      expect(
        (await call(admin, 'GET', `/v1/organizations/${orgA.id}`, undefined, projectB)).status,
      ).toBe(404)
      const listB = await json<ContactView[]>(
        await call(admin, 'GET', '/v1/contacts', undefined, projectB),
      )
      expect(listB.map((c) => c.id)).not.toContain(inA.id)

      // Без фильтра в коде: row-level security показывает только строки B.
      for (const table of [
        'contact',
        'contact_phone',
        'contact_email',
        'organization',
        'change_log',
      ] as const) {
        const rows = await inProject(projectB, (trx) =>
          sql<{ project_id: string }>`select project_id from ${sql.table(table)}`.execute(trx),
        )
        expect(
          rows.rows.every((r) => r.project_id === projectB),
          table,
        ).toBe(true)
      }
      const ownRows = await inProject(projectA, (trx) =>
        sql<{ n: number }>`select count(*)::int as n from change_log`.execute(trx),
      )
      expect(ownRows.rows[0]?.n).toBeGreaterThan(0)

      // Поиск совпадения в B не находит контакт A.
      const match = await withProject(h.appDb, projectB, (trx) =>
        findContactMatch(trx, { phones: [phone.e164], emails: [] }, { excludeId: inB.id }),
      )
      expect(match).toBeNull()
    })
  })

  describe('права и охват', () => {
    it('без права — 403', async () => {
      expect((await call(noRights, 'GET', '/v1/contacts')).status).toBe(403)
      expect((await call(noRights, 'POST', '/v1/contacts', { firstName: 'Х' })).status).toBe(403)
      expect((await call(noRights, 'GET', '/v1/organizations')).status).toBe(403)
      expect((await call(noRights, 'POST', '/v1/organizations', { name: 'Х' })).status).toBe(403)
      const own = await createContact(managerA1, { firstName: 'Свій' })
      // У менеджера нет права «контакты: удалять».
      expect((await call(managerA1, 'DELETE', `/v1/contacts/${own.id}`)).status).toBe(403)
    })

    it('менеджер с охватом «свои» видит созданные им контакты и не видит чужие', async () => {
      const mine = await createContact(managerA1, { firstName: 'Мій' })
      const theirs = await createContact(managerA2, { firstName: 'Чужий' })

      const list = await json<ContactView[]>(await call(managerA1, 'GET', '/v1/contacts'))
      const ids = list.map((c) => c.id)
      expect(ids).toContain(mine.id)
      expect(ids).not.toContain(theirs.id)
      expect((await call(managerA1, 'GET', `/v1/contacts/${mine.id}`)).status).toBe(200)
      expect((await call(managerA1, 'GET', `/v1/contacts/${theirs.id}`)).status).toBe(404)
      expect(
        (await call(managerA1, 'PUT', `/v1/contacts/${theirs.id}`, { firstName: 'Злам' })).status,
      ).toBe(404)

      // Администратор видит все контакты проекта.
      const all = await json<ContactView[]>(await call(admin, 'GET', '/v1/contacts?limit=200'))
      expect(all.map((c) => c.id)).toEqual(expect.arrayContaining([mine.id, theirs.id]))
    })
  })

  describe('совпадения по телефону и email', () => {
    it('«чужой клиент»: 409 без имени, телефона, email и id чужого контакта', async () => {
      const phone = fakePhone()
      const email = fakeEmail()
      const theirs = await createContact(managerA2, {
        firstName: 'Секретна',
        lastName: 'Клієнтка',
        phones: [phone.e164],
        emails: [email],
      })

      for (const res of [
        await call(managerA1, 'POST', '/v1/contacts', {
          firstName: 'Новий',
          phones: [phone.spaced],
        }),
        // Изменение своего контакта на чужой телефон — тот же ответ.
        await call(
          managerA1,
          'PUT',
          `/v1/contacts/${(await createContact(managerA1, { firstName: 'Свій' })).id}`,
          { phones: [phone.national] },
        ),
      ]) {
        expect(res.status).toBe(409)
        const text = await res.text()
        expect(JSON.parse(text)).toEqual({ code: 'CONTACT_OUT_OF_SCOPE' })
        for (const secret of [
          theirs.id,
          'Секретна',
          'Клієнтка',
          phone.e164,
          phone.e164.slice(4),
          email,
        ]) {
          expect(text).not.toContain(secret)
        }
      }
    })

    it('совпал телефон с видимым контактом — 409 со ссылкой на него', async () => {
      const phone = fakePhone()
      const existing = await createContact(admin, { firstName: 'Є', phones: [phone.e164] })
      const res = await call(admin, 'POST', '/v1/contacts', {
        firstName: 'Повтор',
        phones: [phone.spaced],
      })
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({
        code: 'CONTACT_EXISTS',
        details: { contactId: existing.id },
      })
    })

    it('совпал только email — контакт создаётся с отметкой «возможный дубль»', async () => {
      const email = fakeEmail()
      await createContact(admin, { firstName: 'Перший', emails: [email] })
      const second = await createContact(admin, {
        firstName: 'Другий',
        phones: [fakePhone().e164],
        emails: [email.toUpperCase()],
      })
      expect(second.possibleDuplicate).toBe(true)
    })

    it('конфликт «телефон — один, email — другой»: выигрывает телефон, признак конфликта', async () => {
      const phone = fakePhone()
      const email = fakeEmail()
      const byPhone = await createContact(admin, { firstName: 'Телефон', phones: [phone.e164] })
      const byEmail = await createContact(admin, { firstName: 'Пошта', emails: [email] })

      const match = await withProject(h.appDb, projectA, (trx) =>
        findContactMatch(trx, { phones: [phone.e164], emails: [email] }),
      )
      expect(match).toEqual({ contactId: byPhone.id, by: 'phone', conflict: true })
      expect(match?.contactId).not.toBe(byEmail.id)

      const onlyEmail = await withProject(h.appDb, projectA, (trx) =>
        findContactMatch(trx, { phones: [], emails: [email] }),
      )
      expect(onlyEmail).toEqual({ contactId: byEmail.id, by: 'email', conflict: false })

      // Через API — ссылка на контакт по телефону.
      const res = await call(admin, 'POST', '/v1/contacts', {
        firstName: 'Обидва',
        phones: [phone.national],
        emails: [email],
      })
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({
        code: 'CONTACT_EXISTS',
        details: { contactId: byPhone.id },
      })
    })
  })

  describe('организация контакта', () => {
    it('не больше одной организации: список организаций не принимается, новая заменяет прежнюю', async () => {
      const first = await createOrganization('Перша')
      const second = await createOrganization('Друга')
      const contact = await createContact(admin, {
        firstName: 'Працівник',
        organizationId: first.id,
      })

      const two = await call(admin, 'PUT', `/v1/contacts/${contact.id}`, {
        organizationIds: [first.id, second.id],
      })
      expect(two.status).toBe(400)
      const asArray = await call(admin, 'PUT', `/v1/contacts/${contact.id}`, {
        organizationId: [first.id, second.id],
      })
      expect(asArray.status).toBe(400)

      const moved = await call(admin, 'PUT', `/v1/contacts/${contact.id}`, {
        organizationId: second.id,
      })
      expect(moved.status).toBe(200)
      expect((await json<ContactView>(moved)).organizationId).toBe(second.id)

      // В базе связь — один столбец contact.organization_id (своя организация есть ещё только у
      // сделки) и никакой таблицы связей «контакт — организация».
      const columns = await sql<{ table_name: string }>`
        select table_name from information_schema.columns
        where table_schema = 'public' and column_name = 'organization_id'
        order by table_name
      `.execute(h.owner)
      expect(columns.rows.map((r) => r.table_name)).toEqual(['contact', 'deal'])
    })

    it('организация другого проекта или из корзины — 404', async () => {
      const inB = await createOrganization('Чужа', projectB)
      const res = await call(admin, 'POST', '/v1/contacts', {
        firstName: 'Х',
        organizationId: inB.id,
      })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ code: 'ORGANIZATION_NOT_FOUND' })

      const trashed = await createOrganization('У кошику')
      expect((await call(admin, 'DELETE', `/v1/organizations/${trashed.id}`)).status).toBe(204)
      const onCreate = await call(admin, 'POST', '/v1/contacts', {
        firstName: 'Х',
        organizationId: trashed.id,
      })
      expect(onCreate.status).toBe(404)
      expect(await onCreate.json()).toEqual({ code: 'ORGANIZATION_NOT_FOUND' })
      const contact = await createContact(admin, { firstName: 'Без організації' })
      const onUpdate = await call(admin, 'PUT', `/v1/contacts/${contact.id}`, {
        organizationId: trashed.id,
      })
      expect(onUpdate.status).toBe(404)
      expect(await onUpdate.json()).toEqual({ code: 'ORGANIZATION_NOT_FOUND' })
      expect(
        (await json<ContactView>(await call(admin, 'GET', `/v1/contacts/${contact.id}`)))
          .organizationId,
      ).toBeNull()
    })
  })

  describe('журнал изменений', () => {
    it('изменение имени и телефона пишет «было → стало»', async () => {
      const before = fakePhone()
      const after = fakePhone()
      const contact = await createContact(managerA1, {
        firstName: 'Стара',
        phones: [before.e164],
      })
      const res = await call(managerA1, 'PUT', `/v1/contacts/${contact.id}`, {
        firstName: 'Нова',
        phones: [after.spaced],
      })
      expect(res.status).toBe(200)

      const rows = await h.owner
        .selectFrom('change_log')
        .select(['entity_type', 'actor_id', 'field', 'before', 'after', 'project_id'])
        .where('entity_id', '=', contact.id)
        .orderBy('field')
        .execute()
      expect(rows).toEqual([
        {
          entity_type: 'contact',
          actor_id: managerA1.id,
          field: 'firstName',
          before: 'Стара',
          after: 'Нова',
          project_id: projectA,
        },
        {
          entity_type: 'contact',
          actor_id: managerA1.id,
          field: 'phones',
          before: [before.e164],
          after: [after.e164],
          project_id: projectA,
        },
      ])

      // Повтор тех же значений — без новых строк.
      await call(managerA1, 'PUT', `/v1/contacts/${contact.id}`, {
        firstName: 'Нова',
        phones: [after.e164],
      })
      const again = await h.owner
        .selectFrom('change_log')
        .select('id')
        .where('entity_id', '=', contact.id)
        .execute()
      expect(again).toHaveLength(2)
    })

    it('роль приложения не может изменить или удалить строку журнала', async () => {
      const contact = await createContact(admin, { firstName: 'Журнал' })
      await call(admin, 'PUT', `/v1/contacts/${contact.id}`, { lastName: 'Змінено' })

      await expect(
        inProject(projectA, (trx) =>
          sql`update change_log set after = '"підробка"'::jsonb where entity_id = ${contact.id}`.execute(
            trx,
          ),
        ),
      ).rejects.toThrow(/permission denied for table change_log/)
      await expect(
        inProject(projectA, (trx) =>
          sql`delete from change_log where entity_id = ${contact.id}`.execute(trx),
        ),
      ).rejects.toThrow(/permission denied for table change_log/)
      // Отдельной функции «стереть историю» нет: история уходит только вместе с записью из
      // корзины, а живую запись purge_from_trash не удаляет.
      await expect(
        inProject(projectA, (trx) =>
          sql`select change_log_forget('contact', ${contact.id}::uuid)`.execute(trx),
        ),
      ).rejects.toThrow(/function change_log_forget\(unknown, uuid\) does not exist/)
      await expect(
        inProject(projectA, (trx) =>
          sql`select purge_from_trash('contact', ${contact.id}::uuid)`.execute(trx),
        ),
      ).rejects.toThrow(/записи нет в корзине/)

      const left = await h.owner
        .selectFrom('change_log')
        .select('after')
        .where('entity_id', '=', contact.id)
        .execute()
      expect(left).toEqual([{ after: 'Змінено' }])
    })
  })

  describe('окончательное удаление не стирает историю живой записи', () => {
    it('роль приложения не удаляет контакты и организации и не меняет их id', async () => {
      const contact = await createContact(admin, { firstName: 'Живий' })
      const org = await createOrganization('Жива')
      await call(admin, 'PUT', `/v1/contacts/${contact.id}`, { lastName: 'Історія' })

      for (const statement of [
        sql`delete from contact where id = ${contact.id}`,
        sql`delete from organization where id = ${org.id}`,
        sql`update contact set id = gen_random_uuid() where id = ${contact.id}`,
        sql`update contact set project_id = ${projectB} where id = ${contact.id}`,
        sql`update organization set id = gen_random_uuid() where id = ${org.id}`,
      ]) {
        await expect(inProject(projectA, (trx) => statement.execute(trx))).rejects.toThrow(
          /permission denied for table (contact|organization)/,
        )
      }
    })

    it('приём «в корзину через UPDATE → purge_from_trash → INSERT с тем же id» невозможен', async () => {
      const contact = await createContact(admin, { firstName: 'Ціль' })
      await call(admin, 'PUT', `/v1/contacts/${contact.id}`, { firstName: 'Ціль 2' })
      const org = await createOrganization('Ціль')
      await call(admin, 'PUT', `/v1/organizations/${org.id}`, { name: 'Ціль 2' })

      for (const [table, id, insert] of [
        [
          'contact',
          contact.id,
          sql`insert into contact (id, project_id, first_name, created_by)
            values (${contact.id}, ${projectA}, 'Ціль 2', ${admin.id})`,
        ],
        [
          'organization',
          org.id,
          sql`insert into organization (id, project_id, name, created_by)
            values (${org.id}, ${projectA}, 'Ціль 2', ${admin.id})`,
        ],
      ] as const) {
        let reached = ''
        const attempt = inProject(projectA, async (trx) => {
          await sql`update ${sql.table(table)} set deleted_at = now() where id = ${id}`.execute(trx)
          reached = 'purge'
          await sql`select purge_from_trash(${table}, ${id}::uuid)`.execute(trx)
          reached = 'insert'
          await insert.execute(trx)
          reached = 'done'
        })
        // Первые два шага роли приложения доступны; вставить запись с выбранным id — нет.
        await expect(attempt, table).rejects.toThrow(
          new RegExp(`permission denied for table ${table}`),
        )
        expect(reached, table).toBe('insert')

        const history = await h.owner
          .selectFrom('change_log')
          .select(['field', 'after'])
          .where('entity_id', '=', id)
          .execute()
        expect(history, table).toEqual([
          { field: table === 'contact' ? 'firstName' : 'name', after: 'Ціль 2' },
        ])
      }
      expect((await call(admin, 'GET', `/v1/contacts/${contact.id}`)).status).toBe(200)
      expect((await call(admin, 'GET', `/v1/organizations/${org.id}`)).status).toBe(200)

      // id не задаётся и при вставке сразу «удалённой» записи; отметку корзины тоже не вставить.
      for (const statement of [
        sql`insert into contact (id, project_id, first_name)
          values (gen_random_uuid(), ${projectA}, 'Підміна')`,
        sql`insert into contact (project_id, first_name, deleted_at)
          values (${projectA}, 'Підміна', now())`,
      ]) {
        await expect(inProject(projectA, (trx) => statement.execute(trx))).rejects.toThrow(
          /permission denied for table contact/,
        )
      }
    })

    it('purge_from_trash удаляет только запись из корзины текущего проекта', async () => {
      const inB = await createContact(admin, { firstName: 'Б' }, projectB)
      const trashed = await call(admin, 'DELETE', `/v1/contacts/${inB.id}`, undefined, projectB)
      expect(trashed.status).toBe(204)
      await expect(
        inProject(projectA, (trx) =>
          sql`select purge_from_trash('contact', ${inB.id}::uuid)`.execute(trx),
        ),
      ).rejects.toThrow(/записи нет в корзине/)
      await expect(
        inProject(projectA, (trx) =>
          sql`select purge_from_trash('change_log', ${inB.id}::uuid)`.execute(trx),
        ),
      ).rejects.toThrow(/так не удаляется/)
      const still = await h.owner
        .selectFrom('contact')
        .select('id')
        .where('id', '=', inB.id)
        .execute()
      expect(still).toHaveLength(1)
    })
  })

  describe('восстановление из корзины проверяет совпадения так же, как создание', () => {
    /** Контакт пользователя `owner` в корзине; пока он там, тот же ключ появился у `other`. */
    async function trashedWithClash(
      owner: SignedInUser,
      other: SignedInUser,
      key: 'phone' | 'email',
    ) {
      const phone = fakePhone()
      const email = fakeEmail()
      const mine = await createContact(owner, {
        firstName: 'Мій',
        ...(key === 'phone' ? { phones: [phone.e164] } : { emails: [email] }),
      })
      expect(mine.possibleDuplicate).toBe(false)
      expect((await call(owner, 'DELETE', `/v1/contacts/${mine.id}`)).status).toBe(204)
      const theirs = await createContact(other, {
        firstName: 'Таємний',
        ...(key === 'phone' ? { phones: [phone.spaced] } : { emails: [email.toUpperCase()] }),
      })
      return { mine, theirs, phone, email }
    }

    async function inTrash(id: string): Promise<boolean> {
      const row = await h.owner
        .selectFrom('contact')
        .select('deleted_at')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
      return row.deleted_at !== null
    }

    it('телефон у контакта вне охвата — 409 без данных, контакт остаётся в корзине', async () => {
      const { mine, theirs, phone } = await trashedWithClash(ownRestorer, managerA2, 'phone')
      const res = await call(ownRestorer, 'POST', `/v1/contacts/${mine.id}/restore`)
      expect(res.status).toBe(409)
      const text = await res.text()
      expect(JSON.parse(text)).toEqual({ code: 'CONTACT_OUT_OF_SCOPE' })
      for (const secret of [theirs.id, 'Таємний', phone.e164, phone.e164.slice(4)]) {
        expect(text).not.toContain(secret)
      }
      expect(await inTrash(mine.id)).toBe(true)
    })

    it('телефон у видимого контакта — 409 со ссылкой на него, контакт остаётся в корзине', async () => {
      const { mine, theirs } = await trashedWithClash(admin, managerA1, 'phone')
      const res = await call(admin, 'POST', `/v1/contacts/${mine.id}/restore`)
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({
        code: 'CONTACT_EXISTS',
        details: { contactId: theirs.id },
      })
      expect(await inTrash(mine.id)).toBe(true)
    })

    it('только email — восстанавливается с отметкой «возможный дубль», и вне охвата тоже', async () => {
      for (const [owner, other] of [
        [ownRestorer, managerA2],
        [admin, managerA1],
      ] as const) {
        const { mine, theirs } = await trashedWithClash(owner, other, 'email')
        const res = await call(owner, 'POST', `/v1/contacts/${mine.id}/restore`)
        expect(res.status).toBe(200)
        const text = await res.text()
        expect((JSON.parse(text) as ContactView).possibleDuplicate).toBe(true)
        expect(text).not.toContain(theirs.id)
        expect(text).not.toContain('Таємний')
        expect(await inTrash(mine.id)).toBe(false)
        const logged = await h.owner
          .selectFrom('change_log')
          .select(['field', 'before', 'after'])
          .where('entity_id', '=', mine.id)
          .where('field', '=', 'possibleDuplicate')
          .execute()
        expect(logged).toEqual([{ field: 'possibleDuplicate', before: false, after: true }])
      }
    })

    it('при создании те же правила: email вне охвата — «возможный дубль», телефон — 409', async () => {
      const email = fakeEmail()
      const phone = fakePhone()
      await createContact(managerA2, {
        firstName: 'Таємний',
        emails: [email],
        phones: [phone.e164],
      })
      const byEmail = await createContact(ownRestorer, { firstName: 'Новий', emails: [email] })
      expect(byEmail.possibleDuplicate).toBe(true)
      const byPhone = await call(ownRestorer, 'POST', '/v1/contacts', {
        firstName: 'Новий',
        phones: [phone.national],
      })
      expect(byPhone.status).toBe(409)
      expect(await byPhone.json()).toEqual({ code: 'CONTACT_OUT_OF_SCOPE' })
    })
  })

  describe('корзина', () => {
    it('удалённый контакт не виден, восстанавливается; окончательно удаляет только право «корзина: удалять»', async () => {
      const contact = await createContact(admin, {
        firstName: 'Кошик',
        phones: [fakePhone().e164],
      })
      expect((await call(admin, 'DELETE', `/v1/contacts/${contact.id}`)).status).toBe(204)
      expect((await call(admin, 'GET', `/v1/contacts/${contact.id}`)).status).toBe(404)
      const list = await json<ContactView[]>(await call(admin, 'GET', '/v1/contacts?limit=200'))
      expect(list.map((c) => c.id)).not.toContain(contact.id)

      // Восстановить — право «корзина: изменять» (у руководителя есть).
      expect((await call(managerA1, 'POST', `/v1/contacts/${contact.id}/restore`)).status).toBe(403)
      const restored = await call(head, 'POST', `/v1/contacts/${contact.id}/restore`)
      expect(restored.status).toBe(200)
      expect((await call(admin, 'GET', `/v1/contacts/${contact.id}`)).status).toBe(200)

      // Окончательно — только из корзины и только с правом «корзина: удалять».
      const notInTrash = await call(admin, 'DELETE', `/v1/contacts/${contact.id}/permanent`)
      expect(notInTrash.status).toBe(409)
      expect(await notInTrash.json()).toEqual({ code: 'NOT_IN_TRASH' })
      expect((await call(head, 'DELETE', `/v1/contacts/${contact.id}`)).status).toBe(204)
      expect((await call(head, 'DELETE', `/v1/contacts/${contact.id}/permanent`)).status).toBe(403)
      expect((await call(managerA1, 'DELETE', `/v1/contacts/${contact.id}/permanent`)).status).toBe(
        403,
      )
      expect((await call(admin, 'DELETE', `/v1/contacts/${contact.id}/permanent`)).status).toBe(204)

      const gone = await h.owner
        .selectFrom('contact')
        .select('id')
        .where('id', '=', contact.id)
        .execute()
      expect(gone).toEqual([])
      const history = await h.owner
        .selectFrom('change_log')
        .select('id')
        .where('entity_id', '=', contact.id)
        .execute()
      expect(history).toEqual([])
      const audit = await h.owner
        .selectFrom('audit_log')
        .select(['action', 'actor_id', 'details'])
        .where('entity_id', '=', contact.id)
        .execute()
      expect(audit).toEqual([{ action: 'contact.purged', actor_id: admin.id, details: {} }])
    })

    it('организация в корзине: связь у контактов остаётся до окончательного удаления', async () => {
      const org = await createOrganization('Тимчасова')
      const contact = await createContact(admin, {
        firstName: 'Співробітник',
        organizationId: org.id,
      })

      expect((await call(admin, 'DELETE', `/v1/organizations/${org.id}`)).status).toBe(204)
      expect((await call(admin, 'GET', `/v1/organizations/${org.id}`)).status).toBe(404)
      const orgs = await json<OrganizationView[]>(await call(admin, 'GET', '/v1/organizations'))
      expect(orgs.map((o) => o.id)).not.toContain(org.id)
      const stillLinked = await json<ContactView>(
        await call(admin, 'GET', `/v1/contacts/${contact.id}`),
      )
      expect(stillLinked.organizationId).toBe(org.id)

      expect(
        (await call(managerA1, 'DELETE', `/v1/organizations/${org.id}/permanent`)).status,
      ).toBe(403)
      expect((await call(admin, 'DELETE', `/v1/organizations/${org.id}/permanent`)).status).toBe(
        204,
      )
      const unlinked = await json<ContactView>(
        await call(admin, 'GET', `/v1/contacts/${contact.id}`),
      )
      expect(unlinked.organizationId).toBeNull()
      const logged = await h.owner
        .selectFrom('change_log')
        .select(['field', 'before', 'after'])
        .where('entity_id', '=', contact.id)
        .execute()
      expect(logged).toEqual([{ field: 'organizationId', before: org.id, after: null }])
    })

    it('точка расширения «что ещё удаляется вместе с контактом»: та же транзакция', async () => {
      const calls: string[] = []
      let fail = false
      const dependents: ContactDependents = {
        async pending() {
          return { records: [], forbidden: false }
        },
        async trash({ db }, contactId, deletedAt) {
          const row = await db
            .selectFrom('contact')
            .select('deleted_at')
            .where('id', '=', contactId)
            .executeTakeFirstOrThrow()
          // Видит уже удалённый в этой же транзакции контакт с тем же временем.
          expect(new Date(row.deleted_at ?? 0).getTime()).toBe(deletedAt.getTime())
          calls.push(`trash ${contactId}`)
          if (fail) throw new Error('сделки не удалились')
        },
        async restore(_actor, contactId) {
          calls.push(`restore ${contactId}`)
          return null
        },
        async purge(_db, contactId) {
          calls.push(`purge ${contactId}`)
        },
      }
      const app = createApp({ auth: h.auth, db: h.appDb, contactDependents: dependents })
      const contact = await createContact(admin, { firstName: 'Зі сделками' })
      const opts = { project: projectA }

      expect((await admin.call(app, 'DELETE', `/v1/contacts/${contact.id}`, opts)).status).toBe(204)
      expect(
        (await admin.call(app, 'POST', `/v1/contacts/${contact.id}/restore`, opts)).status,
      ).toBe(200)

      fail = true
      expect((await admin.call(app, 'DELETE', `/v1/contacts/${contact.id}`, opts)).status).toBe(500)
      // Ошибка точки расширения откатывает и удаление контакта.
      expect((await call(admin, 'GET', `/v1/contacts/${contact.id}`)).status).toBe(200)

      fail = false
      await admin.call(app, 'DELETE', `/v1/contacts/${contact.id}`, opts)
      expect(
        (await admin.call(app, 'DELETE', `/v1/contacts/${contact.id}/permanent`, opts)).status,
      ).toBe(204)
      expect(calls).toEqual([
        `trash ${contact.id}`,
        `restore ${contact.id}`,
        `trash ${contact.id}`,
        `trash ${contact.id}`,
        `purge ${contact.id}`,
      ])
    })
  })
})
