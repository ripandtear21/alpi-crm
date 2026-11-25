import { type FieldPreset, PROJECT_PRESETS, type PresetKey } from '@alpi/db'
import type { ProductCurrency } from '@alpi/shared'
import {
  BUSINESS_KINDS,
  BUSINESS_NAMES,
  CITIES,
  FIRST_NAMES,
  LAST_NAMES,
  PARTICIPANT_ROLES,
} from './names.ts'
import { createRandom, type Random } from './random.ts'

// Что создаёт pnpm seed (тикет crm-deals/10) — чистая функция от зерна, масштаба и «сейчас»:
// одно зерно — те же люди, этапы и суммы. Записи названы ключами (`contact-0001`), id им даёт
// запись в базу (store.ts), и по ключам же повторный запуск находит уже созданное.
//
// Распределение — по docs/research/our-pipedrive.md, раздел 1, сжатое: в Pipedrive на «Новий
// лід» 84 тыс. сделок из 86, здесь — большинство, но не все, чтобы остальные этапы не пустовали.
//
// Стартовые поля ALPI (тикет crm-fields/08) заполнены выдуманными значениями у части сделок
// (alpiCustom); поля, обязательные по правилу «з етапу X» / при выигрыше, — у сделок, которые
// до этого этапа дошли или выиграны.

/** Зерно по умолчанию: менять — значит получить других людей при следующем запуске. */
export const DEFAULT_SEED = 20261123

/** Объём при масштабе 1. */
export const FULL_VOLUME = { alpiContacts: 4000, alpiDeals: 5000, franchDeals: 300 } as const

export type UserRole = 'admin' | 'teamlead' | 'manager'

export interface PlannedUser {
  key: string
  email: string
  name: string
  role: UserRole
}

export interface PlannedTeam {
  key: string
  name: string
  leadKey: string
  memberKeys: string[]
}

export interface PlannedProduct {
  key: string
  name: string
  prices: Record<ProductCurrency, number>
}

export interface PlannedOrganization {
  key: string
  name: string
  address: string
  website: string | null
}

export interface PlannedContact {
  key: string
  firstName: string
  lastName: string
  language: 'uk' | 'ru' | null
  organizationKey: string | null
  phone: string
  email: string | null
}

export type DealStatus = 'open' | 'won' | 'lost'

export interface PlannedDeal {
  key: string
  title: string
  pipelineCode: string
  /** Номер этапа в воронке по порядку (с 0). */
  stageIndex: number
  status: DealStatus
  /** Номер причины проигрыша по порядку справочника проекта (группы, затем причины). */
  lostReasonIndex: number | null
  amount: number
  currency: ProductCurrency
  /** Ключ пользователя; null — общая очередь. */
  ownerKey: string | null
  contactKey: string
  organizationKey: string | null
  createdAt: Date
  stageChangedAt: Date
  closedAt: Date | null
  archived: boolean
  lines: { productKey: string; quantity: number; unitPrice: number }[]
  participants: { contactKey: string; role: string }[]
  /** Значения пользовательских полей по коду (стартовые поля проекта); пусто — не заполнены. */
  custom: Record<string, PlannedFieldValue>
}

/**
 * Значение пользовательского поля в плане: id варианта и пользователя появляются только в
 * базе, поэтому вариант — по названию, пользователь — по ключу плана (store.ts переводит в id и
 * проверяет packages/shared/src/fields/values.ts).
 */
export type PlannedFieldValue =
  | { kind: 'value'; value: string | number | boolean | { from: string; to: string } }
  | { kind: 'option'; name: string }
  | { kind: 'user'; userKey: string }

export interface ProjectPlan {
  code: string
  name: string
  preset: PresetKey
  /** Участники проекта, кроме администратора: ключ пользователя и шаблон роли. */
  members: { userKey: string; role: Exclude<UserRole, 'admin'> }[]
  teams: PlannedTeam[]
  products: PlannedProduct[]
  organizations: PlannedOrganization[]
  contacts: PlannedContact[]
  deals: PlannedDeal[]
}

export interface SeedPlan {
  users: PlannedUser[]
  adminKey: string
  projects: ProjectPlan[]
}

export interface PlanOptions {
  seed?: number
  /** Доля полного объёма: 0.1 — десятая часть контактов и сделок. Менеджеров всегда 10. */
  scale?: number
  now?: Date | undefined
}

const DAY = 86_400_000

/** Телефон из диапазона +380 70: код 70 абонентам в Украине не выдан. Номер `n` — от 1. */
function phoneOf(n: number): string {
  return `+38070${String(n).padStart(7, '0')}`
}

function pad(n: number, width = 4): string {
  return String(n).padStart(width, '0')
}

export function buildSeedPlan(options: PlanOptions = {}): SeedPlan {
  const random = createRandom(options.seed ?? DEFAULT_SEED)
  const scale = options.scale ?? 1
  const now = options.now ?? new Date()
  const count = (full: number) => Math.max(1, Math.round(full * scale))

  const adminKey = 'admin'
  const users: PlannedUser[] = [
    {
      key: adminKey,
      email: 'seed.admin@example.com',
      name: 'Адміністратор (тестовий)',
      role: 'admin',
    },
  ]
  for (let i = 1; i <= 10; i++) {
    const [first] = random.pick(FIRST_NAMES)
    const [last] = random.pick(LAST_NAMES)
    users.push({
      key: `manager-${pad(i, 2)}`,
      email: `seed.manager${pad(i, 2)}@example.com`,
      name: `${first} ${last}`,
      // Первый из каждой пятёрки — тимлид своей команды.
      role: i === 1 || i === 6 ? 'teamlead' : 'manager',
    })
  }
  const managers = users.filter((u) => u.role !== 'admin')
  const teams: PlannedTeam[] = [0, 1].map((t) => {
    const five = managers.slice(t * 5, t * 5 + 5).map((u) => u.key)
    return {
      key: `team-${t + 1}`,
      name: `Команда ${t + 1}`,
      leadKey: five[0] ?? '',
      memberKeys: five,
    }
  })

  const alpi = alpiPlan(random, {
    contacts: count(FULL_VOLUME.alpiContacts),
    deals: count(FULL_VOLUME.alpiDeals),
    managerKeys: managers.map((u) => u.key),
    now,
  })
  // Значения полей — своим генератором: люди, этапы и суммы при том же зерне не меняются.
  const fieldRandom = createRandom((options.seed ?? DEFAULT_SEED) + FIELD_SEED_OFFSET)
  const managerKeys = managers.map((u) => u.key)
  for (const deal of alpi.deals) deal.custom = alpiCustom(fieldRandom, deal, managerKeys)
  alpi.members = managers.map((u) => ({
    userKey: u.key,
    role: u.role === 'teamlead' ? 'teamlead' : 'manager',
  }))
  alpi.teams = teams

  // «Франч» ведут три менеджера ALPI (по одному из команды и ещё один) с ролью «менеджер».
  const franchManagers = ['manager-02', 'manager-03', 'manager-07']
  const franch = franchPlan(random, {
    deals: count(FULL_VOLUME.franchDeals),
    managerKeys: franchManagers,
    now,
  })
  franch.members = franchManagers.map((userKey) => ({ userKey, role: 'manager' }))

  return { users, adminKey, projects: [alpi, franch] }
}

interface DealDates {
  createdAt: Date
  stageChangedAt: Date
  closedAt: Date | null
}

function dealDates(random: Random, now: Date, status: DealStatus, maxDaysAgo: number): DealDates {
  const createdAt = new Date(now.getTime() - random.int(1, maxDaysAgo) * DAY - random.int(0, DAY))
  const span = now.getTime() - createdAt.getTime()
  const stageChangedAt = new Date(createdAt.getTime() + Math.floor(random.next() * span))
  return { createdAt, stageChangedAt, closedAt: status === 'open' ? null : stageChangedAt }
}

function person(random: Random) {
  const [firstName, firstLatin] = random.pick(FIRST_NAMES)
  const [lastName, lastLatin] = random.pick(LAST_NAMES)
  return { firstName, lastName, latin: `${firstLatin}.${lastLatin}` }
}

/** Сумма в валюте сделки: в основном евро, иногда гривна или доллар. */
function pickCurrency(random: Random): ProductCurrency {
  return (['EUR', 'UAH', 'USD'] as const)[random.weighted([85, 10, 5])] ?? 'EUR'
}

const ALPI_PRODUCTS: PlannedProduct[] = [
  { key: 'alpi-booking', name: 'Бронювання місця', prices: { EUR: 100, UAH: 4400, USD: 110 } },
  {
    key: 'alpi-course-basic',
    name: 'Курс «AI-контент»: Базовий',
    prices: { EUR: 790, UAH: 34900, USD: 850 },
  },
  {
    key: 'alpi-course-pro',
    name: 'Курс «AI-контент»: Профі',
    prices: { EUR: 1490, UAH: 65900, USD: 1590 },
  },
  {
    key: 'alpi-course-vip',
    name: 'Курс «AI-контент»: VIP',
    prices: { EUR: 2490, UAH: 109900, USD: 2690 },
  },
  {
    key: 'alpi-platform-start',
    name: 'Платформа: пакет Start',
    prices: { EUR: 290, UAH: 12900, USD: 310 },
  },
  {
    key: 'alpi-platform-pro',
    name: 'Платформа: пакет Pro',
    prices: { EUR: 590, UAH: 25900, USD: 630 },
  },
]

const COURSES = ['alpi-course-basic', 'alpi-course-pro', 'alpi-course-vip']
const PLATFORM_PACKAGES = ['alpi-platform-start', 'alpi-platform-pro']

/** Сумма и строки сделки на товаре `productKey`; строки — у части сделок. */
function priced(
  random: Random,
  products: PlannedProduct[],
  productKey: string,
  currency: ProductCurrency,
  linesChance: number,
): Pick<PlannedDeal, 'amount' | 'lines'> {
  const product = products.find((p) => p.key === productKey)
  if (!product) throw new Error(`нет товара ${productKey}`)
  const unitPrice = product.prices[currency]
  return {
    amount: unitPrice,
    lines: random.chance(linesChance) ? [{ productKey, quantity: 1, unitPrice }] : [],
  }
}

// Этапы воронки ALPI по порядку (packages/db/src/presets/project-preset.ts).
const ALPI_BOOKING = 6
const ALPI_INVOICE = 7
/** Веса этапов открытых сделок ALPI: «Новий лід» … «Відкладений попит». */
const ALPI_OPEN_WEIGHTS = [80, 1, 6, 4, 1, 3, 2, 1, 2]
/** Где сделки ALPI проигрывают: на ранних этапах. */
const ALPI_LOST_WEIGHTS = [45, 5, 15, 15, 5, 10, 3, 2, 0]
/** «Платформа (допродаж)»: Новий лід (Д) … Відкладений попит (Д). */
const PLATFORM_OPEN_WEIGHTS = [425, 40, 150, 90, 15, 10, 160]
const PLATFORM_BOOKING = 4
const PLATFORM_INVOICE = 5
const AUTOWEBINAR_STAGES = 10
/** Причин проигрыша в настройке ALPI: «Якість ліда» (12) и «Інше» (1). */
const ALPI_LOST_REASONS = 13

function alpiPlan(
  random: Random,
  volume: { contacts: number; deals: number; managerKeys: string[]; now: Date },
): ProjectPlan {
  const { now, managerKeys } = volume
  const contacts: PlannedContact[] = []
  for (let i = 1; i <= volume.contacts; i++) {
    const p = person(random)
    contacts.push({
      key: `contact-${pad(i)}`,
      firstName: p.firstName,
      lastName: p.lastName,
      language: ([null, 'uk', 'ru'] as const)[random.weighted([10, 70, 20])] ?? null,
      organizationKey: null,
      phone: phoneOf(i),
      email: random.chance(0.75) ? `${p.latin}.${i}@example.com` : null,
    })
  }
  const contactAt = (i: number) => {
    const contact = contacts[i % contacts.length]
    if (!contact) throw new Error('контактов нет')
    return contact
  }
  const fullName = (c: PlannedContact) => `${c.firstName} ${c.lastName}`

  const deals: PlannedDeal[] = []
  const autowebinarCount = Math.round(volume.deals * 0.01)
  const upsellTarget = Math.round(volume.deals * 0.05)
  const mainCount = volume.deals - autowebinarCount - upsellTarget
  /** Контакты с выигранной сделкой ALPI и её ответственный — для воронки допродаж. */
  const wonContacts = new Map<string, string | null>()

  for (let i = 0; i < mainCount; i++) {
    const contact = contactAt(i)
    // Первая сделка контакта — любая; повторные (регистрация ещё раз) — только закрытые, иначе
    // у человека было бы две открытые сделки в воронке.
    const first = i < contacts.length
    const status: DealStatus = first
      ? ((['open', 'won', 'lost'] as const)[random.weighted([84, 6, 10])] ?? 'open')
      : random.chance(0.2)
        ? 'won'
        : 'lost'
    const stageIndex =
      status === 'won'
        ? ALPI_INVOICE
        : status === 'lost'
          ? random.weighted(ALPI_LOST_WEIGHTS)
          : random.weighted(ALPI_OPEN_WEIGHTS)
    const queue = status === 'open' && random.chance(stageIndex === 0 ? 0.25 : 0.03)
    const ownerKey = queue ? null : random.pick(managerKeys)
    const currency = pickCurrency(random)
    const money =
      status === 'won' || (status === 'open' && stageIndex === ALPI_INVOICE)
        ? priced(random, ALPI_PRODUCTS, random.pick(COURSES), currency, 0.6)
        : status === 'open' && stageIndex === ALPI_BOOKING
          ? priced(random, ALPI_PRODUCTS, 'alpi-booking', currency, 0.6)
          : { amount: 0, lines: [] }
    deals.push({
      key: `deal-${pad(deals.length + 1)}`,
      title: `${fullName(contact)} — вебінар`,
      pipelineCode: 'alpi',
      stageIndex,
      status,
      lostReasonIndex: status === 'lost' ? random.int(0, ALPI_LOST_REASONS - 1) : null,
      ...money,
      currency: money.amount === 0 ? 'EUR' : currency,
      ownerKey,
      contactKey: contact.key,
      organizationKey: null,
      ...dealDates(random, now, status, 365),
      archived: random.chance(0.04),
      participants: [],
      custom: {},
    })
    if (status === 'won' && !wonContacts.has(contact.key)) wonContacts.set(contact.key, ownerKey)
  }

  // Допродажи — только тем, кто уже купил: у контакта есть выигранная сделка ALPI.
  for (const [contactKey, wonOwner] of [...wonContacts].slice(0, upsellTarget)) {
    const contact = contacts.find((c) => c.key === contactKey)
    if (!contact) continue
    const status: DealStatus =
      (['open', 'won', 'lost'] as const)[random.weighted([70, 15, 15])] ?? 'open'
    const stageIndex =
      status === 'won'
        ? PLATFORM_INVOICE
        : status === 'lost'
          ? random.int(0, 3)
          : random.weighted(PLATFORM_OPEN_WEIGHTS)
    const ownerKey = status === 'open' && random.chance(0.05) ? null : wonOwner
    const currency = pickCurrency(random)
    const money =
      status === 'won' ||
      (status === 'open' && (stageIndex === PLATFORM_BOOKING || stageIndex === PLATFORM_INVOICE))
        ? priced(random, ALPI_PRODUCTS, random.pick(PLATFORM_PACKAGES), currency, 0.6)
        : { amount: 0, lines: [] }
    deals.push({
      key: `deal-${pad(deals.length + 1)}`,
      title: `${fullName(contact)} — платформа`,
      pipelineCode: 'platform',
      stageIndex,
      status,
      lostReasonIndex: status === 'lost' ? random.int(0, ALPI_LOST_REASONS - 1) : null,
      ...money,
      currency: money.amount === 0 ? 'EUR' : currency,
      ownerKey,
      contactKey: contact.key,
      organizationKey: null,
      ...dealDates(random, now, status, 120),
      archived: false,
      participants: [],
      custom: {},
    })
  }

  // Автовебінари — почти пустая воронка: немного открытых сделок у последних контактов.
  for (let i = 0; i < autowebinarCount; i++) {
    const contact = contactAt(contacts.length - 1 - i)
    deals.push({
      key: `deal-${pad(deals.length + 1)}`,
      title: `${fullName(contact)} — автовебінар`,
      pipelineCode: 'autowebinars',
      stageIndex: random.int(0, AUTOWEBINAR_STAGES - 1),
      status: 'open',
      lostReasonIndex: null,
      amount: 0,
      lines: [],
      currency: 'EUR',
      ownerKey: random.chance(0.3) ? null : random.pick(managerKeys),
      contactKey: contact.key,
      organizationKey: null,
      ...dealDates(random, now, 'open', 60),
      archived: false,
      participants: [],
      custom: {},
    })
  }

  return {
    code: 'alpi',
    name: 'ALPI',
    preset: 'alpi',
    members: [],
    teams: [],
    products: ALPI_PRODUCTS,
    organizations: [],
    contacts,
    deals,
  }
}

/** Сдвиг зерна генератора значений полей. */
const FIELD_SEED_OFFSET = 8
/** Доля сделок на первом этапе (лид ещё не обработан) с заполненными полями. */
const UNTOUCHED_FILLED = 0.1
/** Вероятность, что необязательное поле обработанной сделки заполнено. */
const OPTIONAL_FILLED = 0.4
/** Выдуманные профессии для «Професія клієнта». */
const PROFESSIONS = [
  'Бухгалтер',
  'Вчитель',
  'Дизайнер',
  'Маркетолог',
  'Продавець',
  'Інженер',
  'Перекладач',
  'Фотограф',
  'Психолог',
  'Кондитер',
]
/** «Тип закриття» — процент из набора Pipedrive. */
const CLOSING_PERCENTS = [0, 5, 8, 10, 15]

const isoDay = (date: Date) => date.toISOString().slice(0, 10)

/**
 * Значения стартовых полей ALPI для сделки `deal`: поля, видимые в её воронке. Обязательное по
 * правилу (сделка выиграна или дошла до этапа правила) заполнено всегда, остальные — у части
 * обработанных сделок; на первом этапе поля заполнены у немногих.
 */
export function alpiCustom(
  random: Random,
  deal: PlannedDeal,
  managerKeys: readonly string[],
): Record<string, PlannedFieldValue> {
  const preset = PROJECT_PRESETS.alpi
  const stages = preset.pipelines.find((p) => p.code === deal.pipelineCode)?.stages ?? []
  const untouched = deal.status === 'open' && deal.stageIndex === 0
  if (untouched && !random.chance(UNTOUCHED_FILLED)) return {}
  const custom: Record<string, PlannedFieldValue> = {}
  for (const field of preset.fields) {
    if (field.entity !== 'deal') continue
    if (field.pipelines && !field.pipelines.includes(deal.pipelineCode)) continue
    const rule = field.required?.find((r) => r.pipeline === deal.pipelineCode)
    if (!(rule && isRequired(rule.stage, stages, deal)) && !random.chance(OPTIONAL_FILLED)) {
      continue
    }
    custom[field.code] = fieldValue(random, field, deal, managerKeys)
  }
  return custom
}

/** Обязательно ли поле по правилу с этапа `stage` (null — при выигрыше). */
function isRequired(stage: string | null, stages: readonly string[], deal: PlannedDeal): boolean {
  if (deal.status === 'won') return true
  if (stage === null) return false
  const from = stages.indexOf(stage)
  if (from === -1) throw new Error(`в воронке ${deal.pipelineCode} нет этапа «${stage}»`)
  return deal.stageIndex >= from
}

function fieldValue(
  random: Random,
  field: FieldPreset,
  deal: PlannedDeal,
  managerKeys: readonly string[],
): PlannedFieldValue {
  const value = (v: string | number | boolean | { from: string; to: string }) =>
    ({ kind: 'value', value: v }) as const
  switch (field.type) {
    case 'single_option':
      return { kind: 'option', name: random.pick(field.options ?? []) }
    case 'boolean':
      return value(random.chance(0.5))
    case 'number':
      return value(
        field.code === 'typ_zakryttia' ? random.pick(CLOSING_PERCENTS) : random.int(1, 100),
      )
    case 'text':
      return value(random.pick(PROFESSIONS))
    case 'date_range':
      return value({ from: isoDay(deal.createdAt), to: isoDay(deal.stageChangedAt) })
    case 'user':
      return { kind: 'user', userKey: random.pick(managerKeys) }
    default:
      throw new Error(`seed: нет выдуманного значения для поля ${field.code} типа ${field.type}`)
  }
}

const FRANCH_PRODUCTS: PlannedProduct[] = [
  { key: 'franch-start', name: 'Пакет START 2.0', prices: { EUR: 4900, UAH: 215000, USD: 5300 } },
  { key: 'franch-pro', name: 'Пакет PRO 2.0', prices: { EUR: 9900, UAH: 435000, USD: 10700 } },
  { key: 'franch-max', name: 'Пакет MAX 2.0', prices: { EUR: 14900, UAH: 655000, USD: 16100 } },
  { key: 'franch-vip', name: 'Пакет VIP', prices: { EUR: 24900, UAH: 1095000, USD: 26900 } },
  {
    key: 'franch-lawyer',
    name: 'Консультация юриста',
    prices: { EUR: 300, UAH: 13200, USD: 330 },
  },
]
const FRANCH_PACKAGES = ['franch-start', 'franch-pro', 'franch-max', 'franch-vip']
/** «Новый лид» … «Подписание договора» (docs/research/our-pipedrive.md, раздел 1). */
const FRANCH_OPEN_WEIGHTS = [1300, 200, 240, 20, 55, 210, 100, 190, 120, 10]
/** Суммы у сделок «Франча» — с этапа «Встреча проведена». */
export const FRANCH_PRICED_FROM_STAGE = 5
const FRANCH_SIGNING = 9
const FRANCH_LOST_REASONS = 2

function franchPlan(
  random: Random,
  volume: { deals: number; managerKeys: string[]; now: Date },
): ProjectPlan {
  const { now } = volume
  const organizations: PlannedOrganization[] = []
  const orgCount = Math.max(1, Math.round(volume.deals * 0.85))
  for (let i = 1; i <= orgCount; i++) {
    const city = random.pick(CITIES)
    organizations.push({
      key: `org-${pad(i)}`,
      name: `${random.pick(BUSINESS_KINDS)} «${random.pick(BUSINESS_NAMES)}», ${city}`,
      address: `${city}, вул. Тестова, ${random.int(1, 120)}`,
      website: random.chance(0.4) ? `https://org-${pad(i)}.example.com` : null,
    })
  }

  const contacts: PlannedContact[] = []
  const newContact = (organizationKey: string) => {
    const p = person(random)
    const n = contacts.length + 1
    const contact: PlannedContact = {
      key: `contact-${pad(n)}`,
      firstName: p.firstName,
      lastName: p.lastName,
      language: random.chance(0.7) ? 'ru' : 'uk',
      organizationKey,
      // Отдельная сотня тысяч номеров: телефоны не совпадают с контактами ALPI.
      phone: phoneOf(5_000_000 + n),
      email: random.chance(0.9) ? `${p.latin}.f${n}@example.com` : null,
    }
    contacts.push(contact)
    return contact
  }

  const deals: PlannedDeal[] = []
  for (let i = 0; i < volume.deals; i++) {
    // Первые сделки — по одной на организацию, остальные — вторая сделка той же организации
    // с другим человеком.
    const organization = organizations[i < orgCount ? i : random.int(0, orgCount - 1)]
    if (!organization) throw new Error('организаций нет')
    const contact = newContact(organization.key)
    const status: DealStatus =
      (['open', 'won', 'lost'] as const)[random.weighted([85, 5, 10])] ?? 'open'
    const stageIndex =
      status === 'won'
        ? FRANCH_SIGNING
        : status === 'lost'
          ? random.int(0, 6)
          : random.weighted(FRANCH_OPEN_WEIGHTS)
    const money =
      status === 'won' || (status !== 'lost' && stageIndex >= FRANCH_PRICED_FROM_STAGE)
        ? priced(random, FRANCH_PRODUCTS, random.pick(FRANCH_PACKAGES), 'EUR', 0.5)
        : { amount: 0, lines: [] }
    const participants = random.chance(0.3)
      ? [{ contactKey: newContact(organization.key).key, role: random.pick(PARTICIPANT_ROLES) }]
      : []
    deals.push({
      key: `deal-${pad(deals.length + 1)}`,
      title: `${organization.name.split(',')[0]} — франшиза`,
      pipelineCode: 'franch',
      stageIndex,
      status,
      lostReasonIndex: status === 'lost' ? random.int(0, FRANCH_LOST_REASONS - 1) : null,
      ...money,
      currency: 'EUR',
      ownerKey: status === 'open' && random.chance(0.1) ? null : random.pick(volume.managerKeys),
      contactKey: contact.key,
      organizationKey: organization.key,
      ...dealDates(random, now, status, 365),
      archived: random.chance(0.03),
      participants,
      custom: {},
    })
  }

  return {
    code: 'franch',
    name: 'Франч',
    preset: 'franch',
    members: [],
    teams: [],
    products: FRANCH_PRODUCTS,
    organizations,
    contacts,
    deals,
  }
}
