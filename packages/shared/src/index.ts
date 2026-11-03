// Общие типы сервера и клиента. Типы маршрутов API клиент берёт из apps/api через Hono RPC,
// сюда кладём то, что нужно обеим сторонам независимо от маршрутов.

/** Ответ `GET /health`. */
export interface HealthResponse {
  status: 'ok'
}
