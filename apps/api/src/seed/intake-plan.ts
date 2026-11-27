import { type InboundOutcome, normalizeEmail, normalizePhone } from '@alpi/shared'
import { FIRST_NAMES, LAST_NAMES } from './names.ts'
import type { PlannedContact, PlannedDeal, ProjectPlan } from './plan.ts'
import type { Random } from './random.ts'

// Данные эпика crm-intake в плане pnpm seed (тикет crm-intake/10) — чистая функция от генератора,
// масштаба и «сейчас», как остальной план (plan.ts):
// - источники регистраций проекта, один отключён;
// - регистрации сделок плана (на каждую сделку одна, у части — несколько) с метками, рекламными
//   идентификаторами, браузером, extra и у части — просмотром вебинара;
// - журнал входящих за последние 30 дней: тела запросов, которые store проводит функциями
//   приёма (принятые, повторы, ошибки 400 без телефона и email, просмотры без регистрации);
// - готовые дубли каждого правила тикета crm-intake/05, пара «не дубль» и слияния.
// Готовые дубли — контакты и сделки плана (ключи `dup-…`, `merge-…`): их пишет та же запись,
// что людей и сделки. Телефоны и email в разной записи приводятся к единому виду теми же
// функциями, что у приёма и ручного создания (normalizePhone, normalizeEmail).

const DAY = 86_400_000
const HOUR = 3_600_000
const MINUTE = 60_000

/** Источник регистраций проекта. */
export interface PlannedSource {
  key: string
  name: string
  pipelineCode: string
  /** Когда отключён; null — включён. */
  disabledAt: Date | null
  /** Как его регистрации выглядят: форма, страница, вебинар, тарифы. */
  form: string
  slug: string
  webinar: boolean
  plans: readonly string[]
  /** Доля регистраций сделок его воронки. */
  weight: number
}

/** Строковые поля регистрации (столбцы registration). */
export interface RegistrationText {
  name: string | null
  dial_code: string | null
  form: string | null
  webinar: string | null
  plan_name: string | null
  page_url: string | null
  referrer: string | null
  utm_source: string | null
  utm_medium: string | null
  utm_campaign: string | null
  utm_term: string | null
  utm_content: string | null
  ad_id: string | null
  gclid: string | null
  fbclid: string | null
  fbp: string | null
  fbc: string | null
  user_agent: string | null
}

/** Регистрация сделки плана (пишется в базу напрямую: их тысячи). */
export interface PlannedRegistration {
  eventId: string
  sourceKey: string
  dealKey: string
  registeredAt: Date
  /** Телефон в E.164 и как его прислала форма. */
  phone: string
  phoneRaw: string
  email: string | null
  text: RegistrationText
  extra: Record<string, unknown>
  view: { startedAt: Date; finishedAt: Date; minutes: number } | null
}

/** Запрос журнала входящих: store проводит его функцией приёма и ставит время получения. */
export interface PlannedInbound {
  key: string
  sourceKey: string
  channel: 'registration' | 'webinar_view'
  body: Record<string, unknown>
  receivedAt: Date
  /** Ответ, который должен дать приём: другой — ошибка seed, а не тихая строка журнала. */
  expected: { status: number; outcome: InboundOutcome }
}

/** Слияние контактов: survivor остаётся, merged скрывается; ageDays > 30 — откат недоступен. */
export interface PlannedMerge {
  key: string
  survivorKey: string
  mergedKey: string
  ageDays: number
}

export interface IntakePlan {
  sources: PlannedSource[]
  registrations: PlannedRegistration[]
  inbound: PlannedInbound[]
  merges: PlannedMerge[]
  /** Пары контактов с отметкой «не дубль». */
  notDuplicates: { aKey: string; bKey: string }[]
}

/** План без данных приёма: его заполняет addIntake. */
export function emptyIntake(): IntakePlan {
  return { sources: [], registrations: [], inbound: [], merges: [], notDuplicates: [] }
}

/** Чем проекты различаются в данных приёма. */
export interface IntakeProfile {
  site: string
  /** Основная воронка: в ней готовые дубли со сделками. */
  mainPipeline: string
  sources: Omit<PlannedSource, 'disabledAt'>[]
  /** Код отключённого источника. */
  disabledKey: string
  /** Номера телефонов: готовые дубли, новые люди журнала, просмотры без регистрации. */
  phones: { fixtures: number; journal: number; unmatched: number }
}

const WEBINAR_FORM = 'Реєстрація на вебінар'

export const ALPI_INTAKE: IntakeProfile = {
  site: 'alpi.example.com',
  mainPipeline: 'alpi',
  sources: [
    {
      key: 'webinar',
      name: 'Вебінар',
      pipelineCode: 'alpi',
      form: WEBINAR_FORM,
      slug: 'webinar',
      webinar: true,
      plans: [],
      weight: 65,
    },
    {
      key: 'consultation',
      name: 'Консультація',
      pipelineCode: 'platform',
      form: 'Запис на консультацію',
      slug: 'consultation',
      webinar: false,
      plans: ['Start', 'Pro'],
      weight: 1,
    },
    {
      key: 'landing',
      name: 'Лендінг курсу',
      pipelineCode: 'alpi',
      form: 'Заявка з лендінгу курсу',
      slug: 'course',
      webinar: false,
      plans: ['Базовий', 'Профі', 'VIP'],
      weight: 35,
    },
    {
      key: 'autowebinar',
      name: 'Автовебінар (старий)',
      pipelineCode: 'autowebinars',
      form: 'Реєстрація на автовебінар',
      slug: 'autowebinar',
      webinar: true,
      plans: [],
      weight: 1,
    },
  ],
  disabledKey: 'autowebinar',
  phones: { fixtures: 6_000_000, journal: 7_000_000, unmatched: 7_900_000 },
}

export const FRANCH_INTAKE: IntakeProfile = {
  site: 'franch.example.com',
  mainPipeline: 'franch',
  sources: [
    {
      key: 'webinar',
      name: 'Вебінар',
      pipelineCode: 'franch',
      form: WEBINAR_FORM,
      slug: 'webinar',
      webinar: true,
      plans: [],
      weight: 40,
    },
    {
      key: 'consultation',
      name: 'Консультація',
      pipelineCode: 'franch',
      form: 'Запис на консультацію',
      slug: 'consultation',
      webinar: false,
      plans: [],
      weight: 40,
    },
    {
      key: 'landing',
      name: 'Лендінг курсу',
      pipelineCode: 'franch',
      form: 'Заявка з лендінгу',
      slug: 'franchise',
      webinar: false,
      plans: ['START 2.0', 'PRO 2.0', 'MAX 2.0', 'VIP'],
      weight: 15,
    },
    {
      key: 'old-landing',
      name: 'Старий лендінг',
      pipelineCode: 'franch',
      form: 'Заявка зі старого лендінгу',
      slug: 'old',
      webinar: false,
      plans: [],
      weight: 5,
    },
  ],
  disabledKey: 'old-landing',
  phones: { fixtures: 6_500_000, journal: 7_500_000, unmatched: 7_950_000 },
}

/** Объём журнала при масштабе 1 (на проект). */
const JOURNAL = { fresh: 40, known: 30, repeats: 10, errors: 8, views: 10, unmatched: 6 }

const WEBINAR_TOPICS = ['AI-контент з нуля', 'Нейромережі для блогера', 'Контент-завод за тиждень']
const CAMPAIGNS = ['autumn_launch', 'webinar_nov', 'retarget_30d', 'lookalike_ua', 'brand']
const SEARCH_TERMS = ['курс ai контент', 'нейромережі для контенту', 'як вести блог з ai']
const QUIZ_ANSWERS = ['Хочу змінити професію', 'Веду блог', 'Маю бізнес', 'Просто цікаво']
const USER_AGENTS = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 15; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
]
const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'

function token(random: Random, length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) {
    out += TOKEN_ALPHABET[Math.floor(random.next() * TOKEN_ALPHABET.length)]
  }
  return out
}

/** Телефон из диапазона +380 70 (код абонентам не выдан). Номер `n` — от 1. */
export function phoneOf(n: number): string {
  return `+38070${String(n).padStart(7, '0')}`
}

/** Как телефон пишут в формах: `070 123 45 67`. */
function national(e164: string): string {
  const d = e164.slice(4)
  return `0${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 7)} ${d.slice(7)}`
}

function normalized(phone: string): string {
  const value = normalizePhone(phone)
  if (value === null) throw new Error(`seed: тестовый телефон ${phone} не разбирается`)
  return value
}

const isoDay = (date: Date) => date.toISOString().slice(0, 10)

function person(random: Random) {
  const [firstName, firstLatin] = random.pick(FIRST_NAMES)
  const [lastName, lastLatin] = random.pick(LAST_NAMES)
  return { firstName, lastName, latin: `${firstLatin}.${lastLatin}` }
}

/** Метки, рекламные идентификаторы и браузер регистрации из источника `source` в момент `at`. */
function marketing(
  random: Random,
  source: Omit<PlannedSource, 'disabledAt'>,
  site: string,
  at: Date,
): Omit<RegistrationText, 'name' | 'dial_code'> & { extra: Record<string, unknown> } {
  const channel =
    (['facebook', 'instagram', 'google', 'email', 'direct'] as const)[
      random.weighted([40, 20, 20, 10, 10])
    ] ?? 'direct'
  const paid = channel === 'facebook' || channel === 'instagram' || channel === 'google'
  const meta = channel === 'facebook' || channel === 'instagram'
  const fbclid = meta ? `IwAR${token(random, 40)}` : null
  const webinar = source.webinar
    ? `${random.pick(WEBINAR_TOPICS)} · ${isoDay(new Date(at.getTime() + random.int(1, 4) * DAY))}`
    : null
  return {
    form: source.form,
    webinar,
    plan_name: source.plans.length > 0 && random.chance(0.7) ? random.pick(source.plans) : null,
    page_url: `https://${site}/${source.slug}`,
    referrer:
      channel === 'facebook'
        ? 'https://l.facebook.com/'
        : channel === 'instagram'
          ? 'https://l.instagram.com/'
          : channel === 'google'
            ? 'https://www.google.com/'
            : null,
    utm_source: channel === 'direct' ? null : channel === 'email' ? 'newsletter' : channel,
    utm_medium: channel === 'direct' ? null : channel === 'email' ? 'email' : 'cpc',
    utm_campaign: channel === 'direct' ? null : `${source.slug}_${random.pick(CAMPAIGNS)}`,
    utm_term: channel === 'google' ? random.pick(SEARCH_TERMS) : null,
    utm_content: paid ? `creative_${random.int(1, 6)}` : null,
    ad_id: paid ? String(random.int(100_000_000_000, 999_999_999_999)) : null,
    gclid: channel === 'google' ? `Cj0KCQ${token(random, 60)}` : null,
    fbclid,
    fbp:
      meta || random.chance(0.2)
        ? `fb.1.${at.getTime() - random.int(0, 30) * DAY}.${random.int(1_000_000_000, 1_999_999_999)}`
        : null,
    fbc: fbclid === null ? null : `fb.1.${at.getTime()}.${fbclid}`,
    user_agent: random.pick(USER_AGENTS),
    extra: {
      lang: random.chance(0.8) ? 'uk' : 'ru',
      ...(random.chance(0.4) ? { quiz_answer: random.pick(QUIZ_ANSWERS) } : {}),
      ...(random.chance(0.2) ? { promo_code: `SEED${random.int(10, 99)}` } : {}),
    },
  }
}

/** Как форма прислала телефон: E.164, национальный вид или цифры с кодом 380. */
function rawPhone(random: Random, e164: string): { phoneRaw: string; dialCode: string | null } {
  switch (random.weighted([50, 30, 20])) {
    case 0:
      return { phoneRaw: e164, dialCode: null }
    case 1:
      return { phoneRaw: national(e164), dialCode: null }
    default:
      return { phoneRaw: e164.slice(4), dialCode: '+380' }
  }
}

interface IntakeOptions {
  now: Date
  count: (full: number) => number
  /** Ответственные готовых сделок. */
  ownerKeys: readonly string[]
  profile: IntakeProfile
}

/**
 * Добавляет в план проекта `project` готовые дубли (контакты и сделки) и данные приёма.
 * Генератор `random` — свой у данных приёма: люди и сделки плана при том же зерне не меняются.
 */
export function addIntake(project: ProjectPlan, random: Random, options: IntakeOptions): void {
  const { now, profile } = options
  const disabledAt = new Date(now.getTime() - 7 * DAY)
  const sources: PlannedSource[] = profile.sources.map((source) => ({
    ...source,
    disabledAt: source.key === profile.disabledKey ? disabledAt : null,
  }))
  const fixtures = duplicateFixtures(random, options)
  project.contacts.push(...fixtures.contacts)
  project.deals.push(...fixtures.deals)

  const contacts = new Map(project.contacts.map((c) => [c.key, c]))
  const registrations: PlannedRegistration[] = []
  for (const deal of project.deals) {
    const candidates = sources.filter((s) => s.pipelineCode === deal.pipelineCode)
    const contact = contacts.get(deal.contactKey)
    if (candidates.length === 0 || !contact) continue
    const source = candidates[random.weighted(candidates.map((s) => s.weight))]
    if (!source) continue
    const times = 1 + (random.chance(0.25) ? 1 : 0) + (random.chance(0.05) ? 1 : 0)
    for (let i = 0; i < times; i++) {
      // Первая регистрация создала сделку; повторные — позже, до «сейчас».
      let at =
        i === 0
          ? deal.createdAt
          : new Date(
              deal.createdAt.getTime() +
                Math.floor(random.next() * (now.getTime() - deal.createdAt.getTime())),
            )
      if (source.disabledAt !== null && at >= source.disabledAt) {
        at = new Date(source.disabledAt.getTime() - random.int(1, 72) * HOUR)
      }
      const { extra, ...text } = marketing(random, source, profile.site, at)
      const { phoneRaw, dialCode } = rawPhone(random, contact.phone)
      const minutes = random.int(3, 150)
      const startedAt = new Date(at.getTime() + random.int(1, 3) * DAY)
      const finishedAt = new Date(startedAt.getTime() + minutes * MINUTE)
      registrations.push({
        eventId: `seed-${deal.key}-${i + 1}`,
        sourceKey: source.key,
        dealKey: deal.key,
        registeredAt: at,
        phone: contact.phone,
        phoneRaw,
        email: contact.email,
        text: {
          ...text,
          name: random.chance(0.9)
            ? `${contact.firstName} ${contact.lastName}`.trim()
            : contact.firstName,
          dial_code: dialCode,
        },
        extra,
        view:
          source.webinar && random.chance(0.4) && finishedAt < now
            ? { startedAt, finishedAt, minutes }
            : null,
      })
    }
  }

  project.intake = {
    sources,
    registrations,
    inbound: journal(random, project, sources, options),
    merges: [
      { key: 'merge-fresh', survivorKey: 'merge-fresh-1', mergedKey: 'merge-fresh-2', ageDays: 0 },
      {
        key: 'merge-nested',
        survivorKey: 'merge-nested-1',
        mergedKey: 'merge-nested-2',
        ageDays: 0,
      },
      { key: 'merge-old', survivorKey: 'merge-old-1', mergedKey: 'merge-old-2', ageDays: 40 },
    ],
    notDuplicates: [{ aKey: 'dup-not-1', bKey: 'dup-not-2' }],
  }
}

/**
 * Готовые дубли каждого правила тикета crm-intake/05 и пары для слияний: телефон в разной
 * записи, email в разном регистре, отметка «возможный дубль», одинаковые имя и фамилия с
 * совпадением последних 9 цифр, контакт с архивной и открытой сделкой в одной воронке, пара
 * контактов с открытыми сделками в одной воронке (тикет crm-intake/04), группа из трёх, пара
 * «не дубль»; для слияний — свежая пара, пара со сделками (вложенное слияние сделок) и старая.
 */
function duplicateFixtures(
  random: Random,
  options: IntakeOptions,
): { contacts: PlannedContact[]; deals: PlannedDeal[] } {
  const { now, profile } = options
  const contacts: PlannedContact[] = []
  const deals: PlannedDeal[] = []
  const phone = (n: number) => phoneOf(profile.phones.fixtures + n)
  const add = (
    key: string,
    keys: { phone: string; email?: string },
    extra: { name?: { firstName: string; lastName: string }; duplicateOfKey?: string } = {},
  ) => {
    const p = person(random)
    const name = extra.name ?? p
    contacts.push({
      key,
      firstName: name.firstName,
      lastName: name.lastName,
      language: 'uk',
      organizationKey: null,
      phone: normalized(keys.phone),
      email:
        keys.email === undefined
          ? `${p.latin}.${key}@example.com`.toLowerCase()
          : normalizeEmail(keys.email),
      ...(extra.duplicateOfKey === undefined ? {} : { duplicateOfKey: extra.duplicateOfKey }),
    })
  }
  const deal = (contactKey: string, n: number, archived: boolean) => {
    const contact = contacts.find((c) => c.key === contactKey)
    if (!contact) throw new Error(`нет контакта ${contactKey}`)
    const createdAt = new Date(now.getTime() - random.int(2, 20) * DAY)
    deals.push({
      key: `${contactKey}/deal-${n}`,
      title: `${contact.firstName} ${contact.lastName} — вебінар`,
      pipelineCode: profile.mainPipeline,
      stageIndex: n === 1 ? 0 : 1,
      status: 'open',
      lostReasonIndex: null,
      amount: 0,
      currency: 'EUR',
      ownerKey: random.pick(options.ownerKeys),
      contactKey,
      organizationKey: null,
      createdAt,
      stageChangedAt: createdAt,
      closedAt: null,
      archived,
      lines: [],
      participants: [],
      custom: {},
    })
  }
  const latin = () => person(random).latin.toLowerCase()

  // Телефон в разной записи: `+380 70…` и `070 …` — один номер.
  add('dup-phone-1', { phone: phone(1) })
  add('dup-phone-2', { phone: national(phone(1)) })
  // Email в разном регистре.
  const email = `${latin()}.dup@example.com`
  add('dup-email-1', { phone: phone(3), email })
  add('dup-email-2', { phone: phone(4), email: email.toUpperCase() })
  // Отметка «возможный дубль»: второй контакт отмечен, ссылается на первый.
  add('dup-mark-1', { phone: phone(5) })
  add('dup-mark-2', { phone: phone(6) }, { duplicateOfKey: 'dup-mark-1' })
  // Одинаковые имя и фамилия, последние 9 цифр совпадают, телефоны разные (+48 70x — платные
  // услуги Польши, не абонентский номер).
  const twin = person(random)
  add('dup-name-1', { phone: phone(7) }, { name: twin })
  add('dup-name-2', { phone: `+48${phone(7).slice(-9)}` }, { name: twin })
  // Архивная и открытая сделки контакта в одной воронке — пара сделок.
  add('dup-archived', { phone: phone(9) })
  deal('dup-archived', 1, true)
  deal('dup-archived', 2, false)
  // Пара контактов с открытыми сделками в одной воронке (слияние с выбором сделки, тикет 04).
  const shared = `${latin()}.deals@example.com`
  add('dup-deals-1', { phone: phone(10), email: shared })
  add('dup-deals-2', { phone: phone(11), email: shared })
  deal('dup-deals-1', 1, false)
  deal('dup-deals-2', 1, false)
  // Группа из трёх: первый со вторым — по телефону, второй с третьим — по email.
  const three = `${latin()}.three@example.com`
  add('dup-three-1', { phone: phone(12) })
  add('dup-three-2', { phone: national(phone(12)), email: three })
  add('dup-three-3', { phone: phone(13), email: three })
  // Пара с отметкой «не дубль»: один телефон, но предлагаться не должна.
  add('dup-not-1', { phone: phone(14) })
  add('dup-not-2', { phone: phone(14) })
  // Слияния: свежее, свежее с вложенным слиянием сделок, старше 30 дней.
  add('merge-fresh-1', { phone: phone(15) })
  add('merge-fresh-2', { phone: national(phone(15)) })
  const nested = `${latin()}.nested@example.com`
  add('merge-nested-1', { phone: phone(16), email: nested })
  add('merge-nested-2', { phone: phone(17), email: nested })
  deal('merge-nested-1', 1, false)
  deal('merge-nested-2', 1, false)
  add('merge-old-1', { phone: phone(18) })
  add('merge-old-2', { phone: phone(18) })
  return { contacts, deals }
}

/**
 * Журнал входящих за последние 30 дней: новые люди и люди плана (принятые), повторы тех же
 * тел, ошибки 400 без телефона и email, просмотры вебинара своих регистраций и без регистрации.
 * Время получения — равномерно по 30 дням; повтор и просмотр — после своей регистрации.
 */
function journal(
  random: Random,
  project: ProjectPlan,
  sources: PlannedSource[],
  options: IntakeOptions,
): PlannedInbound[] {
  const { now, count, profile } = options
  const enabled = sources.filter((s) => s.disabledAt === null)
  const webinarSource = enabled.find((s) => s.webinar)
  if (!webinarSource) throw new Error('нет включённого источника вебинаров')
  const known = project.contacts.filter((c) => c.key.startsWith('contact-'))
  const fresh = count(JOURNAL.fresh)
  const originals = fresh + count(JOURNAL.known)
  /** Время j-й исходной регистрации: равномерно по 30 дням, новые — ближе к «сейчас». */
  const receivedAt = (j: number) =>
    new Date(
      now.getTime() -
        Math.floor(((originals - j - 0.5) / originals) * 29 * DAY) +
        random.int(-6, 6) * HOUR,
    )
  const before = (at: Date) => new Date(Math.min(at.getTime(), now.getTime() - MINUTE))

  const entries: PlannedInbound[] = []
  /** Телефон регистрации журнала в E.164 — для её просмотра. */
  const phones = new Map<string, string>()
  const registration = (
    key: string,
    source: PlannedSource,
    who: { name: string; phone: string; email: string | null },
    at: Date,
  ): PlannedInbound => {
    const { extra, ...text } = marketing(random, source, profile.site, at)
    const { phoneRaw, dialCode } = rawPhone(random, who.phone)
    phones.set(key, who.phone)
    return {
      key,
      sourceKey: source.key,
      channel: 'registration',
      body: {
        event_id: `seed-in-${key}`,
        name: who.name,
        phone: phoneRaw,
        ...(dialCode === null ? {} : { dial_code: dialCode }),
        ...(who.email === null ? {} : { email: who.email }),
        registered_at: at.toISOString(),
        ...Object.fromEntries(Object.entries(text).filter(([, v]) => v !== null)),
        ...extra,
      },
      receivedAt: before(at),
      expected: { status: 201, outcome: 'accepted' },
    }
  }

  for (let i = 1; i <= originals; i++) {
    const at = receivedAt(i - 1)
    if (i <= fresh) {
      const p = person(random)
      // Первая новая регистрация — на вебинар: для неё есть просмотр.
      const source = i === 1 ? webinarSource : random.pick(enabled)
      entries.push(
        registration(
          `inbound-${i}`,
          source,
          {
            name: `${p.firstName} ${p.lastName}`,
            phone: phoneOf(profile.phones.journal + i),
            email: random.chance(0.7) ? `${p.latin}.in${i}@example.com`.toLowerCase() : null,
          },
          at,
        ),
      )
    } else {
      const contact = random.pick(known)
      entries.push(
        registration(
          `inbound-${i}`,
          random.pick(enabled),
          {
            name: `${contact.firstName} ${contact.lastName}`,
            phone: contact.phone,
            email: contact.email,
          },
          at,
        ),
      )
    }
  }
  const accepted = [...entries]

  for (let i = 1; i <= count(JOURNAL.repeats); i++) {
    const original = random.pick(accepted)
    entries.push({
      ...original,
      key: `inbound-repeat-${i}`,
      receivedAt: before(new Date(original.receivedAt.getTime() + random.int(1, 30) * MINUTE)),
      expected: { status: 200, outcome: 'repeat' },
    })
  }

  for (let i = 1; i <= count(JOURNAL.errors); i++) {
    const source = random.pick(enabled)
    const { extra, ...text } = marketing(random, source, profile.site, now)
    const p = person(random)
    entries.push({
      key: `inbound-error-${i}`,
      sourceKey: source.key,
      channel: 'registration',
      // Без телефона и email — 400 CONTACT_KEYS_REQUIRED.
      body: {
        event_id: `seed-in-error-${i}`,
        name: p.firstName,
        ...Object.fromEntries(Object.entries(text).filter(([, v]) => v !== null)),
        ...extra,
      },
      receivedAt: new Date(now.getTime() - random.int(1, 29 * 24) * HOUR),
      expected: { status: 400, outcome: 'error' },
    })
  }

  // Просмотры: по регистрациям журнала на вебинар — принятые; по номеру без регистрации — нет.
  const webinarRegs = accepted.filter(
    (e) => e.sourceKey === webinarSource.key && typeof e.body.webinar === 'string',
  )
  const views = Math.min(count(JOURNAL.views), webinarRegs.length)
  for (let i = 1; i <= views; i++) {
    const reg = webinarRegs[i - 1]
    if (!reg) break
    const startedAt = new Date(reg.receivedAt.getTime() + random.int(2, 30) * HOUR)
    const minutes = random.int(5, 120)
    entries.push({
      key: `inbound-view-${i}`,
      sourceKey: webinarSource.key,
      channel: 'webinar_view',
      body: {
        event_id: `seed-view-${i}`,
        phone: phones.get(reg.key),
        webinar: reg.body.webinar,
        started_at: startedAt.toISOString(),
        finished_at: new Date(startedAt.getTime() + minutes * MINUTE).toISOString(),
        minutes,
      },
      receivedAt: before(new Date(startedAt.getTime() + (minutes + 5) * MINUTE)),
      expected: { status: 200, outcome: 'accepted' },
    })
  }
  for (let i = 1; i <= count(JOURNAL.unmatched); i++) {
    const startedAt = new Date(now.getTime() - random.int(2, 29 * 24) * HOUR)
    const minutes = random.int(5, 120)
    entries.push({
      key: `inbound-unmatched-${i}`,
      sourceKey: webinarSource.key,
      channel: 'webinar_view',
      body: {
        event_id: `seed-view-unmatched-${i}`,
        phone: phoneOf(profile.phones.unmatched + i),
        webinar: `${random.pick(WEBINAR_TOPICS)} · ${isoDay(startedAt)}`,
        started_at: startedAt.toISOString(),
        minutes,
      },
      receivedAt: before(new Date(startedAt.getTime() + (minutes + 5) * MINUTE)),
      expected: { status: 200, outcome: 'unmatched' },
    })
  }
  return entries
}
