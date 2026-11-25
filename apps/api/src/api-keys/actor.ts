// Кто выполняет запрос в контексте проекта (тикет crm-api/01): пользователь по сессии или ключ
// API. Обработчики берут автора записи в журналы отсюда, а не из сессии: у запроса по ключу
// сессии нет.

export type RequestActor = { type: 'user'; userId: string } | { type: 'api_key'; apiKeyId: string }

/** Автор для audit_log и change_log: ровно одно из двух заполнено (ограничение в базе). */
export function requestAuthor(actor: RequestActor): {
  actorId: string | null
  actorApiKeyId: string | null
} {
  return actor.type === 'user'
    ? { actorId: actor.userId, actorApiKeyId: null }
    : { actorId: null, actorApiKeyId: actor.apiKeyId }
}
