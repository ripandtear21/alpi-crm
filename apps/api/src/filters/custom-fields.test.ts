import { randomUUID } from 'node:crypto'
import { withProject } from '@alpi/db'
import {
  type FieldDefinitionSummary,
  type FieldGroupSummary,
  type FilterGroup,
  type FilterNode,
  fullPermissions,
  type KanbanCardFields,
  type ListCount,
  type RoleSummary,
  type SavedFilterSummary,
} from '@alpi/shared'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import type { BulkJobDetails, BulkJobSummary } from '../bulk/routes.ts'
import { type BulkJobMessage, runBulkJob } from '../bulk/runner.ts'
import type { DealsPage } from '../deals/board.ts'
import { archiveDeals, DEAL_BULK_REGISTRY } from '../deals/bulk.ts'
import { buildFieldIndex } from '../jobs/field-index.ts'
import { loadMemberAccess } from '../roles/access.ts'
import { PROJECT_TEAMS, resolveViewer } from '../roles/scope.ts'
import { type ApiHarness, type SignedInUser, startApiHarness } from '../testing/api-harness.ts'
import { compileFilter } from './compile.ts'
import { loadFilterCatalog } from './custom.ts'

// Пользовательские поля в фильтрах, списках, сохранённых фильтрах, выгрузке и на карточке
// канбана, копия значений «часто фильтруют» (тикет crm-fields/07) — на настоящем PostgreSQL;
// API ходит ролью приложения без BYPASSRLS. Имена вымышленные.

describe('пользовательские поля в списках и фильтрах', () => {
  let h: ApiHarness
  let admin: SignedInUser
  let manager: SignedInUser
  let limited: SignedInUser
  let projectA: string
  let projectB: string
  let pipeline: string
  let stages: string[]
  let group: FieldGroupSummary
  let hiddenGroup: FieldGroupSummary
  const field: Record<string, FieldDefinitionSummary> = {}
  let secret: FieldDefinitionSummary
  let options: string[]
  /** Сделки D1…D5 по порядку. */
  let deals: string[]
  let counter = 0

  const api =
    (user: SignedInUser, project = projectA) =>
    (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) =>
      user.api(method, `/v1${path}`, { project, ...(body === undefined ? {} : { body }) })

  async function json<T>(res: Response, status = 200): Promise<T> {
    const text = await res.text()
    expect(res.status, text).toBe(status)
    return (text === '' ? null : JSON.parse(text)) as T
  }

  const q = (value: unknown) => encodeURIComponent(JSON.stringify(value))

  async function createField(
    project: string,
    groupId: string,
    code: string,
    type: string,
    extra: Record<string, unknown> = {},
  ): Promise<FieldDefinitionSummary> {
    return json(
      await api(admin, project)('POST', '/fields', {
        groupId,
        nameUk: `Поле ${code}`,
        nameRu: `Поле ${code} ru`,
        code,
        type,
        ...extra,
      }),
      201,
    )
  }

  async function createPipeline(project: string, stageNames = ['Новий', 'Дзвінок']) {
    counter += 1
    const created = await json<{ id: string }>(
      await api(admin, project)('POST', '/pipelines', {
        name: `Воронка ${counter}`,
        code: `cf${counter}`,
      }),
      201,
    )
    const ids: string[] = []
    for (const name of stageNames) {
      const stage = await json<{ id: string }>(
        await api(admin, project)('POST', `/pipelines/${created.id}/stages`, { name }),
        201,
      )
      ids.push(stage.id)
    }
    return { id: created.id, stages: ids }
  }

  /** Сделки прямо в базе (служебной ролью), у каждой свой контакт и свои значения `custom`. */
  async function seed(
    project: string,
    pipelineId: string,
    stageId: string,
    customs: Record<string, unknown>[],
    titles?: string[],
  ): Promise<string[]> {
    const contacts = await h.owner
      .insertInto('contact')
      .values(
        customs.map(() => {
          counter += 1
          return { project_id: project, first_name: `Клієнт${counter}` }
        }),
      )
      .returning('id')
      .execute()
    const rows = await h.owner
      .insertInto('deal')
      .values(
        customs.map((custom, index) => ({
          project_id: project,
          title: titles?.[index] ?? `Угода ${index + 1}`,
          pipeline_id: pipelineId,
          stage_id: stageId,
          owner_id: admin.id,
          primary_contact_id: contacts[index]?.id ?? '',
          custom: JSON.stringify(custom),
        })),
      )
      .returning('id')
      .execute()
    return rows.map((row) => row.id)
  }

  /** id сделок выдачи по фильтру (все страницы), по порядку выдачи. */
  async function ids(user: SignedInUser, params: string, project = projectA): Promise<string[]> {
    const out: string[] = []
    let cursor: string | null = null
    do {
      const url: string = `/deals?status=any&${params}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const page: DealsPage = await json(await api(user, project)('GET', url))
      out.push(...page.items.map((item) => item.id))
      cursor = page.nextCursor
    } while (cursor)
    return out
  }

  const D = (...numbers: number[]) => numbers.map((n) => deals[n - 1] ?? '')

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_custom_filters')
    admin = await h.signIn('owner')
    manager = await h.signIn()
    limited = await h.signIn()
    projectA = (await h.createProject(admin, 'Поля А')).id
    projectB = (await h.createProject(admin, 'Поля Б')).id
    await h.addMember(projectA, manager.id, 'manager')
    const created = await createPipeline(projectA)
    pipeline = created.id
    stages = created.stages
    group = await json(
      await api(admin)('POST', '/field-groups', { entity: 'deal', nameUk: 'Фільтри' }),
      201,
    )
    hiddenGroup = await json(
      await api(admin)('POST', '/field-groups', { entity: 'deal', nameUk: 'Таємна' }),
      201,
    )
    const types: [string, string, Record<string, unknown>?][] = [
      ['txt', 'text'],
      ['ph', 'phone'],
      ['em', 'email'],
      ['num', 'number'],
      ['money', 'money'],
      ['dt', 'date'],
      ['tm', 'time'],
      ['rng', 'date_range'],
      [
        'one',
        'single_option',
        { options: [{ nameUk: 'Перший' }, { nameUk: 'Другий' }, { nameUk: 'Третій' }] },
      ],
      ['many', 'multi_option', { options: [{ nameUk: 'А' }, { nameUk: 'Б' }, { nameUk: 'В' }] }],
      ['flag', 'boolean'],
      ['who', 'user'],
    ]
    for (const [code, type, extra] of types) {
      field[code] = await createField(projectA, group.id, code, type, extra)
    }
    secret = await createField(projectA, hiddenGroup.id, 'secret', 'text')
    options = (field.one?.options ?? []).map((o) => o.id)
    const many = (field.many?.options ?? []).map((o) => o.id)
    const [o1, o2, o3] = options
    const [m1, m2, m3] = many
    deals = await seed(
      projectA,
      pipeline,
      stages[0] ?? '',
      [
        {
          txt: 'Київ центр',
          ph: '+380501112233',
          em: 'a@example.com',
          num: 5,
          money: { amount: 100, currency: 'UAH' },
          dt: '2026-01-10',
          tm: '09:00',
          rng: { from: '2026-01-01', to: '2026-01-31' },
          one: o1,
          many: [m1, m2],
          flag: true,
          who: admin.id,
          secret: 'таємниця-1',
        },
        {
          txt: 'Львів',
          ph: '+380671234567',
          num: -3,
          money: { amount: 500, currency: 'EUR' },
          dt: '2026-03-01',
          tm: '13:30',
          rng: { from: '2026-02-10', to: '2026-03-10' },
          one: o2,
          many: [m3],
          flag: false,
          who: manager.id,
        },
        {
          txt: 'Одеса',
          num: 10.5,
          money: { amount: 1000, currency: 'USD' },
          dt: '2026-12-31',
          tm: '18:45',
          one: o1,
          many: [m2],
        },
        { num: 100 },
        {},
      ],
      ['Альфа', 'Бета', 'Гама', 'Дельта', 'Епсилон'],
    )
    void o3
    // Роль «Обмежена»: группа «Таємна» скрыта, выгрузка разрешена.
    const role = await json<RoleSummary>(
      await admin.api('POST', '/roles', {
        project: projectA,
        body: {
          name: 'Обмежена',
          permissions: {
            actions: { deals: ['view', 'create', 'edit'] },
            scopes: { deals: { read: 'all', write: 'all' } },
            standalone: ['export'],
            fieldGroups: { [hiddenGroup.id]: 'hidden' },
          },
        },
      }),
      201,
    )
    await h.owner
      .insertInto('project_member')
      .values({ project_id: projectA, user_id: limited.id, role_id: role.id })
      .execute()
  })

  afterAll(async () => {
    await h?.stop()
  })

  /** Таблица операций тикета: условие → ровно эти сделки (номера D1…D5). */
  function operationCases(): [string, FilterNode, number[]][] {
    const [o1, o2] = options
    const [, m2] = (field.many?.options ?? []).map((o) => o.id)
    const id = (code: string) => `custom.${field[code]?.id}`
    return [
      ['текст содержит', { field: 'custom.txt', op: 'contains', value: 'центр' }, [1]],
      ['текст равно', { field: id('txt'), op: 'eq', value: 'Львів' }, [2]],
      ['текст пусто', { field: 'custom.txt', op: 'empty' }, [4, 5]],
      ['текст не пусто', { field: 'custom.txt', op: 'not_empty' }, [1, 2, 3]],
      [
        'телефон равно (приводится к E.164)',
        { field: 'custom.ph', op: 'eq', value: '050 111 22 33' },
        [1],
      ],
      [
        'email равно (нижний регистр)',
        { field: 'custom.em', op: 'eq', value: 'A@Example.com' },
        [1],
      ],
      ['число =', { field: 'custom.num', op: 'eq', value: 5 }, [1]],
      ['число <', { field: id('num'), op: 'lt', value: 0 }, [2]],
      ['число >', { field: 'custom.num', op: 'gt', value: 10 }, [3, 4]],
      ['число между', { field: 'custom.num', op: 'between', value: [5, 10.5] }, [1, 3]],
      ['число пусто', { field: 'custom.num', op: 'empty' }, [5]],
      ['число не пусто', { field: 'custom.num', op: 'not_empty' }, [1, 2, 3, 4]],
      ['деньги =', { field: 'custom.money', op: 'eq', value: 500 }, [2]],
      ['деньги <', { field: 'custom.money', op: 'lt', value: 200 }, [1]],
      ['деньги >', { field: 'custom.money', op: 'gt', value: 200 }, [2, 3]],
      ['деньги между', { field: 'custom.money', op: 'between', value: [100, 500] }, [1, 2]],
      ['деньги пусто', { field: 'custom.money', op: 'empty' }, [4, 5]],
      ['дата =', { field: 'custom.dt', op: 'eq', value: '2026-03-01' }, [2]],
      ['дата <', { field: 'custom.dt', op: 'lt', value: '2026-03-01' }, [1]],
      ['дата >', { field: 'custom.dt', op: 'gt', value: '2026-03-01' }, [3]],
      [
        'дата между',
        { field: 'custom.dt', op: 'between', value: ['2026-01-01', '2026-03-01'] },
        [1, 2],
      ],
      ['дата не пусто', { field: 'custom.dt', op: 'not_empty' }, [1, 2, 3]],
      ['время =', { field: 'custom.tm', op: 'eq', value: '13:30' }, [2]],
      ['время <', { field: 'custom.tm', op: 'lt', value: '13:30' }, [1]],
      ['время >', { field: 'custom.tm', op: 'gt', value: '13:30' }, [3]],
      ['время между', { field: 'custom.tm', op: 'between', value: ['09:00', '13:30'] }, [1, 2]],
      ['время пусто', { field: 'custom.tm', op: 'empty' }, [4, 5]],
      ['интервал: начало <', { field: 'custom.rng.start', op: 'lt', value: '2026-02-01' }, [1]],
      ['интервал: начало >', { field: `${id('rng')}.start`, op: 'gt', value: '2026-02-01' }, [2]],
      [
        'интервал: конец между',
        { field: 'custom.rng.end', op: 'between', value: ['2026-01-31', '2026-02-28'] },
        [1],
      ],
      ['интервал: конец >', { field: 'custom.rng.end', op: 'gt', value: '2026-02-28' }, [2]],
      ['интервал: пусто', { field: 'custom.rng.start', op: 'empty' }, [3, 4, 5]],
      ['один вариант: любой из', { field: 'custom.one', op: 'in', value: [o1 ?? ''] }, [1, 3]],
      [
        'один вариант: ни один из',
        { field: 'custom.one', op: 'not_in', value: [o1 ?? ''] },
        [2, 4, 5],
      ],
      ['один вариант: пусто', { field: 'custom.one', op: 'empty' }, [4, 5]],
      ['один вариант: не пусто', { field: 'custom.one', op: 'not_empty' }, [1, 2, 3]],
      [
        'один вариант: любой из двух',
        { field: id('one'), op: 'in', value: [o1 ?? '', o2 ?? ''] },
        [1, 2, 3],
      ],
      ['несколько: любой из', { field: 'custom.many', op: 'in', value: [m2 ?? ''] }, [1, 3]],
      [
        'несколько: ни один из',
        { field: 'custom.many', op: 'not_in', value: [m2 ?? ''] },
        [2, 4, 5],
      ],
      ['несколько: пусто', { field: 'custom.many', op: 'empty' }, [4, 5]],
      ['несколько: не пусто', { field: 'custom.many', op: 'not_empty' }, [1, 2, 3]],
      ['да', { field: 'custom.flag', op: 'eq', value: true }, [1]],
      ['нет', { field: 'custom.flag', op: 'eq', value: false }, [2]],
      ['да/нет: пусто', { field: 'custom.flag', op: 'empty' }, [3, 4, 5]],
      ['пользователь: я', { field: 'custom.who', op: 'eq', value: 'me' }, [1]],
      [
        'пользователь: любой из',
        { field: 'custom.who', op: 'in', value: [manager.id, 'me'] },
        [1, 2],
      ],
      ['пользователь: пусто', { field: 'custom.who', op: 'empty' }, [3, 4, 5]],
      ['пользователь: не пусто', { field: 'custom.who', op: 'not_empty' }, [1, 2]],
    ]
  }

  async function expectOperations() {
    for (const [label, condition, expected] of operationCases()) {
      const filter = { and: [{ field: 'pipeline', op: 'eq', value: pipeline }, condition] }
      const found = await ids(admin, `filter=${q(filter)}`)
      expect({ label, found: [...found].sort() }).toEqual({ label, found: D(...expected).sort() })
    }
  }

  async function markAndBuild(code: string, project = projectA) {
    const target = field[code]
    if (!target) throw new Error(`нет поля ${code}`)
    const updated = await json<FieldDefinitionSummary>(
      await api(admin, project)('PUT', `/fields/${target.id}`, { isFrequentlyFiltered: true }),
    )
    expect(updated.indexState).toBe('building')
    expect(await buildFieldIndex(h.appDb, { projectId: project, fieldId: target.id }, 2)).toBe(
      'ready',
    )
  }

  /** Строки копии поля: [номер части, текст, число] по записям. */
  async function copyOf(fieldId: string) {
    const rows = await h.owner
      .selectFrom('custom_value')
      .select(['record_id', 'part', 'value_text', 'value_number', 'project_id'])
      .where('field_id', '=', fieldId)
      .orderBy('record_id')
      .orderBy('part')
      .orderBy('value_text')
      .orderBy('value_number')
      .execute()
    return rows
  }

  describe('построитель запроса: таблица операций', () => {
    it('каждая строка таблицы операций находит ровно ожидаемые сделки (по `custom`, без копии)', async () => {
      await expectOperations()
    })

    it('группы И/ИЛИ с системными и пользовательскими полями вместе', async () => {
      const [o1] = options
      const filter: FilterGroup = {
        and: [
          { field: 'pipeline', op: 'eq', value: pipeline },
          {
            or: [
              {
                and: [
                  { field: 'title', op: 'contains', value: 'Аль' },
                  { field: 'custom.num', op: 'gt', value: 1 },
                ],
              },
              {
                and: [
                  { field: 'custom.one', op: 'in', value: [o1 ?? ''] },
                  { field: 'custom.dt', op: 'gt', value: '2026-06-01' },
                ],
              },
              { field: 'custom.money', op: 'empty' },
            ],
          },
        ],
      }
      expect((await ids(admin, `filter=${q(filter)}`)).sort()).toEqual(D(1, 3, 4, 5).sort())
      const count = await json<ListCount>(
        await api(admin)('GET', `/deals/count?status=any&filter=${q(filter)}`),
      )
      expect(count).toEqual({ count: 4, approximate: false })
    })

    it('значения — параметрами: код поля и значение не попадают в текст SQL', async () => {
      const injected = "x'); drop table deal; --"
      const catalog = await withProject(h.appDb, projectA, (trx) =>
        loadFilterCatalog(trx, fullPermissions(), 'deal'),
      )
      const compiled = h.appDb
        .selectFrom('deal')
        .select('deal.id')
        .where(
          compileFilter(
            'deals',
            {
              or: [
                { field: `custom.${field.txt?.id}`, op: 'contains', value: injected },
                { field: `custom.${field.txt?.id}`, op: 'eq', value: injected },
                { field: `custom.${field.num?.id}`, op: 'between', value: [1, 4242.5] },
              ],
            },
            { actorId: 'me-id', custom: catalog },
          ),
        )
        .compile()
      expect(compiled.sql).not.toContain('drop table')
      expect(compiled.sql).not.toContain('txt')
      expect(compiled.sql).not.toContain('4242')
      expect(compiled.parameters).toContain(injected)
      expect(compiled.parameters).toContain('txt')
    })

    it('неверные условия — 400, неизвестный код — 422 CUSTOM_FIELD_UNKNOWN', async () => {
      const bad = [
        { field: 'custom.num', op: 'contains', value: 'x' },
        { field: 'custom.num', op: 'between', value: [5, 1] },
        { field: 'custom.rng', op: 'lt', value: '2026-01-01' },
        { field: 'custom.dt', op: 'eq', value: '2026-02-30' },
        { field: 'custom.one', op: 'in', value: ['не-uuid'] },
      ]
      for (const condition of bad) {
        const res = await api(admin)('GET', `/deals?filter=${q({ and: [condition] })}`)
        expect(res.status, JSON.stringify(condition)).toBe(400)
      }
      const unknown = await api(admin)(
        'GET',
        `/deals?filter=${q({ and: [{ field: 'custom.nope', op: 'empty' }] })}`,
      )
      expect(await json(unknown, 422)).toMatchObject({ code: 'CUSTOM_FIELD_UNKNOWN' })
    })
  })

  describe('колонки, сортировка и выгрузка', () => {
    it('сортировка по пользовательскому полю идёт по страницам курсором; пустые — в начале при возрастании', async () => {
      const inPipeline = `pipeline=${pipeline}&limit=2`
      expect(await ids(admin, `${inPipeline}&sort=custom.num:asc`)).toEqual(D(5, 2, 1, 3, 4))
      expect(await ids(admin, `${inPipeline}&sort=custom.num:desc`)).toEqual(D(4, 3, 1, 2, 5))
      const byText = await ids(admin, `${inPipeline}&sort=custom.txt:asc`)
      expect(byText.slice(0, 2).sort()).toEqual(D(4, 5).sort())
      expect(byText.slice(2)).toEqual(D(1, 2, 3))
      // Один вариант — по порядку вариантов: «Перший» (D1, D3), «Другий» (D2).
      const byOption = await ids(admin, `${inPipeline}&sort=custom.one:asc`)
      expect(byOption.slice(0, 2).sort()).toEqual(D(4, 5).sort())
      expect(byOption.slice(2, 4).sort()).toEqual(D(1, 3).sort())
      expect(byOption[4]).toBe(D(2)[0])
      // «Несколько вариантов» не сортируется.
      expect((await api(admin)('GET', `/deals?sort=custom.many:asc`)).status).toBe(400)
    })

    it('выгрузка: выбранные колонки полей, варианты и пользователи — названиями', async () => {
      const columns = [
        'title',
        'custom.one',
        'custom.many',
        'custom.flag',
        'custom.who',
        'custom.money',
        'custom.rng',
      ].join(',')
      const res = await api(admin)(
        'GET',
        `/deals/export.csv?status=any&pipeline=${pipeline}&sort=title:asc&columns=${columns}`,
      )
      const text = await res.text()
      expect(res.status, text).toBe(200)
      const lines = text.replace('﻿', '').trim().split('\r\n')
      expect(lines[0]).toBe('Назва,Поле one,Поле many,Поле flag,Поле who,Поле money,Поле rng')
      expect(lines[1]).toBe('Альфа,Перший,"А, Б",Так,Власник,100 UAH,2026-01-01 — 2026-01-31')
      expect(lines[2]).toBe('Бета,Другий,В,Ні,Користувач,500 EUR,2026-02-10 — 2026-03-10')
      const ru = await api(admin)(
        'GET',
        `/deals/export.csv?status=any&pipeline=${pipeline}&columns=custom.flag&lang=ru`,
      )
      expect((await ru.text()).replace('﻿', '').split('\r\n')[0]).toBe('Поле flag ru')
    })
  })

  describe('права: скрытая группа', () => {
    it('условие, сортировка и колонка выгрузки по скрытому полю — 422 CUSTOM_FIELD_UNKNOWN, как неизвестный код', async () => {
      const call = api(limited)
      const condition = { and: [{ field: 'custom.secret', op: 'not_empty' }] }
      const byId = { and: [{ field: `custom.${secret.id}`, op: 'not_empty' }] }
      for (const path of [
        `/deals?filter=${q(condition)}`,
        `/deals?filter=${q(byId)}`,
        `/deals/count?filter=${q(condition)}`,
        '/deals?sort=custom.secret:asc',
        '/deals/export.csv?columns=title,custom.secret',
      ]) {
        expect(await json(await call('GET', path), 422), path).toEqual({
          code: 'CUSTOM_FIELD_UNKNOWN',
          details: { field: expect.stringMatching(/^custom\./) },
        })
      }
      expect(
        await json(
          await call('POST', '/saved-filters', {
            entity: 'deals',
            name: 'Таємне',
            visibility: 'personal',
            filter: condition,
          }),
          422,
        ),
      ).toMatchObject({ code: 'CUSTOM_FIELD_UNKNOWN' })
      // Администратору то же условие — 200.
      expect((await api(admin)('GET', `/deals?filter=${q(condition)}`)).status).toBe(200)
    })

    it('в выгрузке и выдаче канбана нет кода и значения скрытого поля', async () => {
      await json(
        await api(admin)('PUT', `/pipelines/${pipeline}/card-fields`, {
          fieldIds: [secret.id, field.num?.id],
        }),
      )
      const csv = await (
        await api(limited)(
          'GET',
          `/deals/export.csv?status=any&pipeline=${pipeline}&columns=title,custom.num`,
        )
      ).text()
      expect(csv).toContain('Поле num')
      for (const leak of ['secret', 'таємниця', secret.id]) expect(csv).not.toContain(leak)
      const page = await api(limited)('GET', `/deals?status=any&pipeline=${pipeline}&view=kanban`)
      const text = await page.text()
      expect(page.status, text).toBe(200)
      for (const leak of ['secret', 'таємниця']) expect(text).not.toContain(leak)
      const cardFields = await json<KanbanCardFields>(
        await api(limited)('GET', `/pipelines/${pipeline}/card-fields`),
      )
      expect(cardFields).toEqual({ fieldIds: [field.num?.id] })
      // Администратор видит оба поля карточки.
      const adminCard = await json<DealsPage>(
        await api(admin)('GET', `/deals?status=any&pipeline=${pipeline}&view=kanban`),
      )
      const first = adminCard.items.find((item) => item.id === D(1)[0])
      expect(first?.custom).toEqual({ secret: 'таємниця-1', num: 5 })
    })
  })

  describe('карточка канбана', () => {
    it('четыре поля — 422; выдача канбана отдаёт значения только выбранных полей', async () => {
      const four = ['txt', 'num', 'dt', 'flag'].map((code) => field[code]?.id)
      expect(
        await json(
          await api(admin)('PUT', `/pipelines/${pipeline}/card-fields`, { fieldIds: four }),
          422,
        ),
      ).toMatchObject({ code: 'TOO_MANY_CARD_FIELDS' })
      const chosen = [field.flag?.id, field.txt?.id]
      expect(
        await json<KanbanCardFields>(
          await api(admin)('PUT', `/pipelines/${pipeline}/card-fields`, { fieldIds: chosen }),
        ),
      ).toEqual({ fieldIds: chosen })
      const page = await json<DealsPage>(
        await api(limited)('GET', `/deals?status=any&pipeline=${pipeline}&view=kanban`),
      )
      const byId = new Map(page.items.map((item) => [item.id, item.custom]))
      expect(byId.get(D(1)[0] ?? '')).toEqual({ flag: true, txt: 'Київ центр' })
      // Пустое поле карточки в ответе не приходит.
      expect(byId.get(D(3)[0] ?? '')).toEqual({ txt: 'Одеса' })
      expect(byId.get(D(5)[0] ?? '')).toEqual({})
      // Без выбора канбана список отдаёт все видимые поля.
      const list = await json<DealsPage>(
        await api(admin)('GET', `/deals?status=any&pipeline=${pipeline}`),
      )
      expect(Object.keys(list.items.find((i) => i.id === D(1)[0])?.custom ?? {}).length).toBe(13)
      // view=kanban без воронки — 400; менеджер настройки не меняет — 403.
      expect((await api(manager)('GET', '/deals?view=kanban')).status).toBe(400)
      expect(
        (await api(manager)('PUT', `/pipelines/${pipeline}/card-fields`, { fieldIds: [] })).status,
      ).toBe(403)
      // Поле контакта и чужое поле на карточку сделки не ставятся.
      const contactGroup = await json<FieldGroupSummary>(
        await api(admin)('POST', '/field-groups', { entity: 'contact', nameUk: 'Контакт' }),
        201,
      )
      const contactField = await createField(projectA, contactGroup.id, 'city', 'text')
      expect(
        await json(
          await api(admin)('PUT', `/pipelines/${pipeline}/card-fields`, {
            fieldIds: [contactField.id],
          }),
          422,
        ),
      ).toMatchObject({ code: 'CUSTOM_FIELD_UNKNOWN' })
      // Архивное поле с карточки пропадает само.
      await json(await api(admin)('POST', `/fields/${field.flag?.id}/archive`))
      expect(
        await json<KanbanCardFields>(await api(admin)('GET', `/pipelines/${pipeline}/card-fields`)),
      ).toEqual({ fieldIds: [field.txt?.id] })
      await json(await api(admin)('POST', `/fields/${field.flag?.id}/restore`))
    })

    it('база не примет четвёртое поле карточки', async () => {
      await expect(
        h.owner
          .insertInto('pipeline_card_field')
          .values({
            project_id: projectA,
            pipeline_id: pipeline,
            field_id: field.em?.id ?? '',
            position: 4,
          })
          .execute(),
      ).rejects.toThrow(/pipeline_card_field_position_check/)
    })
  })

  describe('сохранённые фильтры', () => {
    it('сохраняется, открывается и даёт тот же результат; после архива поля — пометка «умова недоступна» и без условия', async () => {
      const filter: FilterGroup = {
        and: [
          { field: 'pipeline', op: 'eq', value: pipeline },
          { field: 'custom.num', op: 'gt', value: 1 },
        ],
      }
      const direct = await ids(admin, `filter=${q(filter)}`)
      expect(direct.sort()).toEqual(D(1, 3, 4).sort())
      const saved = await json<SavedFilterSummary>(
        await api(admin)('POST', '/saved-filters', {
          entity: 'deals',
          name: 'Число більше 1',
          visibility: 'project',
          filter,
        }),
        201,
      )
      // Хранится по id поля.
      expect(saved.filter).toEqual({
        and: [
          { field: 'pipeline', op: 'eq', value: pipeline },
          { field: `custom.${field.num?.id}`, op: 'gt', value: 1 },
        ],
      })
      const open = async (user: SignedInUser) =>
        (
          await json<SavedFilterSummary[]>(await api(user)('GET', '/saved-filters?entity=deals'))
        ).find((f) => f.id === saved.id)
      const opened = await open(admin)
      expect(opened?.unavailableConditions).toBe(0)
      expect((await ids(admin, `filter=${q(opened?.filter)}`)).sort()).toEqual(direct.sort())

      await json(await api(admin)('POST', `/fields/${field.num?.id}/archive`))
      const archived = await open(admin)
      expect(archived?.unavailableConditions).toBe(1)
      expect(archived?.filter).toEqual({ and: [{ field: 'pipeline', op: 'eq', value: pipeline }] })
      // Применить его можно: условие по архивному полю не применяется.
      expect((await ids(admin, `filter=${q(archived?.filter)}`)).sort()).toEqual(
        D(1, 2, 3, 4, 5).sort(),
      )
      // Прямой запрос с архивным полем — 422.
      expect((await api(admin)('GET', `/deals?filter=${q(filter)}`)).status).toBe(422)

      await json(await api(admin)('POST', `/fields/${field.num?.id}/restore`))
      expect((await open(admin))?.unavailableConditions).toBe(0)
    })

    it('условие по полю, скрытому от того, кто открыл общий фильтр, не применяется', async () => {
      const saved = await json<SavedFilterSummary>(
        await api(admin)('POST', '/saved-filters', {
          entity: 'deals',
          name: 'З таємним полем',
          visibility: 'project',
          filter: {
            or: [
              { field: 'custom.secret', op: 'not_empty' },
              { field: 'custom.num', op: 'eq', value: 5 },
            ],
          },
        }),
        201,
      )
      const list = await json<SavedFilterSummary[]>(
        await api(limited)('GET', '/saved-filters?entity=deals'),
      )
      const opened = list.find((f) => f.id === saved.id)
      expect(opened?.unavailableConditions).toBe(1)
      expect(JSON.stringify(opened)).not.toContain(secret.id)
      expect(opened?.filter).toEqual({
        or: [{ field: `custom.${field.num?.id}`, op: 'eq', value: 5 }],
      })
    })
  })

  describe('контакты и организации', () => {
    it('фильтр, сортировка и выгрузка по полям контакта и организации', async () => {
      const contactGroup = await json<FieldGroupSummary>(
        await api(admin)('POST', '/field-groups', { entity: 'contact', nameUk: 'Контакти' }),
        201,
      )
      const age = await createField(projectA, contactGroup.id, 'age', 'number')
      const orgGroup = await json<FieldGroupSummary>(
        await api(admin)('POST', '/field-groups', {
          entity: 'organization',
          nameUk: 'Організації',
        }),
        201,
      )
      const size = await createField(projectA, orgGroup.id, 'size', 'single_option', {
        options: [{ nameUk: 'Мала' }, { nameUk: 'Велика' }],
      })
      const contacts = await h.owner
        .insertInto('contact')
        .values(
          [20, 40, 30].map((value, i) => ({
            project_id: projectA,
            first_name: `Вік${i}`,
            custom: JSON.stringify({ age: value }),
          })),
        )
        .returning('id')
        .execute()
      const [small, big] = size.options.map((o) => o.id)
      const orgs = await h.owner
        .insertInto('organization')
        .values(
          [small, big].map((option, i) => ({
            project_id: projectA,
            name: `Організація ${i}`,
            custom: JSON.stringify({ size: option }),
          })),
        )
        .returning('id')
        .execute()

      const contactPage = await json<{ items: { id: string }[] }>(
        await api(admin)(
          'GET',
          `/contacts/list?filter=${q({ and: [{ field: 'custom.age', op: 'gt', value: 25 }] })}&sort=custom.age:desc`,
        ),
      )
      expect(contactPage.items.map((i) => i.id)).toEqual([contacts[1]?.id, contacts[2]?.id])
      const orgPage = await json<{ items: { id: string }[] }>(
        await api(admin)(
          'GET',
          `/organizations/list?filter=${q({ and: [{ field: `custom.${size.id}`, op: 'in', value: [big] }] })}`,
        ),
      )
      expect(orgPage.items.map((i) => i.id)).toEqual([orgs[1]?.id])
      const csv = await (
        await api(admin)('GET', `/organizations/export.csv?columns=name,custom.size&sort=name:asc`)
      ).text()
      expect(csv).toContain('Організація 1,Велика')
      expect((await api(admin)('GET', `/contacts/list?sort=custom.unknown:asc`)).status).toBe(422)
      expect(age.entity).toBe('contact')
    })
  })

  describe('копия значений «часто фильтруют»', () => {
    it('с готовой копией таблица операций даёт те же сделки, а запрос идёт через custom_value', async () => {
      for (const code of Object.keys(field)) await markAndBuild(code)
      const [o1] = options
      // Копия: по строке на значение, у «несколько» — на каждый вариант, у интервала — две.
      const many = await copyOf(field.many?.id ?? '')
      expect(many.filter((r) => r.record_id === D(1)[0]).length).toBe(2)
      const rng = await copyOf(field.rng?.id ?? '')
      expect(rng.filter((r) => r.record_id === D(1)[0]).map((r) => [r.part, r.value_text])).toEqual(
        [
          [1, '2026-01-01'],
          [2, '2026-01-31'],
        ],
      )
      const money = await copyOf(field.money?.id ?? '')
      expect(money.map((r) => r.value_number).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
        100, 500, 1000,
      ])
      await expectOperations()
      const catalog = await withProject(h.appDb, projectA, (trx) =>
        loadFilterCatalog(trx, fullPermissions(), 'deal'),
      )
      expect(catalog.every((f) => f.indexReady || f.code === 'secret')).toBe(true)
      const compiled = h.appDb
        .selectFrom('deal')
        .select('deal.id')
        .where(
          compileFilter(
            'deals',
            { and: [{ field: `custom.${field.one?.id}`, op: 'in', value: [o1 ?? ''] }] },
            { actorId: admin.id, custom: catalog },
          ),
        )
        .compile()
      expect(compiled.sql).toContain('custom_value')
    })

    it('копия следует за `custom`: изменение, очистка, запись в обход API, удаление записи', async () => {
      const num = field.num?.id ?? ''
      const [id] = await seed(projectA, pipeline, stages[1] ?? '', [{ num: 1 }])
      const valuesOf = async () =>
        (await copyOf(num)).filter((r) => r.record_id === id).map((r) => r.value_number)
      expect(await valuesOf()).toEqual([1])
      await json(await api(admin)('PUT', `/deals/${id}`, { custom: { num: 7 } }))
      expect(await valuesOf()).toEqual([7])
      await json(await api(admin)('PUT', `/deals/${id}`, { custom: { num: null } }))
      expect(await valuesOf()).toEqual([])
      // Запись в обход общего пути (как фоновые задачи): ролью приложения прямо в таблицу.
      await withProject(h.appDb, projectA, (trx) =>
        sql`update deal set custom = custom || '{"num": 9}'::jsonb where id = ${id}`.execute(trx),
      )
      expect(await valuesOf()).toEqual([9])
      // Массовая операция по фильтру с условием по пользовательскому полю: выбор — по копии.
      const access = await withProject(h.appDb, projectA, (trx) => loadMemberAccess(trx, admin.id))
      if (!access) throw new Error('нет доступа')
      const selected = await withProject(h.appDb, projectA, async (trx) =>
        archiveDeals.select(
          trx,
          { and: [{ field: 'custom.num', op: 'eq', value: 9 }] },
          {
            bulkJobId: randomUUID(),
            initiatorId: admin.id,
            access,
            viewer: await resolveViewer(trx, admin.id, PROJECT_TEAMS),
            params: {},
          },
        ),
      )
      expect(selected).toEqual([id])
      await h.owner
        .deleteFrom('deal')
        .where('id', '=', id ?? '')
        .execute()
      expect(await valuesOf()).toEqual([])
    })

    it('снятие отметки и архив убирают копию; восстановление строит её заново', async () => {
      const dt = field.dt?.id ?? ''
      expect((await copyOf(dt)).length).toBe(3)
      const off = await json<FieldDefinitionSummary>(
        await api(admin)('PUT', `/fields/${dt}`, { isFrequentlyFiltered: false }),
      )
      expect(off.indexState).toBeNull()
      expect(await copyOf(dt)).toEqual([])
      await markAndBuild('dt')
      expect((await copyOf(dt)).length).toBe(3)

      const archived = await json<FieldDefinitionSummary>(
        await api(admin)('POST', `/fields/${dt}/archive`),
      )
      expect(archived.indexState).toBeNull()
      expect(await copyOf(dt)).toEqual([])
      const restored = await json<FieldDefinitionSummary>(
        await api(admin)('POST', `/fields/${dt}/restore`),
      )
      expect(restored.indexState).toBe('building')
      // Пока строится, фильтр работает по `custom`.
      const filter = { and: [{ field: 'custom.dt', op: 'eq', value: '2026-03-01' }] }
      expect(await ids(admin, `filter=${q(filter)}`)).toEqual(D(2))
      expect(await buildFieldIndex(h.appDb, { projectId: projectA, fieldId: dt })).toBe('ready')
      expect((await copyOf(dt)).length).toBe(3)
    })

    it('задача: повторный запуск не размножает строки; прежняя копия «готово» не ставит', async () => {
      const txt = field.txt?.id ?? ''
      await json(await api(admin)('PUT', `/fields/${txt}`, { isFrequentlyFiltered: false }))
      await json(await api(admin)('PUT', `/fields/${txt}`, { isFrequentlyFiltered: true }))
      const outcomes = await Promise.all([
        buildFieldIndex(h.appDb, { projectId: projectA, fieldId: txt }, 1),
        buildFieldIndex(h.appDb, { projectId: projectA, fieldId: txt }, 1),
        buildFieldIndex(h.appDb, { projectId: projectA, fieldId: txt }, 2),
      ])
      expect(outcomes).toContain('ready')
      expect((await copyOf(txt)).map((r) => r.value_text).sort()).toEqual(
        ['Київ центр', 'Львів', 'Одеса'].sort(),
      )
      expect(await buildFieldIndex(h.appDb, { projectId: projectA, fieldId: txt })).toBe('skipped')
      // Та же строка второй раз база не примет.
      const [row] = await copyOf(txt)
      if (!row) throw new Error('нет строки')
      await expect(
        h.owner
          .insertInto('custom_value')
          .values({
            project_id: row.project_id,
            field_id: txt,
            record_id: row.record_id,
            part: row.part,
            value_text: row.value_text,
            value_number: row.value_number,
          })
          .execute(),
      ).rejects.toThrow(/custom_value_text_idx/)
    })

    it('ошибка задачи переводит поле в failed с текстом ошибки', async () => {
      const big = await createField(projectA, group.id, 'big', 'number')
      // Число, которого нет в float8: так значение могло лечь только в обход API.
      const [id] = await seed(projectA, pipeline, stages[1] ?? '', [{}])
      await sql`update deal set custom = '{"big": 1e400}'::jsonb where id = ${id}`.execute(h.owner)
      const marked = await json<FieldDefinitionSummary>(
        await api(admin)('PUT', `/fields/${big.id}`, { isFrequentlyFiltered: true }),
      )
      expect(marked.indexState).toBe('building')
      expect(await buildFieldIndex(h.appDb, { projectId: projectA, fieldId: big.id })).toBe(
        'failed',
      )
      const failed = await json<FieldDefinitionSummary>(
        await api(admin)('GET', `/fields/${big.id}`),
      )
      expect(failed.indexState).toBe('failed')
      expect(failed.indexError).toMatch(/out of range/)
      expect(await copyOf(big.id)).toEqual([])
      await h.owner
        .deleteFrom('deal')
        .where('id', '=', id ?? '')
        .execute()
    })
  })

  describe('массовая операция по фильтру с пользовательским полем', () => {
    const queued: BulkJobMessage[] = []
    const actions = new Map(DEAL_BULK_REGISTRY)
    let bulkApp: ReturnType<typeof createApp>
    /** Участник с «массовыми операциями»; группа «Таємна» от его роли скрыта. */
    let initiator: SignedInUser
    let roleId: string
    const basePermissions = {
      actions: { deals: ['view', 'create', 'edit', 'delete'] },
      scopes: { deals: { read: 'all', write: 'all' } },
      standalone: ['bulk_operations', 'transfer_deals'],
    }

    beforeAll(async () => {
      // Приложение с действиями сделок; очередь — список: операцию выполняет runBulkJob ниже.
      bulkApp = createApp({
        auth: h.auth,
        db: h.appDb,
        bulk: {
          actions,
          enqueue: async (_trx, message) => {
            queued.push(message)
          },
        },
      })
      initiator = await h.signIn()
      const role = await json<RoleSummary>(
        await admin.api('POST', '/roles', {
          project: projectA,
          body: {
            name: 'Масові',
            permissions: { ...basePermissions, fieldGroups: { [hiddenGroup.id]: 'hidden' } },
          },
        }),
        201,
      )
      roleId = role.id
      await h.owner
        .insertInto('project_member')
        .values({ project_id: projectA, user_id: initiator.id, role_id: role.id })
        .execute()
    })

    const start = (user: SignedInUser, body: unknown) =>
      user.call(bulkApp, 'POST', '/v1/bulk-jobs', { project: projectA, body })

    /** Выполняет операцию так же, как обработчик очереди, и отдаёт её состояние. */
    async function run(user: SignedInUser, started: BulkJobSummary) {
      const message = queued.find((m) => m.bulkJobId === started.id)
      if (!message) throw new Error('операции нет в очереди')
      await runBulkJob(h.appDb, actions, message)
      return json<BulkJobDetails>(
        await user.call(bulkApp, 'GET', `/v1/bulk-jobs/${started.id}`, { project: projectA }),
      )
    }

    /** Архив и корзина сделок — прямо из базы. */
    async function stateOf(dealIds: string[]) {
      const rows = await h.owner
        .selectFrom('deal')
        .select(['id', 'archived_at', 'deleted_at'])
        .where('id', 'in', dealIds)
        .execute()
      return Object.fromEntries(
        rows.map((r) => [
          r.id,
          { archived: r.archived_at !== null, deleted: r.deleted_at !== null },
        ]),
      )
    }
    const untouched = (dealIds: string[]) =>
      Object.fromEntries(dealIds.map((id) => [id, { archived: false, deleted: false }]))

    it('запуск проверяет фильтр целиком с каталогом инициатора: неверное условие после пользовательского — 400', async () => {
      const before = queued.length
      const cases: [Record<string, unknown>, string][] = [
        [
          {
            and: [
              { field: 'custom.num', op: 'contains', value: 'x' },
              { field: 'title', op: 'bogus' },
            ],
          },
          'фильтр: .and.0.op — оператор не подходит к полю',
        ],
        [
          {
            and: [
              { field: 'custom.num', op: 'eq', value: 5 },
              { field: 'title', op: 'bogus' },
            ],
          },
          'фильтр: .and.1.op — оператор не подходит к полю',
        ],
      ]
      const launches: [string, Record<string, unknown>][] = [
        ['deals.archive', {}],
        ['deals.unarchive', {}],
        ['deals.trash', {}],
        ['deals.assign', { ownerId: null }],
        ['deals.stage', { stageId: stages[1] }],
      ]
      for (const [filter, problem] of cases) {
        for (const [action, params] of launches) {
          const res = await start(initiator, { action, params, selection: { filter } })
          expect({ action, body: await json(res, 400) }).toEqual({
            action,
            body: { code: 'INVALID_PARAMS', problem },
          })
        }
      }
      expect(queued.length).toBe(before)
      // Верное условие по видимому полю — запуск принят.
      const good = { and: [{ field: 'custom.num', op: 'eq', value: 5 }] }
      expect(
        (await start(initiator, { action: 'deals.archive', selection: { filter: good } })).status,
      ).toBe(202)
      expect(queued.length).toBe(before + 1)
    })

    it('неизвестное и скрытое от роли поле в фильтре запуска — один и тот же ответ', async () => {
      const answer = async (user: SignedInUser, field: string) => {
        const res = await start(user, {
          action: 'deals.archive',
          selection: { filter: { and: [{ field, op: 'eq', value: 'x' }] } },
        })
        return { status: res.status, body: await res.text() }
      }
      const unknownCode = await answer(initiator, 'custom.nope')
      expect(unknownCode).toEqual({
        status: 400,
        body: JSON.stringify({
          code: 'INVALID_PARAMS',
          problem: 'фильтр: .and.0.field — неизвестное поле',
        }),
      })
      expect(await answer(initiator, 'custom.secret')).toEqual(unknownCode)
      expect(await answer(initiator, `custom.${secret.id}`)).toEqual(
        await answer(initiator, `custom.${randomUUID()}`),
      )
      expect((await answer(initiator, `custom.${secret.id}`)).body).toBe(unknownCode.body)
      // Тот, кому группа видна, по тому же полю запускает.
      expect((await answer(admin, 'custom.secret')).status).toBe(202)
    })

    it('поле условия ушло в архив между запуском и выбором — операция failed, ни одна сделка не в корзине', async () => {
      const target = await createField(projectA, group.id, 'bulkarch', 'number')
      const p = await createPipeline(projectA)
      const own = await seed(projectA, p.id, p.stages[0] ?? '', [
        { bulkarch: 1 },
        { bulkarch: 1 },
        { bulkarch: 2 },
        {},
      ])
      const filter = {
        and: [
          { field: 'pipeline', op: 'eq', value: p.id },
          { field: 'custom.bulkarch', op: 'eq', value: 1 },
        ],
      }
      const started = await json<BulkJobSummary>(
        await start(initiator, { action: 'deals.trash', selection: { filter } }),
        202,
      )
      await json(await api(admin)('POST', `/fields/${target.id}/archive`))

      const job = await run(initiator, started)
      expect(job).toMatchObject({
        status: 'failed',
        failure: 'FILTER_UNAVAILABLE',
        total: null,
        processed: 0,
        failed: 0,
      })
      expect(job.finishedAt).not.toBeNull()
      expect(await stateOf(own)).toEqual(untouched(own))
      // Повтор той же задачи (как у pg-boss) ничего не меняет.
      await runBulkJob(h.appDb, actions, { projectId: projectA, bulkJobId: started.id })
      expect(await stateOf(own)).toEqual(untouched(own))

      // Проверка самой проверки: с восстановленным полем тот же фильтр берёт ровно две сделки.
      await json(await api(admin)('POST', `/fields/${target.id}/restore`))
      const again = await json<BulkJobSummary>(
        await start(initiator, { action: 'deals.trash', selection: { filter } }),
        202,
      )
      expect(await run(initiator, again)).toMatchObject({ status: 'done', total: 2, processed: 2 })
      const [first, second, ...rest] = own
      expect(await stateOf(own)).toEqual({
        ...untouched(rest),
        [first ?? '']: { archived: false, deleted: true },
        [second ?? '']: { archived: false, deleted: true },
      })
    })

    it('группа поля стала скрытой от инициатора между запуском и выбором — операция failed, ни одна сделка не в архиве', async () => {
      const closing = await json<FieldGroupSummary>(
        await api(admin)('POST', '/field-groups', { entity: 'deal', nameUk: 'Масова' }),
        201,
      )
      const target = await createField(projectA, closing.id, 'bulkhid', 'text')
      const p = await createPipeline(projectA)
      const own = await seed(projectA, p.id, p.stages[0] ?? '', [
        { bulkhid: 'так' },
        { bulkhid: 'ні' },
        {},
      ])
      const filter = {
        and: [
          { field: 'pipeline', op: 'eq', value: p.id },
          { field: `custom.${target.id}`, op: 'eq', value: 'так' },
        ],
      }
      const started = await json<BulkJobSummary>(
        await start(initiator, { action: 'deals.archive', selection: { filter } }),
        202,
      )
      await json(
        await admin.api('PUT', `/roles/${roleId}`, {
          project: projectA,
          body: {
            permissions: {
              ...basePermissions,
              fieldGroups: { [hiddenGroup.id]: 'hidden', [closing.id]: 'hidden' },
            },
          },
        }),
      )

      const job = await run(initiator, started)
      expect(job).toMatchObject({
        status: 'failed',
        failure: 'FILTER_UNAVAILABLE',
        total: null,
        processed: 0,
        failed: 0,
      })
      expect(await stateOf(own)).toEqual(untouched(own))

      // Проверка самой проверки: тот, кому группа видна, тем же фильтром архивирует одну сделку.
      const control = await json<BulkJobSummary>(
        await start(admin, { action: 'deals.archive', selection: { filter } }),
        202,
      )
      expect(await run(admin, control)).toMatchObject({ status: 'done', total: 1, processed: 1 })
      const [first, ...rest] = own
      expect(await stateOf(own)).toEqual({
        ...untouched(rest),
        [first ?? '']: { archived: true, deleted: false },
      })
    })
  })

  describe('изоляция проектов', () => {
    it('поле проекта A в контексте B — 422; поле B с тем же кодом находит только сделки B; копия A под withProject(B) не видна', async () => {
      const num = field.num?.id ?? ''
      const byIdA = { and: [{ field: `custom.${num}`, op: 'eq', value: 5 }] }
      expect((await api(admin, projectB)('GET', `/deals?filter=${q(byIdA)}`)).status).toBe(422)

      const pipelineB = await createPipeline(projectB, ['Новий'])
      const groupB = await json<FieldGroupSummary>(
        await api(admin, projectB)('POST', '/field-groups', { entity: 'deal', nameUk: 'Б' }),
        201,
      )
      const numB = await createField(projectB, groupB.id, 'num', 'number')
      const dealsB = await seed(projectB, pipelineB.id, pipelineB.stages[0] ?? '', [
        { num: 5 },
        { num: 6 },
      ])
      await json(
        await api(admin, projectB)('PUT', `/fields/${numB.id}`, { isFrequentlyFiltered: true }),
      )
      expect(await buildFieldIndex(h.appDb, { projectId: projectB, fieldId: numB.id })).toBe(
        'ready',
      )
      const byCode = { and: [{ field: 'custom.num', op: 'eq', value: 5 }] }
      expect(await ids(admin, `filter=${q(byCode)}`, projectB)).toEqual([dealsB[0]])
      expect(await ids(admin, `filter=${q(byCode)}`, projectA)).toEqual(D(1))

      // Строки копии поля A — только проекта A; под withProject(B) их не видно вовсе.
      const rowsA = await copyOf(num)
      expect(rowsA.length).toBeGreaterThan(0)
      expect(new Set(rowsA.map((r) => r.project_id))).toEqual(new Set([projectA]))
      const seenFromB = await withProject(h.appDb, projectB, (trx) =>
        trx.selectFrom('custom_value').select('record_id').where('field_id', '=', num).execute(),
      )
      expect(seenFromB).toEqual([])
      // Задача для поля A в контексте проекта B ничего не находит и не пишет.
      expect(await buildFieldIndex(h.appDb, { projectId: projectB, fieldId: num })).toBe('skipped')
      // Строку копии с чужим проектом роль приложения не вставит.
      await expect(
        withProject(h.appDb, projectB, (trx) =>
          trx
            .insertInto('custom_value')
            .values({
              project_id: projectA,
              field_id: num,
              record_id: D(1)[0] ?? '',
              value_number: 1,
            })
            .execute(),
        ),
      ).rejects.toThrow(/row-level security/)
    })
  })

  describe('100 тыс. сделок: план запроса роли приложения', () => {
    let projectC: string
    let numC: string

    beforeAll(async () => {
      projectC = (await h.createProject(admin, 'Поля В')).id
      const pipelineC = await createPipeline(projectC, ['Новий'])
      const groupC = await json<FieldGroupSummary>(
        await api(admin, projectC)('POST', '/field-groups', { entity: 'deal', nameUk: 'В' }),
        201,
      )
      numC = (await createField(projectC, groupC.id, 'score', 'number')).id
      await sql`
        insert into contact (project_id, first_name)
        select ${projectC}::uuid, 'Масовий ' || i from generate_series(1, 100000) i
      `.execute(h.owner)
      await sql`
        insert into deal (project_id, title, pipeline_id, stage_id, owner_id, primary_contact_id, custom)
        select c.project_id, 'Угода ' || c.first_name, ${pipelineC.id}::uuid,
          ${pipelineC.stages[0] ?? ''}::uuid, ${admin.id}, c.id,
          jsonb_build_object('score', row_number() over (order by c.id))
        from contact c where c.project_id = ${projectC}::uuid
      `.execute(h.owner)
    }, 300_000)

    it('отметка строит копию фоновой задачей («готово»), EXPLAIN фильтра «равно» под alpi_app в withProject идёт по индексу; снятие отметки копию удаляет', async () => {
      const marked = await json<FieldDefinitionSummary>(
        await api(admin, projectC)('PUT', `/fields/${numC}`, { isFrequentlyFiltered: true }),
      )
      expect(marked.indexState).toBe('building')
      expect(await buildFieldIndex(h.appDb, { projectId: projectC, fieldId: numC }, 20_000)).toBe(
        'ready',
      )
      const ready = await json<FieldDefinitionSummary>(
        await api(admin, projectC)('GET', `/fields/${numC}`),
      )
      expect(ready.indexState).toBe('ready')
      const copied = await sql<{ n: number }>`
        select count(*)::int as n from custom_value where field_id = ${numC}
      `.execute(h.owner)
      expect(copied.rows[0]?.n).toBe(100_000)
      await sql`analyze deal`.execute(h.owner)
      await sql`analyze custom_value`.execute(h.owner)

      const plan = await withProject(h.appDb, projectC, async (trx) => {
        const role = await sql<{ r: string }>`select current_user as r`.execute(trx)
        expect(role.rows[0]?.r).toBe('alpi_test_custom_filters')
        const catalog = await loadFilterCatalog(trx, fullPermissions(), 'deal')
        const [explained] = await trx
          .selectFrom('deal')
          .select('deal.id')
          .where(
            compileFilter(
              'deals',
              { and: [{ field: `custom.${numC}`, op: 'eq', value: 4242 }] },
              { actorId: admin.id, custom: catalog },
            ),
          )
          .explain('json')
        return JSON.stringify(explained)
      })
      expect(plan).toMatch(/"Index Name":\s*"custom_value_number_idx"/)
      expect(plan).not.toMatch(/"Node Type":\s*"Seq Scan",[^}]*"Relation Name":\s*"custom_value"/)
      // Сама выдача находит ровно одну сделку.
      const found = await json<DealsPage>(
        await api(admin, projectC)(
          'GET',
          `/deals?filter=${q({ and: [{ field: 'custom.score', op: 'eq', value: 4242 }] })}`,
        ),
      )
      expect(found.items.length).toBe(1)

      const off = await json<FieldDefinitionSummary>(
        await api(admin, projectC)('PUT', `/fields/${numC}`, { isFrequentlyFiltered: false }),
      )
      expect(off.indexState).toBeNull()
      const left = await sql<{ n: number }>`
        select count(*)::int as n from custom_value where field_id = ${numC}
      `.execute(h.owner)
      expect(left.rows[0]?.n).toBe(0)
    }, 300_000)
  })
})
