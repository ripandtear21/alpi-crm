import { isIP } from 'node:net'
import type { Database } from '@alpi/db'
import type { ProjectAuditAction, SystemAuditAction } from '@alpi/shared'
import type { Kysely } from 'kysely'
import type { ProjectEnv } from '../middleware/project-context.ts'

// Запись в журнал (тикет crm-foundation/07; таблицы — packages/db/migrations/0006_audit.ts).
//
// - audit.record — событие проекта. Пишется той же транзакцией проекта, что и само действие:
//   откатилось действие — откатилась и запись, и наоборот, ошибка записи в журнал отменяет
//   действие (опасное действие без следа в журнале хуже, чем отказ).
// - audit.recordSystem — событие вне проекта (вход, 2FA). Отдельный запрос: у Better Auth
//   своя работа с базой, общей транзакции с ним нет.
// Будущие эпики (выгрузка, массовые операции, удаление) зовут audit.record со своим кодом
// действия из packages/shared/src/audit.ts.

/** Событие для записи в журнал. */
export interface AuditEvent<A extends string> {
  action: A
  /** Кто действовал (`user.id`); null — неизвестный пользователь или система. */
  actorId: string | null
  /** Адрес клиента; не адрес (мусор из заголовка) пишется как null. */
  ip: string | null
  /** Над чем действовали: тип и id сущности. */
  entity?: { type: string; id: string }
  /** Подробности, например «было → стало». */
  details?: Record<string, unknown>
}

/** Событие вне проекта; у неудачного входа — ещё email, который вводили. */
export interface SystemAuditEvent extends AuditEvent<SystemAuditAction> {
  attemptedEmail?: string | null
}

/** Наибольшая длина email попытки входа (RFC 5321); длиннее — обрезается. */
const MAX_EMAIL_LENGTH = 320

/** Адрес клиента или null, если строка — не IP-адрес (столбец inet не примет мусор). */
export function normalizeIp(ip: string | null | undefined): string | null {
  return ip && isIP(ip) !== 0 ? ip : null
}

function columns<A extends string>(event: AuditEvent<A>) {
  return {
    action: event.action,
    actor_id: event.actorId,
    ip: normalizeIp(event.ip),
    entity_type: event.entity?.type ?? null,
    entity_id: event.entity?.id ?? null,
    details: JSON.stringify(event.details ?? {}),
  }
}

export const audit = {
  /**
   * Событие проекта. `db` — транзакция проекта (withProject): row-level security пропустит
   * запись только с `projectId` текущего проекта.
   */
  async record(
    db: Kysely<Database>,
    projectId: string,
    event: AuditEvent<ProjectAuditAction>,
  ): Promise<void> {
    await db
      .insertInto('audit_log')
      .values({ project_id: projectId, ...columns(event) })
      .execute()
  },

  /** Событие вне проекта: системный журнал, его читает только владелец системы. */
  async recordSystem(db: Kysely<Database>, event: SystemAuditEvent): Promise<void> {
    const email = event.attemptedEmail?.trim().slice(0, MAX_EMAIL_LENGTH)
    await db
      .insertInto('system_audit_log')
      .values({ ...columns(event), attempted_email: email ? email : null })
      .execute()
  },
}

/**
 * Событие проекта от имени пользователя запроса: проект, автор и адрес — из контекста
 * запроса, запись — в его транзакции проекта.
 */
export function recordInRequest(
  c: { var: ProjectEnv['Variables'] },
  event: Omit<AuditEvent<ProjectAuditAction>, 'actorId' | 'ip'>,
): Promise<void> {
  return audit.record(c.var.db, c.var.projectId, {
    ...event,
    actorId: c.var.session.user.id,
    ip: c.var.clientIp,
  })
}
