import { randomUUID } from 'node:crypto'
import type {
  FieldDefinitionSummary,
  FieldGroupSummary,
  PipelineSummary,
  RolePermissions,
  RoleSummary,
  StageSummary,
} from '@alpi/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ContactView } from '../contacts/contacts.ts'
import type { DealView } from '../deals/store.ts'
import type { OrganizationView } from '../organizations/organizations.ts'
import { type ApiHarness, type SignedInUser, startApiHarness } from '../testing/api-harness.ts'
import { pathError, problemFields, problemOf } from '../testing/problem.ts'

// Права ролей на группы полей в API (тикет crm-fields/03) — на настоящем PostgreSQL, API ходит
// ролью приложения. Роль «Обмежена»: сделки, контакты, организации — смотреть, создавать,
// изменять, охват «все»; группы «Таємна …» каждой сущности у неё скрыты, группа сделок
// «Для читання» — только чтение, группа «Відкрита» — без записи (по правам: «изменять»).
// Скрытое ищется в строке ответа целиком: код, название поля и группы, значение, id.

type Entity = 'deal' | 'contact' | 'organization'
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

const SECRET_VALUE = 'ТАЄМНЕ-ЗНАЧЕННЯ'

describe('права ролей на группы полей', () => {
  let h: ApiHarness
  let admin: SignedInUser
  let limited: SignedInUser
  let projectA: string
  let projectB: string
  let pipelineA: string
  let pipelineB: string
  /** Скрытые от «Обмеженої» группы и поля по сущностям. */
  const hiddenGroup = {} as Record<Entity, FieldGroupSummary>
  const hiddenField = {} as Record<Entity, FieldDefinitionSummary>
  let readField: FieldDefinitionSummary
  let openField: FieldDefinitionSummary
  let limitedRole: RoleSummary
  let deal: DealView
  let contact: ContactView
  let organization: OrganizationView

  const as =
    (user: SignedInUser, project: string) => (method: Method, path: string, body?: unknown) =>
      user.api(method, `/v1${path}`, { project, ...(body === undefined ? {} : { body }) })

  async function json<T>(res: Response, status = 200): Promise<T> {
    const text = await res.text()
    expect(res.status, text).toBe(status)
    return (text === '' ? null : JSON.parse(text)) as T
  }

  async function createPipeline(project: string): Promise<string> {
    const call = as(admin, project)
    const pipeline = await json<PipelineSummary>(
      await call('POST', '/pipelines', { name: 'Воронка', code: 'access' }),
      201,
    )
    await json<StageSummary>(
      await call('POST', `/pipelines/${pipeline.id}/stages`, { name: 'Новий' }),
      201,
    )
    return pipeline.id
  }

  async function createGroup(project: string, entity: Entity, nameUk: string) {
    return json<FieldGroupSummary>(
      await as(admin, project)('POST', '/field-groups', { entity, nameUk }),
      201,
    )
  }

  async function createField(
    project: string,
    group: FieldGroupSummary,
    code: string,
    nameUk: string,
  ) {
    return json<FieldDefinitionSummary>(
      await as(admin, project)('POST', '/fields', {
        groupId: group.id,
        nameUk,
        code,
        type: 'text',
      }),
      201,
    )
  }

  /** Участник `project` с ролью `roleId` (служебной ролью: роль задана, проверки guard не нужны). */
  async function addWithRole(project: string, userId: string, roleId: string) {
    await h.owner
      .insertInto('project_member')
      .values({ project_id: project, user_id: userId, role_id: roleId })
      .execute()
  }

  async function storedCustom(table: Entity, id: string) {
    const row = await h.owner
      .selectFrom(table)
      .select('custom')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    return row.custom as Record<string, unknown>
  }

  /** Что не должно встречаться в ответах «Обмеженої» по сущности. */
  function secretsOf(entity: Entity): string[] {
    return [
      hiddenField[entity].code,
      hiddenField[entity].nameUk,
      hiddenField[entity].id,
      hiddenGroup[entity].nameUk,
      hiddenGroup[entity].id,
      SECRET_VALUE,
    ]
  }

  const RECORD_ACTIONS = ['view', 'create', 'edit'] as const

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_field_access')
    admin = await h.signIn('owner')
    limited = await h.signIn()
    projectA = (await h.createProject(admin, 'Доступ А')).id
    projectB = (await h.createProject(admin, 'Доступ Б')).id
    pipelineA = await createPipeline(projectA)
    pipelineB = await createPipeline(projectB)

    for (const entity of ['deal', 'contact', 'organization'] as const) {
      hiddenGroup[entity] = await createGroup(projectA, entity, `Таємна група ${entity}`)
      hiddenField[entity] = await createField(
        projectA,
        hiddenGroup[entity],
        `secret_${entity}`,
        `Таємне поле ${entity}`,
      )
    }
    readField = await createField(
      projectA,
      await createGroup(projectA, 'deal', 'Для читання'),
      'read_note',
      'Поле для читання',
    )
    openField = await createField(
      projectA,
      await createGroup(projectA, 'deal', 'Відкрита'),
      'open_note',
      'Відкрите поле',
    )

    const permissions = {
      actions: {
        deals: RECORD_ACTIONS,
        contacts: RECORD_ACTIONS,
        organizations: RECORD_ACTIONS,
      },
      scopes: { deals: { read: 'all', write: 'all' }, contacts: { read: 'all', write: 'all' } },
      fieldGroups: {
        [hiddenGroup.deal.id]: 'hidden',
        [hiddenGroup.contact.id]: 'hidden',
        [hiddenGroup.organization.id]: 'hidden',
        [readField.groupId]: 'read',
      },
    }
    limitedRole = await json<RoleSummary>(
      await admin.api('POST', '/roles', {
        project: projectA,
        body: { name: 'Обмежена', permissions },
      }),
      201,
    )
    await addWithRole(projectA, limited.id, limitedRole.id)

    // Записи с секретом заводит администратор; второе изменение — строка истории.
    const call = as(admin, projectA)
    organization = await json<OrganizationView>(
      await call('POST', '/organizations', {
        name: 'Організація',
        custom: { [hiddenField.organization.code]: `${SECRET_VALUE}-1` },
      }),
      201,
    )
    contact = await json<ContactView>(
      await call('POST', '/contacts', {
        firstName: 'Клієнт',
        organizationId: organization.id,
        custom: { [hiddenField.contact.code]: `${SECRET_VALUE}-1` },
      }),
      201,
    )
    deal = await json<DealView>(
      await call('POST', '/deals', {
        title: 'Угода',
        pipelineId: pipelineA,
        contactId: contact.id,
        custom: {
          [hiddenField.deal.code]: `${SECRET_VALUE}-1`,
          [readField.code]: 'читаю',
          [openField.code]: 'відкрито',
        },
      }),
      201,
    )
    await json(
      await call('PUT', `/deals/${deal.id}`, {
        custom: { [hiddenField.deal.code]: `${SECRET_VALUE}-2`, [openField.code]: 'змінено' },
      }),
    )
    await json(
      await call('PUT', `/contacts/${contact.id}`, {
        custom: { [hiddenField.contact.code]: `${SECRET_VALUE}-2` },
      }),
    )
    await json(
      await call('PUT', `/organizations/${organization.id}`, {
        custom: { [hiddenField.organization.code]: `${SECRET_VALUE}-2` },
      }),
    )
  })

  afterAll(async () => {
    await h?.stop()
  })

  /** Ответы о записях и описаниях, где могло бы оказаться скрытое поле сущности. */
  function readPaths(entity: Entity): string[] {
    const record = {
      deal: `/deals/${deal.id}`,
      contact: `/contacts/${contact.id}`,
      organization: `/organizations/${organization.id}`,
    }[entity]
    const list = {
      deal: `/deals?pipeline=${pipelineA}`,
      contact: '/contacts/list',
      organization: '/organizations/list',
    }[entity]
    return [
      `/field-groups?entity=${entity}`,
      `/fields?entity=${entity}`,
      `/fields?entity=${entity}&includeArchived=true`,
      record,
      `${record}/timeline`,
      list,
      ...(entity === 'deal' ? [`/deals/${deal.id}/history`] : []),
      ...(entity === 'contact' ? ['/contacts?limit=50'] : []),
      ...(entity === 'organization' ? ['/organizations?limit=50'] : []),
    ]
  }

  describe('скрытое не отдаётся', () => {
    it.each(['deal', 'contact', 'organization'] as const)(
      '%s: описания, запись, лента, история и список не содержат ни кода, ни названия, ни значения',
      async (entity) => {
        for (const path of readPaths(entity)) {
          // Администратор видит всё — иначе проверка ниже ничего не доказывала бы.
          const full = await (await as(admin, projectA)('GET', path)).text()
          const seen = secretsOf(entity).filter((s) => full.includes(s))
          expect({ path, seen: seen.length > 0 }).toEqual({ path, seen: true })

          const res = await as(limited, projectA)('GET', path)
          const text = await res.text()
          expect({ path, status: res.status }).toEqual({ path, status: 200 })
          for (const secret of secretsOf(entity)) {
            expect({ path, leaked: secret, found: text.includes(secret) }).toEqual({
              path,
              leaked: secret,
              found: false,
            })
          }
        }
      },
    )

    it('видимые поля на месте: «только чтение» и группа без записи', async () => {
      const view = await json<DealView>(await as(limited, projectA)('GET', `/deals/${deal.id}`))
      expect(view.custom).toEqual({ [readField.code]: 'читаю', [openField.code]: 'змінено' })
      const groups = await json<FieldGroupSummary[]>(
        await as(limited, projectA)('GET', '/field-groups?entity=deal'),
      )
      expect(groups.map((g) => g.nameUk)).toEqual(['Для читання', 'Відкрита'])
      const fields = await json<FieldDefinitionSummary[]>(
        await as(limited, projectA)('GET', '/fields?entity=deal'),
      )
      expect(fields.map((f) => f.code)).toEqual([readField.code, openField.code])
      const history = await json<{ field: string }[]>(
        await as(limited, projectA)('GET', `/deals/${deal.id}/history`),
      )
      expect(history.map((e) => e.field)).toContain(`custom.${openField.code}`)
    })

    it('описание скрытого поля по id — 404, как несуществующего', async () => {
      const hidden = await as(limited, projectA)('GET', `/fields/${hiddenField.deal.id}`)
      const missing = await as(limited, projectA)('GET', `/fields/${randomUUID()}`)
      expect({ status: hidden.status, body: await hidden.json() }).toEqual({
        status: missing.status,
        body: await missing.json(),
      })
      expect(missing.status).toBe(404)
      await json(await as(admin, projectA)('GET', `/fields/${hiddenField.deal.id}`))
    })
  })

  describe('запись', () => {
    it('поле группы «только чтение» — 403; администратор пишет', async () => {
      const res = await as(limited, projectA)('PUT', `/deals/${deal.id}`, {
        custom: { [readField.code]: 'інакше' },
      })
      expect({ status: res.status, body: await problemOf(res) }).toEqual({
        status: 403,
        body: { code: 'CUSTOM_FIELD_READ_ONLY', details: { field: readField.code } },
      })
      expect((await storedCustom('deal', deal.id))[readField.code]).toBe('читаю')
    })

    it('поле группы «только чтение» с прежним значением — тоже 403', async () => {
      const stored = (await storedCustom('deal', deal.id))[readField.code]
      expect(stored).toBe('читаю')
      const res = await as(limited, projectA)('PUT', `/deals/${deal.id}`, {
        custom: { [readField.code]: stored },
      })
      expect({ status: res.status, body: await problemOf(res) }).toEqual({
        status: 403,
        body: { code: 'CUSTOM_FIELD_READ_ONLY', details: { field: readField.code } },
      })
    })

    it('поле «только чтение» и скрытое поле в одном запросе — 422, как с неизвестным кодом', async () => {
      // Поле «только чтение» — первым: отказ по нему (403) не должен опередить «неизвестный»,
      // иначе 403 вместо 422 выдал бы, что скрытое поле есть.
      const call = as(limited, projectA)
      const code = hiddenField.deal.code
      const unknownCode = `${code}x`
      const hidden = await call('PUT', `/deals/${deal.id}`, {
        custom: { [readField.code]: 'інакше', [code]: 'злам' },
      })
      const unknown = await call('PUT', `/deals/${deal.id}`, {
        custom: { [readField.code]: 'інакше', [unknownCode]: 'злам' },
      })
      expect({ status: hidden.status, body: await problemOf(hidden) }).toEqual({
        status: 422,
        body: { code: 'CUSTOM_FIELD_UNKNOWN', details: { field: code } },
      })
      expect({ status: unknown.status, body: await problemOf(unknown) }).toEqual({
        status: 422,
        body: { code: 'CUSTOM_FIELD_UNKNOWN', details: { field: unknownCode } },
      })
      expect(await storedCustom('deal', deal.id)).toMatchObject({
        [readField.code]: 'читаю',
        [code]: `${SECRET_VALUE}-2`,
      })
    })

    it.each(['deal', 'contact', 'organization'] as const)(
      '%s: поле скрытой группы — 422 тем же телом, что неизвестный код',
      async (entity) => {
        const path = {
          deal: `/deals/${deal.id}`,
          contact: `/contacts/${contact.id}`,
          organization: `/organizations/${organization.id}`,
        }[entity]
        const code = hiddenField[entity].code
        const unknownCode = `${code}x`
        const hidden = await as(limited, projectA)('PUT', path, { custom: { [code]: 'злам' } })
        const unknown = await as(limited, projectA)('PUT', path, {
          custom: { [unknownCode]: 'злам' },
        })
        expect(hidden.status).toBe(422)
        expect(unknown.status).toBe(422)
        expect(await hidden.text()).toBe((await unknown.text()).replace(unknownCode, code))
        expect(
          (
            await storedCustom(
              entity,
              { deal: deal.id, contact: contact.id, organization: organization.id }[entity],
            )
          )[code],
        ).toBe(`${SECRET_VALUE}-2`)
      },
    )

    it('новая запись с полем скрытой группы — 422; с полем «только чтение» — 403', async () => {
      const call = as(limited, projectA)
      const base = { title: 'Нова', pipelineId: pipelineA, contactId: contact.id }
      const hidden = await call('POST', '/deals', {
        ...base,
        custom: { [hiddenField.deal.code]: 'x' },
      })
      expect({ status: hidden.status, body: await problemOf(hidden) }).toEqual({
        status: 422,
        body: { code: 'CUSTOM_FIELD_UNKNOWN', details: { field: hiddenField.deal.code } },
      })
      const readOnly = await call('POST', '/deals', { ...base, custom: { [readField.code]: 'x' } })
      expect(readOnly.status).toBe(403)
    })

    it('изменение другого поля не теряет значение скрытого', async () => {
      const call = as(limited, projectA)
      const view = await json<DealView>(
        await call('PUT', `/deals/${deal.id}`, { custom: { [openField.code]: 'від обмеженої' } }),
      )
      expect(view.custom).toEqual({ [readField.code]: 'читаю', [openField.code]: 'від обмеженої' })
      await json(await call('PUT', `/deals/${deal.id}`, { title: 'Нова назва' }))
      await json(await call('PUT', `/contacts/${contact.id}`, { firstName: 'Інше' }))
      await json(await call('PUT', `/organizations/${organization.id}`, { name: 'Інша назва' }))
      expect(await storedCustom('deal', deal.id)).toEqual({
        [hiddenField.deal.code]: `${SECRET_VALUE}-2`,
        [readField.code]: 'читаю',
        [openField.code]: 'від обмеженої',
      })
      expect((await storedCustom('contact', contact.id))[hiddenField.contact.code]).toBe(
        `${SECRET_VALUE}-2`,
      )
      expect(
        (await storedCustom('organization', organization.id))[hiddenField.organization.code],
      ).toBe(`${SECRET_VALUE}-2`)
    })
  })

  describe('конструктор полей под правами на группы', () => {
    // Отдельный проект «Конструктор»: роль «Конструктор» — право «поля» целиком и сделки
    // (смотреть, создавать, изменять). Группа «К прихована» у неё скрыта, «К читання» — только
    // чтение, «К відкрита» и «К відкрита 2» — без записи (по правам: «изменять»).
    let projectC: string
    let builder: SignedInUser
    let cRead: FieldGroupSummary
    let cHidden: FieldGroupSummary
    let cOpen: FieldGroupSummary
    let cOpen2: FieldGroupSummary
    let fHidden: FieldDefinitionSummary
    let fRead: FieldDefinitionSummary
    let fOpen: FieldDefinitionSummary

    const asBuilder = (method: Method, path: string, body?: unknown) =>
      as(builder, projectC)(method, path, body)
    const asAdmin = (method: Method, path: string, body?: unknown) =>
      as(admin, projectC)(method, path, body)

    /** Ответ целиком: статус и тело. */
    async function answer(res: Response) {
      const text = await res.text()
      return {
        status: res.status,
        body: text === '' ? null : problemFields(JSON.parse(text), res.status),
      }
    }

    const NOT_FOUND = { status: 404, body: { code: 'NOT_FOUND' } }
    const EXCEEDS = { status: 403, body: pathError('EXCEEDS_OWN_PERMISSIONS', 'groupId') }
    const GROUP_NOT_FOUND = { status: 422, body: pathError('FIELD_GROUP_NOT_FOUND', 'groupId') }

    async function optionField(group: FieldGroupSummary, code: string) {
      return json<FieldDefinitionSummary>(
        await asAdmin('POST', '/fields', {
          groupId: group.id,
          nameUk: `Поле ${code}`,
          code,
          type: 'single_option',
          options: [{ nameUk: 'Варіант' }],
        }),
        201,
      )
    }

    const adminField = async (id: string) =>
      json<FieldDefinitionSummary>(await asAdmin('GET', `/fields/${id}`))
    const adminGroups = async () =>
      json<FieldGroupSummary[]>(await asAdmin('GET', '/field-groups?entity=deal'))

    beforeAll(async () => {
      projectC = (await h.createProject(admin, 'Конструктор')).id
      builder = await h.signIn()
      // Скрытая группа — посередине: порядок групп роли не должен её сдвигать.
      cRead = await createGroup(projectC, 'deal', 'К читання')
      cHidden = await createGroup(projectC, 'deal', 'К прихована')
      cOpen = await createGroup(projectC, 'deal', 'К відкрита')
      cOpen2 = await createGroup(projectC, 'deal', 'К відкрита 2')
      fHidden = await optionField(cHidden, 'k_hidden')
      fRead = await optionField(cRead, 'k_read')
      fOpen = await optionField(cOpen, 'k_open')
      const role = await json<RoleSummary>(
        await admin.api('POST', '/roles', {
          project: projectC,
          body: {
            name: 'Конструктор',
            permissions: {
              actions: { deals: RECORD_ACTIONS, fields: ['view', 'create', 'edit', 'delete'] },
              scopes: { deals: { read: 'all', write: 'all' } },
              fieldGroups: { [cHidden.id]: 'hidden', [cRead.id]: 'read' },
            },
          },
        }),
        201,
      )
      await addWithRole(projectC, builder.id, role.id)
    })

    it('поле скрытой группы: каждый изменяющий запрос — 404, как на несуществующее поле', async () => {
      const before = await adminField(fHidden.id)
      const optionId = fHidden.options[0]?.id as string
      const missing = randomUUID()
      const requests: [Method, string, unknown?][] = [
        ['PUT', '', {}],
        ['PUT', '', { nameUk: 'Перейменовано' }],
        ['PUT', '', { groupId: cOpen.id }],
        ['PUT', '', { required: { mode: 'always' } }],
        ['POST', '/archive'],
        ['POST', '/restore'],
        ['DELETE', ''],
        ['POST', '/options', { nameUk: 'Новий' }],
        ['PUT', '/options/order', { ids: [optionId] }],
        ['PUT', `/options/${optionId}`, { nameUk: 'Інший' }],
      ]
      for (const [method, suffix, body] of requests) {
        const request = `${method} /fields/:id${suffix}`
        const hidden = await answer(await asBuilder(method, `/fields/${fHidden.id}${suffix}`, body))
        const absent = await answer(await asBuilder(method, `/fields/${missing}${suffix}`, body))
        expect({ request, ...hidden }).toEqual({ request, ...NOT_FOUND })
        expect({ request, ...absent }).toEqual({ request, ...NOT_FOUND })
      }
      expect(await adminField(fHidden.id)).toEqual(before)
      // Администратор меняет поле, как прежде.
      const renamed = await json<FieldDefinitionSummary>(
        await asAdmin('PUT', `/fields/${fHidden.id}`, { nameUk: 'Поле k_hidden' }),
      )
      expect(renamed).toEqual(before)
    })

    it('скрытая группа: правка и удаление — 404, как несуществующая', async () => {
      const missing = randomUUID()
      const requests: [Method, unknown?][] = [['PUT', {}], ['PUT', { nameUk: 'Інша' }], ['DELETE']]
      for (const [method, body] of requests) {
        const hidden = await answer(await asBuilder(method, `/field-groups/${cHidden.id}`, body))
        const absent = await answer(await asBuilder(method, `/field-groups/${missing}`, body))
        expect({ method, ...hidden }).toEqual({ method, ...NOT_FOUND })
        expect({ method, ...absent }).toEqual({ method, ...NOT_FOUND })
      }
      expect((await adminGroups()).find((g) => g.id === cHidden.id)).toEqual(cHidden)
      const renamed = await json<FieldGroupSummary>(
        await asAdmin('PUT', `/field-groups/${cHidden.id}`, { nameUk: 'К прихована' }),
      )
      expect(renamed).toEqual(cHidden)
    })

    it('порядок полей скрытой группы — тот же отказ, что у несуществующей группы', async () => {
      const hidden = await answer(
        await asBuilder('PUT', '/fields/order', { groupId: cHidden.id, ids: [fHidden.id] }),
      )
      const absent = await answer(
        await asBuilder('PUT', '/fields/order', { groupId: randomUUID(), ids: [fHidden.id] }),
      )
      expect(hidden).toEqual({ status: 400, body: pathError('INVALID_INPUT', 'groupId') })
      expect(absent).toEqual(hidden)
    })

    it('порядок групп: роль переставляет видимые, скрытая остаётся на своём месте', async () => {
      const visible = await json<FieldGroupSummary[]>(
        await asBuilder('GET', '/field-groups?entity=deal'),
      )
      expect(visible.map((g) => g.id)).toEqual([cRead.id, cOpen.id, cOpen2.id])
      // id скрытой группы в списке — как неизвестный id.
      const order = (ids: string[]) =>
        asBuilder('PUT', '/field-groups/order', { entity: 'deal', ids })
      const withHidden = await answer(await order([cRead.id, cHidden.id, cOpen.id, cOpen2.id]))
      const withUnknown = await answer(await order([cRead.id, randomUUID(), cOpen.id, cOpen2.id]))
      expect(withHidden).toEqual({ status: 400, body: { code: 'INVALID_ORDER' } })
      expect(withUnknown).toEqual(withHidden)

      const reordered = await json<FieldGroupSummary[]>(
        await order([cOpen2.id, cOpen.id, cRead.id]),
      )
      expect(reordered.map((g) => g.id)).toEqual([cOpen2.id, cOpen.id, cRead.id])
      expect((await adminGroups()).map((g) => g.id)).toEqual([
        cOpen2.id,
        cHidden.id,
        cOpen.id,
        cRead.id,
      ])

      // Администратор задаёт порядок всех групп, как прежде.
      const initial = [cRead.id, cHidden.id, cOpen.id, cOpen2.id]
      const restored = await json<FieldGroupSummary[]>(
        await asAdmin('PUT', '/field-groups/order', { entity: 'deal', ids: initial }),
      )
      expect(restored.map((g) => g.id)).toEqual(initial)
    })

    it('перенос поля: нужно «изменять» на обе группы; скрытая цель — как несуществующая', async () => {
      const move = (field: FieldDefinitionSummary, groupId: string) =>
        asBuilder('PUT', `/fields/${field.id}`, { groupId })
      expect(await answer(await move(fOpen, cRead.id))).toEqual(EXCEEDS)
      expect(await answer(await move(fRead, cOpen.id))).toEqual(EXCEEDS)
      expect(await answer(await move(fOpen, cHidden.id))).toEqual(GROUP_NOT_FOUND)
      expect(await answer(await move(fOpen, randomUUID()))).toEqual(GROUP_NOT_FOUND)
      expect((await adminField(fOpen.id)).groupId).toBe(cOpen.id)
      expect((await adminField(fRead.id)).groupId).toBe(cRead.id)

      // Между группами с «изменять» — можно.
      expect((await json<FieldDefinitionSummary>(await move(fOpen, cOpen2.id))).groupId).toBe(
        cOpen2.id,
      )
      await json(await move(fOpen, cOpen.id))

      // Администратор переносит, как прежде, и в скрытую от роли группу, и из неё.
      const toHidden = await asAdmin('PUT', `/fields/${fRead.id}`, { groupId: cHidden.id })
      expect((await json<FieldDefinitionSummary>(toHidden)).groupId).toBe(cHidden.id)
      const back = await asAdmin('PUT', `/fields/${fRead.id}`, { groupId: cRead.id })
      expect((await json<FieldDefinitionSummary>(back)).groupId).toBe(cRead.id)
    })

    it('создание поля: в скрытой группе — как в несуществующей, в «только чтение» — 403', async () => {
      const field = (groupId: string, nameUk = 'Нове поле') => ({ groupId, nameUk, type: 'text' })
      expect(await answer(await asBuilder('POST', '/fields', field(cHidden.id)))).toEqual(
        GROUP_NOT_FOUND,
      )
      expect(await answer(await asBuilder('POST', '/fields', field(randomUUID())))).toEqual(
        GROUP_NOT_FOUND,
      )
      expect(await answer(await asBuilder('POST', '/fields', field(cRead.id)))).toEqual(EXCEEDS)
      const created = await json<FieldDefinitionSummary>(
        await asBuilder('POST', '/fields', field(cOpen.id)),
        201,
      )
      expect(created.groupId).toBe(cOpen.id)
      const all = await json<FieldDefinitionSummary[]>(await asAdmin('GET', '/fields?entity=deal'))
      expect(all.filter((f) => f.nameUk === 'Нове поле').map((f) => f.groupId)).toEqual([cOpen.id])

      // Известное ограничение (решено без владельца): код поля уникален в сущности проекта, и код
      // скрытого поля отвечает «занят».
      expect(
        await answer(
          await asBuilder('POST', '/fields', { ...field(cOpen.id), code: fHidden.code }),
        ),
      ).toEqual({ status: 422, body: pathError('FIELD_CODE_TAKEN', 'code') })

      // Администратор создаёт поле и в скрытой от роли группе.
      const own = await json<FieldDefinitionSummary>(
        await asAdmin('POST', '/fields', field(cHidden.id, 'Поле адміністратора')),
        201,
      )
      expect(own.groupId).toBe(cHidden.id)
    })
  })

  describe('изоляция проектов', () => {
    it('права на группы проекта A не действуют на группы проекта B, и наоборот', async () => {
      // В проекте B у того же пользователя роль-шаблон «керівник» без записей о группах.
      const headB = await h.owner
        .selectFrom('role')
        .select('id')
        .where('project_id', '=', projectB)
        .where('template_key', '=', 'head')
        .executeTakeFirstOrThrow()
      await addWithRole(projectB, limited.id, headB.id)
      const groupB = await createGroup(projectB, 'deal', 'Таємна група deal')
      const fieldB = await createField(projectB, groupB, hiddenField.deal.code, 'Поле Б')
      const contactB = await json<ContactView>(
        await as(admin, projectB)('POST', '/contacts', { firstName: 'Клієнт Б' }),
        201,
      )
      const dealB = await json<DealView>(
        await as(admin, projectB)('POST', '/deals', {
          title: 'Угода Б',
          pipelineId: pipelineB,
          contactId: contactB.id,
          custom: { [fieldB.code]: 'видно в Б' },
        }),
        201,
      )
      const callB = as(limited, projectB)
      const groups = await json<FieldGroupSummary[]>(
        await callB('GET', '/field-groups?entity=deal'),
      )
      expect(groups.map((g) => g.id)).toEqual([groupB.id])
      const view = await json<DealView>(await callB('GET', `/deals/${dealB.id}`))
      expect(view.custom).toEqual({ [fieldB.code]: 'видно в Б' })
      await json(await callB('PUT', `/deals/${dealB.id}`, { custom: { [fieldB.code]: 'змінено' } }))

      // Группа проекта B в правах роли проекта A — 422; права роли A не изменились.
      const permissions: RolePermissions = { ...limitedRole.permissions }
      const res = await admin.api('PUT', `/roles/${limitedRole.id}`, {
        project: projectA,
        body: {
          permissions: {
            ...permissions,
            fieldGroups: { ...permissions.fieldGroups, [groupB.id]: 'hidden' },
          },
        },
      })
      expect(res.status).toBe(422)
      // А в проекте A поле с тем же кодом по-прежнему скрыто.
      const textA = await (await as(limited, projectA)('GET', `/deals/${deal.id}`)).text()
      expect(textA).not.toContain(hiddenField.deal.code)
    })
  })
})
