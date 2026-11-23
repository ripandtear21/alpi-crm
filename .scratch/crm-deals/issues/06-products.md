# Товары и строки товаров в сделке

Type: task
Status: done 2026-11-23T17:38Z
PR: #7
Blocked by: 05
Source: .scratch/crm-build/issues/01-deals-epic-scope.md (Answer, волна 3); .scratch/crm-mvp/spec.md, разделы 3.2 (`product`, `deal_product`), 5.5, 13.0.4

## Что сделать

Миграция (следующий свободный номер миграции), таблицы с `project_id` и RLS:

- `product` — название, цены в EUR, UAH и USD (любая может быть пустой), `archived_at`. Без вариаций и скидок.
- `deal_product` — сделка, товар, количество (больше нуля), цена за единицу в валюте сделки.

Запросы: `/api/v1/products` (каталог: список, создать, изменить, архив; право `products`) и `/api/v1/deals/:id/products` (строки: добавить, изменить, убрать; право «сделки: изменять» в охвате на изменение). При добавлении строки цена подставляется из каталога в валюте сделки, если она там есть; иначе пользователь вводит её. Архивный товар нельзя добавить в новую строку, старые строки с ним остаются.

Строки товаров сумму сделки не меняют (ответ владельца 13.0.4). Ответ сделки несёт «сума по товарах» — сумму строк в валюте сделки; кнопка «підставити» — отдельное действие `POST /api/v1/deals/:id/apply-products-total`, которое записывает эту сумму в сумму сделки и в историю. Смена валюты сделки цены строк не пересчитывает (решено без владельца, подтвердить). Добавление, изменение и удаление строки пишется в историю сделки.

Небольшой экран «Настройки → Товари»: каталог с тремя ценами, архив; uk и ru. Строится на текущих компонентах, если тикет 01 ещё не слит. Строки в карточке сделки — тикет 13.

Тикет не отправляет событий и ничего не делает сам (ADR 0003); события — в эпике API.

## Where in code

packages/db/migrations/**, packages/db/src/schema.ts, apps/api/src/products/**, apps/api/src/deals/** (строки, «підставити»), apps/web/src/routes/settings/**.

## Done when

- [ ] Миграция применяется на чистую базу и откатывается.
  - evidence: test-run pass · `pnpm vitest run packages/db/src/project-isolation.test.ts` exit 0 (in pnpm verify) · windows - · d4743e4092d22b8454bbc029a73627e6d4cd94ce
- [ ] Тест изоляции: товары и строки проекта A не видны в B; товар проекта B нельзя добавить в сделку проекта A.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/products/products.test.ts apps/api/src/deals/lines.test.ts` exit 0 (in pnpm verify) · windows - · d4743e4092d22b8454bbc029a73627e6d4cd94ce
- [ ] Тест прав: менеджер по шаблону видит каталог, но не меняет его (403); строку в сделке вне охвата на изменение добавить нельзя.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/products/products.test.ts apps/api/src/deals/lines.test.ts` exit 0 (in pnpm verify) · windows - · d4743e4092d22b8454bbc029a73627e6d4cd94ce
- [ ] Тест: добавление, изменение и удаление строк не меняет сумму сделки; «сума по товарах» в ответе верна (2 × 100 + 1 × 50,50 = 250,50); «підставити» записывает её в сумму и в историю «было → стало».
  - evidence: test-run pass · `pnpm vitest run apps/api/src/deals/lines.test.ts` exit 0 (in pnpm verify) · windows - · d4743e4092d22b8454bbc029a73627e6d4cd94ce
- [ ] Тест: цена строки берётся из каталога в валюте сделки; при пустой цене в этой валюте без введённой цены — 422; архивный товар в новую строку — 422.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/deals/lines.test.ts` exit 0 (in pnpm verify) · windows - · d4743e4092d22b8454bbc029a73627e6d4cd94ce
- [ ] Экран каталога проверен в браузере на 1280 и 375 px.
- [ ] `pnpm verify` зелёный.
  - evidence: test-run pass · `pnpm verify` exit 0 · windows - · d4743e4092d22b8454bbc029a73627e6d4cd94ce

## Результат

- Миграция `packages/db/migrations/0011_products.ts`: `product` (цены `price_eur`, `price_uah`, `price_usd` numeric(14,2), любая пустая; `archived_at`) и `deal_product` (количество — целое больше нуля, цена за единицу в валюте сделки) под RLS. Составные ключи `(project_id, …)` не дают сослаться на чужой проект; триггер `deal_product_active` не ставит архивный товар в новую строку и в обход API. У роли приложения нет DELETE на `product`; у строки меняются только количество и цена.
- `/api/v1/products`: список (с архивными), создать, изменить (название, цены, `archived`) — права `products` view / create / edit. Запись в журнал опасных действий не ведётся (её нет в тикете).
- `/api/v1/deals/:id/products` (POST, PUT и DELETE `/:lineId`) — право «сделки: изменять» в охвате изменения. Ответ сделки несёт `products` и `productsTotal` («сума по товарах»), `POST /api/v1/deals/:id/apply-products-total` («підставити») пишет сумму в `amount` и в историю; без строк — 422 `DEAL_HAS_NO_PRODUCTS`, чтобы нажатие не обнулило сумму. Изменения строк — запись истории `products` «было → стало» всем списком.
- Экран «Настройки → Товари», uk и ru.
- Смена валюты сделки цены строк не пересчитывает — **решено без владельца, подтвердить**.
- Решено исполнителем без владельца: введённая цена важнее каталожной; количество — целое до 1 000 000; «підставити» без строк — отказ 422.
- Пункт 6 (экран 1280 и 375 px): not verified исполнителем; проверяющий снял экран Playwright на обеих ширинах, тёмной темы в приложении нет (снимки в папке прогона волны, verify-06/screens/products-{1280,375}-light.png). Проверка: VERIFIED, PR #7.
