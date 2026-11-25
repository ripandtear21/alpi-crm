import type { Database } from '@alpi/db'
import {
  type Action,
  can,
  hasStandalone,
  type Resource,
  type RolePermissions,
  type StandalonePermission,
} from '@alpi/shared'
import type { Kysely, Transaction } from 'kysely'
import type { MemberAccess } from '../roles/access.ts'
import type { Viewer } from '../roles/scope.ts'

// Реестр массовых действий (тикет crm-deals/04). Каркас (runner.ts) разворачивает выбор, режет
// записи на порции, на каждой порции заново читает роль инициатора и проверяет права; действие
// отвечает только за свои записи: какие попадают под фильтр, какие в охвате, что сделать с
// одной записью. Конкретные действия (архив, передача, смена этапа, удаление) регистрируют
// тикеты 09 и 12 эпика crm-deals. Право запуска и продолжения — bulkAllowed ниже: его
// проверяют и маршрут запуска, и каждая порция.

/** С чем действие работает: инициатор и его права на момент текущей порции. */
export interface BulkContext {
  bulkJobId: string
  initiatorId: string
  access: MemberAccess
  viewer: Viewer
  /** Параметры действия из запроса запуска (новый ответственный, этап…). */
  params: Record<string, unknown>
}

/** Ошибка действия по одной записи: запись не меняется, код и текст идут в журнал операции. */
export class BulkRecordError extends Error {
  /** Код вида ARCHIVED, STAGE_NOT_FOUND: заглавные латинские буквы, цифры и «_». */
  readonly code: string

  constructor(code: string, message?: string) {
    super(message ?? code)
    this.name = 'BulkRecordError'
    this.code = code
  }
}

/**
 * Фильтр выбора больше не годится правам инициатора на момент старта: например, поле условия
 * с запуска ушло в архив или стало скрытым (тикет crm-fields/07). Каркас останавливает операцию
 * целиком (`FILTER_UNAVAILABLE`) и не трогает ни одной записи: повтор задачи этого не исправит,
 * а выбор без условия был бы шире заказанного.
 */
export class BulkSelectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BulkSelectionError'
  }
}

/** Массовое действие. Все методы получают транзакцию проекта: RLS показывает только его строки. */
export interface BulkAction {
  /** Право части системы, без которого действие не запускается и не продолжается. */
  requires: { resource: Resource; action: Action }
  /**
   * Отдельное право вместо «массовых операций» (`bulk_operations`) — при запуске и на каждой
   * порции. Передаче сделок участника хватает «передачи сделок» (тикет 09): у тимлида нет
   * массовых операций, а передавать сделки своей команды он может. Решено без владельца —
   * подтвердить.
   */
  standalone?: StandalonePermission
  /**
   * Отдельное право сверх «массовых операций» (или `standalone`): массовая передача сделок из
   * списка (тикет 12) требует и «массовые операции», и «передачу сделок».
   */
  alsoRequires?: StandalonePermission
  /**
   * Проверка параметров и фильтра при запуске: текст ошибки — 400, null — годится. `db` —
   * транзакция проекта запроса, `permissions` — роль инициатора: по ним фильтр проверяется
   * с каталогом пользовательских полей, которые инициатор видит.
   */
  validate?(input: {
    params: Record<string, unknown>
    filter?: Record<string, unknown>
    db: Kysely<Database>
    permissions: RolePermissions
  }): string | null | Promise<string | null>
  /** id записей по фильтру, в порядке обработки. */
  select(
    trx: Transaction<Database>,
    filter: Record<string, unknown>,
    ctx: BulkContext,
  ): Promise<string[]>
  /** Какие из `ids` инициатор может менять: охват изменений его текущей роли. */
  inScope(
    trx: Transaction<Database>,
    ids: readonly string[],
    ctx: BulkContext,
  ): Promise<ReadonlySet<string>>
  /** Изменить одну запись. Исключение откатывает только эту запись, остальные идут дальше. */
  apply(trx: Transaction<Database>, id: string, ctx: BulkContext): Promise<void>
}

/** Разрешено ли действие правами `permissions`: отдельное право, право части системы, ещё одно. */
export function bulkAllowed(permissions: RolePermissions, action: BulkAction): boolean {
  return (
    hasStandalone(permissions, action.standalone ?? 'bulk_operations') &&
    (action.alsoRequires === undefined || hasStandalone(permissions, action.alsoRequires)) &&
    can(permissions, action.requires.resource, action.requires.action)
  )
}

/** Код действия («раздел.действие») → действие. */
export type BulkActionRegistry = ReadonlyMap<string, BulkAction>

/**
 * Пустой реестр — для приложения без очереди (NO_BULK). Действия API собирает index.ts:
 * передача сделок (тикет 09), остальные добавляет тикет 12 эпика crm-deals.
 */
export const NO_BULK_ACTIONS: BulkActionRegistry = new Map()
