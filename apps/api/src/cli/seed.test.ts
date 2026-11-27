import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createProject, PROJECT_PRESETS } from '@alpi/db'
import {
  type FieldType,
  INTAKE_KEY_PREFIX,
  normalizeFieldValue,
  normalizePhone,
} from '@alpi/shared'
import { type SqlBool, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DUPLICATE_REASONS } from '../duplicates/finder.ts'
import { hashIntakeKey } from '../intake/key.ts'
import { buildSeedPlan, FRANCH_PRICED_FROM_STAGE } from '../seed/plan.ts'
import { SEED_SOURCE } from '../seed/store.ts'
import { readCredentials, readSourceKeys } from '../seed/users.ts'
import { type ApiHarness, ORIGIN, startApiHarness } from '../testing/api-harness.ts'
import { totp } from '../testing/totp.ts'
import { refusal, runSeed, type SeedDeps } from './seed.ts'

// `pnpm seed` (тикет crm-deals/10): тестовые данные на уменьшенном объёме (1/10) — числа,
// правила базы, повторный запуск, --reset, отказ на проде и чтение созданного через API под
// менеджером. Данные эпика crm-intake (тикет crm-intake/10): источники, регистрации, журнал
// входящих, дубли каждого правила и слияния; экран «Дублі» и откат — через API под
// администратором seed.

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
      appDatabaseUrl: h.appUrl,
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
    'intake_source',
    'registration',
    'intake_event',
    'inbound_request',
    'merge_record',
    'merge_moved_item',
    'duplicate_pair',
    'not_duplicate',
  ] as const

  /** Вывод первого запуска seed: команды и консоли процесса (журнал сервера). */
  const firstRunOutput: string[] = []

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

  /** id записей `table` проекта, созданных по плану людей и сделок (ключи `contact-…`, `deal-…`). */
  async function plannedIds(table: 'contact' | 'deal', project: string) {
    const rows = await h.owner
      .selectFrom('external_link')
      .select('entity_id')
      .where('project_id', '=', project)
      .where('source', '=', SEED_SOURCE)
      .where('entity_type', '=', table)
      .where('external_id', 'like', `${table}-%`)
      .execute()
    return new Set(rows.map((r) => r.entity_id))
  }

  /** Вход пользователем seed роли `role` паролем и кодом 2FA из файла учётных данных. */
  async function signInSeed(role: 'admin' | 'manager') {
    const credential = (await readCredentials(credentialsFile)).find((c) => c.role === role)
    if (!credential) throw new Error(`нет пользователя ${role}`)
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
    return { browser, email: credential.email }
  }

  it('план детерминирован: то же зерно — те же люди и сделки', () => {
    const now = new Date('2026-11-23T12:00:00Z')
    const a = buildSeedPlan({ scale: 0.05, now })
    const b = buildSeedPlan({ scale: 0.05, now })
    expect(b).toEqual(a)
    expect(buildSeedPlan({ scale: 0.05, now, seed: 1 }).projects[0]?.contacts).not.toEqual(
      a.projects[0]?.contacts,
    )
    // Данные приёма — тоже от зерна: другое зерно — другие регистрации.
    expect(a.projects[0]?.intake.registrations.length).toBeGreaterThan(0)
    expect(buildSeedPlan({ scale: 0.05, now, seed: 1 }).projects[0]?.intake).not.toEqual(
      a.projects[0]?.intake,
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
      // Вывод команды и консоль процесса — для проверки, что ключи источников туда не попали.
      const out = {
        log: (m: string) => firstRunOutput.push(m),
        error: (m: string) => firstRunOutput.push(m),
      }
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          firstRunOutput.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' '))
        }),
      )
      try {
        expect(await runSeed({ ...deps, out }, SCALE)).toBe(0)
      } finally {
        for (const spy of spies) spy.mockRestore()
      }
      const alpi = await projectId('alpi')
      const franch = await projectId('franch')
      if (!alpi || !franch) throw new Error('проекты не созданы')
      // Люди и сделки плана; готовые дубли и журнал входящих добавляют своих — они ниже.
      const planned = new Set([
        ...(await plannedIds('deal', alpi)),
        ...(await plannedIds('deal', franch)),
      ])

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
        .then((rows) => rows.filter((d) => planned.has(d.id)))
      const alpiDeals = deals.filter((d) => d.pipeline !== 'franch')
      expect((await plannedIds('contact', alpi)).size).toBe(400)
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
          and merged_into_id is null
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

    // Тестовые номера: +380 70 (код абонентам не выдан) и для правила «имя и последние 9 цифр» —
    // польский +48 70x (платные услуги, не абонентский).
    const phones = await h.owner.selectFrom('contact_phone').select('phone').execute()
    expect(phones.filter((p) => !/^\+(38070\d{7}|4870\d{7})$/.test(p.phone))).toEqual([])
    expect(phones.filter((p) => normalizePhone(p.phone) !== p.phone)).toEqual([])
  })

  it(
    'источники, регистрации, журнал входящих, дубли каждого правила и слияния всех видов — в каждом проекте',
    async () => {
      const keys = await readSourceKeys(credentialsFile)
      const now = Date.now()
      for (const code of ['alpi', 'franch']) {
        const pid = await projectId(code)
        if (!pid) throw new Error('нет проекта')

        // Источники: «Вебінар», «Консультація», «Лендінг курсу» и один отключённый, у каждого —
        // воронка своего проекта; ключ — в файле учётных данных, в базе — его отпечаток.
        const { rows: sources } = await sql<{
          id: string
          name: string
          disabled_at: Date | null
          key_hash: string
          pipeline_project: string
        }>`
          select s.id, s.name, s.disabled_at, s.key_hash, p.project_id as pipeline_project
          from intake_source s join pipeline p on p.id = s.pipeline_id
          where s.project_id = ${pid}
        `.execute(h.owner)
        expect(sources).toHaveLength(4)
        expect(sources.map((s) => s.name)).toEqual(
          expect.arrayContaining(['Вебінар', 'Консультація', 'Лендінг курсу']),
        )
        expect(sources.filter((s) => s.disabled_at !== null)).toHaveLength(1)
        expect(sources.every((s) => s.pipeline_project === pid)).toBe(true)
        for (const source of sources) {
          const known = keys.find((k) => k.sourceId === source.id)
          expect(known && hashIntakeKey(known.key)).toBe(source.key_hash)
        }

        // Регистрации: на каждую сделку плана — хотя бы одна, у части сделок — несколько; сделки
        // первого этапа и дальше; метки, идентификаторы рекламы, браузер, extra и просмотры.
        const { rows: regs } = await sql<{
          deal_id: string | null
          stage: number
          form: string | null
          webinar: string | null
          plan_name: string | null
          page_url: string | null
          utm_source: string | null
          utm_campaign: string | null
          fbclid: string | null
          gclid: string | null
          fbp: string | null
          fbc: string | null
          user_agent: string | null
          extra: Record<string, unknown>
          view_minutes: number | null
        }>`
          select r.deal_id, s.position as stage, r.form, r.webinar, r.plan_name, r.page_url,
            r.utm_source, r.utm_campaign, r.fbclid, r.gclid, r.fbp, r.fbc, r.user_agent, r.extra,
            r.view_minutes
          from registration r
          join deal d on d.id = r.deal_id
          join stage s on s.id = d.stage_id
          where r.project_id = ${pid}
        `.execute(h.owner)
        const planned = await plannedIds('deal', pid)
        expect(regs.length).toBeGreaterThan(planned.size)
        expect(new Set(regs.map((r) => r.stage)).size).toBeGreaterThan(1)
        const perDeal = new Map<string, number>()
        for (const r of regs) perDeal.set(r.deal_id ?? '', (perDeal.get(r.deal_id ?? '') ?? 0) + 1)
        expect([...perDeal.values()].some((n) => n >= 2)).toBe(true)
        for (const column of [
          'form',
          'webinar',
          'plan_name',
          'page_url',
          'utm_source',
          'utm_campaign',
          'fbclid',
          'gclid',
          'fbp',
          'fbc',
          'user_agent',
          'view_minutes',
        ] as const) {
          expect(
            regs.some((r) => r[column] !== null),
            column,
          ).toBe(true)
        }
        expect(regs.some((r) => Object.keys(r.extra).length > 0)).toBe(true)

        // Журнал входящих за последние 30 дней: принятые, повторы, ошибки 400 без телефона и
        // email, просмотры без регистрации.
        const { rows: inbound } = await sql<{
          channel: string
          outcome: string
          status_code: number
          error_code: string | null
          received_at: Date
        }>`
          select channel, outcome, status_code, error_code, received_at
          from inbound_request where project_id = ${pid}
        `.execute(h.owner)
        const outcomes = (outcome: string) => inbound.filter((r) => r.outcome === outcome)
        expect(outcomes('accepted').length).toBeGreaterThan(0)
        expect(outcomes('repeat').length).toBeGreaterThan(0)
        expect(outcomes('error').length).toBeGreaterThan(0)
        expect(
          outcomes('error').every(
            (r) => r.status_code === 400 && r.error_code === 'CONTACT_KEYS_REQUIRED',
          ),
        ).toBe(true)
        expect(outcomes('unmatched').length).toBeGreaterThan(0)
        expect(outcomes('unmatched').every((r) => r.channel === 'intake.webinar_view')).toBe(true)
        const times = inbound.map((r) => new Date(r.received_at).getTime())
        expect(Math.min(...times)).toBeGreaterThan(now - 30 * 86_400_000)
        expect(Math.max(...times)).toBeLessThanOrEqual(Date.now())
        expect(Math.max(...times) - Math.min(...times)).toBeGreaterThan(7 * 86_400_000)

        // Дубли: пары каждого правила тикета crm-intake/05 и одна пара с отметкой «не дубль».
        const pairs = await h.owner
          .selectFrom('duplicate_pair')
          .select('reason')
          .distinct()
          .where('project_id', '=', pid)
          .execute()
        expect(pairs.map((p) => p.reason).sort()).toEqual([...DUPLICATE_REASONS].sort())
        const marks = await h.owner
          .selectFrom('not_duplicate')
          .select('entity_type')
          .where('project_id', '=', pid)
          .execute()
        expect(marks).toEqual([{ entity_type: 'contact' }])

        // Слияния контактов: свежие (откат доступен) и старше 30 дней (недоступен); в одно
        // вложено слияние сделок.
        const merges = await h.owner
          .selectFrom('merge_record')
          .select(['id', 'entity_type', 'parent_id', 'merged_at', 'undo_until', 'undone_at'])
          .where('project_id', '=', pid)
          .execute()
        const top = merges.filter((m) => m.entity_type === 'contact' && m.parent_id === null)
        const fresh = top.filter((m) => new Date(m.undo_until).getTime() > now)
        const old = top.filter(
          (m) =>
            new Date(m.undo_until).getTime() < now &&
            new Date(m.merged_at).getTime() < now - 30 * 86_400_000,
        )
        expect(fresh.length).toBeGreaterThanOrEqual(2)
        expect(old.length).toBeGreaterThanOrEqual(1)
        expect(top.every((m) => m.undone_at === null)).toBe(true)
        const nested = merges.filter((m) => m.entity_type === 'deal' && m.parent_id !== null)
        expect(nested.length).toBeGreaterThanOrEqual(1)
        expect(nested.every((m) => fresh.some((f) => f.id === m.parent_id))).toBe(true)
      }
    },
    SLOW,
  )

  it('изоляция: источники, регистрации, журнал, дубли и слияния ссылаются только на свой проект', async () => {
    const { rows } = await sql<{ name: string; n: number }>`
      select 'регистрация - сделка' as name, count(*)::int as n
        from registration r join deal d on d.id = r.deal_id where d.project_id <> r.project_id
      union all select 'регистрация - контакт', count(*)::int
        from registration r join contact c on c.id = r.contact_id where c.project_id <> r.project_id
      union all select 'регистрация - источник', count(*)::int
        from registration r join intake_source s on s.id = r.intake_source_id
        where s.project_id <> r.project_id
      union all select 'источник - воронка', count(*)::int
        from intake_source s join pipeline p on p.id = s.pipeline_id where p.project_id <> s.project_id
      union all select 'событие приёма - источник', count(*)::int
        from intake_event e join intake_source s on s.id = e.intake_source_id
        where s.project_id <> e.project_id
      union all select 'журнал - источник', count(*)::int
        from inbound_request i join intake_source s on s.id = i.intake_source_id
        where s.project_id <> i.project_id
      union all select 'журнал - регистрация', count(*)::int
        from inbound_request i join registration r on r.id::text = i.result->>'registration_id'
        where r.project_id <> i.project_id
      union all select 'пара контактов', count(*)::int
        from duplicate_pair p join contact c on c.id in (p.a_id, p.b_id)
        where p.entity_type = 'contact' and c.project_id <> p.project_id
      union all select 'пара сделок', count(*)::int
        from duplicate_pair p join deal d on d.id in (p.a_id, p.b_id)
        where p.entity_type = 'deal' and d.project_id <> p.project_id
      union all select 'не дубль', count(*)::int
        from not_duplicate p join contact c on c.id in (p.a_id, p.b_id) where c.project_id <> p.project_id
      union all select 'слияние контактов', count(*)::int
        from merge_record m join contact c on c.id in (m.survivor_id, m.merged_id)
        where m.entity_type = 'contact' and c.project_id <> m.project_id
      union all select 'слияние сделок', count(*)::int
        from merge_record m join deal d on d.id in (m.survivor_id, m.merged_id)
        where m.entity_type = 'deal' and d.project_id <> m.project_id
    `.execute(h.owner)
    expect(rows).toHaveLength(12)
    expect(rows.filter((r) => r.n !== 0)).toEqual([])
    // Сравнение выше не пустое: пары, слияния и регистрации нашли свои записи.
    const { rows: found } = await sql<{ pairs: number; merges: number; regs: number }>`
      select
        (select count(*)::int from duplicate_pair p join contact c on c.id = p.a_id) as pairs,
        (select count(*)::int from merge_record m join contact c on c.id = m.merged_id) as merges,
        (select count(*)::int from registration r join deal d on d.id = r.deal_id) as regs
    `.execute(h.owner)
    expect(found[0]?.pairs).toBeGreaterThan(0)
    expect(found[0]?.merges).toBeGreaterThan(0)
    expect(found[0]?.regs).toBeGreaterThan(0)
  })

  it('ключи источников — только в файле учётных данных: не в выводе команды и не в консоли процесса', async () => {
    const keys = await readSourceKeys(credentialsFile)
    expect(keys).toHaveLength(8)
    const output = firstRunOutput.join('\n')
    expect(output).toContain('Ключи источников регистраций')
    expect(output).not.toContain(INTAKE_KEY_PREFIX)
    for (const { key } of keys) expect(output).not.toContain(key.slice(INTAKE_KEY_PREFIX.length))
  })

  it(
    'повторный запуск не меняет числа записей',
    async () => {
      const before = await counts()
      const keys = await readSourceKeys(credentialsFile)
      expect(await runSeed(deps, SCALE)).toBe(0)
      expect(await counts()).toEqual(before)
      expect(await readSourceKeys(credentialsFile)).toEqual(keys)
    },
    SLOW,
  )

  it(
    'экран «Дублі» на данных seed показывает группы каждого правила; свежее слияние откатывается, старое — нет',
    async () => {
      const alpi = await projectId('alpi')
      if (!alpi) throw new Error('нет проекта')
      const { browser } = await signInSeed('admin')
      type Group = { reasons: string[]; recordIds: string[] }
      const groups = async (type: 'contact' | 'deal') => {
        const all: Group[] = []
        let cursor: string | null = null
        do {
          const query: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`
          const res = await browser.api('GET', `/v1/duplicates?type=${type}&limit=200${query}`, {
            project: alpi,
          })
          expect(res.status).toBe(200)
          const body = (await res.json()) as { data: Group[]; next_cursor: string | null }
          all.push(...body.data)
          cursor = body.next_cursor
        } while (cursor !== null)
        return all
      }
      const contactGroups = await groups('contact')
      const reasons = new Set(contactGroups.flatMap((g) => g.reasons))
      for (const reason of ['phone', 'email', 'mark', 'name_phone']) {
        expect([...reasons]).toContain(reason)
      }
      expect(contactGroups.some((g) => g.recordIds.length === 3)).toBe(true)
      const dealGroups = await groups('deal')
      expect(dealGroups.length).toBeGreaterThan(0)
      expect(dealGroups.every((g) => g.reasons.includes('open_deals'))).toBe(true)
      // Пара с отметкой «не дубль» на экране не предлагается.
      const marked = await h.owner
        .selectFrom('not_duplicate')
        .select(['a_id', 'b_id'])
        .where('project_id', '=', alpi)
        .executeTakeFirstOrThrow()
      expect(
        contactGroups.some(
          (g) => g.recordIds.includes(marked.a_id) && g.recordIds.includes(marked.b_id),
        ),
      ).toBe(false)

      const merges = await h.owner
        .selectFrom('merge_record')
        .select(['id', 'undo_until'])
        .where('project_id', '=', alpi)
        .where('entity_type', '=', 'contact')
        .where('parent_id', 'is', null)
        .orderBy('merged_at')
        .execute()
      const old = merges.find((m) => new Date(m.undo_until).getTime() < Date.now())
      const fresh = merges.find((m) => new Date(m.undo_until).getTime() > Date.now())
      if (!old || !fresh) throw new Error('нет свежего или старого слияния')
      const undo = (id: string) => browser.api('POST', `/v1/merges/${id}/undo`, { project: alpi })
      const refused = await undo(old.id)
      expect(refused.status).toBe(409)
      expect(await refused.json()).toMatchObject({ code: 'MERGE_UNDO_EXPIRED' })
      const undone = await undo(fresh.id)
      expect(undone.status).toBe(200)
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
          and external_id like 'deal-%'
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
      expect((await plannedIds('deal', (await projectId('alpi')) ?? '')).size).toBe(500)
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

  it(
    '--reset оставляет контакт seed, в который слили ручной контакт, — сброс проекта не срывается',
    async () => {
      const alpi = await projectId('alpi')
      if (!alpi) throw new Error('нет проекта')
      // Прошлые сбросы уже удалили свободные контакты seed: два контакта с меткой seed — здесь.
      const seedContact = async (name: string) => {
        const row = await h.owner
          .insertInto('contact')
          .values({ project_id: alpi, first_name: name })
          .returning('id')
          .executeTakeFirstOrThrow()
        await h.owner
          .insertInto('external_link')
          .values({
            project_id: alpi,
            entity_type: 'contact',
            entity_id: row.id,
            source: SEED_SOURCE,
            external_id: `merge-test-${row.id}`,
          })
          .execute()
        return row
      }
      const survivor = await seedContact('Демо, у якого злиття')
      // Контрольный: такой же контакт seed без слияния сброс удаляет.
      const free = await seedContact('Демо без злиття')
      // Ручной контакт, слитый в контакт seed (тикет crm-intake/01): скрыт, ссылается на него.
      const hidden = await h.owner
        .insertInto('contact')
        .values({ project_id: alpi, first_name: 'Злитий руками' })
        .returning('id')
        .executeTakeFirstOrThrow()
      await h.owner
        .updateTable('contact')
        .set({ merged_into_id: survivor.id, merged_at: new Date() })
        .where('id', '=', hidden.id)
        .execute()

      const log: string[] = []
      const loud = { log: (m: string) => log.push(m), error: (m: string) => log.push(m) }
      expect(await runSeed({ ...deps, out: loud }, ['--reset'])).toBe(0)

      expect(await projectId('alpi')).toBe(alpi)
      const contacts = await h.owner
        .selectFrom('contact')
        .select(['id', 'merged_into_id'])
        .where('id', 'in', [survivor.id, hidden.id])
        .execute()
      expect(contacts).toEqual(
        expect.arrayContaining([
          { id: survivor.id, merged_into_id: null },
          { id: hidden.id, merged_into_id: survivor.id },
        ]),
      )
      expect(contacts).toHaveLength(2)
      expect(
        await h.owner.selectFrom('contact').select('id').where('id', '=', free.id).execute(),
      ).toEqual([])
      expect(log.join('\n')).toMatch(/Оставлены записи seed[^\n]*контактов [1-9]/)
    },
    SLOW,
  )
})
