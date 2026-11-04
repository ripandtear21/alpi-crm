import type { AuthApi, Session } from './auth-api.ts'

// Подставной клиент входа для тестов: сессия в памяти, ответы API задаёт тест.

export const SIGNED_IN: Session = {
  user: { id: 'user-1', email: 'owner@example.test', name: 'Власник', twoFactorEnabled: true },
}

export function fakeAuthApi(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    getSession: async () => SIGNED_IN,
    signIn: async () => ({ ok: true, twoFactor: true }),
    verifyTotp: async () => ({ ok: true }),
    verifyBackupCode: async () => ({ ok: true }),
    enableTwoFactor: async () => ({
      ok: true,
      totpURI: 'otpauth://totp/Alpi%20CRM:owner%40example.test?secret=JBSWY3DPEHPK3PXP',
      secret: 'JBSWY3DPEHPK3PXP',
      backupCodes: ['aaaaa-11111', 'bbbbb-22222'],
    }),
    signOut: async () => {},
    ...overrides,
  }
}
