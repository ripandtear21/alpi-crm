import type { Auth } from './auth.ts'

/** Роль плагина admin у владельца системы: он заводит пользователей и проекты. */
export const OWNER_ROLE = 'admin'

export interface NewOwner {
  email: string
  name: string
  password: string
}

/**
 * Создаёт владельца системы через плагин admin (вызов на сервере, без сессии). 2FA владелец
 * настраивает сам при первом входе: до этого API пускает его только к настройке 2FA.
 */
export async function createOwner(auth: Auth, owner: NewOwner): Promise<{ id: string }> {
  const { user } = await auth.api.createUser({
    body: { email: owner.email, name: owner.name, password: owner.password, role: OWNER_ROLE },
  })
  return { id: user.id }
}
