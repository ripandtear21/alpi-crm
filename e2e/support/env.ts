import { readFileSync } from 'node:fs'

// Общее для стенда (stack.ts), global-setup.ts и тестов: как стенд сообщает о готовности и
// где тесты берут адрес клиента и учётные данные тестовых пользователей.

/** Строка готовности стенда в stdout: дальше — JSON `StackInfo`. */
export const READY_PREFIX = 'E2E_READY '

/** Переменная окружения, в которой global-setup передаёт тестам `StackInfo`. */
export const STACK_ENV = 'ALPI_E2E_STACK'

export interface StackInfo {
  /** Адрес клиента: его открывает браузер. */
  baseURL: string
  /** Файл учётных данных тестовых пользователей (формат .seed-credentials.json). */
  credentialsFile: string
}

/** Пользователь тестовых данных (apps/api/src/seed/users.ts, SeedCredential). */
export interface SeedUser {
  email: string
  name: string
  role: 'admin' | 'teamlead' | 'manager'
  password: string
  totpSecret: string
}

export function stackInfo(): StackInfo {
  const raw = process.env[STACK_ENV]
  if (!raw) throw new Error(`нет ${STACK_ENV}: тесты запускаются через pnpm e2e (global-setup)`)
  return JSON.parse(raw) as StackInfo
}

export function seedUser(email: string): SeedUser {
  const file = JSON.parse(readFileSync(stackInfo().credentialsFile, 'utf8')) as {
    users: SeedUser[]
  }
  const user = file.users.find((u) => u.email === email)
  if (!user) throw new Error(`в тестовых данных нет пользователя ${email}`)
  return user
}
