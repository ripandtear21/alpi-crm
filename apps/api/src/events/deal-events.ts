import type { ChangeAuthor } from '../change-log/record.ts'
import { emitEvent } from './emit.ts'

// События сделки по её состоянию до и после изменения (тикет crm-api/05, каталог сделок): один
// вывод для всех путей — карточка и запрос по ключу (deals/deals.ts), массовые операции
// (deals/bulk.ts), передача сделок участника (deals/transfer.ts). Событие — только о том, что
// действительно изменилось; сумма, название, контакт и пользовательские поля событий не дают.

/** То в сделке, о чём пишутся события. */
export interface DealEventState {
  id: string
  pipeline_id: string
  stage_id: string
  /** open, won или lost. */
  status: string
  lost_reason_id: string | null
  owner_id: string | null
  archived_at: Date | string | null
}

/** Новая сделка: `deal.created`. */
export async function emitDealCreated(
  author: ChangeAuthor,
  deal: { id: string; pipeline_id: string; stage_id: string; primary_contact_id: string },
): Promise<void> {
  await emitEvent(author, 'deal.created', {
    deal_id: deal.id,
    pipeline_id: deal.pipeline_id,
    stage_id: deal.stage_id,
    contact_id: deal.primary_contact_id,
  })
}

/**
 * События изменения сделки `before` → `after` той же транзакцией `author.db`: этап (в том числе
 * перенос в другую воронку), статус (выиграна, проиграна, открыта заново), ответственный,
 * архив. Смена причины у уже проигранной сделки — не «проиграна»: события нет.
 */
export async function emitDealChanges(
  author: ChangeAuthor,
  before: DealEventState,
  after: DealEventState,
): Promise<void> {
  const deal_id = after.id
  if (before.pipeline_id !== after.pipeline_id || before.stage_id !== after.stage_id) {
    await emitEvent(author, 'deal.stage_changed', {
      deal_id,
      from: { pipeline_id: before.pipeline_id, stage_id: before.stage_id },
      to: { pipeline_id: after.pipeline_id, stage_id: after.stage_id },
    })
  }
  if (before.status !== after.status) {
    if (after.status === 'won') {
      await emitEvent(author, 'deal.won', { deal_id, stage_id: after.stage_id })
    } else if (after.status === 'open') {
      await emitEvent(author, 'deal.reopened', { deal_id, stage_id: after.stage_id })
    } else {
      if (after.lost_reason_id === null) throw new Error(`сделка ${deal_id} проиграна без причины`)
      await emitEvent(author, 'deal.lost', {
        deal_id,
        stage_id: after.stage_id,
        lost_reason_id: after.lost_reason_id,
      })
    }
  }
  if (before.owner_id !== after.owner_id) {
    await emitEvent(author, 'deal.owner_changed', {
      deal_id,
      from_user_id: before.owner_id,
      to_user_id: after.owner_id,
    })
  }
  if ((before.archived_at === null) !== (after.archived_at === null)) {
    await emitEvent(author, after.archived_at === null ? 'deal.unarchived' : 'deal.archived', {
      deal_id,
    })
  }
}
