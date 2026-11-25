import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { MAX_WEBHOOK_URL_LENGTH } from '@alpi/shared'

// Защита адресов событий от запросов во внутреннюю сеть — SSRF (тикет crm-api/06; решено без
// владельца — подтвердить). Адрес вводит пользователь, а запрос на него отправляет сервер CRM:
// без защиты через адрес можно достучаться до базы, до сервисов в частной сети и до адреса
// метаданных облака (169.254.169.254).
//
// - Только `https://`, без имени и пароля в адресе и без `#фрагмента`.
// - Имя разрешается в IP; адрес отклоняется, если хоть один IP не публичный: частные сети,
//   loopback, link-local (в том числе метаданные облака), CGNAT, multicast, неуказанный,
//   документационные и зарезервированные. Для IPv6 разрешены только глобальные адреса 2000::/3
//   без служебных подсетей (документация, Teredo, 6to4); IPv4 внутри IPv6 (::ffff:a.b.c.d)
//   проверяется как IPv4 и тоже отклоняется.
// - Проверка — при сохранении адреса и перед каждой отправкой; отправка идёт на тот IP, который
//   проверен (events/send.ts), — подмена DNS между проверкой и соединением не помогает.
// - `allowInsecure` (WEBHOOK_ALLOW_INSECURE_URLS, только автотесты и разработка; config.ts) —
//   разрешает `http://` и loopback (localhost, 127.0.0.0/8, ::1). Остальные внутренние сети
//   запрещены и с ней.

/** Почему адрес не годится: форма, не https, внутренний адрес, имя не разрешилось. */
export type UrlProblem = 'invalid' | 'not_https' | 'forbidden_address' | 'unresolvable'

/** Разрешение имени: все адреса имени. Тесты подставляют свою таблицу имён. */
export type HostLookup = (hostname: string) => Promise<{ address: string; family: number }[]>

export const systemLookup: HostLookup = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true })

export interface UrlPolicy {
  /** Разрешить `http://` и loopback — только для автотестов. */
  allowInsecure: boolean
  lookup?: HostLookup
}

/** Проверенный IP, на который пойдёт соединение. */
export interface ResolvedAddress {
  address: string
  family: 4 | 6
}

export type UrlCheck<T> = { ok: true; value: T } | { ok: false; problem: UrlProblem }

/** Форма адреса: строка URL до 2048 символов, https (или http с allowInsecure), без учётных данных. */
export function parseWebhookUrl(raw: unknown, policy: UrlPolicy): UrlCheck<URL> {
  if (typeof raw !== 'string') return { ok: false, problem: 'invalid' }
  const text = raw.trim()
  if (text === '' || text.length > MAX_WEBHOOK_URL_LENGTH || !URL.canParse(text)) {
    return { ok: false, problem: 'invalid' }
  }
  const url = new URL(text)
  if (url.protocol !== 'https:' && !(policy.allowInsecure && url.protocol === 'http:')) {
    return { ok: false, problem: 'not_https' }
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '' || url.hostname === '') {
    return { ok: false, problem: 'invalid' }
  }
  return { ok: true, value: url }
}

/** Имя хоста без скобок IPv6-литерала. */
function bareHost(url: URL): string {
  const host = url.hostname
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/**
 * Разрешает имя адреса и проверяет каждый IP. Годится — все IP (соединение идёт на первый);
 * хоть один внутренний — forbidden_address; имя не разрешилось — unresolvable.
 */
export async function resolveWebhookHost(
  url: URL,
  policy: UrlPolicy,
): Promise<UrlCheck<ResolvedAddress[]>> {
  const host = bareHost(url)
  let addresses: { address: string; family: number }[]
  if (isIP(host) !== 0) {
    addresses = [{ address: host, family: isIP(host) }]
  } else {
    try {
      addresses = await (policy.lookup ?? systemLookup)(host)
    } catch {
      return { ok: false, problem: 'unresolvable' }
    }
  }
  if (addresses.length === 0) return { ok: false, problem: 'unresolvable' }
  const checked: ResolvedAddress[] = []
  for (const { address } of addresses) {
    const family = isIP(address)
    if (family === 0 || isForbiddenAddress(address, policy.allowInsecure)) {
      return { ok: false, problem: 'forbidden_address' }
    }
    checked.push({ address, family: family as 4 | 6 })
  }
  return { ok: true, value: checked }
}

/** Форма и адреса сразу: то, что проверяется при сохранении адреса и перед каждой отправкой. */
export async function checkWebhookUrl(
  raw: unknown,
  policy: UrlPolicy,
): Promise<UrlCheck<{ url: URL; addresses: ResolvedAddress[] }>> {
  const parsed = parseWebhookUrl(raw, policy)
  if (!parsed.ok) return parsed
  const resolved = await resolveWebhookHost(parsed.value, policy)
  if (!resolved.ok) return resolved
  return { ok: true, value: { url: parsed.value, addresses: resolved.value } }
}

// ---- Адреса ----------------------------------------------------------------------------------

/** [адрес, длина префикса] запрещённых подсетей IPv4. */
const IPV4_FORBIDDEN: readonly [number[], number][] = [
  [[0, 0, 0, 0], 8], // «эта сеть», в том числе 0.0.0.0
  [[10, 0, 0, 0], 8], // частная
  [[100, 64, 0, 0], 10], // CGNAT
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local, метаданные облака 169.254.169.254
  [[172, 16, 0, 0], 12], // частная
  [[192, 0, 0, 0], 24], // служебные назначения IETF
  [[192, 0, 2, 0], 24], // документация (TEST-NET-1)
  [[192, 88, 99, 0], 24], // 6to4 relay
  [[192, 168, 0, 0], 16], // частная
  [[198, 18, 0, 0], 15], // тестирование производительности
  [[198, 51, 100, 0], 24], // документация (TEST-NET-2)
  [[203, 0, 113, 0], 24], // документация (TEST-NET-3)
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // зарезервировано, в том числе 255.255.255.255
]

const LOOPBACK_V4: [number[], number] = [[127, 0, 0, 0], 8]

function inSubnet(bytes: readonly number[], [net, prefix]: readonly [number[], number]): boolean {
  for (let bit = 0; bit < prefix; bit++) {
    const byte = bit >> 3
    const mask = 0x80 >> (bit & 7)
    if (((bytes[byte] ?? 0) & mask) !== ((net[byte] ?? 0) & mask)) return false
  }
  return true
}

function ipv4Bytes(text: string): number[] {
  return text.split('.').map(Number)
}

/** 16 байт адреса IPv6 (в том числе с IPv4 в конце: ::ffff:10.0.0.1). */
export function ipv6Bytes(text: string): number[] {
  const zone = text.indexOf('%')
  let address = zone === -1 ? text : text.slice(0, zone)
  let tail: number[] = []
  const lastColon = address.lastIndexOf(':')
  if (address.slice(lastColon + 1).includes('.')) {
    tail = ipv4Bytes(address.slice(lastColon + 1))
    address = `${address.slice(0, lastColon + 1)}0:0`
  }
  const [head = '', rest] = address.split('::')
  const left = head === '' ? [] : head.split(':')
  const right = rest === undefined || rest === '' ? [] : rest.split(':')
  const groups =
    rest === undefined
      ? left
      : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
  const bytes = groups.flatMap((group) => {
    const value = Number.parseInt(group, 16)
    return [value >> 8, value & 0xff]
  })
  if (tail.length === 4) bytes.splice(12, 4, ...tail)
  return bytes
}

/** IPv6, где разрешены только глобальные адреса 2000::/3 — минус служебные подсети в нём. */
const IPV6_FORBIDDEN_GLOBAL: readonly [number[], number][] = [
  [[0x20, 0x01, 0x0d, 0xb8], 32], // документация
  [[0x20, 0x01, 0x00, 0x00], 23], // служебные назначения IETF, в том числе Teredo 2001::/32
  [[0x20, 0x02], 16], // 6to4: внутри любой IPv4
  [[0x3f, 0xff], 20], // документация (RFC 9637)
]

/** Запрещён ли IP для отправки события; `allowLoopback` — только для автотестов. */
export function isForbiddenAddress(address: string, allowLoopback = false): boolean {
  const family = isIP(address)
  if (family === 4) {
    const bytes = ipv4Bytes(address)
    if (allowLoopback && inSubnet(bytes, LOOPBACK_V4)) return false
    return IPV4_FORBIDDEN.some((subnet) => inSubnet(bytes, subnet))
  }
  if (family !== 6) return true
  const bytes = ipv6Bytes(address)
  if (bytes.length !== 16) return true
  // IPv4 внутри IPv6 (::ffff:a.b.c.d и устаревший ::a.b.c.d) — как сам IPv4.
  const mapped = bytes.slice(0, 10).every((b) => b === 0)
  if (
    mapped &&
    ((bytes[10] === 0xff && bytes[11] === 0xff) || (bytes[10] === 0 && bytes[11] === 0))
  ) {
    const isLoopback6 = bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1
    if (isLoopback6) return !allowLoopback
    return isForbiddenAddress(bytes.slice(12).join('.'), allowLoopback)
  }
  if (((bytes[0] ?? 0) & 0xe0) !== 0x20) return true
  return IPV6_FORBIDDEN_GLOBAL.some((subnet) => inSubnet(bytes, subnet))
}
