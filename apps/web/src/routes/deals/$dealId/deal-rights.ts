import { can, hasStandalone, type ProjectAccess } from '@alpi/shared'
import type { DealCard } from './deal-card-api.ts'

// Что пользователь может сделать с этой сделкой — чтобы не показывать кнопки без права
// (тикет crm-deals/13). Решает всё равно сервер (apps/api/src/deals/deals.ts): здесь только
// видимость кнопок.

export interface DealRights {
  /** Менять поля, этап, статус, участников, товары, заметки и файлы. */
  edit: boolean
  /** Сменить ответственного (право «передача сделок»). */
  transfer: boolean
  /** Взять сделку общей очереди в работу. */
  take: boolean
  /** Удалить сделку в корзину; удалить чужие заметки и файлы. */
  remove: boolean
  /** Создать допродажу из выигранной сделки. */
  upsell: boolean
}

export function dealRights(access: ProjectAccess, deal: DealCard): DealRights {
  const { permissions, userId } = access
  const scope = permissions.scopes.deals.write
  // Сделку общей очереди меняет каждый с правом на сделки; свою — всегда.
  // shortcut: охват «команда» считается подходящим для любой чужой сделки — клиент не знает
  // состава команд; кнопка может оказаться лишней, сервер ответит 403. Переделать, когда
  // ответ сделки или /project/access станет сообщать, в охвате ли запись.
  const inScope = deal.ownerId === null || deal.ownerId === userId || scope !== 'own'
  const edit = can(permissions, 'deals', 'edit') && inScope
  return {
    edit,
    transfer: edit && hasStandalone(permissions, 'transfer_deals'),
    take: edit && deal.ownerId === null,
    remove: can(permissions, 'deals', 'delete') && inScope,
    upsell: can(permissions, 'deals', 'create') && deal.status === 'won',
  }
}
