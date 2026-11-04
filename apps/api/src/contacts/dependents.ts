import type { Database } from '@alpi/db'
import type { Kysely } from 'kysely'

// Что ещё удаляется вместе с контактом (ответ владельца, пункт 35): контакт, который основной
// в сделках, удаляется только вместе с ними. Сделок ещё нет — правило подключит тикет 05,
// реализовав этот интерфейс и передав его в createApp({ contactDependents }).
//
// Каждая функция вызывается в транзакции проекта того же запроса, после изменения самого
// контакта: ошибка откатывает и удаление контакта (ответ 500).

export interface ContactDependents {
  /**
   * Контакт `contactId` только что ушёл в корзину с отметкой `deletedAt`. Зависимые записи
   * уходят в корзину с той же отметкой — по ней restore найдёт их.
   */
  trash(db: Kysely<Database>, contactId: string, deletedAt: Date): Promise<void>
  /**
   * Контакт восстановлен из корзины; `deletedAt` — отметка, с которой он был удалён.
   * Восстанавливаются записи, удалённые вместе с ним (решение эпика — подтвердить).
   */
  restore(db: Kysely<Database>, contactId: string, deletedAt: Date): Promise<void>
  /** Контакт сейчас будет удалён окончательно: зависимые записи удаляются раньше него. */
  purge(db: Kysely<Database>, contactId: string): Promise<void>
}

/** До эпика сделок: вместе с контактом удалять нечего. */
export const NO_CONTACT_DEPENDENTS: ContactDependents = {
  async trash() {},
  async restore() {},
  async purge() {},
}
