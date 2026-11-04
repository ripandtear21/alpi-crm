// Настройки API из переменных окружения (образец — .env.example в корне репозитория).
import { isIP } from 'node:net'

export interface ApiEnv {
  databaseUrl: string
  authSecret: string
  authUrl: string
  /** Secure у cookie: везде, кроме NODE_ENV=development. */
  secureCookies: boolean
  /** Доверенные прокси перед API (TRUSTED_PROXIES): адреса и подсети CIDR через запятую. */
  trustedProxies: string[]
}

/** Короче ключ подписи cookie и шифрования секретов 2FA не принимаем. */
const MIN_SECRET_LENGTH = 32

/** Читает и проверяет окружение; при ошибке бросает исключение с перечнем проблем. */
export function readApiEnv(env: NodeJS.ProcessEnv = process.env): ApiEnv {
  const problems: string[] = []
  const databaseUrl = env.DATABASE_URL ?? ''
  const authSecret = env.BETTER_AUTH_SECRET ?? ''
  const authUrl = env.BETTER_AUTH_URL ?? ''
  if (!databaseUrl) problems.push('не задана DATABASE_URL')
  if (authSecret.length < MIN_SECRET_LENGTH) {
    problems.push(`BETTER_AUTH_SECRET не задана или короче ${MIN_SECRET_LENGTH} символов`)
  }
  if (!URL.canParse(authUrl)) problems.push('BETTER_AUTH_URL не задана или не адрес URL')
  const trustedProxies = (env.TRUSTED_PROXIES ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  const badProxies = trustedProxies.filter((entry) => !isAddressOrCidr(entry))
  if (badProxies.length > 0) {
    problems.push(`TRUSTED_PROXIES: не адрес и не подсеть CIDR: ${badProxies.join(', ')}`)
  }
  if (problems.length > 0) {
    throw new Error(`Окружение API не настроено: ${problems.join('; ')}`)
  }
  return {
    databaseUrl,
    authSecret,
    authUrl,
    secureCookies: env.NODE_ENV !== 'development',
    trustedProxies,
  }
}

/** «10.0.0.1», «10.0.0.0/8», «2001:db8::/32». */
function isAddressOrCidr(entry: string): boolean {
  const [address = '', prefix, ...rest] = entry.split('/')
  const family = isIP(address)
  if (family === 0 || rest.length > 0) return false
  if (prefix === undefined) return true
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128)
}
