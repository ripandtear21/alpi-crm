import type { RolePermissions } from '@alpi/shared'
import type { ChangeAuthor } from '../change-log/record.ts'
import type { Viewer } from '../roles/scope.ts'

// Что ещё удаляется вместе с контактом (ответ владельца, пункт 35): контакт, который основной
// в сделках, удаляется только вместе с ними и только после подтверждения их списка.
// Реализация — apps/api/src/deals/dependents.ts, передаётся в createApp({ contactDependents }).
//
// Каждая функция вызывается в транзакции проекта того же запроса (`actor.db`): ошибка
// откатывает и действие с самим контактом (ответ 500).

/** Запись, которая уйдёт в корзину вместе с контактом. */
export interface DependentRecord {
  type: 'deal'
  id: string
  title: string
}

/**
 * Почему с зависимыми записями нельзя сделать то же, что с контактом: открытая сделка стоит
 * на удалённом этапе (`STAGE_DELETED`) или среди записей есть такие, которые пользователь сам
 * восстановить или удалить не может (`PERMISSION_DENIED`, без их данных).
 */
export type DependentRefusal =
  | { code: 'STAGE_DELETED'; dealId: string }
  | { code: 'PERMISSION_DENIED' }

/** Кто удаляет контакт: его права и охват решают, может ли он удалить и зависимые записи. */
export interface DependentsActor extends ChangeAuthor {
  permissions: RolePermissions
  viewer: Viewer
}

export interface ContactDependents {
  /**
   * Записи, которые уйдут в корзину вместе с контактом `contactId`. `forbidden` — среди них
   * есть такие, которые пользователь удалить не может (нет права или вне охвата): тогда
   * список не отдаётся, а удаление контакта запрещено.
   */
  pending(
    actor: DependentsActor,
    contactId: string,
  ): Promise<{ records: DependentRecord[]; forbidden: boolean }>
  /**
   * Контакт `contactId` только что ушёл в корзину с отметкой `deletedAt`. Зависимые записи
   * уходят в корзину с той же отметкой — по ней restore найдёт их.
   */
  trash(actor: ChangeAuthor, contactId: string, deletedAt: Date): Promise<void>
  /**
   * Контакт `contactId` ещё в корзине и сейчас будет восстановлен: восстанавливаются записи,
   * удалённые вместе с ним, — с той же отметкой deleted_at (решение эпика — подтвердить).
   * Не восстановить запись (в том числе нет прав или охвата на неё) — отказ без изменений:
   * тогда и контакт остаётся в корзине.
   */
  restore(actor: DependentsActor, contactId: string): Promise<DependentRefusal | null>
  /**
   * Контакт сейчас будет удалён окончательно: зависимые записи удаляются раньше него. Нет
   * прав или охвата хотя бы на одну — отказ без изменений, контакт остаётся в корзине.
   */
  purge(actor: DependentsActor, contactId: string): Promise<DependentRefusal | null>
}

/** Вместе с контактом удалять нечего: для тестов точки расширения. */
export const NO_CONTACT_DEPENDENTS: ContactDependents = {
  async pending() {
    return { records: [], forbidden: false }
  },
  async trash() {},
  async restore() {
    return null
  },
  async purge() {
    return null
  },
}
