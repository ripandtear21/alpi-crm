import type { ProductPrices, ProductSummary } from '@alpi/shared'
import { projectHeaders } from '../../components/project-switcher/projects-api.ts'
import { RolesApiError } from './roles-api.ts'

// Запросы каталога товаров к API (apps/api/src/products/products.ts): `/api/v1/products`, в
// контексте проекта. Отказ — RolesApiError с кодом ответа, как у остальных экранов настроек.

export interface ProductInput {
  name: string
  prices: Partial<ProductPrices>
}

/** Изменение товара: названные поля; цена null — убрать цену в этой валюте. */
export interface ProductChange {
  name?: string
  prices?: Partial<ProductPrices>
  archived?: boolean
}

export interface ProductsApi {
  list(projectId: string): Promise<ProductSummary[]>
  create(projectId: string, input: ProductInput): Promise<ProductSummary>
  update(projectId: string, productId: string, change: ProductChange): Promise<ProductSummary>
}

export function createProductsApi(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): ProductsApi {
  async function send<T>(
    projectId: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers = projectHeaders(projectId)
    if (body !== undefined) headers.set('content-type', 'application/json')
    const res = await fetchImpl(`/api/v1${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { code?: unknown } | null
      throw new RolesApiError(res.status, typeof payload?.code === 'string' ? payload.code : '')
    }
    return (await res.json()) as T
  }

  return {
    list: (projectId) => send(projectId, 'GET', '/products'),
    create: (projectId, input) => send(projectId, 'POST', '/products', input),
    update: (projectId, productId, change) =>
      send(projectId, 'PUT', `/products/${productId}`, change),
  }
}
