// Каталог товаров проекта (тикет crm-deals/06; spec.md MVP, раздел 3.2 — `product`): общие типы
// API `/api/v1/products` и экрана «Настройки → Товари».

/** Валюты цен товара — те же, что у сделки. */
export const PRODUCT_CURRENCIES = ['EUR', 'UAH', 'USD'] as const
export type ProductCurrency = (typeof PRODUCT_CURRENCIES)[number]

/** Наибольшая длина названия товара. */
export const MAX_PRODUCT_NAME_LENGTH = 200

/** Цены товара по валютам: null — цены в этой валюте нет. */
export type ProductPrices = Record<ProductCurrency, number | null>

/** Товар в ответах API. */
export interface ProductSummary {
  id: string
  name: string
  prices: ProductPrices
  /** Отметка архива; null — действующий. */
  archivedAt: string | null
  createdAt: string
}

/**
 * Коды ошибок API каталога товаров (вдобавок к PERMISSION_DENIED). INVALID_PRODUCT — тело
 * запроса не той формы, `details.path` — какое поле.
 */
export type ProductsErrorCode = 'INVALID_PRODUCT' | 'PRODUCT_NOT_FOUND'
