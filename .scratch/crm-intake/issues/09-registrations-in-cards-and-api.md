# Регистрации в карточках и в API

Type: task
Status: done 2026-11-27T18:45Z
PR: #48
Blocked by: 06
Source: .scratch/crm-build/issues/07-intake-epic-scope.md (Ответы владельца, пункты 2, 12, 16, 17, 35); GLOSSARY.md («Регистрация», «Просмотр вебинара»); .scratch/crm-deals/spec.md («Не входит»: заглушка регистраций в карточке сделки); .scratch/crm-api/issues/04-contacts-orgs-reference-for-keys.md (образец запросов для ключа); .scratch/crm-intake/spec.md

## Что сделать

Регистрации видны там, где с ними работают: в карточке сделки и контакта, и внешней автоматизации — через API ключом.

Запросы (`/api/v1`, отметка «доступно ключу»; курсор `?limit=` и `{ data, next_cursor }` по общим правилам `crm-api`):

- `GET /api/v1/registrations/:id` — регистрация со всеми полями пункта 12, `extra`, просмотром (тикет 08), id источника, контакта и сделки (пункт 16).
- `GET /api/v1/deals/:id/registrations` — регистрации сделки, новые сверху (пункт 16).
- `GET /api/v1/contacts/:id/registrations` — регистрации контакта, новые сверху; для карточки контакта, тоже открыт ключу (решено без владельца — подтвердить).
- Право и охват: регистрация видна тому, кто видит её сделку (`deals: view` с охватом чтения); иначе 404, как несуществующая (решено без владельца — подтвердить). Регистрация слитой сделки — у оставшейся.
- Описание API — схемы ответов в `/api/v1/openapi.json`.

Карточки (uk, ru; 375 px; пункт 2):

- Карточка сделки: блок «Реєстрації» вместо заглушки эпика `crm-deals` — список, новые сверху: время, источник, форма, вебинар, тариф; раскрытие — все метки, адрес страницы, `referrer`, `user_agent`, `extra` строками «ключ: значение», просмотр («почав дивитися», «вийшов», «хвилин переглянуто»).
- Карточка контакта: тот же блок по всем сделкам контакта, со ссылкой на сделку.
- Подгрузка по курсору, если регистраций много.

## Where in code

apps/api/src/intake/** или apps/api/src/registrations/** (запросы чтения), apps/api/src/deals/scope.ts, apps/api/src/openapi/**, apps/web/src/routes/deals/$dealId/** (блок вместо заглушки в `deal-sidebar.tsx`), apps/web/src/routes/contacts/$contactId/**, apps/web/src/locales/{uk,ru}/**.

## Done when

- [ ] Тест изоляции: регистрация проекта A по id в контексте B — 404; списки не содержат регистраций B.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/registrations/registrations.test.ts` exit 0 · windows - · ada9feb51e4093c73a5afed6f75fdd36947d8626
  - evidence: test-run pass · `pnpm vitest run apps/api/src/registrations/registrations.test.ts` exit 0 · windows - · c9988442ccea2f8702083911060d2c2c575ed077
- [ ] Тест прав: ключ с ролью без «сделки: смотреть» — 403; роль с охватом «свои» не видит регистрации чужой сделки (404), видит своей; маршруты открыты ключу (нет `API_KEY_NOT_ALLOWED`).
  - evidence: test-run pass · `pnpm vitest run apps/api/src/registrations/registrations.test.ts` exit 0 · windows - · ada9feb51e4093c73a5afed6f75fdd36947d8626
  - evidence: test-run pass · `pnpm vitest run apps/api/src/registrations/registrations.test.ts` exit 0 · windows - · c9988442ccea2f8702083911060d2c2c575ed077
- [ ] Тест списков: новые сверху; курсор отдаёт все регистрации без повторов и пропусков; после слияния сделок регистрации второй — в списке оставшейся.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/registrations/registrations.test.ts` exit 0 · windows - · ada9feb51e4093c73a5afed6f75fdd36947d8626
  - evidence: test-run pass · `pnpm vitest run apps/api/src/registrations/registrations.test.ts` exit 0 · windows - · c9988442ccea2f8702083911060d2c2c575ed077
- [ ] Тест ответа: все поля пункта 12, `extra` и просмотр приходят; описание API совпадает с ответом.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/registrations/registrations.test.ts` exit 0 · windows - · c9988442ccea2f8702083911060d2c2c575ed077
- [ ] Экран: блок регистраций в карточке сделки и контакта, `extra` строками «ключ: значение», просмотр; тексты uk и ru; работает на 375 px.
  - evidence: test-run pass · `pnpm vitest run apps/web/src/routes/deals/$dealId/deal-card-page.test.tsx apps/web/src/routes/contacts/$contactId/contact-card-page.test.tsx` exit 0 · windows - · ada9feb51e4093c73a5afed6f75fdd36947d8626
  - evidence: test-run pass · `pnpm vitest run apps/web/src/routes/deals/$dealId/deal-card-page.test.tsx apps/web/src/routes/contacts/$contactId/contact-card-page.test.tsx` exit 0 · windows - · c9988442ccea2f8702083911060d2c2c575ed077
- [ ] `pnpm verify` зелёный.
  - evidence: test-run pass · `pnpm verify` exit 0 · windows - · ada9feb51e4093c73a5afed6f75fdd36947d8626
  - evidence: test-run pass · `pnpm verify` exit 0 · windows - · c9988442ccea2f8702083911060d2c2c575ed077
