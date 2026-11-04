import type { ProductSummary } from '@alpi/shared'
import type { ProductsApi } from './products-api.ts'
import { RolesApiError } from './roles-api.ts'

// Подставной клиент каталога товаров для тестов: данные в памяти, как их отдаёт API (по
// названию, архивные — с отметкой). `deny` — список отвечает 403, как без права «товари:
// бачити»; `failNextWith` — следующее изменение отклоняется с этим кодом (403).

export interface FakeProductsApi extends ProductsApi {
  products: ProductSummary[]
  failNextWith: string | null
}

let counter = 0
function fakeId(): string {
  counter += 1
  return `00000000-0000-4000-9100-${String(counter).padStart(12, '0')}`
}

/** Каталог из двух товаров: «Курс» с ценами в EUR и UAH и «Вебінар» только в EUR. */
export function fakeProductsApi({ deny = false }: { deny?: boolean } = {}): FakeProductsApi {
  function failIfAsked() {
    const code = api.failNextWith
    if (code) {
      api.failNextWith = null
      throw new RolesApiError(403, code)
    }
  }

  function product(id: string): ProductSummary {
    const found = api.products.find((p) => p.id === id)
    if (!found) throw new RolesApiError(404, 'PRODUCT_NOT_FOUND')
    return found
  }

  const api: FakeProductsApi = {
    products: [
      {
        id: fakeId(),
        name: 'Вебінар',
        prices: { EUR: 50.5, UAH: null, USD: null },
        archivedAt: null,
        createdAt: '2026-11-01T10:00:00.000Z',
      },
      {
        id: fakeId(),
        name: 'Курс',
        prices: { EUR: 100, UAH: 4000, USD: null },
        archivedAt: null,
        createdAt: '2026-11-01T10:00:00.000Z',
      },
    ],
    failNextWith: null,
    async list() {
      if (deny) throw new RolesApiError(403, 'PERMISSION_DENIED')
      return structuredClone([...api.products].sort((a, b) => a.name.localeCompare(b.name, 'uk')))
    },
    async create(_projectId, input) {
      failIfAsked()
      const created: ProductSummary = {
        id: fakeId(),
        name: input.name,
        prices: { EUR: null, UAH: null, USD: null, ...input.prices },
        archivedAt: null,
        createdAt: new Date().toISOString(),
      }
      api.products.push(created)
      return structuredClone(created)
    },
    async update(_projectId, productId, change) {
      failIfAsked()
      const found = product(productId)
      if (change.name !== undefined) found.name = change.name
      if (change.prices !== undefined) found.prices = { ...found.prices, ...change.prices }
      if (change.archived !== undefined) {
        found.archivedAt = change.archived ? new Date().toISOString() : null
      }
      return structuredClone(found)
    },
  }
  return api
}
