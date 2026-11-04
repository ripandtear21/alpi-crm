import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readApiEnv } from './config.ts'

const BASE = {
  DATABASE_URL: 'postgres://alpi_api:x@localhost:5432/alpi_crm',
  BETTER_AUTH_SECRET: 'a'.repeat(32),
  BETTER_AUTH_URL: 'https://crm.example.test',
  STORAGE_DIR: path.resolve('/srv/alpi/files'),
}

describe('readApiEnv', () => {
  it('cookie Secure везде, кроме NODE_ENV=development', () => {
    expect(readApiEnv({ ...BASE, NODE_ENV: 'production' }).secureCookies).toBe(true)
    expect(readApiEnv(BASE).secureCookies).toBe(true)
    expect(readApiEnv({ ...BASE, NODE_ENV: 'development' }).secureCookies).toBe(false)
  })

  it('TRUSTED_PROXIES — адреса и подсети через запятую, по умолчанию пусто', () => {
    expect(readApiEnv(BASE).trustedProxies).toEqual([])
    expect(
      readApiEnv({ ...BASE, TRUSTED_PROXIES: ' 10.0.0.1, 172.16.0.0/12 ,2001:db8::/32,' })
        .trustedProxies,
    ).toEqual(['10.0.0.1', '172.16.0.0/12', '2001:db8::/32'])
  })

  it('отклоняет неверные TRUSTED_PROXIES и недостающие переменные', () => {
    expect(() => readApiEnv({ ...BASE, TRUSTED_PROXIES: '10.0.0.0/33,caddy' })).toThrow(
      /TRUSTED_PROXIES: не адрес и не подсеть CIDR: 10\.0\.0\.0\/33, caddy/,
    )
    expect(() => readApiEnv({ BETTER_AUTH_SECRET: 'short' })).toThrow(
      /DATABASE_URL.*BETTER_AUTH_SECRET.*BETTER_AUTH_URL/,
    )
  })

  it('STORAGE_DIR — абсолютный путь вне каталога приложения', () => {
    const appDir = path.resolve('/srv/alpi/app')
    expect(readApiEnv(BASE, appDir).storageDir).toBe(path.resolve('/srv/alpi/files'))
    expect(() => readApiEnv({ ...BASE, STORAGE_DIR: '' }, appDir)).toThrow(
      /STORAGE_DIR не задана или не абсолютный путь/,
    )
    expect(() => readApiEnv({ ...BASE, STORAGE_DIR: 'files' }, appDir)).toThrow(
      /STORAGE_DIR не задана или не абсолютный путь/,
    )
    for (const inside of [appDir, path.join(appDir, 'dist', 'files')]) {
      expect(() => readApiEnv({ ...BASE, STORAGE_DIR: inside }, appDir)).toThrow(
        /STORAGE_DIR внутри каталога приложения/,
      )
    }
    // Соседний каталог с тем же началом имени — не внутри.
    expect(readApiEnv({ ...BASE, STORAGE_DIR: `${appDir}-files` }, appDir).storageDir).toBe(
      `${appDir}-files`,
    )
  })

  it('по умолчанию каталог приложения — apps/api', () => {
    expect(() =>
      readApiEnv({ ...BASE, STORAGE_DIR: path.resolve(import.meta.dirname, 'files') }),
    ).toThrow(/STORAGE_DIR внутри каталога приложения/)
  })
})
