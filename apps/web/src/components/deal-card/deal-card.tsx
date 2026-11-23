import type { DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { BoardDeal } from '../../routes/deals/deals-api.ts'
import { Badge } from '../../ui/badge.tsx'
import { Button } from '../../ui/button.tsx'
import { cx } from '../../ui/cx.ts'
import { Menu, type MenuItem } from '../../ui/menu.tsx'
import './deal-card.css'

// Карточка сделки на канбане (тикет crm-deals/11): название (ссылка на карточку сделки),
// основной контакт, сумма с валютой, ответственный или «без відповідального» с кнопкой
// «Взяти в роботу», место под индикатор следующей задачи (заполнит эпик задач) и меню действий
// — смена этапа, выигрыш, проигрыш: на телефоне перетаскивания нет, а с клавиатуры так удобнее.

/** Сумма с валютой по правилам языка интерфейса: «1 200,50 €». */
export function formatMoney(amount: number, currency: string, language: string): string {
  return new Intl.NumberFormat(language === 'ru' ? 'ru-UA' : 'uk-UA', {
    style: 'currency',
    currency,
    // «€», «₴», «$», а не «EUR»: так короче и привычнее на карточке.
    currencyDisplay: 'narrowSymbol',
    // Целые суммы — без «,00».
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount)
}

export interface DealCardProps {
  deal: BoardDeal
  /** Адрес карточки сделки — с кодом проекта (`/p/<код>/deals/<id>`). */
  href: string
  /** Карточку можно перетащить (на телефоне — нет). */
  draggable: boolean
  /** Карточку сейчас тащат: на её месте — пустая рамка. */
  dragging?: boolean
  onDragStart?: () => void
  onDragEnd?: () => void
  actions: MenuItem[]
  /** «Взяти в роботу» — только у сделки без ответственного. */
  onTake?: () => void
}

export function DealCard({
  deal,
  href,
  draggable,
  dragging = false,
  onDragStart,
  onDragEnd,
  actions,
  onTake,
}: DealCardProps) {
  const { t, i18n } = useTranslation('deals')
  return (
    <article
      className={cx(
        'deal-card',
        draggable && 'deal-card--draggable',
        dragging && 'deal-card--dragging',
      )}
      aria-label={deal.title}
      draggable={draggable || undefined}
      onDragStart={(event: DragEvent) => {
        // В happy-dom и старых браузерах dataTransfer может не быть: id хранит сам канбан.
        event.dataTransfer?.setData('text/plain', deal.id)
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
        onDragStart?.()
      }}
      onDragEnd={onDragEnd}
    >
      <a className="deal-card__title" href={href} draggable={false}>
        {deal.title}
      </a>
      {deal.contactName === null ? (
        <span className="deal-card__meta">{t('card.contactHidden')}</span>
      ) : (
        deal.contactName !== deal.title && (
          <span className="deal-card__meta">{deal.contactName}</span>
        )
      )}
      <div className="deal-card__row">
        <span className="deal-card__amount">
          {formatMoney(deal.amount, deal.currency, i18n.language)}
        </span>
        {/* Индикатор следующей задачи: появится с эпиком задач. */}
        <span className="deal-card__task" data-slot="next-task" aria-hidden="true" />
      </div>
      <div className="deal-card__row">
        {deal.ownerId === null ? (
          <span className="deal-card__queue">
            <Badge tone="ask">{t('card.noOwner')}</Badge>
            {onTake && (
              <Button size="sm" variant="secondary" onClick={onTake}>
                {t('card.take')}
              </Button>
            )}
          </span>
        ) : (
          <span className="deal-card__meta">{deal.ownerName}</span>
        )}
        <Menu
          label={t('card.actions', { title: deal.title })}
          icon={<span aria-hidden="true">⋯</span>}
          items={actions}
          variant="quiet"
          size="sm"
          align="end"
        />
      </div>
    </article>
  )
}
