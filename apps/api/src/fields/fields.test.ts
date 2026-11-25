import { type Database, withProject } from '@alpi/db'
import {
  FIELD_ENTITIES,
  type FieldDefinitionSummary,
  type FieldGroupSummary,
  type FieldOptionSummary,
  offeredOptions,
  type PipelineSummary,
  type RoleSummary,
  type StageSummary,
  SYSTEM_FIELD_CODES,
} from '@alpi/shared'
import { sql, type Transaction } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.ts'
import { NO_BULK_ACTIONS } from '../bulk/registry.ts'
import { type Jobs, startJobs } from '../jobs/jobs.ts'
import { type ApiHarness, type SignedInUser, startApiHarness } from '../testing/api-harness.ts'
import { NO_TRASH_PURGERS } from '../trash/purge.ts'

// Конструктор полей (тикет crm-fields/01) — на настоящем PostgreSQL, API ходит ролью
// приложения, окончательное удаление выполняет настоящая очередь pg-boss. Часы API подменены:
// срок «30 дней после архива» проверяется без ожидания.

const DAY_MS = 24 * 60 * 60 * 1000

describe('конструктор полей', () => {
  let h: ApiHarness
  let jobs: Jobs
  let app: ReturnType<typeof createApp>
  let admin: SignedInUser
  let projectA: string
  let projectB: string
  /** Время API; null — настоящее. */
  let clock: Date | null = null

  /** Воронки проекта A: main (этапы s1, s2, s3) и other (этап t1); проекта B — b (этап u1). */
  let main: PipelineSummary & { stageIds: string[] }
  let other: PipelineSummary & { stageIds: string[] }
  let pipelineB: PipelineSummary & { stageIds: string[] }

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_fields')
    jobs = await startJobs({
      connectionString: h.appUrl,
      db: h.appDb,
      bulkActions: NO_BULK_ACTIONS,
      trashPurgers: NO_TRASH_PURGERS,
      // Маленькая порция: удаление идёт в несколько транзакций.
      fieldPurgeBatchSize: 2,
      pollingIntervalSeconds: 0.5,
      schedule: false,
    })
    app = createApp({
      auth: h.auth,
      db: h.appDb,
      fields: {
        enqueuePurge: jobs.enqueueFieldPurge,
        enqueueRetype: jobs.enqueueFieldRetype,
        now: () => clock ?? new Date(),
      },
    })
    admin = await h.signIn('owner')
    projectA = (await h.createProject(admin, 'Поля А')).id
    projectB = (await h.createProject(admin, 'Поля Б')).id
    main = await createPipeline(projectA, 'main', ['s1', 's2', 's3'])
    other = await createPipeline(projectA, 'other', ['t1'])
    pipelineB = await createPipeline(projectB, 'b', ['u1'])
  })

  afterAll(async () => {
    await jobs?.stop()
    await h?.stop()
  })

  type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'
  const as =
    (user: SignedInUser, project: string) => (method: Method, path: string, body?: unknown) =>
      user.call(app, method, `/v1${path}`, { project, ...(body === undefined ? {} : { body }) })

  async function json<T>(res: Response, status = 200): Promise<T> {
    const text = await res.text()
    expect(res.status, text).toBe(status)
    return (text === '' ? null : JSON.parse(text)) as T
  }

  async function refusal(res: Response, status: number): Promise<string> {
    return (await json<{ code: string }>(res, status)).code
  }

  async function createPipeline(project: string, code: string, stages: string[]) {
    const call = as(admin, project)
    const pipeline = await json<PipelineSummary>(
      await call('POST', '/pipelines', { name: `Воронка ${code}`, code }),
      201,
    )
    const stageIds: string[] = []
    for (const name of stages) {
      stageIds.push(
        (
          await json<StageSummary>(
            await call('POST', `/pipelines/${pipeline.id}/stages`, { name }),
            201,
          )
        ).id,
      )
    }
    return { ...pipeline, stageIds }
  }

  let groupCounter = 0
  async function createGroup(
    project: string,
    entity: 'deal' | 'contact' | 'organization' = 'deal',
  ): Promise<FieldGroupSummary> {
    groupCounter += 1
    return json<FieldGroupSummary>(
      await as(admin, project)('POST', '/field-groups', {
        entity,
        nameUk: `Група ${groupCounter}`,
      }),
      201,
    )
  }

  let fieldCounter = 0
  async function createField(
    project: string,
    groupId: string,
    input: Record<string, unknown> = {},
  ): Promise<FieldDefinitionSummary> {
    fieldCounter += 1
    return json<FieldDefinitionSummary>(
      await as(admin, project)('POST', '/fields', {
        groupId,
        nameUk: `Поле ${fieldCounter}`,
        code: `pole_${fieldCounter}`,
        type: 'text',
        ...input,
      }),
      201,
    )
  }

  async function memberWith(project: string, permissions: unknown): Promise<SignedInUser> {
    const role = await json<RoleSummary>(
      await admin.api('POST', '/roles', {
        project,
        body: { name: `Роль ${Math.random().toString(36).slice(2, 8)}`, permissions },
      }),
      201,
    )
    const user = await h.signIn()
    await h.owner
      .insertInto('project_member')
      .values({ project_id: project, user_id: user.id, role_id: role.id })
      .execute()
    return user
  }

  /** Как будто у поля появилось значение (first_value_at ставит тикет 02). */
  async function markHasValues(fieldId: string) {
    await h.owner
      .updateTable('field_definition')
      .set({ first_value_at: new Date() })
      .where('id', '=', fieldId)
      .execute()
  }

  describe('права', () => {
    it('без права «поля» создание, изменение и удаление — 403; с правом смотреть сущность чтение — 200', async () => {
      const group = await createGroup(projectA)
      const field = await createField(projectA, group.id, {
        type: 'single_option',
        options: [{ nameUk: 'Так' }],
      })
      const manager = await h.signIn()
      await h.addMember(projectA, manager.id, 'manager')
      const call = as(manager, projectA)

      expect(
        await refusal(await call('POST', '/field-groups', { entity: 'deal', nameUk: 'Х' }), 403),
      ).toBe('PERMISSION_DENIED')
      expect((await call('PUT', `/field-groups/${group.id}`, { nameUk: 'Х' })).status).toBe(403)
      expect((await call('DELETE', `/field-groups/${group.id}`)).status).toBe(403)
      expect(
        (await call('POST', '/fields', { groupId: group.id, nameUk: 'Х', type: 'text' })).status,
      ).toBe(403)
      expect((await call('PUT', `/fields/${field.id}`, { nameUk: 'Х' })).status).toBe(403)
      expect((await call('POST', `/fields/${field.id}/archive`)).status).toBe(403)
      expect((await call('DELETE', `/fields/${field.id}`)).status).toBe(403)
      expect((await call('POST', `/fields/${field.id}/options`, { nameUk: 'Х' })).status).toBe(403)
      const [option] = field.options
      expect(
        (await call('PUT', `/fields/${field.id}/options/${option?.id}`, { nameUk: 'Х' })).status,
      ).toBe(403)

      const fields = await json<FieldDefinitionSummary[]>(await call('GET', '/fields?entity=deal'))
      expect(fields.map((f) => f.id)).toContain(field.id)
      const groups = await json<FieldGroupSummary[]>(await call('GET', '/field-groups?entity=deal'))
      expect(groups.map((g) => g.id)).toContain(group.id)
      expect(
        (await json<FieldDefinitionSummary>(await call('GET', `/fields/${field.id}`))).code,
      ).toBe(field.code)
      // Ничего не изменилось.
      expect(
        (
          await json<FieldDefinitionSummary>(
            await as(admin, projectA)('GET', `/fields/${field.id}`),
          )
        ).nameUk,
      ).toBe(field.nameUk)
    })

    it('читать описания сущности можно только с правом смотреть её', async () => {
      const group = await createGroup(projectA)
      const field = await createField(projectA, group.id)
      const contactsOnly = await memberWith(projectA, { actions: { contacts: ['view'] } })
      const call = as(contactsOnly, projectA)
      expect((await call('GET', '/fields?entity=contact')).status).toBe(200)
      expect((await call('GET', '/field-groups?entity=contact')).status).toBe(200)
      expect((await call('GET', '/fields?entity=deal')).status).toBe(403)
      expect((await call('GET', '/field-groups?entity=deal')).status).toBe(403)
      expect((await call('GET', '/fields?entity=organization')).status).toBe(403)
      expect((await call('GET', `/fields/${field.id}`)).status).toBe(403)
    })

    it('редактор с правом «поля» меняет описания', async () => {
      const editor = await memberWith(projectA, {
        actions: { deals: ['view'], fields: ['view', 'create', 'edit', 'delete'] },
      })
      const call = as(editor, projectA)
      const group = await json<FieldGroupSummary>(
        await call('POST', '/field-groups', { entity: 'deal', nameUk: 'Редактора' }),
        201,
      )
      const field = await json<FieldDefinitionSummary>(
        await call('POST', '/fields', {
          groupId: group.id,
          nameUk: 'Поле редактора',
          type: 'text',
        }),
        201,
      )
      await json(await call('PUT', `/fields/${field.id}`, { nameUk: 'Нове' }))
      expect((await call('DELETE', `/fields/${field.id}`)).status).toBe(204)
    })
  })

  describe('изоляция проектов', () => {
    it('описания, группы и варианты проекта A не видны в контексте B без фильтра в коде', async () => {
      const group = await createGroup(projectA)
      const field = await createField(projectA, group.id, {
        type: 'single_option',
        options: [{ nameUk: 'А' }],
      })
      const seen = await withProject(h.appDb, projectB, async (trx) => ({
        groups: (await sql<{ id: string }>`select * from field_group`.execute(trx)).rows,
        fields: (await sql<{ id: string }>`select * from field_definition`.execute(trx)).rows,
        options: (await sql<{ id: string }>`select * from field_option`.execute(trx)).rows,
      }))
      expect(seen.groups.map((r) => r.id)).not.toContain(group.id)
      expect(seen.fields.map((r) => r.id)).not.toContain(field.id)
      expect(seen.options.map((r) => r.id)).not.toContain(field.options[0]?.id)

      const callB = as(admin, projectB)
      expect((await callB('GET', `/fields/${field.id}`)).status).toBe(404)
      expect((await callB('PUT', `/fields/${field.id}`, { nameUk: 'Х' })).status).toBe(404)
      expect((await callB('DELETE', `/field-groups/${group.id}`)).status).toBe(404)
      const listB = await json<FieldDefinitionSummary[]>(await callB('GET', '/fields?entity=deal'))
      expect(listB.map((f) => f.id)).not.toContain(field.id)
      // Поле в группу чужого проекта не создать.
      expect(
        await refusal(
          await callB('POST', '/fields', { groupId: group.id, nameUk: 'Чуже', type: 'text' }),
          422,
        ),
      ).toBe('FIELD_GROUP_NOT_FOUND')
    })
  })

  describe('код поля', () => {
    it('по умолчанию — из украинского названия; занятый получает суффикс', async () => {
      const group = await createGroup(projectA)
      const call = as(admin, projectA)
      const first = await json<FieldDefinitionSummary>(
        await call('POST', '/fields', {
          groupId: group.id,
          nameUk: 'Головний мотив',
          type: 'text',
        }),
        201,
      )
      expect(first.code).toBe('holovnyi_motyv')
      const second = await json<FieldDefinitionSummary>(
        await call('POST', '/fields', {
          groupId: group.id,
          nameUk: 'Головний мотив',
          type: 'text',
        }),
        201,
      )
      expect(second.code).toBe('holovnyi_motyv_2')
      // «Статус» → status — код системного поля сделки: берётся следующий.
      const status = await json<FieldDefinitionSummary>(
        await call('POST', '/fields', { groupId: group.id, nameUk: 'Статус', type: 'text' }),
        201,
      )
      expect(status.code).toBe('status_2')
    })

    it('дубликат в проекте и сущности, код системного поля и код не по формату — 422', async () => {
      const group = await createGroup(projectA)
      const contacts = await createGroup(projectA, 'contact')
      const groupB = await createGroup(projectB)
      const call = as(admin, projectA)
      const field = await createField(projectA, group.id, { code: 'dublikat' })
      const post = (groupId: string, code: unknown) =>
        call('POST', '/fields', { groupId, nameUk: 'Дубль', type: 'text', code })

      expect(await refusal(await post(group.id, 'dublikat'), 422)).toBe('FIELD_CODE_TAKEN')
      // Архивное поле тоже держит код.
      await json(await call('POST', `/fields/${field.id}/archive`))
      expect(await refusal(await post(group.id, 'dublikat'), 422)).toBe('FIELD_CODE_TAKEN')
      // Другая сущность и другой проект — свои коды.
      await json(await post(contacts.id, 'dublikat'), 201)
      await json(
        await as(admin, projectB)('POST', '/fields', {
          groupId: groupB.id,
          nameUk: 'Дубль',
          type: 'text',
          code: 'dublikat',
        }),
        201,
      )

      for (const code of ['status', 'title', 'stage', 'amount', 'currency', 'owner']) {
        expect(await refusal(await post(group.id, code), 422)).toBe('FIELD_CODE_RESERVED')
      }
      expect(await refusal(await post(contacts.id, 'first_name'), 422)).toBe('FIELD_CODE_RESERVED')
      for (const code of ['Bad', '1abc', '_a', 'a-b', 'код', 'a'.repeat(64), 5]) {
        expect(await refusal(await post(group.id, code), 422)).toBe('FIELD_CODE_INVALID')
      }
      // Тот же отказ при смене кода.
      const another = await createField(projectA, group.id)
      expect(
        await refusal(await call('PUT', `/fields/${another.id}`, { code: 'status' }), 422),
      ).toBe('FIELD_CODE_RESERVED')
      expect(await refusal(await call('PUT', `/fields/${another.id}`, { code: 'Bad' }), 422)).toBe(
        'FIELD_CODE_INVALID',
      )
      expect(
        await refusal(await call('PUT', `/fields/${another.id}`, { code: 'dublikat' }), 422),
      ).toBe('FIELD_CODE_TAKEN')
    })

    it('код меняется, пока нет значений и отметки «часто фильтруют»; потом — 409, название меняется', async () => {
      const group = await createGroup(projectA)
      const call = as(admin, projectA)
      const free = await createField(projectA, group.id)
      const renamed = await json<FieldDefinitionSummary>(
        await call('PUT', `/fields/${free.id}`, { code: 'novyi_kod' }),
      )
      expect(renamed.code).toBe('novyi_kod')

      const withValues = await createField(projectA, group.id)
      await markHasValues(withValues.id)
      expect(
        await refusal(await call('PUT', `/fields/${withValues.id}`, { code: 'inshyi' }), 409),
      ).toBe('FIELD_CODE_LOCKED')
      const named = await json<FieldDefinitionSummary>(
        await call('PUT', `/fields/${withValues.id}`, { nameUk: 'Нова назва', nameRu: 'Новое' }),
      )
      expect(named).toMatchObject({ nameUk: 'Нова назва', nameRu: 'Новое', code: withValues.code })

      const filtered = await createField(projectA, group.id, { isFrequentlyFiltered: true })
      expect(
        await refusal(await call('PUT', `/fields/${filtered.id}`, { code: 'inshyi_2' }), 409),
      ).toBe('FIELD_CODE_LOCKED')
      expect(
        (
          await json<FieldDefinitionSummary>(
            await call('PUT', `/fields/${filtered.id}`, { nameUk: 'Інша' }),
          )
        ).nameUk,
      ).toBe('Інша')
      // Тот же код в запросе — не смена.
      await json(await call('PUT', `/fields/${filtered.id}`, { code: filtered.code }))
    })

    it('название: украинское обязательно, русское — нет', async () => {
      const group = await createGroup(projectA)
      const call = as(admin, projectA)
      const field = await createField(projectA, group.id)
      expect(field.nameRu).toBeNull()
      expect(
        await refusal(
          await call('POST', '/fields', { groupId: group.id, nameUk: ' ', type: 'text' }),
          400,
        ),
      ).toBe('INVALID_INPUT')
      expect(
        await refusal(
          await call('POST', '/fields', { groupId: group.id, nameRu: 'Только ру', type: 'text' }),
          400,
        ),
      ).toBe('INVALID_INPUT')
      expect(await refusal(await call('PUT', `/fields/${field.id}`, { nameUk: '' }), 400)).toBe(
        'INVALID_INPUT',
      )
      expect(
        await refusal(
          await call('POST', '/field-groups', { entity: 'deal', nameRu: 'Группа' }),
          400,
        ),
      ).toBe('INVALID_INPUT')
    })
  })

  describe('тип поля', () => {
    it('меняется, пока нет значений; со значениями — 409', async () => {
      const group = await createGroup(projectA)
      const call = as(admin, projectA)
      const field = await createField(projectA, group.id)
      const changed = await json<FieldDefinitionSummary>(
        await call('PUT', `/fields/${field.id}`, { type: 'long_text' }),
      )
      expect(changed.type).toBe('long_text')
      await markHasValues(field.id)
      expect(await refusal(await call('PUT', `/fields/${field.id}`, { type: 'text' }), 409)).toBe(
        'FIELD_TYPE_LOCKED',
      )
    })

    it('поле с вариантами не становится полем без вариантов', async () => {
      const group = await createGroup(projectA)
      const call = as(admin, projectA)
      const field = await createField(projectA, group.id, {
        type: 'single_option',
        options: [{ nameUk: 'Так' }],
      })
      expect(await refusal(await call('PUT', `/fields/${field.id}`, { type: 'text' }), 409)).toBe(
        'FIELD_HAS_OPTIONS',
      )
      const multi = await json<FieldDefinitionSummary>(
        await call('PUT', `/fields/${field.id}`, { type: 'multi_option' }),
      )
      expect(multi.type).toBe('multi_option')
    })
  })

  describe('варианты', () => {
    it('переименование и порядок не меняют id; архивный не предлагается, но остаётся в описании', async () => {
      const group = await createGroup(projectA)
      const call = as(admin, projectA)
      const field = await createField(projectA, group.id, {
        type: 'single_option',
        options: [{ nameUk: 'Перший' }, { nameUk: 'Другий', nameRu: 'Второй' }],
      })
      expect(field.options.map((o) => [o.nameUk, o.nameRu, o.position])).toEqual([
        ['Перший', null, 1],
        ['Другий', 'Второй', 2],
      ])
      const [first, second] = field.options as [FieldOptionSummary, FieldOptionSummary]
      const third = await json<FieldOptionSummary>(
        await call('POST', `/fields/${field.id}/options`, { nameUk: 'Третій' }),
        201,
      )
      expect(third.position).toBe(3)

      const renamed = await json<FieldOptionSummary>(
        await call('PUT', `/fields/${field.id}/options/${first.id}`, { nameUk: 'Перший новий' }),
      )
      expect(renamed).toMatchObject({ id: first.id, nameUk: 'Перший новий' })

      const reordered = await json<FieldOptionSummary[]>(
        await call('PUT', `/fields/${field.id}/options/order`, {
          ids: [third.id, first.id, second.id],
        }),
      )
      expect(reordered.map((o) => o.id)).toEqual([third.id, first.id, second.id])
      expect(
        await refusal(
          await call('PUT', `/fields/${field.id}/options/order`, { ids: [third.id, first.id] }),
          400,
        ),
      ).toBe('INVALID_ORDER')

      const archived = await json<FieldOptionSummary>(
        await call('PUT', `/fields/${field.id}/options/${second.id}`, { archived: true }),
      )
      expect(archived.archivedAt).not.toBeNull()
      const read = await json<FieldDefinitionSummary>(await call('GET', `/fields/${field.id}`))
      expect(read.options.map((o) => o.id)).toEqual([third.id, first.id, second.id])
      expect(offeredOptions(read).map((o) => o.id)).toEqual([third.id, first.id])

      const restored = await json<FieldOptionSummary>(
        await call('PUT', `/fields/${field.id}/options/${second.id}`, { archived: false }),
      )
      expect(restored).toMatchObject({ id: second.id, archivedAt: null })
    })

    it('варианты — только у типов со списком; удаления варианта нет', async () => {
      const group = await createGroup(projectA)
      const call = as(admin, projectA)
      expect(
        await refusal(
          await call('POST', '/fields', {
            groupId: group.id,
            nameUk: 'Текст з варіантами',
            type: 'text',
            options: [{ nameUk: 'А' }],
          }),
          422,
        ),
      ).toBe('FIELD_OPTIONS_NOT_ALLOWED')
      const text = await createField(projectA, group.id)
      expect(
        await refusal(await call('POST', `/fields/${text.id}/options`, { nameUk: 'А' }), 422),
      ).toBe('FIELD_OPTIONS_NOT_ALLOWED')
      const list = await createField(projectA, group.id, {
        type: 'multi_option',
        options: [{ nameUk: 'А' }],
      })
      expect(
        (await call('DELETE', `/fields/${list.id}/options/${list.options[0]?.id}`)).status,
      ).toBe(404)
    })
  })

  describe('видимость по воронкам и «обязательно с этапа»', () => {
    it('правило с этапом своей воронки, где поле видно, и «выигрыш» — сохраняются', async () => {
      const group = await createGroup(projectA)
      const field = await createField(projectA, group.id, {
        pipelines: [main.id, other.id],
        required: {
          mode: 'stages',
          stages: [
            { pipelineId: main.id, stageId: main.stageIds[1] },
            { pipelineId: other.id, stageId: null },
          ],
        },
        isImportant: true,
      })
      expect(field).toMatchObject({
        pipelines: [main.id, other.id],
        required: {
          mode: 'stages',
          stages: [
            { pipelineId: main.id, stageId: main.stageIds[1] },
            { pipelineId: other.id, stageId: null },
          ],
        },
        isImportant: true,
      })
      const always = await json<FieldDefinitionSummary>(
        await as(admin, projectA)('PUT', `/fields/${field.id}`, {
          pipelines: 'all',
          required: { mode: 'always' },
        }),
      )
      expect(always).toMatchObject({ pipelines: 'all', required: { mode: 'always' } })
    })

    it('этап чужого проекта или другой воронки, воронка, где поле не видно, «с этапа» у контакта — 422', async () => {
      const group = await createGroup(projectA)
      const contacts = await createGroup(projectA, 'contact')
      const call = as(admin, projectA)
      const post = (input: Record<string, unknown>, groupId = group.id) =>
        call('POST', '/fields', { groupId, nameUk: 'Правило', type: 'text', ...input })

      expect(
        await refusal(
          await post({
            required: {
              mode: 'stages',
              stages: [{ pipelineId: main.id, stageId: pipelineB.stageIds[0] }],
            },
          }),
          422,
        ),
      ).toBe('FIELD_STAGE_NOT_FOUND')
      expect(
        await refusal(
          await post({
            required: {
              mode: 'stages',
              stages: [{ pipelineId: main.id, stageId: other.stageIds[0] }],
            },
          }),
          422,
        ),
      ).toBe('FIELD_STAGE_NOT_FOUND')
      expect(
        await refusal(
          await post({
            required: { mode: 'stages', stages: [{ pipelineId: pipelineB.id, stageId: null }] },
          }),
          422,
        ),
      ).toBe('FIELD_PIPELINE_NOT_FOUND')
      expect(await refusal(await post({ pipelines: [pipelineB.id] }), 422)).toBe(
        'FIELD_PIPELINE_NOT_FOUND',
      )
      expect(
        await refusal(
          await post({
            pipelines: [other.id],
            required: {
              mode: 'stages',
              stages: [{ pipelineId: main.id, stageId: main.stageIds[0] }],
            },
          }),
          422,
        ),
      ).toBe('FIELD_PIPELINE_HIDDEN')
      expect(
        await refusal(
          await post(
            { required: { mode: 'stages', stages: [{ pipelineId: main.id, stageId: null }] } },
            contacts.id,
          ),
          422,
        ),
      ).toBe('FIELD_DEAL_ONLY')
      expect(await refusal(await post({ pipelines: [main.id] }, contacts.id), 422)).toBe(
        'FIELD_DEAL_ONLY',
      )
      // «Всегда» у контакта — можно.
      await json(
        await post({ code: 'kontakt_zavzhdy', required: { mode: 'always' } }, contacts.id),
        201,
      )

      // Сузить видимость так, что правило останется на скрытой воронке, нельзя.
      const field = await createField(projectA, group.id, {
        required: { mode: 'stages', stages: [{ pipelineId: main.id, stageId: main.stageIds[0] }] },
      })
      expect(
        await refusal(await call('PUT', `/fields/${field.id}`, { pipelines: [other.id] }), 422),
      ).toBe('FIELD_PIPELINE_HIDDEN')
    })

    it('удаление этапа переводит правило на следующий этап, с последнего — на «выигрыш»', async () => {
      const pipeline = await createPipeline(projectA, 'moves', ['m1', 'm2', 'm3'])
      const [m1, m2, m3] = pipeline.stageIds
      const group = await createGroup(projectA)
      const field = await createField(projectA, group.id, {
        pipelines: [pipeline.id],
        required: { mode: 'stages', stages: [{ pipelineId: pipeline.id, stageId: m2 }] },
      })
      const call = as(admin, projectA)
      const read = async () =>
        (await json<FieldDefinitionSummary>(await call('GET', `/fields/${field.id}`))).required

      expect((await call('DELETE', `/pipelines/${pipeline.id}/stages/${m2}`)).status).toBe(204)
      expect(await read()).toEqual({
        mode: 'stages',
        stages: [{ pipelineId: pipeline.id, stageId: m3 }],
      })
      expect((await call('DELETE', `/pipelines/${pipeline.id}/stages/${m3}`)).status).toBe(204)
      expect(await read()).toEqual({
        mode: 'stages',
        stages: [{ pipelineId: pipeline.id, stageId: null }],
      })
      // Этап без правил удаляется как раньше.
      expect((await call('DELETE', `/pipelines/${pipeline.id}/stages/${m1}`)).status).toBe(204)
    })
  })

  describe('архив и удаление', () => {
    it('поле без данных удаляется сразу, код свободен', async () => {
      const group = await createGroup(projectA)
      const call = as(admin, projectA)
      const field = await createField(projectA, group.id, {
        code: 'bez_danykh',
        type: 'single_option',
        options: [{ nameUk: 'А' }],
      })
      expect((await call('DELETE', `/fields/${field.id}`)).status).toBe(204)
      expect((await call('GET', `/fields/${field.id}`)).status).toBe(404)
      await createField(projectA, group.id, { code: 'bez_danykh' })
      const log = await h.owner
        .selectFrom('audit_log')
        .select('action')
        .where('entity_id', '=', field.id)
        .execute()
      expect(log.map((r) => r.action)).toContain('field.deleted')
    })

    it('поле с данными при удалении уходит в архив; из архива возвращается со значениями', async () => {
      const group = await createGroup(projectA, 'organization')
      const call = as(admin, projectA)
      const field = await createField(projectA, group.id, { code: 'arkhiv' })
      await markHasValues(field.id)
      const org = await h.owner
        .insertInto('organization')
        .values({ project_id: projectA, name: 'Архівна', custom: JSON.stringify({ arkhiv: 'x' }) })
        .returning('id')
        .executeTakeFirstOrThrow()

      const archived = await json<FieldDefinitionSummary>(
        await call('DELETE', `/fields/${field.id}`),
      )
      expect(archived.archivedAt).not.toBeNull()
      expect(archived.purgeRequestedAt).toBeNull()
      const live = await json<FieldDefinitionSummary[]>(
        await call('GET', '/fields?entity=organization'),
      )
      expect(live.map((f) => f.id)).not.toContain(field.id)
      const all = await json<FieldDefinitionSummary[]>(
        await call('GET', '/fields?entity=organization&includeArchived=true'),
      )
      expect(all.map((f) => f.id)).toContain(field.id)

      const restored = await json<FieldDefinitionSummary>(
        await call('POST', `/fields/${field.id}/restore`),
      )
      expect(restored.archivedAt).toBeNull()
      const row = await h.owner
        .selectFrom('organization')
        .select('custom')
        .where('id', '=', org.id)
        .executeTakeFirstOrThrow()
      expect(row.custom).toEqual({ arkhiv: 'x' })
    })

    it('окончательное удаление раньше 30 дней — 409; после — задача убирает ключ из custom всех записей, код свободен, журнал есть', async () => {
      const group = await createGroup(projectA, 'organization')
      const groupB = await createGroup(projectB, 'organization')
      const call = as(admin, projectA)
      const field = await createField(projectA, group.id, { code: 'motyv' })
      await createField(projectB, groupB.id, { code: 'motyv' })
      await markHasValues(field.id)
      const orgs = await h.owner
        .insertInto('organization')
        .values([
          ...Array.from({ length: 5 }, (_, i) => ({
            project_id: projectA,
            name: `Мотив ${i}`,
            custom: JSON.stringify({ motyv: `m${i}`, inshe: i }),
          })),
          { project_id: projectA, name: 'Без мотиву', custom: JSON.stringify({ inshe: 9 }) },
          { project_id: projectB, name: 'Чужа', custom: JSON.stringify({ motyv: 'b' }) },
        ])
        .returning(['id', 'project_id', 'updated_at'])
        .execute()

      // Архив 29 дней назад: рано.
      clock = new Date(Date.now() - 29 * DAY_MS)
      await json(await call('POST', `/fields/${field.id}/archive`))
      clock = null
      const early = await json<{ code: string; details: { availableAt: string } }>(
        await call('DELETE', `/fields/${field.id}`),
        409,
      )
      expect(early.code).toBe('FIELD_PURGE_TOO_EARLY')
      // Возврат и архив 31 день назад: можно.
      await json(await call('POST', `/fields/${field.id}/restore`))
      clock = new Date(Date.now() - 31 * DAY_MS)
      await json(await call('POST', `/fields/${field.id}/archive`))
      clock = null

      const pending = await json<FieldDefinitionSummary>(
        await call('DELETE', `/fields/${field.id}`),
        202,
      )
      expect(pending.purgeRequestedAt).not.toBeNull()

      await vi.waitFor(
        async () => {
          expect((await call('GET', `/fields/${field.id}`)).status).toBe(404)
        },
        { timeout: 30_000, interval: 250 },
      )
      const after = await h.owner
        .selectFrom('organization')
        .select(['id', 'project_id', 'custom', 'updated_at'])
        .where(
          'id',
          'in',
          orgs.map((o) => o.id),
        )
        .execute()
      for (const org of after) {
        if (org.project_id === projectB) expect(org.custom).toEqual({ motyv: 'b' })
        else expect(org.custom).not.toHaveProperty('motyv')
      }
      expect(
        after
          .filter((o) => o.project_id === projectA)
          .map((o) => o.custom.inshe)
          .sort(),
      ).toEqual([0, 1, 2, 3, 4, 9])
      // Ничего, кроме custom, задача не трогает.
      for (const org of orgs) {
        expect(after.find((o) => o.id === org.id)?.updated_at).toEqual(org.updated_at)
      }
      const options = await h.owner
        .selectFrom('field_option')
        .select('id')
        .where('field_id', '=', field.id)
        .execute()
      expect(options).toEqual([])
      await createField(projectA, group.id, { code: 'motyv' })

      const log = await h.owner
        .selectFrom('audit_log')
        .select(['action', 'actor_id', 'project_id'])
        .where('entity_id', '=', field.id)
        .execute()
      expect(log).toEqual(
        expect.arrayContaining([
          { action: 'field.purge_requested', actor_id: admin.id, project_id: projectA },
          { action: 'field.purged', actor_id: admin.id, project_id: projectA },
        ]),
      )
    })

    it('пока идёт окончательное удаление, поле не меняется и не возвращается из архива', async () => {
      const group = await createGroup(projectA)
      const call = as(admin, projectA)
      const field = await createField(projectA, group.id)
      await h.owner
        .updateTable('field_definition')
        .set({
          first_value_at: new Date(),
          archived_at: new Date(),
          purge_requested_at: new Date(),
        })
        .where('id', '=', field.id)
        .execute()
      expect(await refusal(await call('POST', `/fields/${field.id}/restore`), 409)).toBe(
        'FIELD_PURGE_PENDING',
      )
      expect(await refusal(await call('PUT', `/fields/${field.id}`, { nameUk: 'Х' }), 409)).toBe(
        'FIELD_PURGE_PENDING',
      )
    })

    it('создание поля не меняет ни одной записи', async () => {
      const org = await h.owner
        .insertInto('organization')
        .values({ project_id: projectA, name: 'Незмінна' })
        .returning(['id', 'custom', 'updated_at'])
        .executeTakeFirstOrThrow()
      const group = await createGroup(projectA, 'organization')
      await createField(projectA, group.id, { code: 'nove_pole' })
      const after = await h.owner
        .selectFrom('organization')
        .select(['id', 'custom', 'updated_at'])
        .where('id', '=', org.id)
        .executeTakeFirstOrThrow()
      expect(after).toEqual(org)
      expect(after.custom).toEqual({})
    })
  })

  describe('группы', () => {
    it('группу с полем (и с архивным) удалить нельзя — 409, пустую — можно', async () => {
      const call = as(admin, projectA)
      const group = await createGroup(projectA)
      const field = await createField(projectA, group.id)
      expect(await refusal(await call('DELETE', `/field-groups/${group.id}`), 409)).toBe(
        'FIELD_GROUP_NOT_EMPTY',
      )
      await json(await call('POST', `/fields/${field.id}/archive`))
      expect(await refusal(await call('DELETE', `/field-groups/${group.id}`), 409)).toBe(
        'FIELD_GROUP_NOT_EMPTY',
      )
      const empty = await createGroup(projectA)
      expect((await call('DELETE', `/field-groups/${empty.id}`)).status).toBe(204)
      const groups = await json<FieldGroupSummary[]>(await call('GET', '/field-groups?entity=deal'))
      expect(groups.map((g) => g.id)).not.toContain(empty.id)
    })

    it('поле лежит в группе своей сущности; порядок групп и полей переставляется', async () => {
      const call = as(admin, projectA)
      const g1 = await createGroup(projectA, 'contact')
      const g2 = await createGroup(projectA, 'contact')
      const deals = await createGroup(projectA)
      const f1 = await createField(projectA, g1.id)
      const f2 = await createField(projectA, g1.id)
      expect(f1.entity).toBe('contact')
      expect(await refusal(await call('PUT', `/fields/${f1.id}`, { groupId: deals.id }), 422)).toBe(
        'FIELD_GROUP_NOT_FOUND',
      )

      const contactGroups = await json<FieldGroupSummary[]>(
        await call('GET', '/field-groups?entity=contact'),
      )
      const order = [g2.id, ...contactGroups.map((g) => g.id).filter((id) => id !== g2.id)]
      const reordered = await json<FieldGroupSummary[]>(
        await call('PUT', '/field-groups/order', { entity: 'contact', ids: order }),
      )
      expect(reordered.map((g) => g.id)).toEqual(order)

      const fields = await json<FieldDefinitionSummary[]>(
        await call('PUT', '/fields/order', { groupId: g1.id, ids: [f2.id, f1.id] }),
      )
      expect(fields.map((f) => f.id)).toEqual([f2.id, f1.id])
      const moved = await json<FieldDefinitionSummary>(
        await call('PUT', `/fields/${f1.id}`, { groupId: g2.id }),
      )
      expect(moved.groupId).toBe(g2.id)
    })
  })

  // Те же правила держит база: запись в обход API (ролью приложения, в контексте проекта).
  describe('правила в базе', () => {
    const inA = <T>(fn: (trx: Transaction<Database>) => Promise<T>) =>
      withProject(h.appDb, projectA, fn)

    it('коды системных полей из packages/shared запрещены и базой (снимок в миграции не отстал)', async () => {
      const groups = new Map<string, string>()
      for (const entity of FIELD_ENTITIES)
        groups.set(entity, (await createGroup(projectA, entity)).id)
      for (const entity of FIELD_ENTITIES) {
        for (const code of SYSTEM_FIELD_CODES[entity]) {
          await expect(
            h.owner
              .insertInto('field_definition')
              .values({
                project_id: projectA,
                entity,
                group_id: groups.get(entity) ?? '',
                code,
                name_uk: 'Системне',
                type: 'text',
              })
              .execute(),
            `${entity}.${code}`,
          ).rejects.toThrow(/field_definition_code_not_system/)
        }
      }
      await expect(
        h.owner
          .insertInto('field_definition')
          .values({
            project_id: projectA,
            entity: 'deal',
            group_id: groups.get('deal') ?? '',
            code: 'Bad',
            name_uk: 'Формат',
            type: 'text',
          })
          .execute(),
      ).rejects.toThrow(/field_definition_code_format/)
    })

    it('код и тип поля со значениями, код при «часто фильтруют», ранний окончательный delete', async () => {
      const group = await createGroup(projectA)
      const withValues = await createField(projectA, group.id)
      await markHasValues(withValues.id)
      const filtered = await createField(projectA, group.id, { isFrequentlyFiltered: true })

      await expect(
        inA((trx) =>
          trx
            .updateTable('field_definition')
            .set({ code: 'obkhid' })
            .where('id', '=', withValues.id)
            .execute(),
        ),
      ).rejects.toMatchObject({ code: 'FD001' })
      await expect(
        inA((trx) =>
          trx
            .updateTable('field_definition')
            .set({ code: 'obkhid' })
            .where('id', '=', filtered.id)
            .execute(),
        ),
      ).rejects.toMatchObject({ code: 'FD001' })
      await expect(
        inA((trx) =>
          trx
            .updateTable('field_definition')
            .set({ type: 'number' })
            .where('id', '=', withValues.id)
            .execute(),
        ),
      ).rejects.toMatchObject({ code: 'FD002' })
      // Архив 29 дней назад — рано; 31 — можно.
      await h.owner
        .updateTable('field_definition')
        .set({ archived_at: new Date(Date.now() - 29 * DAY_MS) })
        .where('id', '=', withValues.id)
        .execute()
      await expect(
        inA((trx) => trx.deleteFrom('field_definition').where('id', '=', withValues.id).execute()),
      ).rejects.toMatchObject({ code: 'FD006' })
      await h.owner
        .updateTable('field_definition')
        .set({ archived_at: new Date(Date.now() - 31 * DAY_MS) })
        .where('id', '=', withValues.id)
        .execute()
      await inA((trx) =>
        trx.deleteFrom('field_definition').where('id', '=', withValues.id).execute(),
      )
    })

    it('варианты — только у полей со списком и не удаляются; поле сделки — в группе сделки', async () => {
      const group = await createGroup(projectA)
      const contacts = await createGroup(projectA, 'contact')
      const text = await createField(projectA, group.id)
      const list = await createField(projectA, group.id, {
        type: 'single_option',
        options: [{ nameUk: 'А' }],
      })
      await expect(
        inA((trx) =>
          trx
            .insertInto('field_option')
            .values({ project_id: projectA, field_id: text.id, name_uk: 'Х' })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: 'FD005' })
      await expect(
        inA((trx) =>
          trx
            .updateTable('field_definition')
            .set({ type: 'text' })
            .where('id', '=', list.id)
            .execute(),
        ),
      ).rejects.toMatchObject({ code: 'FD005' })
      await expect(
        inA((trx) => trx.deleteFrom('field_option').where('field_id', '=', list.id).execute()),
      ).rejects.toThrow(/permission denied/)
      await expect(
        inA((trx) =>
          trx
            .updateTable('field_definition')
            .set({ group_id: contacts.id })
            .where('id', '=', text.id)
            .execute(),
        ),
      ).rejects.toThrow(/foreign key/)
    })

    it('видимость и «с этапа» — только у сделки; правило — на видимой воронке и действующем этапе', async () => {
      const contacts = await createGroup(projectA, 'contact')
      const contactField = await createField(projectA, contacts.id)
      await expect(
        inA((trx) =>
          trx
            .updateTable('field_definition')
            .set({ pipeline_visibility: 'selected' })
            .where('id', '=', contactField.id)
            .execute(),
        ),
      ).rejects.toThrow(/field_definition_deal_only/)

      const pipeline = await createPipeline(projectA, 'db_rules', ['d1', 'd2'])
      const group = await createGroup(projectA)
      const field = await createField(projectA, group.id, {
        pipelines: [pipeline.id],
        required: {
          mode: 'stages',
          stages: [{ pipelineId: pipeline.id, stageId: pipeline.stageIds[0] }],
        },
      })
      // Правило на воронке, где поле не видно.
      await expect(
        inA((trx) =>
          trx
            .insertInto('field_required_stage')
            .values({
              project_id: projectA,
              field_id: field.id,
              pipeline_id: main.id,
              stage_id: null,
            })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: 'FD003' })
      // Воронка уходит из видимости, а правило осталось.
      await expect(
        inA((trx) =>
          trx
            .deleteFrom('field_pipeline')
            .where('field_id', '=', field.id)
            .where('pipeline_id', '=', pipeline.id)
            .execute(),
        ),
      ).rejects.toMatchObject({ code: 'FD003' })
      // Этап чужой воронки.
      await expect(
        inA((trx) =>
          trx
            .updateTable('field_required_stage')
            .set({ stage_id: main.stageIds[0] ?? '' })
            .where('field_id', '=', field.id)
            .execute(),
        ),
      ).rejects.toThrow(/foreign key/)
      // Удалить этап с правилом в обход API нельзя.
      await expect(
        inA((trx) =>
          trx
            .updateTable('stage')
            .set({ deleted_at: new Date() })
            .where('id', '=', pipeline.stageIds[0] ?? '')
            .execute(),
        ),
      ).rejects.toMatchObject({ code: 'FD004' })
      // Правило на удалённом этапе.
      await inA((trx) =>
        trx
          .updateTable('stage')
          .set({ deleted_at: new Date() })
          .where('id', '=', pipeline.stageIds[1] ?? '')
          .execute(),
      )
      await expect(
        inA((trx) =>
          trx
            .updateTable('field_required_stage')
            .set({ stage_id: pipeline.stageIds[1] ?? '' })
            .where('field_id', '=', field.id)
            .execute(),
        ),
      ).rejects.toMatchObject({ code: 'FD004' })
      // Окончательное удаление поля без значений уносит видимость и правила каскадом.
      await inA((trx) => trx.deleteFrom('field_definition').where('id', '=', field.id).execute())
      const left = await h.owner
        .selectFrom('field_required_stage')
        .select('field_id')
        .where('field_id', '=', field.id)
        .execute()
      expect(left).toEqual([])
    })
  })
})
