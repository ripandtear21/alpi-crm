import type { HealthResponse } from '@alpi/shared'
import { Hono } from 'hono'

export const app = new Hono().get('/health', (c) => c.json<HealthResponse>({ status: 'ok' }))

/** Тип приложения для Hono RPC: клиент (apps/web) получает из него типы маршрутов. */
export type AppType = typeof app
