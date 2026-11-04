// Настройки API из переменных окружения (образец — .env.example в корне репозитория).

export interface ApiEnv {
  databaseUrl: string
  authSecret: string
  authUrl: string
  /** Secure у cookie: везде, кроме NODE_ENV=development. */
  secureCookies: boolean
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
  if (problems.length > 0) {
    throw new Error(`Окружение API не настроено: ${problems.join('; ')}`)
  }
  return {
    databaseUrl,
    authSecret,
    authUrl,
    secureCookies: env.NODE_ENV !== 'development',
  }
}
