import type {
  FieldDefinitionSummary,
  FieldGroupSummary,
  FieldType,
  PipelineSummary,
  StageSummary,
} from '@alpi/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.ts'
import { NO_BULK_ACTIONS } from '../bulk/registry.ts'
import type { ContactView } from '../contacts/contacts.ts'
import type { DealsPage } from '../deals/board.ts'
import type { DealHistoryEntry } from '../deals/deals.ts'
import type { DealView } from '../deals/store.ts'
import { type Jobs, startJobs } from '../jobs/jobs.ts'
import type { OrganizationView } from '../organizations/organizations.ts'
import { type ApiHarness, type SignedInUser, startApiHarness } from '../testing/api-harness.ts'
import { NO_TRASH_PURGERS } from '../trash/purge.ts'
import type { FieldRetypeMessage } from './retype.ts'

// Значения пользовательских полей (тикет crm-fields/02) — на настоящем PostgreSQL, API ходит
// ролью приложения, смену типа поля с данными выполняет настоящая очередь pg-boss. Пока
// `holdRetype`, задача не ставится в очередь, а запоминается: так проверяется «во время задачи».

describe('значения пользовательских полей', () => {
  let h: ApiHarness
  let jobs: Jobs
  let app: ReturnType<typeof createApp>
  let admin: SignedInUser
  let projectA: string
  let projectB: string
  let pipelineA: string
  let pipelineB: string
  let holdRetype = false
  const heldRetypes: FieldRetypeMessage[] = []

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_field_values')
    jobs = await startJobs({
      connectionString: h.appUrl,
      db: h.appDb,
      bulkActions: NO_BULK_ACTIONS,
      trashPurgers: NO_TRASH_PURGERS,
      // Маленькая порция: смена типа идёт в несколько транзакций.
      fieldRetypeBatchSize: 2,
      pollingIntervalSeconds: 0.5,
      schedule: false,
    })
    app = createApp({
      auth: h.auth,
      db: h.appDb,
      fields: {
        enqueuePurge: jobs.enqueueFieldPurge,
        enqueueRetype: async (trx, message) => {
          if (holdRetype) heldRetypes.push(message)
          else await jobs.enqueueFieldRetype(trx, message)
        },
        now: () => new Date(),
      },
    })
    admin = await h.signIn('owner')
    projectA = (await h.createProject(admin, 'Значення А')).id
    projectB = (await h.createProject(admin, 'Значення Б')).id
    pipelineA = await createPipeline(projectA)
    pipelineB = await createPipeline(projectB)
  })

  afterAll(async () => {
    await jobs?.stop()
    await h?.stop()
  })

  type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'
  const as =
    (user: SignedInUser, project: string) => (method: Method, path: string, body?: unknown) =>
      user.call(app, method, `/v1${path}`, { project, ...(body === undefined ? {} : { body }) })
  const callA = (method: Method, path: string, body?: unknown) =>
    as(admin, projectA)(method, path, body)

  async function json<T>(res: Response, status = 200): Promise<T> {
    const text = await res.text()
    expect(res.status, text).toBe(status)
    return (text === '' ? null : JSON.parse(text)) as T
  }

  async function refusal(res: Response, status: number) {
    return json<{ code: string; details?: Record<string, unknown> }>(res, status)
  }

  async function createPipeline(project: string): Promise<string> {
    const call = as(admin, project)
    const pipeline = await json<PipelineSummary>(
      await call('POST', '/pipelines', { name: 'Воронка', code: 'values' }),
      201,
    )
    await json<StageSummary>(
      await call('POST', `/pipelines/${pipeline.id}/stages`, { name: 'Новий' }),
      201,
    )
    return pipeline.id
  }

  const groups = new Map<string, string>()
  async function groupOf(project: string, entity: 'deal' | 'contact' | 'organization') {
    const key = `${project}:${entity}`
    let id = groups.get(key)
    if (!id) {
      id = (
        await json<FieldGroupSummary>(
          await as(admin, project)('POST', '/field-groups', { entity, nameUk: 'Значення' }),
          201,
        )
      ).id
      groups.set(key, id)
    }
    return id
  }

  let fieldCounter = 0
  async function createField(
    type: FieldType,
    input: Record<string, unknown> = {},
    { project = projectA, entity = 'deal' as 'deal' | 'contact' | 'organization' } = {},
  ): Promise<FieldDefinitionSummary> {
    fieldCounter += 1
    return json<FieldDefinitionSummary>(
      await as(admin, project)('POST', '/fields', {
        groupId: await groupOf(project, entity),
        nameUk: `Поле ${fieldCounter}`,
        code: `f${fieldCounter}_${type}`,
        type,
        ...input,
      }),
      201,
    )
  }

  let contactCounter = 0
  async function createDeal(
    custom?: Record<string, unknown>,
    project = projectA,
    status = 201,
  ): Promise<DealView> {
    contactCounter += 1
    const call = as(admin, project)
    const contact = await json<ContactView>(
      await call('POST', '/contacts', { firstName: `Клієнт ${contactCounter}` }),
      201,
    )
    return json<DealView>(
      await call('POST', '/deals', {
        title: 'Угода',
        pipelineId: project === projectA ? pipelineA : pipelineB,
        contactId: contact.id,
        ...(custom === undefined ? {} : { custom }),
      }),
      status,
    )
  }

  const putDeal = (id: string, custom: unknown, project = projectA) =>
    as(admin, project)('PUT', `/deals/${id}`, { custom })

  async function fieldRow(id: string) {
    return h.owner
      .selectFrom('field_definition')
      .select(['type', 'converting_to', 'first_value_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  }

  async function storedCustom(table: 'deal' | 'contact' | 'organization', id: string) {
    const row = await h.owner
      .selectFrom(table)
      .select('custom')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    return row.custom
  }

  describe('проверка по типу', () => {
    it('каждый из 15 типов: верное значение сохраняется приведённым, неверное — 422 с кодом поля', async () => {
      const member = await h.signIn()
      const disabled = await h.signIn()
      await h.addMember(projectA, member.id)
      await h.addMember(projectA, disabled.id)
      await h.owner
        .updateTable('project_member')
        .set({ disabled_at: new Date() })
        .where('project_id', '=', projectA)
        .where('user_id', '=', disabled.id)
        .execute()
      const single = await createField('single_option', {
        options: [{ nameUk: 'Перший' }, { nameUk: 'Архівний' }],
      })
      const [first, archived] = single.options
      if (!first || !archived) throw new Error('варіантів немає')
      await json(
        await callA('PUT', `/fields/${single.id}/options/${archived.id}`, { archived: true }),
      )
      const multi = await createField('multi_option', {
        options: [{ nameUk: 'А' }, { nameUk: 'Б' }],
      })
      const [optA, optB] = multi.options
      if (!optA || !optB) throw new Error('варіантів немає')

      const cases: [FieldType, string | null, unknown, unknown, unknown][] = [
        // тип, код (null — новое поле), верное, приведённое, неверное
        ['text', null, '  Привіт  ', 'Привіт', 'x'.repeat(501)],
        ['long_text', null, 'Абзац\nдругий', 'Абзац\nдругий', 'x'.repeat(10_001)],
        ['number', null, 42.5, 42.5, '42'],
        [
          'money',
          null,
          { amount: 99.9, currency: 'USD' },
          { amount: 99.9, currency: 'USD' },
          { amount: 1, currency: 'GBP' },
        ],
        ['date', null, '2026-12-31', '2026-12-31', '31.12.2026'],
        ['time', null, '18:05', '18:05', '18:60'],
        [
          'date_range',
          null,
          { from: '2026-01-01', to: '2026-01-31' },
          { from: '2026-01-01', to: '2026-01-31' },
          { from: '2026-02-01', to: '2026-01-01' },
        ],
        ['single_option', single.code, first.id, first.id, archived.id],
        ['multi_option', multi.code, [optB.id, optA.id], [optA.id, optB.id], [optA.id, 'nope']],
        ['boolean', null, true, true, 'так'],
        ['phone', null, '067 123 45 67', '+380671234567', '067'],
        ['email', null, 'Olena@Alpi.UA', 'olena@alpi.ua', 'olena@'],
        ['url', null, 'https://alpi.ua/', 'https://alpi.ua/', 'javascript:alert(1)'],
        ['address', null, ' Львів ', 'Львів', { city: 'Львів' }],
        ['user', null, member.id, member.id, disabled.id],
      ]
      expect(new Set(cases.map(([type]) => type)).size).toBe(15)

      const deal = await createDeal()
      const codes = new Map<FieldType, string>()
      for (const [type, existing, good, normalized, wrong] of cases) {
        const code = existing ?? (await createField(type)).code
        codes.set(type, code)
        const bad = await refusal(await putDeal(deal.id, { [code]: wrong }), 422)
        expect({ fieldType: type, ...bad }).toMatchObject({
          fieldType: type,
          code: 'CUSTOM_FIELD_INVALID',
          details: { field: code },
        })
        const saved = await json<DealView>(await putDeal(deal.id, { [code]: good }))
        expect({ type, value: saved.custom[code] }).toEqual({ type, value: normalized })
        expect({ type, value: (await storedCustom('deal', deal.id))[code] }).toEqual({
          type,
          value: normalized,
        })
      }
      // Причины — в ответе: схема ссылки, архивный вариант, отключённый пользователь.
      const url = await createField('url')
      expect(
        (await refusal(await putDeal(deal.id, { [url.code]: 'javascript:alert(1)' }), 422)).details,
      ).toEqual({ field: url.code, reason: 'scheme' })
      expect(
        (await refusal(await putDeal(deal.id, { [single.code]: archived.id }), 422)).details,
      ).toEqual({ field: single.code, reason: 'archived_option' })
      const userCode = codes.get('user') ?? ''
      expect(
        (await refusal(await putDeal(deal.id, { [userCode]: disabled.id }), 422)).details,
      ).toEqual({ field: userCode, reason: 'disabled_user' })
      // Участник другого проекта — не участник этого.
      const stranger = await h.signIn()
      await h.addMember(projectB, stranger.id)
      expect(
        (await refusal(await putDeal(deal.id, { [userCode]: stranger.id }), 422)).details,
      ).toEqual({ field: userCode, reason: 'unknown_user' })
      // Все 15 значений лежат рядом, приведённые.
      expect(Object.keys(await storedCustom('deal', deal.id)).sort()).toEqual(
        [...codes.values()].sort(),
      )
    })

    it('архивный вариант, который уже в значении, можно записать снова; новый — нет', async () => {
      const field = await createField('single_option', {
        options: [{ nameUk: 'Старий' }, { nameUk: 'Новий' }],
      })
      const [old, fresh] = field.options
      if (!old || !fresh) throw new Error('варіантів немає')
      const deal = await createDeal({ [field.code]: old.id })
      await json(await callA('PUT', `/fields/${field.id}/options/${old.id}`, { archived: true }))
      await json<DealView>(await putDeal(deal.id, { [field.code]: old.id }))
      const other = await createDeal()
      expect((await refusal(await putDeal(other.id, { [field.code]: old.id }), 422)).code).toBe(
        'CUSTOM_FIELD_INVALID',
      )
      // Новая сделка с архивным вариантом не создаётся.
      expect(
        (
          await refusal(
            await callA('POST', '/deals', {
              title: 'Угода',
              pipelineId: pipelineA,
              contactId: other.primaryContactId,
              custom: { [field.code]: old.id },
            }),
            422,
          )
        ).code,
      ).toBe('CUSTOM_FIELD_INVALID')
    })
  })

  describe('запрос', () => {
    it('PUT с одним кодом не трогает другие ключи; null убирает ключ; неизвестный и архивный код — 422', async () => {
      const a = await createField('text')
      const b = await createField('number')
      const deal = await createDeal({ [a.code]: 'перше', [b.code]: 1 })
      expect(deal.custom).toEqual({ [a.code]: 'перше', [b.code]: 1 })

      const changed = await json<DealView>(await putDeal(deal.id, { [b.code]: 2 }))
      expect(changed.custom).toEqual({ [a.code]: 'перше', [b.code]: 2 })
      expect(changed.title).toBe(deal.title)

      const cleared = await json<DealView>(await putDeal(deal.id, { [a.code]: null }))
      expect(cleared.custom).toEqual({ [b.code]: 2 })
      expect(await storedCustom('deal', deal.id)).toEqual({ [b.code]: 2 })

      const unknown = await refusal(await putDeal(deal.id, { nemaye: 'x' }), 422)
      expect(unknown).toMatchObject({ code: 'CUSTOM_FIELD_UNKNOWN', details: { field: 'nemaye' } })
      await json(await callA('POST', `/fields/${a.id}/archive`))
      const archived = await refusal(await putDeal(deal.id, { [a.code]: 'x' }), 422)
      expect(archived).toMatchObject({ code: 'CUSTOM_FIELD_UNKNOWN', details: { field: a.code } })
      // Отказ ничего не меняет: ни значения, ни остальные поля запроса.
      const refused = await refusal(
        await callA('PUT', `/deals/${deal.id}`, { title: 'Нова', custom: { [b.code]: 'x' } }),
        422,
      )
      expect(refused.code).toBe('CUSTOM_FIELD_INVALID')
      const after = await json<DealView>(await callA('GET', `/deals/${deal.id}`))
      expect(after.title).toBe(deal.title)
      expect(after.custom).toEqual({ [b.code]: 2 })
      // custom — только объект.
      expect((await refusal(await putDeal(deal.id, [1]), 400)).code).toBe('INVALID_DEAL')
    })

    it('архивное поле не приходит в ответах; из архива возвращается со значением', async () => {
      const field = await createField('text')
      const deal = await createDeal({ [field.code]: 'є' })
      await json(await callA('POST', `/fields/${field.id}/archive`))
      expect((await json<DealView>(await callA('GET', `/deals/${deal.id}`))).custom).toEqual({})
      await json(await callA('POST', `/fields/${field.id}/restore`))
      expect((await json<DealView>(await callA('GET', `/deals/${deal.id}`))).custom).toEqual({
        [field.code]: 'є',
      })
    })

    it('список сделок, контакты и организации: custom в ответах карточки и списка', async () => {
      const dealField = await createField('boolean')
      const deal = await createDeal({ [dealField.code]: true })
      const page = await json<DealsPage>(await callA('GET', `/deals?pipeline=${pipelineA}`))
      expect(page.data.find((d) => d.id === deal.id)?.custom).toEqual({ [dealField.code]: true })

      const contactField = await createField('email', {}, { entity: 'contact' })
      const contact = await json<ContactView>(
        await callA('POST', '/contacts', {
          firstName: 'Ольга',
          custom: { [contactField.code]: 'Olga@Alpi.UA' },
        }),
        201,
      )
      expect(contact.custom).toEqual({ [contactField.code]: 'olga@alpi.ua' })
      const updatedContact = await json<ContactView>(
        await callA('PUT', `/contacts/${contact.id}`, { custom: { [contactField.code]: null } }),
      )
      expect(updatedContact.custom).toEqual({})
      expect(
        (
          await refusal(
            await callA('PUT', `/contacts/${contact.id}`, { custom: { [contactField.code]: 'x' } }),
            422,
          )
        ).details,
      ).toEqual({ field: contactField.code, reason: 'format' })
      await json(
        await callA('PUT', `/contacts/${contact.id}`, {
          custom: { [contactField.code]: 'o@alpi.ua' },
        }),
      )
      const contactList = await json<{ data: { id: string; custom: unknown }[] }>(
        await callA('GET', '/contacts/list'),
      )
      expect(contactList.data.find((c) => c.id === contact.id)?.custom).toEqual({
        [contactField.code]: 'o@alpi.ua',
      })
      expect(
        (await json<ContactView[]>(await callA('GET', '/contacts'))).find(
          (c) => c.id === contact.id,
        )?.custom,
      ).toEqual({ [contactField.code]: 'o@alpi.ua' })

      const orgField = await createField('url', {}, { entity: 'organization' })
      const org = await json<OrganizationView>(
        await callA('POST', '/organizations', {
          name: 'Альпі',
          custom: { [orgField.code]: 'https://alpi.ua' },
        }),
        201,
      )
      expect(org.custom).toEqual({ [orgField.code]: 'https://alpi.ua' })
      expect(
        (
          await refusal(
            await callA('PUT', `/organizations/${org.id}`, {
              custom: { [orgField.code]: 'javascript:x' },
            }),
            422,
          )
        ).details,
      ).toEqual({ field: orgField.code, reason: 'scheme' })
      // Код поля сделки у организации — неизвестный.
      expect(
        (
          await refusal(
            await callA('PUT', `/organizations/${org.id}`, { custom: { [dealField.code]: true } }),
            422,
          )
        ).code,
      ).toBe('CUSTOM_FIELD_UNKNOWN')
      const orgUpdated = await json<OrganizationView>(
        await callA('PUT', `/organizations/${org.id}`, {
          custom: { [orgField.code]: 'http://alpi.ua/new' },
        }),
      )
      expect(orgUpdated.custom).toEqual({ [orgField.code]: 'http://alpi.ua/new' })
      const orgList = await json<{ data: { id: string; custom: unknown }[] }>(
        await callA('GET', '/organizations/list'),
      )
      expect(orgList.data.find((o) => o.id === org.id)?.custom).toEqual({
        [orgField.code]: 'http://alpi.ua/new',
      })
      expect(
        (await json<OrganizationView>(await callA('GET', `/organizations/${org.id}`))).custom,
      ).toEqual({ [orgField.code]: 'http://alpi.ua/new' })
    })
  })

  describe('история', () => {
    it('изменение значения пишет «было → стало» с автором; та же запись строки не пишет', async () => {
      const field = await createField('single_option', {
        options: [{ nameUk: 'Так' }, { nameUk: 'Ні' }],
      })
      const [yes, no] = field.options
      if (!yes || !no) throw new Error('варіантів немає')
      const deal = await createDeal()
      const history = async () =>
        (await json<DealHistoryEntry[]>(await callA('GET', `/deals/${deal.id}/history`))).filter(
          (e) => e.field === `custom.${field.code}`,
        )

      await json(await putDeal(deal.id, { [field.code]: yes.id }))
      await json(await putDeal(deal.id, { [field.code]: no.id }))
      await json(await putDeal(deal.id, { [field.code]: no.id }))
      await json(await putDeal(deal.id, { [field.code]: null }))
      await json(await putDeal(deal.id, { [field.code]: null }))
      expect(
        (await history()).map(({ actorId, before, after }) => ({ actorId, before, after })),
      ).toEqual([
        { actorId: admin.id, before: no.id, after: null },
        { actorId: admin.id, before: yes.id, after: no.id },
        { actorId: admin.id, before: null, after: yes.id },
      ])
    })

    it('объект (деньги, интервал) с тем же значением строки не пишет, хотя jsonb хранит ключи иначе', async () => {
      const money = await createField('money')
      const range = await createField('date_range')
      const deal = await createDeal()
      const value = {
        [money.code]: { amount: 5, currency: 'EUR' },
        [range.code]: { from: '2026-03-01', to: '2026-03-02' },
      }
      await json(await putDeal(deal.id, value))
      await json(await putDeal(deal.id, value))
      const log = await h.owner
        .selectFrom('change_log')
        .select('field')
        .where('entity_id', '=', deal.id)
        .where('field', 'like', 'custom.%')
        .execute()
      expect(log.map((r) => r.field).sort()).toEqual(
        [`custom.${money.code}`, `custom.${range.code}`].sort(),
      )
    })
  })

  describe('первое значение', () => {
    it('ставит first_value_at; после этого смена кода — 409', async () => {
      const field = await createField('text')
      const other = await createField('text')
      expect((await fieldRow(field.id)).first_value_at).toBeNull()
      // Отказ (не тот тип) первого значения не ставит.
      const deal = await createDeal()
      await refusal(await putDeal(deal.id, { [field.code]: 7 }), 422)
      expect((await fieldRow(field.id)).first_value_at).toBeNull()
      // null по полю без значения — тоже не значение.
      await json(await putDeal(deal.id, { [field.code]: null }))
      expect((await fieldRow(field.id)).first_value_at).toBeNull()

      await json(await putDeal(deal.id, { [field.code]: 'перше' }))
      const firstAt = (await fieldRow(field.id)).first_value_at
      expect(firstAt).not.toBeNull()
      expect((await fieldRow(other.id)).first_value_at).toBeNull()
      // Второе значение время не сдвигает.
      await json(await putDeal(deal.id, { [field.code]: 'друге' }))
      expect((await fieldRow(field.id)).first_value_at).toEqual(firstAt)

      expect(
        (await refusal(await callA('PUT', `/fields/${field.id}`, { code: 'novyi_kod' }), 409)).code,
      ).toBe('FIELD_CODE_LOCKED')
      // Значение при создании записи — тоже первое.
      const onCreate = await createField('number', {}, { entity: 'organization' })
      await json(
        await callA('POST', '/organizations', { name: 'Ф', custom: { [onCreate.code]: 1 } }),
        201,
      )
      expect((await fieldRow(onCreate.id)).first_value_at).not.toBeNull()
    })
  })

  describe('смена типа поля с данными', () => {
    it('число → текст: задача переписывает все записи; во время задачи запись — 409', async () => {
      const field = await createField('number')
      const deals = [
        await createDeal({ [field.code]: 1 }),
        await createDeal({ [field.code]: 2.5 }),
        await createDeal({ [field.code]: 300 }),
        await createDeal(),
      ]
      holdRetype = true
      const pending = await json<FieldDefinitionSummary>(
        await callA('PUT', `/fields/${field.id}`, { type: 'text' }),
        202,
      )
      holdRetype = false
      expect(pending).toMatchObject({ type: 'number', convertingTo: 'text' })
      const message = heldRetypes.find((m) => m.fieldId === field.id)
      expect(message).toEqual({ projectId: projectA, fieldId: field.id, actorId: admin.id })

      // Задача ещё не прошла: поле только для чтения, второй смены типа нет.
      const busy = await refusal(await putDeal(deals[3]?.id ?? '', { [field.code]: 4 }), 409)
      expect(busy).toMatchObject({
        code: 'CUSTOM_FIELD_CONVERTING',
        details: { field: field.code },
      })
      const created = (await createDeal({ [field.code]: 5 }, projectA, 409)) as unknown
      expect(created).toMatchObject({ code: 'CUSTOM_FIELD_CONVERTING' })
      expect(
        (await refusal(await callA('PUT', `/fields/${field.id}`, { type: 'long_text' }), 409)).code,
      ).toBe('FIELD_CONVERTING')

      // Задача так и не дошла до очереди (как будто очередь исчерпала повторы): повтор той же
      // смены ставит её снова — уже в настоящую очередь.
      const again = await json<FieldDefinitionSummary>(
        await callA('PUT', `/fields/${field.id}`, { type: 'text' }),
        202,
      )
      expect(again).toMatchObject({ type: 'number', convertingTo: 'text' })
      await vi.waitFor(
        async () => {
          expect(await fieldRow(field.id)).toMatchObject({ type: 'text', converting_to: null })
        },
        { timeout: 30_000, interval: 250 },
      )
      const values = await Promise.all(
        deals.map(async (d) => (await storedCustom('deal', d.id))[field.code]),
      )
      expect(values).toEqual(['1', '2.5', '300', undefined])
      await json(await putDeal(deals[3]?.id ?? '', { [field.code]: 'тепер текст' }))
      const log = await h.owner
        .selectFrom('audit_log')
        .select(['action', 'details'])
        .where('entity_id', '=', field.id)
        .where('action', '=', 'field.updated')
        .execute()
      expect(log.map((r) => r.details)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ before: { type: 'number' }, after: { type: 'text' } }),
        ]),
      )
    })

    it('один вариант → несколько: id становится массивом из одного id во всех записях', async () => {
      const field = await createField('single_option', {
        options: [{ nameUk: 'А' }, { nameUk: 'Б' }],
      })
      const [a, b] = field.options
      if (!a || !b) throw new Error('варіантів немає')
      const deals = await Promise.all([
        createDeal({ [field.code]: a.id }),
        createDeal({ [field.code]: b.id }),
        createDeal({ [field.code]: a.id }),
      ])
      // Записи другого проекта с тем же кодом задача не трогает.
      const fieldB = await createField(
        'single_option',
        { code: field.code, options: [{ nameUk: 'В' }] },
        { project: projectB },
      )
      const dealB = await createDeal({ [fieldB.code]: fieldB.options[0]?.id }, projectB)

      const pending = await json<FieldDefinitionSummary>(
        await callA('PUT', `/fields/${field.id}`, { type: 'multi_option' }),
        202,
      )
      expect(pending.convertingTo).toBe('multi_option')
      await vi.waitFor(
        async () => {
          expect(await fieldRow(field.id)).toMatchObject({
            type: 'multi_option',
            converting_to: null,
          })
        },
        { timeout: 30_000, interval: 250 },
      )
      const values = await Promise.all(
        deals.map(async (d) => (await storedCustom('deal', d.id))[field.code]),
      )
      expect(values).toEqual([[a.id], [b.id], [a.id]])
      expect((await storedCustom('deal', dealB.id))[fieldB.code]).toBe(fieldB.options[0]?.id)
      const after = await json<DealView>(
        await putDeal(deals[0]?.id ?? '', { [field.code]: [a.id, b.id] }),
      )
      expect(after.custom[field.code]).toEqual([a.id, b.id])
    })

    it('текст → большой текст — сразу; дата → число и другие смены с данными — 409', async () => {
      const text = await createField('text')
      const deal = await createDeal({ [text.code]: 'рядок' })
      const changed = await json<FieldDefinitionSummary>(
        await callA('PUT', `/fields/${text.id}`, { type: 'long_text' }),
      )
      expect(changed).toMatchObject({ type: 'long_text', convertingTo: null })
      expect((await storedCustom('deal', deal.id))[text.code]).toBe('рядок')

      const date = await createField('date')
      await createDeal({ [date.code]: '2026-05-01' })
      expect(
        (await refusal(await callA('PUT', `/fields/${date.id}`, { type: 'number' }), 409)).code,
      ).toBe('FIELD_TYPE_LOCKED')
      expect(
        (await refusal(await callA('PUT', `/fields/${text.id}`, { type: 'text' }), 409)).code,
      ).toBe('FIELD_TYPE_LOCKED')
      expect((await fieldRow(date.id)).type).toBe('date')
    })

    it('база: тип поля с данными меняется только безопасно', async () => {
      const field = await createField('date')
      await createDeal({ [field.code]: '2026-05-01' })
      await expect(
        h.owner
          .updateTable('field_definition')
          .set({ type: 'number' })
          .where('id', '=', field.id)
          .execute(),
      ).rejects.toMatchObject({ code: 'FD002' })
      const number = await createField('number')
      await createDeal({ [number.code]: 1 })
      await h.owner
        .updateTable('field_definition')
        .set({ type: 'text' })
        .where('id', '=', number.id)
        .execute()
      // Во время смены — только на тип смены.
      const converting = await createField('single_option', { options: [{ nameUk: 'А' }] })
      await h.owner
        .updateTable('field_definition')
        .set({ converting_to: 'multi_option' })
        .where('id', '=', converting.id)
        .execute()
      await expect(
        h.owner
          .updateTable('field_definition')
          .set({ type: 'text' })
          .where('id', '=', converting.id)
          .execute(),
      ).rejects.toMatchObject({ code: 'FD002' })
    })
  })

  describe('изоляция проектов', () => {
    it('код поля проекта A в проекте B — неизвестный; сделку B из A не изменить', async () => {
      const fieldA = await createField('text', { code: 'tilky_a' })
      const dealB = await createDeal(undefined, projectB)
      const unknown = await refusal(await putDeal(dealB.id, { [fieldA.code]: 'x' }, projectB), 422)
      expect(unknown).toMatchObject({
        code: 'CUSTOM_FIELD_UNKNOWN',
        details: { field: fieldA.code },
      })
      expect(
        (
          await refusal(
            await as(admin, projectB)('POST', '/deals', {
              title: 'Угода',
              pipelineId: pipelineB,
              contactId: dealB.primaryContactId,
              custom: { [fieldA.code]: 'x' },
            }),
            422,
          )
        ).code,
      ).toBe('CUSTOM_FIELD_UNKNOWN')
      // Сделка B из контекста A — как несуществующая.
      expect((await refusal(await putDeal(dealB.id, { [fieldA.code]: 'x' }), 404)).code).toBe(
        'DEAL_NOT_FOUND',
      )
      expect(await storedCustom('deal', dealB.id)).toEqual({})
      expect((await fieldRow(fieldA.id)).first_value_at).toBeNull()
    })
  })
})
