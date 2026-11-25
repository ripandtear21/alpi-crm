// Остановка процесса API (apps/api/src/index.ts) по SIGTERM и SIGINT. Порядок важен:
// 1. HTTP-сервер перестаёт принимать соединения, и остановка дожидается запросов, которые уже
//    выполняются: изменение сделки пишет событие через очередь событий (events/queue.ts) —
//    отключи её раньше, и такой запрос получил бы 500. Запросы, не успевшие за `drainMs`,
//    обрываются (соединения закрываются), их транзакции откатываются;
// 2. фоновые задачи (jobs.stop): дожидаются текущих обработчиков и только потом отключают
//    очередь событий;
// 3. подключения к базе.

/** Сколько остановка ждёт текущих HTTP-запросов, мс. */
export const HTTP_DRAIN_MS = 10_000

export interface ApiProcess {
  /** HTTP-сервер (@hono/node-server serve). */
  server: {
    close(callback?: (error?: Error) => void): unknown
    closeIdleConnections?(): void
    closeAllConnections?(): void
  }
  jobs: { stop(): Promise<void> }
  db: { destroy(): Promise<void> }
}

/** Останавливает API: HTTP, потом фоновые задачи, потом база (порядок — выше). */
export async function stopApi(api: ApiProcess, drainMs = HTTP_DRAIN_MS): Promise<void> {
  try {
    await closeServer(api.server, drainMs)
    await api.jobs.stop()
  } finally {
    await api.db.destroy()
  }
}

/** Как часто закрывать соединения, освободившиеся после ответа, мс. */
const IDLE_SWEEP_MS = 50

/** Закрывает сервер и ждёт текущих запросов; не дождался за `drainMs` — рвёт соединения. */
function closeServer(server: ApiProcess['server'], drainMs: number): Promise<void> {
  return new Promise((resolve) => {
    // close() закрывает только простаивающие соединения; соединение, ответившее позже, держит
    // keep-alive (по умолчанию 5 с) — его закрываем, как только оно освободилось.
    const sweep = setInterval(() => server.closeIdleConnections?.(), IDLE_SWEEP_MS)
    const timer = setTimeout(() => {
      server.closeAllConnections?.()
      done()
    }, drainMs)
    function done() {
      clearInterval(sweep)
      clearTimeout(timer)
      resolve()
    }
    // Ошибка close — сервер уже не слушал: ждать нечего.
    server.close(done)
  })
}
