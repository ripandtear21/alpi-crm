import { withProject } from '@alpi/db'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ApiHarness, type SignedInUser, startApiHarness } from '../testing/api-harness.ts'
import { pathError, problemOf } from '../testing/problem.ts'
import { contactsQuery, parseQuery, type SearchResponse } from './search.ts'

// Быстрый поиск (тикет crm-deals/08): телефон в любом формате, email, имя с опечаткой,
// изоляция проектов, охват роли и признак «есть ещё», архив и корзина, план запроса на
// 10 000 контактах — на настоящем PostgreSQL, API ходит ролью приложения. Имена и телефоны —
// вымышленные.

describe('быстрый поиск', () => {
  let h: ApiHarness
  let admin: SignedInUser
  let manager: SignedInUser
  let colleague: SignedInUser
  let noRights: SignedInUser
  let projectA: string
  let projectB: string
  /** Проект только для плана запроса: 10 000 контактов. */
  let projectC: string
  const stages = new Map<string, { pipeline: string; stage: string }>()

  async function createStage(projectId: string) {
    const pipeline = await h.owner
      .insertInto('pipeline')
      .values({ project_id: projectId, code: 'main', name: 'Продаж', position: 1 })
      .returning('id')
      .executeTakeFirstOrThrow()
    const stage = await h.owner
      .insertInto('stage')
      .values({ project_id: projectId, pipeline_id: pipeline.id, name: 'Новий', position: 1 })
      .returning('id')
      .executeTakeFirstOrThrow()
    stages.set(projectId, { pipeline: pipeline.id, stage: stage.id })
  }

  interface ContactSeed {
    firstName: string
    lastName?: string | null
    phone?: string
    email?: string
    createdBy?: string | null
    project?: string
  }

  async function contact(seed: ContactSeed): Promise<string> {
    const project = seed.project ?? projectA
    const { id } = await h.owner
      .insertInto('contact')
      .values({
        project_id: project,
        first_name: seed.firstName,
        last_name: seed.lastName ?? null,
        created_by: seed.createdBy ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    if (seed.phone) {
      await h.owner
        .insertInto('contact_phone')
        .values({ project_id: project, contact_id: id, phone: seed.phone, is_primary: true })
        .execute()
    }
    if (seed.email) {
      await h.owner
        .insertInto('contact_email')
        .values({ project_id: project, contact_id: id, email: seed.email, is_primary: true })
        .execute()
    }
    return id
  }

  /** Сделка `title` с ответственным `owner` (null — общая очередь) и новым контактом. */
  async function deal(title: string, owner: string | null, project = projectA): Promise<string> {
    const where = stages.get(project)
    if (!where) throw new Error('нет воронки проекта')
    const primary = await contact({ firstName: 'Клієнт', createdBy: owner, project })
    const { id } = await h.owner
      .insertInto('deal')
      .values({
        project_id: project,
        title,
        pipeline_id: where.pipeline,
        stage_id: where.stage,
        amount: 0,
        owner_id: owner,
        primary_contact_id: primary,
        created_by: owner,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return id
  }

  async function search(user: SignedInUser, q: string, project = projectA) {
    const res = await user.api('GET', `/v1/search?q=${encodeURIComponent(q)}`, { project })
    expect(res.status).toBe(200)
    return (await res.json()) as SearchResponse
  }

  const ids = (group: { items: { id: string }[] }) => group.items.map((item) => item.id)

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_search')
    admin = await h.signIn('owner')
    projectA = (await h.createProject(admin, 'Пошук А')).id
    projectB = (await h.createProject(admin, 'Пошук Б')).id
    projectC = (await h.createProject(admin, 'Пошук план')).id
    manager = await h.signIn()
    colleague = await h.signIn()
    noRights = await h.signIn()
    await h.addMember(projectA, manager.id, 'manager')
    await h.addMember(projectA, colleague.id, 'manager')
    const role = await h.owner
      .insertInto('role')
      .values({ project_id: projectA, name: 'Без прав', permissions: JSON.stringify({}) })
      .returning('id')
      .executeTakeFirstOrThrow()
    await h.owner
      .insertInto('project_member')
      .values({ project_id: projectA, user_id: noRights.id, role_id: role.id })
      .execute()
    await createStage(projectA)
    await createStage(projectB)
  })

  afterAll(async () => {
    await h?.stop()
  })

  describe('телефон, email, имя', () => {
    let target: string

    beforeAll(async () => {
      target = await contact({
        firstName: 'Ганна',
        lastName: 'Вигаданенко',
        phone: '+380671234567',
        email: 'ganna.vygadanenko@example.test',
      })
    })

    it.each([
      '0671234567',
      '067 123 45 67',
      '(067) 123-45-67',
      '+38 067 123 4567',
      '+380671234567',
    ])('находит контакт по номеру «%s»', async (q) => {
      const found = await search(admin, q)
      expect(ids(found.contacts)).toEqual([target])
      expect(found.deals.items).toEqual([])
      expect(found.organizations.items).toEqual([])
    })

    it('неполный номер ищется по цифрам внутри номера', async () => {
      expect(ids((await search(admin, '067123')).contacts)).toContain(target)
      expect(ids((await search(admin, '45 67')).contacts)).toContain(target)
      expect(ids((await search(admin, '0679999')).contacts)).not.toContain(target)
    })

    it('email — без учёта регистра, целиком и частью', async () => {
      expect(ids((await search(admin, 'Ganna.Vygadanenko@Example.TEST')).contacts)).toEqual([
        target,
      ])
      expect(ids((await search(admin, 'vygadanenko@')).contacts)).toEqual([target])
    })

    it('часть фамилии с опечаткой в одну букву (триграммы)', async () => {
      const found = await search(admin, 'Вигоданенк')
      expect(ids(found.contacts)).toEqual([target])
      expect(ids((await search(admin, 'Петренко')).contacts)).not.toContain(target)
      expect(found.contacts.items[0]).toEqual({
        id: target,
        firstName: 'Ганна',
        lastName: 'Вигаданенко',
      })
    })

    it('имя и фамилия вместе, подстрокой и без учёта регистра', async () => {
      expect(ids((await search(admin, 'ганна вигад')).contacts)).toEqual([target])
    })

    it('сделка по названию, организация по названию', async () => {
      const dealId = await deal('Сонячні панелі для Вигаданенко', null)
      const { id: orgId } = await h.owner
        .insertInto('organization')
        .values({ project_id: projectA, name: 'ТОВ «Сонячний Вигадок»' })
        .returning('id')
        .executeTakeFirstOrThrow()
      const found = await search(admin, 'сонячн')
      expect(ids(found.deals)).toEqual([dealId])
      expect(found.deals.items[0]).toMatchObject({ status: 'open', archivedAt: null })
      expect(ids(found.organizations)).toEqual([orgId])
    })
  })

  it('контакт проекта Б с тем же телефоном не находится в проекте А', async () => {
    const inA = await contact({ firstName: 'Остап', phone: '+380509876543' })
    const inB = await contact({ firstName: 'Остап', phone: '+380509876543', project: projectB })
    const fromA = await search(admin, '050 987 65 43', projectA)
    expect(ids(fromA.contacts)).toEqual([inA])
    expect(ids((await search(admin, '987654', projectA)).contacts)).toEqual([inA])
    expect(ids((await search(admin, 'Остап', projectA)).contacts)).toEqual([inA])
    expect(ids((await search(admin, '050 987 65 43', projectB)).contacts)).toEqual([inB])
  })

  describe('охват «свои»', () => {
    it('чужая сделка не находится, сделка общей очереди находится; «есть ещё» без скрытого', async () => {
      const own: string[] = []
      for (let i = 0; i < 9; i++) own.push(await deal(`Квазар ${i}`, manager.id))
      const queue = await deal('Квазар черга', null)
      const foreign: string[] = []
      for (let i = 0; i < 3; i++) foreign.push(await deal(`Квазар колеги ${i}`, colleague.id))

      const found = await search(manager, 'Квазар')
      expect(ids(found.deals).sort()).toEqual([...own, queue].sort())
      expect(found.deals.hasMore).toBe(false)

      const all = await search(admin, 'Квазар')
      expect(all.deals.items).toHaveLength(10)
      expect(all.deals.hasMore).toBe(true)
      expect(ids((await search(colleague, 'Квазар')).deals).sort()).toEqual(
        [...foreign, queue].sort(),
      )
    })

    it('чужой контакт не находится и не попадает в «есть ещё»', async () => {
      const own: string[] = []
      for (let i = 0; i < 10; i++) {
        own.push(await contact({ firstName: `Ірідій${i}`, createdBy: manager.id }))
      }
      const foreign = await contact({
        firstName: 'Ірідій',
        lastName: 'Колеги',
        phone: '+380931112233',
        createdBy: colleague.id,
      })

      const found = await search(manager, 'Ірідій')
      expect(ids(found.contacts).sort()).toEqual([...own].sort())
      expect(found.contacts.hasMore).toBe(false)
      expect((await search(manager, '0931112233')).contacts.items).toEqual([])
      expect((await search(manager, '1112233')).contacts.items).toEqual([])

      expect((await search(admin, 'Ірідій')).contacts.hasMore).toBe(true)
      expect(ids((await search(colleague, '0931112233')).contacts)).toEqual([foreign])
    })
  })

  it('архивная сделка находится с отметкой, сделка и контакт в корзине — нет', async () => {
    const archived = await deal('Пульсар архівний', null)
    const trashed = await deal('Пульсар у кошику', null)
    const trashedContact = await contact({ firstName: 'Пульсар', phone: '+380661234567' })
    await h.owner
      .updateTable('deal')
      .set({ archived_at: new Date() })
      .where('id', '=', archived)
      .execute()
    await h.owner
      .updateTable('deal')
      .set({ deleted_at: new Date() })
      .where('id', '=', trashed)
      .execute()
    await h.owner
      .updateTable('contact')
      .set({ deleted_at: new Date() })
      .where('id', '=', trashedContact)
      .execute()

    const found = await search(admin, 'Пульсар')
    expect(ids(found.deals)).toEqual([archived])
    expect(found.deals.items[0]?.archivedAt).toEqual(expect.any(String))
    expect(ids(found.contacts)).not.toContain(trashedContact)
    expect((await search(admin, '0661234567')).contacts.items).toEqual([])
  })

  it('короче двух символов — пустой ответ; слишком длинный запрос — 400', async () => {
    const nothing: SearchResponse = {
      deals: { items: [], hasMore: false },
      contacts: { items: [], hasMore: false },
      organizations: { items: [], hasMore: false },
    }
    expect(await search(admin, 'Г')).toEqual(nothing)
    expect(await search(admin, '  ')).toEqual(nothing)
    const res = await admin.api('GET', `/v1/search?q=${'а'.repeat(201)}`, { project: projectA })
    expect(res.status).toBe(400)
    expect(await problemOf(res)).toEqual(pathError('INVALID_SEARCH', 'q'))
  })

  it('без права «смотреть» группа пустая', async () => {
    await contact({ firstName: 'Невидимка' })
    expect(await search(noRights, 'Невидимка')).toEqual({
      deals: { items: [], hasMore: false },
      contacts: { items: [], hasMore: false },
      organizations: { items: [], hasMore: false },
    })
  })

  it('только в контексте проекта: без заголовка — 400, чужой проект — 403', async () => {
    expect((await admin.api('GET', '/v1/search?q=Ганна')).status).toBe(400)
    expect((await manager.api('GET', '/v1/search?q=Ганна', { project: projectB })).status).toBe(403)
  })

  describe('план запроса на 10 000 контактах', () => {
    beforeAll(async () => {
      await sql`
        insert into contact (project_id, first_name, last_name)
        select ${projectC}::uuid, 'Контакт' || g, md5(g::text) from generate_series(1, 10000) g
      `.execute(h.owner)
      await sql`
        insert into contact_phone (project_id, contact_id, phone, is_primary)
        select project_id, id, '+38067' || (1000000 + row_number() over (order by id))::text, true
        from contact where project_id = ${projectC}::uuid
      `.execute(h.owner)
      // Статистика для планировщика и перенос новых строк из очереди GIN-индекса в сам индекс
      // (fastupdate): иначе план считает по несвёрнутой очереди.
      for (const table of ['contact', 'contact_phone', 'contact_email']) {
        await sql`vacuum analyze ${sql.table(table)}`.execute(h.owner)
      }
    }, 120_000)

    /** План поиска контактов ролью приложения в проекте C (охват «все»). */
    async function plan(q: string) {
      return withProject(h.appDb, projectC, async (trx) => {
        const query = contactsQuery(trx, parseQuery(q), 'all', {
          userId: admin.id,
          teamUserIds: [],
        })
        const rows = await query.explain()
        const [found] = await query.execute()
        return { text: rows.map((row) => String(row['QUERY PLAN'])).join('\n'), found }
      })
    }

    it('по имени — триграммный индекс имени', async () => {
      // md5('1234') = 81dc9bdb52d04dc20036dbd8313ed055 — фамилия контакта 1234.
      const { text, found } = await plan('81dc9bdb52d')
      expect(found).toMatchObject({ first_name: 'Контакт1234' })
      expect(text).toContain('contact_trgm_idx')
      expect(text).not.toMatch(/Seq Scan on contact\b/)
    })

    it('по полному номеру — индекс номера; по части номера — триграммный индекс', async () => {
      const full = await plan('067 100 50 00')
      expect(full.found).toBeDefined()
      expect(full.text).toContain('contact_phone_search_idx')
      expect(full.text).not.toMatch(/Seq Scan on contact(_phone)?\b/)

      const part = await plan('1005000')
      expect(part.found).toBeDefined()
      expect(part.text).toContain('contact_phone_trgm_idx')
      expect(part.text).not.toMatch(/Seq Scan on contact(_phone)?\b/)
    })
  })
})
