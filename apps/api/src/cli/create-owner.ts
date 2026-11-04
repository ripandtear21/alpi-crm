// Создаёт владельца системы — первого пользователя:
//   pnpm create-owner <email> [имя]
// Пароль — из переменной OWNER_PASSWORD или со стандартного ввода (в терминале — без эха).
// Пароль нигде не печатается. Нужны те же переменные, что и API: DATABASE_URL,
// BETTER_AUTH_SECRET, BETTER_AUTH_URL.
import { createDb } from '@alpi/db'
import { createAuth, MIN_PASSWORD_LENGTH } from '../auth/auth.ts'
import { createOwner } from '../auth/owner.ts'
import { readApiEnv } from '../config.ts'

const [email, nameArg] = process.argv.slice(2)
if (!email?.includes('@')) {
  console.error('Использование: pnpm create-owner <email> [имя]')
  process.exit(2)
}

const env = readApiEnv()
const password = process.env.OWNER_PASSWORD || (await readPassword())
if (password.length < MIN_PASSWORD_LENGTH) {
  console.error(`Пароль короче ${MIN_PASSWORD_LENGTH} символов`)
  process.exit(2)
}

const db = createDb(env.databaseUrl)
try {
  const auth = createAuth({
    db,
    secret: env.authSecret,
    baseURL: env.authUrl,
    secureCookies: env.secureCookies,
  })
  const { id } = await createOwner(auth, {
    email,
    name: nameArg ?? email.slice(0, email.indexOf('@')),
    password,
  })
  console.log(`Владелец создан: ${email} (id ${id}). При первом входе он настроит 2FA.`)
} finally {
  await db.destroy()
}

/** Первая строка стандартного ввода; в терминале вводимые символы не показываются. */
async function readPassword(): Promise<string> {
  const { stdin, stderr } = process
  if (!stdin.isTTY) {
    let input = ''
    for await (const chunk of stdin) input += String(chunk)
    return input.split(/\r?\n/)[0] ?? ''
  }
  stderr.write('Пароль владельца: ')
  stdin.setRawMode(true)
  stdin.setEncoding('utf8')
  return new Promise((resolve) => {
    let value = ''
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.off('data', onData)
          stderr.write('\n')
          resolve(value)
          return
        }
        if (char === '\u0003') {
          // Ctrl+C
          stdin.setRawMode(false)
          process.exit(130)
        }
        value = char === '\u007f' || char === '\b' ? value.slice(0, -1) : value + char
      }
    }
    stdin.on('data', onData)
    stdin.resume()
  })
}
