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
  /** null — неизвестный пользователь (неудачный вход) или система. */
  actor: AuditActor | null
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
