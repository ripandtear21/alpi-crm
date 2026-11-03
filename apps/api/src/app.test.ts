import { describe, expect, it } from 'vitest'
import { app } from './app.ts'

describe('GET /health', () => {
  it('отвечает 200 и статусом ok', async () => {
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })
})
