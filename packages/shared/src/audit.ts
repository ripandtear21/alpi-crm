// Журнал входов и опасных действий (тикет crm-foundation/07). Коды действий — общие для
// сервера (запись) и клиента (фильтр и подписи на экране журнала). Новое опасное действие
// (выгрузка, массовая операция, окончательное удаление) добавляет сюда свой код вместе с
// местом записи; база проверяет только форму кода «раздел.действие».

/** События проекта: журнал проекта (`audit_log`), виден администратору проекта. */
export const PROJECT_AUDIT_ACTIONS = [
  'role.created',
  'role.updated',
  'role.deleted',
  'member.role_changed',
  'member.added',
  'member.disabled',
  // Тикет crm-foundation/06: участники и команды.
  /** Заведена новая учётная запись с временным паролем и добавлена в проект. */
  'member.created',
  'member.enabled',
  'member.team_changed',
  'team.created',
  'team.updated',
  'team.deleted',
  'team.lead_assigned',
  // Тикет crm-deals/04: массовые операции.
  /** Запущена массовая операция (entity — bulk_job; details — действие и выбор). */
  'bulk.started',
  // Тикет crm-deals/02: воронки, этапы и причины проигрыша.
  'pipeline.created',
  /** Название, код, отметка «воронка допродаж», архив или возврат из архива. */
  'pipeline.updated',
  'pipeline.reordered',
  'stage.created',
  'stage.updated',
  'stage.deleted',
  'stage.reordered',
  'lost_reason_group.created',
  'lost_reason_group.updated',
  'lost_reason_group.reordered',
  'lost_reason.created',
  'lost_reason.updated',
  'lost_reason.reordered',
  /** Стартовая настройка проекта (`pnpm project-preset`): от имени системы. */
  'project.preset_applied',
  // Тикет crm-deals/03: окончательное удаление из корзины (в подробностях — ничего, только id).
  'contact.purged',
  'organization.purged',
  // Тикет crm-deals/12: списки, выгрузка, корзина.
  /** Сделка удалена из корзины окончательно (в подробностях — ничего, только id). */
  'deal.purged',
  /** Выгрузка списка в CSV (details — список, колонки, фильтр и сортировка). */
  'export.downloaded',
  // Тикет crm-fields/01: конструктор полей.
  'field_group.created',
  'field_group.updated',
  'field_group.reordered',
  'field_group.deleted',
  'field.created',
  /** Название, код, тип, группа, видимость, обязательность, отметки. */
  'field.updated',
  'field.reordered',
  'field.archived',
  'field.restored',
  /** Поле без значений удалено сразу. */
  'field.deleted',
  /** Запрошено окончательное удаление поля со значениями (через 30 дней после архива). */
  'field.purge_requested',
  /** Фоновая задача убрала значения поля из всех записей и удалила описание. */
  'field.purged',
  'field_option.created',
  /** Название варианта, архив или возврат из архива. */
  'field_option.updated',
  'field_option.reordered',
  // Тикет crm-api/01: ключи API (entity — api_key; details — название и роль, без секрета).
  'api_key.created',
  /** Новый секрет вместо старого; старый перестал работать сразу. */
  'api_key.reissued',
  'api_key.revoked',
  /**
   * Запрос по ключу API, который изменил данные (автор — ключ; details — метод, путь, ответ).
   * Что именно изменилось — в истории записи (change_log) с тем же автором.
   */
  'api_key.request',
  // Тикет crm-api/06: адреса событий (entity — webhook_endpoint; details — адрес, описание,
  // типы событий, без секрета).
  'webhook_endpoint.created',
  /** Адрес, описание или типы событий. */
  'webhook_endpoint.updated',
  'webhook_endpoint.deleted',
  /** Новый секрет подписи; прежний действует ещё 24 часа. */
  'webhook_endpoint.secret_rotated',
  'webhook_endpoint.enabled',
  /**
   * Адрес отключён: вручную (автор — пользователь) или системой (автора нет; details.reason —
   * gone_410 или failing_5_days).
   */
  'webhook_endpoint.disabled',
  /**
   * Тикет crm-api/09: «догнать события с даты» — details: адрес, дата (since) и сколько событий
   * поставлено в отправку (queued).
   */
  'webhook_endpoint.caught_up',
  // Тикет crm-intake/03: источники регистраций (entity — intake_source; details — название и
  // воронка, без ключа).
  'intake_source.created',
  /** Новый ключ источника вместо старого; старый перестал работать сразу. */
  'intake_source.key_reissued',
  'intake_source.disabled',
  'intake_source.enabled',
] as const
export type ProjectAuditAction = (typeof PROJECT_AUDIT_ACTIONS)[number]

/** События вне проекта: системный журнал (`system_audit_log`), виден владельцу системы. */
export const SYSTEM_AUDIT_ACTIONS = [
  /** Вход завершён: сессия создана (после кода 2FA или по паролю до настройки 2FA). */
  'auth.sign_in',
  /** Пароль верный, ждём код 2FA. Вход ещё не завершён. */
  'auth.password_accepted',
  /** Неверный пароль, неверный код 2FA или заблокированная учётная запись. */
  'auth.sign_in_failed',
  'auth.sign_out',
  'auth.two_factor_enabled',
  'auth.two_factor_disabled',
  'auth.backup_codes_regenerated',
  /** Действия владельца системы с учётными записями (плагин admin). */
  'admin.user_created',
  'admin.role_set',
  'admin.user_banned',
  'admin.user_unbanned',
  'admin.session_revoked',
  'admin.sessions_revoked',
] as const
export type SystemAuditAction = (typeof SYSTEM_AUDIT_ACTIONS)[number]

export type AuditAction = ProjectAuditAction | SystemAuditAction

export function isProjectAuditAction(value: unknown): value is ProjectAuditAction {
  return PROJECT_AUDIT_ACTIONS.some((action) => action === value)
}

export function isSystemAuditAction(value: unknown): value is SystemAuditAction {
  return SYSTEM_AUDIT_ACTIONS.some((action) => action === value)
}

/** Пользователь в записи журнала. */
export interface AuditActor {
  id: string
  name: string
  email: string
}

/** Запись журнала в ответе API. */
export interface AuditEntry<A extends AuditAction = AuditAction> {
  id: string
  /** Время в ISO 8601. */
  occurredAt: string
  /** null — неизвестный пользователь (неудачный вход), ключ API или система. */
  actor: AuditActor | null
  /** Ключ API, по запросу которого действовали (только в журнале проекта); иначе null. */
  apiKey: { id: string; name: string } | null
  ip: string | null
  action: A
  entityType: string | null
  entityId: string | null
  /** Имя пользователя, если сущность — пользователь (entityType 'user'). */
  entityName: string | null
  details: Record<string, unknown>
}

/** Страница журнала: новые сверху; `nextCursor` — для следующей страницы, null — конец. */
export interface AuditPage<A extends AuditAction = AuditAction> {
  items: AuditEntry<A>[]
  nextCursor: string | null
}
