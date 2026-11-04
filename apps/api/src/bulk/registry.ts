import type { Database } from '@alpi/db'
import type { Action, Resource, StandalonePermission } from '@alpi/shared'
import type { Transaction } from 'kysely'
import type { MemberAccess } from '../roles/access.ts'
import type { Viewer } from '../roles/scope.ts'

// Реестр массовых действий (тикет crm-deals/04). Каркас (runner.ts) разворачивает выбор, режет
// записи на порции, на каждой порции заново читает роль инициатора и проверяет права; действие
// отвечает только за свои записи: какие попадают под фильтр, какие в охвате, что сделать с
// одной записью. Конкретные действия (архив, передача, смена этапа, удаление) регистрируют
// тикеты 09 и 12 эпика crm-deals.

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
  /** Проверка параметров и фильтра при запуске: текст ошибки — 400, null — годится. */
  validate?(input: {
    params: Record<string, unknown>
    filter?: Record<string, unknown>
  }): string | null
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

/** Код действия («раздел.действие») → действие. */
export type BulkActionRegistry = ReadonlyMap<string, BulkAction>

/**
 * Пустой реестр — для приложения без очереди (NO_BULK). Действия API собирает index.ts:
 * передача сделок (тикет 09), остальные добавляет тикет 12 эпика crm-deals.
 */
export const NO_BULK_ACTIONS: BulkActionRegistry = new Map()
