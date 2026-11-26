import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createProject, PROJECT_PRESETS } from '@alpi/db'
import { type FieldType, normalizeFieldValue, normalizePhone } from '@alpi/shared'
import { type SqlBool, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildSeedPlan, FRANCH_PRICED_FROM_STAGE } from '../seed/plan.ts'
import { readCredentials } from '../seed/users.ts'
import { type ApiHarness, ORIGIN, startApiHarness } from '../testing/api-harness.ts'
import { totp } from '../testing/totp.ts'
import { refusal, runSeed, type SeedDeps } from './seed.ts'

// `pnpm seed` (тикет crm-deals/10): тестовые данные на уменьшенном объёме (1/10) — числа,
// правила базы, повторный запуск, --reset, отказ на проде и чтение созданного через API под
// менеджером.

const SCALE = ['--scale', '0.1']
const SLOW = 180_000

describe('pnpm seed', () => {
  let h: ApiHarness
  let deps: SeedDeps
  let credentialsFile: string
  const silent = { log: () => {}, error: () => {} }

  beforeAll(async () => {
    h = await startApiHarness('alpi_seed_test')
    credentialsFile = path.join(await mkdtemp(path.join(tmpdir(), 'alpi-seed-')), 'creds.json')
    deps = {
      serviceDb: h.owner,
      // Тот же сервер, что у служебного подключения: локальный адрес.
      databaseUrl: h.appUrl,
      auth: h.auth,
      authUrl: ORIGIN,
      env: { NODE_ENV: 'test' },
      credentialsFile,
      out: silent,
    }
  })

  afterAll(async () => {
    await h?.stop()
  })

  const TABLES = [
    'user',
    'project',
    'project_member',
    'team',
    'product',
    'organization',
    'contact',
    'contact_phone',
    'contact_email',
    'deal',
    'deal_participant',
    'deal_product',
    'external_link',
    'field_group',
    'field_definition',
    'field_option',
  ] as const

  async function counts() {
    const result: Record<string, number> = {}
    for (const table of TABLES) {
      const { rows } = await sql<{
        n: number
      }>`select count(*)::int as n from ${sql.table(table)}`.execute(h.owner)
      result[table] = rows[0]?.n ?? -1
    }
    return result
  }

  async function projectId(code: string) {
    const row = await h.owner
      .selectFrom('project')
      .select('id')
      .where('code', '=', code)
      .executeTakeFirst()
    return row?.id
  }

  it('план детерминирован: то же зерно — те же люди и сделки', () => {
    const now = new Date('2026-11-23T12:00:00Z')
    const a = buildSeedPlan({ scale: 0.05, now })
    const b = buildSeedPlan({ scale: 0.05, now })
    expect(b).toEqual(a)
    expect(buildSeedPlan({ scale: 0.05, now, seed: 1 }).projects[0]?.contacts).not.toEqual(
      a.projects[0]?.contacts,
    )
  })

  it('NODE_ENV=production или нелокальная база — отказ, ничего не записано', async () => {
    const before = await counts()
    expect(await runSeed({ ...deps, env: { NODE_ENV: 'production' } }, SCALE)).toBe(1)
    expect(
      await runSeed({ ...deps, env: { NODE_ENV: 'production' } }, [...SCALE, '--allow-remote']),
    ).toBe(1)
    expect(await runSeed({ ...deps, env: { NODE_ENV: 'production' } }, ['--reset'])).toBe(1)
    for (const NODE_ENV of ['Production', ' production ', 'PRODUCTION']) {
      expect(await runSeed({ ...deps, env: { NODE_ENV } }, SCALE)).toBe(1)
    }
    // Хост — так, как его выберет pg: `?host=` важнее адреса, без хоста — PGHOST.
    for (const [databaseUrl, env] of [
      ['postgres://alpi:x@db.internal:5432/alpi_crm', {}],
      ['postgres://u:p@localhost/db?host=prod.example.com', {}],
      ['postgres:///db', { PGHOST: 'prod.example.com' }],
      ['postgres://u:p@localhost/db', { PGHOST: 'prod.example.com' }],
      ['postgres://u:p@localhost/db?hostaddr=10.0.0.5', {}],
    ] as const) {
      expect(
        await runSeed({ ...deps, databaseUrl, env: { NODE_ENV: 'test', ...env } }, SCALE),
      ).toBe(1)
    }
    expect(refusal({}, 'postgres:///db', false)).toBeNull()
    expect(refusal({}, 'postgres://u@[::1]:5432/db', false)).toBeNull()
    expect(refusal({}, 'postgres://u@/db?host=/var/run/postgresql', false)).toBeNull()
    expect(refusal({ PGHOST: '/tmp' }, 'postgres:///db', false)).toBeNull()
    expect(refusal({}, 'postgres://u@db.internal/db', true)).toBeNull()
    expect(await runSeed(deps, ['--scale', '5'])).toBe(2)
    expect(await counts()).toEqual(before)
    expect(existsSync(credentialsFile)).toBe(false)
  })

  it(
    'ALPI: 3 воронки, 10 менеджеров в 2 командах, 400 контактов и 500 сделок; «Франч»: сделки с организациями',
    async () => {
      expect(await runSeed(deps, SCALE)).toBe(0)
      const alpi = await projectId('alpi')
      const franch = await projectId('franch')
      if (!alpi || !franch) throw new Error('проекты не созданы')

      const pipelines = await h.owner
        .selectFrom('pipeline')
        .select('code')
        .where('project_id', '=', alpi)
        .orderBy('position')
        .execute()
      expect(pipelines.map((p) => p.code)).toEqual(['alpi', 'platform', 'autowebinars'])

      const members = await h.owner
        .selectFrom('project_member as m')
        .innerJoin('role as r', 'r.id', 'm.role_id')
        .innerJoin('user as u', 'u.id', 'm.user_id')
        .leftJoin('team as t', 't.id', 'm.team_id')
        .select(['u.id', 'u.email', 'r.template_key', 't.name as team', 't.lead_user_id'])
        .where('m.project_id', '=', alpi)
        .execute()
      expect(members).toHaveLength(11)
      expect(members.filter((m) => m.template_key === 'admin').map((m) => m.email)).toEqual([
        'seed.admin@example.com',
      ])
      const managers = members.filter((m) => m.template_key !== 'admin')
      expect(managers).toHaveLength(10)
      for (const team of ['Команда 1', 'Команда 2']) {
        const five = managers.filter((m) => m.team === team)
        expect(five).toHaveLength(5)
        const leads = five.filter((m) => m.template_key === 'teamlead')
        expect(leads).toHaveLength(1)
        expect(five.every((m) => m.lead_user_id === leads[0]?.id)).toBe(true)
        expect(five.filter((m) => m.template_key === 'manager')).toHaveLength(4)
      }

      const deals = await h.owner
        .selectFrom('deal as d')
        .innerJoin('pipeline as p', 'p.id', 'd.pipeline_id')
        .innerJoin('stage as s', 's.id', 'd.stage_id')
        .select([
          'd.id',
          'd.status',
          'd.amount',
          'd.currency',
          'd.owner_id',
          'd.archived_at',
          'd.lost_reason_id',
          'd.organization_id',
          'd.primary_contact_id',
          'p.code as pipeline',
          's.name as stage',
          's.position',
        ])
        .where('d.project_id', 'in', [alpi, franch])
        .execute()
      const alpiDeals = deals.filter((d) => d.pipeline !== 'franch')
      expect(
        await h.owner
          .selectFrom('contact')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('project_id', '=', alpi)
          .executeTakeFirstOrThrow(),
      ).toEqual({ n: '400' })
      expect(alpiDeals).toHaveLength(500)

      // Похоже на настоящее: большинство сделок воронки ALPI — на «Новий лід» с нулевой суммой,
      // суммы — на брони и счёте; есть выигранные, проигранные с причиной, архив, общая очередь.
      const main = alpiDeals.filter((d) => d.pipeline === 'alpi')
      const newLeads = main.filter((d) => d.stage === 'Новий лід' && d.status === 'open')
      expect(newLeads.length).toBeGreaterThan(main.length / 2)
      expect(newLeads.every((d) => Number(d.amount) === 0)).toBe(true)
      const pricedOpen = main.filter((d) => d.status === 'open' && Number(d.amount) > 0)
      expect(pricedOpen.length).toBeGreaterThan(0)
      expect(
        pricedOpen.every((d) => ['Сплатив бронювання', 'Виставили рахунок'].includes(d.stage)),
      ).toBe(true)
      expect(main.some((d) => d.status === 'won')).toBe(true)
      const lost = alpiDeals.filter((d) => d.status === 'lost')
      expect(lost.length).toBeGreaterThan(0)
      expect(lost.every((d) => d.lost_reason_id !== null)).toBe(true)
      expect(alpiDeals.some((d) => d.archived_at !== null)).toBe(true)
      expect(alpiDeals.some((d) => d.owner_id === null && d.status === 'open')).toBe(true)
      expect(new Set(alpiDeals.map((d) => d.currency))).toEqual(new Set(['EUR', 'UAH', 'USD']))

      // Допродажи — только у контактов с выигранной сделкой ALPI.
      const upsell = alpiDeals.filter((d) => d.pipeline === 'platform')
      expect(upsell.length).toBeGreaterThan(0)
      const wonContacts = new Set(
        main.filter((d) => d.status === 'won').map((d) => d.primary_contact_id),
      )
      expect(upsell.every((d) => wonContacts.has(d.primary_contact_id))).toBe(true)

      const products = await h.owner
        .selectFrom('product')
        .selectAll()
        .where('project_id', '=', alpi)
        .execute()
      expect(products.length).toBeGreaterThanOrEqual(3)
      expect(products.every((p) => p.price_eur && p.price_uah && p.price_usd)).toBe(true)
      const lines = await h.owner
        .selectFrom('deal_product')
        .select('deal_id')
        .where('project_id', '=', alpi)
        .execute()
      expect(lines.length).toBeGreaterThan(0)
      expect(lines.length).toBeLessThan(alpiDeals.length / 2)

      // «Франч»: 30 сделок, у всех организация; участники с ролями; суммы в EUR — с этапа
      // «Встреча проведена».
      const franchDeals = deals.filter((d) => d.pipeline === 'franch')
      expect(franchDeals).toHaveLength(30)
      expect(franchDeals.every((d) => d.organization_id !== null)).toBe(true)
      expect(franchDeals.every((d) => d.currency === 'EUR')).toBe(true)
      expect(franchDeals.some((d) => Number(d.amount) > 0)).toBe(true)
      expect(
        franchDeals
          .filter((d) => Number(d.amount) > 0)
          .every((d) => d.position >= FRANCH_PRICED_FROM_STAGE),
      ).toBe(true)
      const participants = await h.owner
        .selectFrom('deal_participant')
        .select('role')
        .where('project_id', '=', franch)
        .execute()
      expect(participants.length).toBeGreaterThan(0)
      expect(participants.every((p) => p.role !== null)).toBe(true)

      // Стартовые поля ALPI (тикет crm-fields/08) и выдуманные значения у части сделок ALPI;
      // у «Франча» полей нет.
      const fields = await h.owner
        .selectFrom('field_definition')
        .select(['id', 'project_id', 'code', 'type', 'first_value_at'])
        .where('project_id', 'in', [alpi, franch])
        .execute()
      expect(fields.filter((f) => f.project_id === franch)).toEqual([])
      const alpiFields = fields.filter((f) => f.project_id === alpi)
      expect(alpiFields.map((f) => f.code).sort()).toEqual(
        PROJECT_PRESETS.alpi.fields.map((f) => f.code).sort(),
      )
      const options = await h.owner
        .selectFrom('field_option')
        .select(['id', 'field_id'])
        .where('project_id', '=', alpi)
        .execute()
      const projectUsers = new Map(members.map((m) => [m.id, { disabled: false }]))
      const customs = await h.owner
        .selectFrom('deal')
        .select(['id', 'custom'])
        .where('project_id', '=', alpi)
        .execute()
      const filled = customs.filter((d) => Object.keys(d.custom).length > 0)
      expect(filled.length).toBeGreaterThan(customs.length / 10)
      expect(filled.length).toBeLessThan(customs.length)
      // Каждое значение проходит проверку значений тикета crm-fields/02, как при записи через API.
      const used = new Set<string>()
      for (const deal of filled) {
        for (const [code, value] of Object.entries(deal.custom)) {
          const field = alpiFields.find((f) => f.code === code)
          if (!field) throw new Error(`значение незаведённого поля ${code}`)
          used.add(code)
          const rules = {
            type: field.type as FieldType,
            options: options
              .filter((o) => o.field_id === field.id)
              .map((o) => ({ id: o.id, archivedAt: null })),
          }
          expect(normalizeFieldValue(rules, value, { users: projectUsers }), code).toEqual({
            ok: true,
            value,
          })
        }
      }
      // Значения есть у каждого поля сделки; first_value_at — ровно у полей со значениями.
      const dealCodes = PROJECT_PRESETS.alpi.fields
        .filter((f) => f.entity === 'deal')
        .map((f) => f.code)
      expect([...used].sort()).toEqual(dealCodes.sort())
      expect(
        alpiFields
          .filter((f) => f.first_value_at !== null)
          .map((f) => f.code)
          .sort(),
      ).toEqual([...used].sort())
      // Похоже на работу менеджера: у выигранных сделок ALPI заполнены поля, обязательные при
      // выигрыше в этой воронке.
      const requiredOnWin = PROJECT_PRESETS.alpi.fields
        .filter((f) => f.required?.some((r) => r.pipeline === 'alpi'))
        .map((f) => f.code)
      const wonIds = new Set(main.filter((d) => d.status === 'won').map((d) => d.id))
      const wonCustoms = customs.filter((d) => wonIds.has(d.id))
      expect(wonCustoms.length).toBeGreaterThan(0)
      for (const deal of wonCustoms) {
        expect(Object.keys(deal.custom)).toEqual(expect.arrayContaining(requiredOnWin))
      }

      const credentials = await readCredentials(credentialsFile)
      expect(credentials.map((c) => c.email).sort()).toEqual(members.map((m) => m.email).sort())
      expect(credentials.every((c) => c.password.length >= 12 && c.totpSecret.length > 0)).toBe(
        true,
      )
      const users = await h.owner
        .selectFrom('user')
        .select(['email', 'two_factor_enabled'])
        .where(
          'email',
          'in',
          credentials.map((c) => c.email),
        )
        .execute()
      expect(users.every((u) => u.two_factor_enabled)).toBe(true)
    },
    SLOW,
  )

  it('ни у одного контакта нет двух открытых неархивных сделок в воронке; email только example.com, телефоны тестовые', async () => {
    const { rows: doubles } = await sql<{ n: number }>`
      select count(*)::int as n from (
        select 1 from deal
        where status = 'open' and archived_at is null and deleted_at is null
        group by project_id, pipeline_id, primary_contact_id
        having count(*) > 1
      ) t
    `.execute(h.owner)
    expect(doubles).toEqual([{ n: 0 }])

    const emails = await h.owner.selectFrom('contact_email').select('email').execute()
    expect(emails.length).toBeGreaterThan(0)
    expect(emails.filter((e) => !e.email.endsWith('@example.com'))).toEqual([])
    const userEmails = await h.owner
      .selectFrom('user')
      .select('email')
      .where('email', 'like', 'seed.%')
      .execute()
    expect(userEmails).toHaveLength(11)
    expect(userEmails.every((u) => u.email.endsWith('@example.com'))).toBe(true)

    const phones = await h.owner.selectFrom('contact_phone').select('phone').execute()
    expect(phones.filter((p) => !/^\+38070\d{7}$/.test(p.phone))).toEqual([])
    expect(phones.filter((p) => normalizePhone(p.phone) !== p.phone)).toEqual([])
  })

  it(
    'повторный запуск не меняет числа записей',
    async () => {
      const before = await counts()
      expect(await runSeed(deps, SCALE)).toBe(0)
      expect(await counts()).toEqual(before)
    },
    SLOW,
  )

  it(
    'под менеджером видны его сделки и общая очередь, сделки других менеджеров — нет',
    async () => {
      const alpi = await projectId('alpi')
      if (!alpi) throw new Error('нет проекта')
      const credential = (await readCredentials(credentialsFile)).find((c) => c.role === 'manager')
      if (!credential) throw new Error('нет менеджера')
      const manager = await h.owner
        .selectFrom('user')
        .select('id')
        .where('email', '=', credential.email)
        .executeTakeFirstOrThrow()

      // Вход паролем и кодом 2FA из учётных данных, которые напечатал seed.
      const browser = h.browser()
      const signIn = await browser.api('POST', '/auth/sign-in/email', {
        body: { email: credential.email, password: credential.password },
      })
      expect(signIn.status).toBe(200)
      expect(await signIn.json()).toMatchObject({ twoFactorRedirect: true })
      const verified = await browser.api('POST', '/auth/two-factor/verify-totp', {
        body: { code: totp(credential.totpSecret) },
      })
      expect(verified.status).toBe(200)

      const deals = await h.owner
        .selectFrom('deal')
        .select(['id', 'owner_id'])
        .where('project_id', '=', alpi)
        .orderBy('id')
        .execute()
      const own = deals.filter((d) => d.owner_id === manager.id).slice(0, 15)
      const queue = deals.filter((d) => d.owner_id === null).slice(0, 15)
      const others = deals
        .filter((d) => d.owner_id !== null && d.owner_id !== manager.id)
        .slice(0, 15)
      expect(own.length).toBeGreaterThan(0)
      expect(queue.length).toBeGreaterThan(0)
      expect(others.length).toBeGreaterThan(0)
      const status = async (id: string) =>
        (await browser.api('GET', `/v1/deals/${id}`, { project: alpi })).status
      for (const d of [...own, ...queue]) expect(await status(d.id)).toBe(200)
      for (const d of others) expect(await status(d.id)).toBe(404)
    },
    SLOW,
  )

  it(
    '--reset удаляет созданное командой и не трогает записи, созданные руками',
    async () => {
      const alpi = await projectId('alpi')
      if (!alpi) throw new Error('нет проекта')
      const author = await h.auth.api
        .createUser({
          body: { email: 'hand@example.test', password: 'ручний-пароль-1', name: 'Ручний' },
        })
        .then((r) => r.user)
      const seededDeals = await h.owner
        .selectFrom('deal as d')
        .innerJoin('pipeline as p', 'p.id', 'd.pipeline_id')
        .innerJoin('external_link as l', (join) =>
          join.on('l.entity_type', '=', 'deal').on(sql<SqlBool>`l.entity_id = d.id::text`),
        )
        .select(['d.id', 'd.primary_contact_id', 'd.status', 'd.archived_at'])
        .where('d.project_id', '=', alpi)
        .where('p.code', '=', 'alpi')
        .orderBy('d.id')
        .execute()
      // C1 — контакт открытой неархивной сделки seed: на нём ручные заметка и файл, а позже —
      // ручная открытая сделка в той же воронке.
      const d2 = seededDeals.find((d) => d.status === 'open' && d.archived_at === null)
      if (!d2) throw new Error('нет открытой сделки')
      const c1 = d2.primary_contact_id
      const seen = new Set([c1])
      const [d1, d3, d4] = seededDeals.filter(
        (d) => !seen.has(d.primary_contact_id) && Boolean(seen.add(d.primary_contact_id)),
      )
      if (!d1 || !d3 || !d4) throw new Error('мало сделок')

      // Руками: контакт без сделок, организация, товар без строк и товар в строке сделки seed,
      // заметка и файл на сделке и на контакте seed, участник сделки seed, сделка у контакта
      // seed в другой воронке, отдельный проект с контактом.
      const auto = await h.owner
        .selectFrom('stage as s')
        .innerJoin('pipeline as p', 'p.id', 's.pipeline_id')
        .select(['s.id', 's.pipeline_id'])
        .where('p.project_id', '=', alpi)
        .where('p.code', '=', 'autowebinars')
        .orderBy('s.position')
        .executeTakeFirstOrThrow()
      const addContact = (first_name: string) =>
        h.owner
          .insertInto('contact')
          .values({ project_id: alpi, first_name })
          .returning('id')
          .executeTakeFirstOrThrow()
      const handContact = await addContact('Ручний')
      const handParticipant = await addContact('Учасник')
      const handOrg = await h.owner
        .insertInto('organization')
        .values({ project_id: alpi, name: 'Ручна організація' })
        .returning('id')
        .executeTakeFirstOrThrow()
      const [handProduct, lonelyProduct] = await h.owner
        .insertInto('product')
        .values([
          { project_id: alpi, name: 'Ручний товар', price_eur: 10 },
          { project_id: alpi, name: 'Ручний товар без рядків', price_eur: 20 },
        ])
        .returning('id')
        .execute()
      if (!handProduct || !lonelyProduct) throw new Error('товары не созданы')
      const handLine = await h.owner
        .insertInto('deal_product')
        .values({
          project_id: alpi,
          deal_id: d3.id,
          product_id: handProduct.id,
          quantity: 1,
          unit_price: 10,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      await h.owner
        .insertInto('deal_participant')
        .values({
          project_id: alpi,
          deal_id: d4.id,
          contact_id: handParticipant.id,
          role: 'колега',
        })
        .execute()
      await h.owner
        .insertInto('note')
        .values([
          { project_id: alpi, deal_id: d1.id, text: 'Нотатка до угоди', author_id: author.id },
          { project_id: alpi, contact_id: c1, text: 'Нотатка до контакту', author_id: author.id },
        ])
        .execute()
      const fileRow = (target: { deal_id: string } | { contact_id: string }) => {
        const id = crypto.randomUUID()
        return {
          id,
          project_id: alpi,
          ...target,
          name: 'договір.pdf',
          content_type: 'application/pdf',
          size: 1,
          storage_key: `${alpi}/${id}`,
          author_id: author.id,
        }
      }
      await h.owner
        .insertInto('file')
        .values([fileRow({ deal_id: d1.id }), fileRow({ contact_id: c1 })])
        .execute()
      const seededAutoContact = await h.owner
        .selectFrom('contact as c')
        .innerJoin('external_link as l', (join) =>
          join.on('l.entity_type', '=', 'contact').on(sql<SqlBool>`l.entity_id = c.id::text`),
        )
        .select('c.id')
        .where('c.project_id', '=', alpi)
        .where('c.id', 'not in', [
          c1,
          d1.primary_contact_id,
          d3.primary_contact_id,
          d4.primary_contact_id,
        ])
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('deal')
                .select('id')
                .whereRef('primary_contact_id', '=', 'c.id')
                .where('pipeline_id', '=', auto.pipeline_id),
            ),
          ),
        )
        .executeTakeFirstOrThrow()
      const handDeal = await h.owner
        .insertInto('deal')
        .values({
          project_id: alpi,
          title: 'Ручна угода',
          pipeline_id: auto.pipeline_id,
          stage_id: auto.id,
          primary_contact_id: seededAutoContact.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const other = await createProject(h.owner, { code: 'hand-made', name: 'Ручний' })
      await h.owner
        .insertInto('contact')
        .values({ project_id: other.id, first_name: 'Чужий' })
        .execute()

      const log: string[] = []
      const loud = { log: (m: string) => log.push(m), error: (m: string) => log.push(m) }
      expect(await runSeed({ ...deps, out: loud }, ['--reset'])).toBe(0)

      expect(await projectId('franch')).toBeUndefined()
      expect(await projectId('alpi')).toBe(alpi)
      const ids = async (
        table: 'deal' | 'contact' | 'organization' | 'product' | 'note' | 'file',
      ) =>
        (
          await sql<{
            id: string
          }>`select id::text as id from ${sql.table(table)} where project_id = ${alpi}`.execute(
            h.owner,
          )
        ).rows
          .map((r) => r.id)
          .sort()
      // Сделки seed с ручными заметкой и файлом, строкой товара, участником — на месте.
      expect(await ids('deal')).toEqual([handDeal.id, d1.id, d3.id, d4.id].sort())
      expect(await ids('contact')).toEqual(
        [
          handContact.id,
          handParticipant.id,
          seededAutoContact.id,
          c1,
          d1.primary_contact_id,
          d3.primary_contact_id,
          d4.primary_contact_id,
        ].sort(),
      )
      expect(await ids('organization')).toEqual([handOrg.id])
      expect(await ids('product')).toEqual(
        expect.arrayContaining([handProduct.id, lonelyProduct.id]),
      )
      expect(await ids('note')).toHaveLength(2)
      expect(await ids('file')).toHaveLength(2)
      expect(
        await h.owner
          .selectFrom('deal_product')
          .select('id')
          .where('id', '=', handLine.id)
          .execute(),
      ).toHaveLength(1)
      expect(
        await h.owner
          .selectFrom('deal_participant')
          .select('contact_id')
          .where('deal_id', '=', d4.id)
          .execute(),
      ).toEqual([{ contact_id: handParticipant.id }])
      expect(log.join('\n')).toMatch(/Оставлены записи seed[^\n]*сделок 3, контактов 5/)
      expect(
        await h.owner
          .selectFrom('contact')
          .select('first_name')
          .where('project_id', '=', other.id)
          .execute(),
      ).toEqual([{ first_name: 'Чужий' }])
      // Пользователи seed — участники оставленного проекта ALPI: остаются, как и их пароли.
      expect(await readCredentials(credentialsFile)).toHaveLength(11)

      // Ручная открытая сделка у контакта C1 в воронке ALPI: при повторном запуске сделка плана
      // для C1 в этой воронке пропускается, и вывод это называет.
      const alpiStage = await h.owner
        .selectFrom('stage as s')
        .innerJoin('pipeline as p', 'p.id', 's.pipeline_id')
        .select(['s.id', 's.pipeline_id'])
        .where('p.project_id', '=', alpi)
        .where('p.code', '=', 'alpi')
        .orderBy('s.position')
        .executeTakeFirstOrThrow()
      await h.owner
        .insertInto('deal')
        .values({
          project_id: alpi,
          title: 'Ручна відкрита',
          pipeline_id: alpiStage.pipeline_id,
          stage_id: alpiStage.id,
          primary_contact_id: c1,
        })
        .execute()
      log.length = 0
      expect(await runSeed({ ...deps, out: loud }, SCALE)).toBe(0)
      expect(log.join('\n')).toMatch(/«ALPI»[^\n]*пропущено сделок 1/)
      const { rows: seededNow } = await sql<{ n: number }>`
        select count(*)::int as n from external_link
        where project_id = ${alpi} and source = 'seed' and entity_type = 'deal'
      `.execute(h.owner)
      expect(seededNow).toEqual([{ n: 499 }])

      // Ручные записи убраны — --reset удаляет проекты и пользователей целиком.
      await h.owner.deleteFrom('deal').where('project_id', '=', alpi).execute()
      await h.owner.deleteFrom('note').where('project_id', '=', alpi).execute()
      await h.owner.deleteFrom('file').where('project_id', '=', alpi).execute()
      await h.owner
        .deleteFrom('contact')
        .where('id', 'in', [handContact.id, handParticipant.id])
        .execute()
      await h.owner.deleteFrom('organization').where('id', '=', handOrg.id).execute()
      await h.owner
        .deleteFrom('product')
        .where('id', 'in', [handProduct.id, lonelyProduct.id])
        .execute()
      // Поле, заведённое руками, держит проект seed, как воронка не из настройки.
      const dealGroup = await h.owner
        .selectFrom('field_group')
        .select('id')
        .where('project_id', '=', alpi)
        .where('entity', '=', 'deal')
        .executeTakeFirstOrThrow()
      const handField = await h.owner
        .insertInto('field_definition')
        .values({
          project_id: alpi,
          entity: 'deal',
          group_id: dealGroup.id,
          code: 'ruchne_pole',
          name_uk: 'Ручне поле',
          type: 'text',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      expect(await runSeed(deps, ['--reset'])).toBe(0)
      expect(await projectId('alpi')).toBe(alpi)
      await h.owner.deleteFrom('field_definition').where('id', '=', handField.id).execute()
      // Поля стартовой настройки со значениями (first_value_at) уходят вместе с проектом.
      expect(
        await h.owner
          .selectFrom('field_definition')
          .select('id')
          .where('project_id', '=', alpi)
          .where('first_value_at', 'is not', null)
          .execute(),
      ).not.toEqual([])
      expect(await runSeed(deps, ['--reset'])).toBe(0)
      expect(await projectId('alpi')).toBeUndefined()
      for (const table of ['field_group', 'field_definition', 'field_option'] as const) {
        expect(await h.owner.selectFrom(table).select('id').execute(), table).toEqual([])
      }
      expect(await projectId('franch')).toBeUndefined()
      expect(await projectId('hand-made')).toBe(other.id)
      expect(
        await h.owner.selectFrom('user').select('id').where('email', 'like', 'seed.%').execute(),
      ).toEqual([])
      expect(existsSync(credentialsFile)).toBe(false)

      // После --reset seed создаёт всё заново.
      expect(await runSeed(deps, SCALE)).toBe(0)
      expect(
        await h.owner
          .selectFrom('deal')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('project_id', '=', (await projectId('alpi')) ?? '')
          .executeTakeFirstOrThrow(),
      ).toEqual({ n: '500' })
    },
    SLOW,
  )

  it(
    '--reset оставляет сделку seed, в которую слили ручную сделку, — сброс проекта не срывается',
    async () => {
      const alpi = await projectId('alpi')
      if (!alpi) throw new Error('нет проекта')
      const survivor = await h.owner
        .selectFrom('deal as d')
        .innerJoin('external_link as l', (join) =>
          join.on('l.entity_type', '=', 'deal').on(sql<SqlBool>`l.entity_id = d.id::text`),
        )
        .select(['d.id', 'd.pipeline_id', 'd.stage_id', 'd.primary_contact_id'])
        .where('d.project_id', '=', alpi)
        .orderBy('d.id')
        .executeTakeFirstOrThrow()
      const handContact = await h.owner
        .insertInto('contact')
        .values({ project_id: alpi, first_name: 'Злитий' })
        .returning('id')
        .executeTakeFirstOrThrow()
      // Ручная сделка, слитая в сделку seed (тикет crm-intake/02): скрыта, ссылается на неё.
      const hidden = await h.owner
        .insertInto('deal')
        .values({
          project_id: alpi,
          title: 'Ручна злита',
          pipeline_id: survivor.pipeline_id,
          stage_id: survivor.stage_id,
          primary_contact_id: handContact.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      await h.owner
        .updateTable('deal')
        .set({ merged_into_id: survivor.id, merged_at: new Date() })
        .where('id', '=', hidden.id)
        .execute()

      const log: string[] = []
      const loud = { log: (m: string) => log.push(m), error: (m: string) => log.push(m) }
      expect(await runSeed({ ...deps, out: loud }, ['--reset'])).toBe(0)

      expect(await projectId('alpi')).toBe(alpi)
      const deals = await h.owner
        .selectFrom('deal')
        .select(['id', 'merged_into_id'])
        .where('project_id', '=', alpi)
        .execute()
      expect(deals).toHaveLength(2)
      expect(deals).toEqual(
        expect.arrayContaining([
          { id: survivor.id, merged_into_id: null },
          { id: hidden.id, merged_into_id: survivor.id },
        ]),
      )
      expect(log.join('\n')).toMatch(/Оставлены записи seed[^\n]*сделок 1/)
    },
    SLOW,
  )
})
