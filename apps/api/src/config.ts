// Настройки API из переменных окружения (образец — .env.example в корне репозитория).
import { isIP } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ApiEnv {
  databaseUrl: string
  authSecret: string
  authUrl: string
  /** Secure у cookie: везде, кроме NODE_ENV=development. */
  secureCookies: boolean
  /** Доверенные прокси перед API (TRUSTED_PROXIES): адреса и подсети CIDR через запятую. */
  trustedProxies: string[]
  /** Каталог файлов на локальном диске (STORAGE_DIR): абсолютный путь вне каталога приложения. */
  storageDir: string
  /**
   * Ключ AES-256-GCM, которым в базе зашифрованы секреты подписи адресов событий
   * (WEBHOOK_SECRET_KEY: base64 от 32 байт). null — не задан: адреса событий не создаются и
   * события не отправляются (ответ 500 и ошибка в журнале процесса).
   */
  webhookSecretKey: Buffer | null
  /**
   * WEBHOOK_ALLOW_INSECURE_URLS=1 — только для автотестов и разработки: адреса событий по
   * `http://` и на loopback (localhost, 127.0.0.1, ::1). С NODE_ENV=production API не запускается.
   */
  webhookAllowInsecureUrls: boolean
}

/** Короче ключ подписи cookie и шифрования секретов 2FA не принимаем. */
const MIN_SECRET_LENGTH = 32

/**
 * Каталог приложения: apps/api при запуске из исходников, /app в образе (код — в dist). Его
 * заменяет каждая сборка и выкладка — файлы пользователей там не хранятся.
 */
const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Читает и проверяет окружение; при ошибке бросает исключение с перечнем проблем. */
export function readApiEnv(env: NodeJS.ProcessEnv = process.env, appDir = APP_DIR): ApiEnv {
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
  const storageDir = env.STORAGE_DIR ?? ''
  if (!path.isAbsolute(storageDir)) {
    problems.push('STORAGE_DIR не задана или не абсолютный путь')
  } else if (isInside(storageDir, appDir)) {
    problems.push(`STORAGE_DIR внутри каталога приложения ${appDir}: его заменяет каждая сборка`)
  }
  const webhookSecretKey = readWebhookSecretKey(env.WEBHOOK_SECRET_KEY)
  if (webhookSecretKey === undefined) {
    problems.push('WEBHOOK_SECRET_KEY: ожидается base64 от 32 байт (openssl rand -base64 32)')
  }
  const insecure = env.WEBHOOK_ALLOW_INSECURE_URLS ?? ''
  if (!['', '0', '1'].includes(insecure)) {
    problems.push('WEBHOOK_ALLOW_INSECURE_URLS: ожидается 1 или 0')
  }
  const webhookAllowInsecureUrls = insecure === '1'
  if (webhookAllowInsecureUrls && env.NODE_ENV === 'production') {
    problems.push('WEBHOOK_ALLOW_INSECURE_URLS=1 запрещена при NODE_ENV=production')
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
    storageDir: path.resolve(storageDir),
    webhookSecretKey: webhookSecretKey ?? null,
    webhookAllowInsecureUrls,
  }
}

/** Ключ шифрования секретов адресов: не задан — null, не 32 байта base64 — undefined. */
function readWebhookSecretKey(value: string | undefined): Buffer | null | undefined {
  const text = value?.trim() ?? ''
  if (text === '') return null
  if (!/^[A-Za-z0-9+/]{43}=$/.test(text)) return undefined
  const key = Buffer.from(text, 'base64')
  return key.length === 32 ? key : undefined
}

/** `target` — сам каталог `dir` или внутри него. */
function isInside(target: string, dir: string): boolean {
  const relative = path.relative(path.resolve(dir), path.resolve(target))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** «10.0.0.1», «10.0.0.0/8», «2001:db8::/32». */
function isAddressOrCidr(entry: string): boolean {
  const [address = '', prefix, ...rest] = entry.split('/')
  const family = isIP(address)
  if (family === 0 || rest.length > 0) return false
  if (prefix === undefined) return true
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128)
}
