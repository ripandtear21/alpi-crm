// Ход и итог «провести заново входящие с момента T» (тикет crm-intake/07): ответ
// `GET /api/v1/inbound/replay` для экрана «Налаштування → Джерела». Запуск и итог берутся из
// журнала проекта (`inbound.replay_started`, `inbound.replay_finished`, intake/replay.ts).

/** Последний запуск «провести заново» в проекте. */
export interface InboundReplayRun {
  /** Входящие с этого момента… */
  since: string
  /** …до этого (момент запуска). */
  until: string
  startedAt: string
  /** Кто запустил; null — пользователь неизвестен. */
  startedBy: { id: string; name: string } | null
  /** null — задача ещё идёт. */
  finishedAt: string | null
  /**
   * Итог: сколько строк журнала проведено с каким итогом (`accepted`, `repeats`, `errors`, …);
   * null — задача ещё идёт.
   */
  counts: Record<string, number> | null
}

/** Ответ `GET /api/v1/inbound/replay`: последний запуск; null — запусков не было. */
export interface InboundReplayStatus {
  latest: InboundReplayRun | null
}
