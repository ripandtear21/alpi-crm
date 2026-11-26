# Слияние сделок с откатом

Type: task
Status: claimed 2026-11-26T21:51Z
Risk: high
Blocked by: —
Source: .scratch/crm-build/issues/07-intake-epic-scope.md (Ответы владельца, пункты 26, 29, 30, 35, 36); docs/adr/0005-sliyanie-s-otkatom.md; docs/adr/0003-crm-ne-menyaet-sdelki-sama.md; GLOSSARY.md («Слияние», «Сделка», «Архив»); .scratch/crm-intake/spec.md

## Что сделать

Начинается после слияния эпика `crm-api` целиком (`.scratch/crm-intake/spec.md`, «Зависимость от эпика `crm-api`»).

Слияние сделок — ручное объединение двух сделок в одну, по тем же правилам хранения и отката, что слияние контактов (ADR 0005). Таблицы `merge_record` и `merge_moved_item` и реестр переноса строит тикет 01; тикеты идут в одной волне, поэтому тот, кто сливается вторым, переводит свою часть на общие таблицы и реестр.

Миграция (следующий свободный номер миграции):

- `deal.merged_into_id`, `deal.merged_at` — скрытая сделка и с какой она слита.
- Уникальный индекс `deal_one_open_per_contact` (`packages/db/migrations/0010_deals.ts`) не считает скрытые сделки: условие дополняется `merged_into_id is null`.
- `merge_record` принимает тип `deal`; `merge_moved_item` — виды: заметка, файл, строка товара, участник сделки; регистрации добавит тикет 06.

Слияние — `POST /api/v1/deals/:id/merge` с `{ merge_deal_id }` (по сессии; `:id` — оставшаяся) и `…/merge/preview` без записи:

- Обе сделки своего проекта, не в корзине, не слиты, разные; статус и воронка любые. Право — «сделки: изменять» с охватом изменения, в который входят обе (пункт 26); иначе 403.
- Этап, статус, воронка, ответственный и заполненные поля — оставшейся; пустые поля, в том числе пользовательские, заполняются из второй (пункт 30). Пустая сумма — `0`: тогда сумма и валюта берутся из второй (решено без владельца — подтвердить).
- Заметки, файлы, строки товаров и участники второй переходят в оставшуюся. Строка товара при разной валюте получает цену товара в валюте оставшейся сделки (решено без владельца — подтвердить). Основной контакт второй, если он другой, становится участником оставшейся (решено без владельца — подтвердить).
- История: строки `change_log` не переносятся (таблица только добавляется); лента и история оставшейся показывают и историю второй с пометкой «зі злитої угоди» (решено без владельца — подтвердить).
- Сумма сделки строками товаров не пересчитывается (ADR 0003).
- Одной транзакцией: перенос, записи слияния, история обеих сделок, журнал проекта (`deal.merged`), событие `deal.merged` (`deal_id` — оставшаяся, `merged_deal_id` — слитая) через `emitEvent`.

Откат — тот же `POST /api/v1/merges/:id/undo` тикета 01: возвращает ровно перешедшее, появившееся после слияния остаётся; правила отказов, полей, изменённых после слияния, и записей в корзине — как в тикете 01. Вторая сделка возвращается со своим этапом, статусом и архивом; если она открыта и это нарушит «одна открытая сделка в воронке» — 409 с конфликтующей сделкой (решено без владельца — подтвердить). Событие `deal.unmerged`, журнал `deal.unmerged`.

Слитая сделка по id — 404 с кодом `DEAL_MERGED` и `merged_into_id` (по образцу пункта 25; решено без владельца — подтвердить). Скрытая сделка не попадает в канбан, список, поиск, корзину, агрегаты колонок и выборки по контакту. Окончательное удаление оставшейся сделки из корзины удаляет и скрытые сделки, слитые в неё (решено без владельца — подтвердить).

Экран (uk, ru; 375 px): «Об'єднати з…» в карточке сделки (поиск сделки, направление с «поміняти місцями», предпросмотр); слияния за 30 дней с «Скасувати об'єднання» в карточке оставшейся и в журнале; прямая ссылка на слитую сделку — «Угоду об'єднано з Y».

## Where in code

packages/db/migrations/**, packages/db/src/schema.ts, packages/shared/src/audit.ts, packages/shared/src/events/index.ts, apps/api/src/merge/**, apps/api/src/deals/** (скрытые сделки, `DEAL_MERGED`, канбан и агрегаты), apps/api/src/timeline/** (история второй сделки), apps/api/src/products/**, apps/api/src/search/**, apps/api/src/trash/**, apps/api/src/openapi/**, apps/web/src/routes/deals/**, apps/web/src/locales/{uk,ru}/**.

## Done when

- [ ] Миграция применяется на чистую базу и откатывается.
  - evidence: test-run pass · `pnpm vitest run packages/db/src/project-isolation.test.ts` exit 0 · windows - · a939724
  - evidence: test-run pass · `pnpm vitest run packages/db/src/project-isolation.test.ts` exit 0 · windows - · 92c24de
- [ ] Тест изоляции: слияния сделок проекта A не видны в контексте B без фильтра в коде; слить сделку A со сделкой B другого проекта нельзя (404).
  - evidence: test-run pass · `pnpm vitest run apps/api/src/merge/deal-merge.test.ts` exit 0 · windows - · a939724
  - evidence: test-run pass · `pnpm vitest run apps/api/src/merge/deal-merge.test.ts` exit 0 · windows - · 92c24de
- [ ] Тест прав: без «сделки: изменять» — 403; с охватом «свои», когда одна сделка чужая, — 403; откат — те же проверки.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/merge/deal-merge.test.ts` exit 0 · windows - · a939724
  - evidence: test-run pass · `pnpm vitest run apps/api/src/merge/deal-merge.test.ts` exit 0 · windows - · 92c24de
- [ ] Тест слияния: этап, ответственный и заполненные поля — оставшейся; пустые заполнены из второй; заметки, файлы, строки товаров и участники перешли; основной контакт второй — участник; сумма не пересчитана строками товаров.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/merge/deal-merge.test.ts` exit 0 · windows - · a939724
  - evidence: test-run pass · `pnpm vitest run apps/api/src/merge/deal-merge.test.ts` exit 0 · windows - · 92c24de
- [ ] Тест скрытия: слитая сделка не видна в канбане, списке, поиске, корзине и агрегатах; `GET` по id — 404 `DEAL_MERGED`; после слияния у контакта можно открыть новую сделку в той же воронке, индекс скрытую не считает.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/merge/deal-merge.test.ts` exit 0 · windows - · a939724
  - evidence: test-run pass · `pnpm vitest run apps/api/src/merge/deal-merge.test.ts` exit 0 · windows - · 92c24de
- [ ] Тест истории: лента оставшейся показывает записи второй с пометкой; после отката — только свои.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/merge/deal-merge.test.ts` exit 0 · windows - · a939724
  - evidence: test-run pass · `pnpm vitest run apps/api/src/merge/deal-merge.test.ts` exit 0 · windows - · 92c24de
- [ ] Тест отката: вернулось ровно перешедшее, добавленное после слияния осталось; вторая сделка с прежними этапом, статусом и архивом; откат, который даёт вторую открытую сделку в воронке, — 409.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/merge/deal-merge.test.ts` exit 0 · windows - · a939724
  - evidence: test-run pass · `pnpm vitest run apps/api/src/merge/deal-merge.test.ts` exit 0 · windows - · 92c24de
- [ ] Тест событий и журнала: по одному `deal.merged` и `deal.unmerged`, тела проходят схему; записи в журнале проекта и в истории обеих сделок; упавшее слияние не оставляет ни переноса, ни события.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/merge/deal-merge.test.ts` exit 0, `pnpm vitest run apps/api/src/events/events.test.ts` exit 0 · windows - · a939724
- [ ] Экран: «Об'єднати з…», «Скасувати об'єднання», страница слитой сделки; тексты uk и ru; работает на 375 px.
- [ ] `pnpm verify` зелёный.
  - evidence: gate pass · `gate fast` exit 0, `pnpm verify` exit 0 · windows - · a939724
  - evidence: gate pass · `gate fast` exit 0, `pnpm verify` exit 0 · windows - · 58066a967e37f963706efeab6afb9f19d9865256

## Результат

Решено без владельца — подтвердить:

- Пустая сумма — `0`: если у оставшейся сумма 0, а у второй больше 0, сумма и валюта берутся из второй; откат возвращает их, только если их не меняли после слияния.
- Строка товара второй сделки в другой валюте получает цену товара из каталога в валюте оставшейся (после слияния); если у товара нет цены в этой валюте, строка сохраняет старую цену. Откат возвращает старую цену, если строку не меняли после слияния.
- Основной контакт второй сделки, если он другой, не участник оставшейся и не в корзине, становится участником оставшейся; откат убирает его. Участники второй, которые уже есть у оставшейся, остаются у скрытой сделки.
- История: строки `change_log` не копируются. Лента (`GET /v1/deals/:id/timeline`, у строк `change.mergedDealId`) и история (`GET /v1/deals/:id/history`, `mergedDealId`) оставшейся показывают изменения скрытых сделок (по всей цепочке) с пометкой «зі злитої угоди» / «из слитой сделки». После отката — только свои.
- Откат, после которого у контакта окажутся две открытые сделки в воронке, — 409 `MERGE_UNDO_DEAL_CONFLICT` с `dealId` конфликтующей сделки.
- Слитая сделка по id — 404 `DEAL_MERGED` с `merged_into_id` (последняя оставшаяся в цепочке), `merge_id` и `undo_until`; если оставшаяся вне охвата пользователя — обычный 404 `DEAL_NOT_FOUND`.
- Окончательное удаление оставшейся из корзины удаляет и все скрытые сделки, слитые в неё (по цепочке), их историю и записи слияний. Скрытую сделку напрямую не удалить (404).
- Откат отказывает и в этих случаях: основной контакт скрытой сделки в корзине — 409 `CONTACT_IN_TRASH`; скрытая открытая сделка стоит на удалённом этапе — 409 `STAGE_DELETED`; оставшаяся в корзине — 409 `MERGE_UNDO_SURVIVOR_TRASHED`; оставшаяся сама слита позже или есть более позднее слияние с этими сделками — 409 `MERGE_UNDO_BLOCKED`.
- Скрытые сделки не мешают удалить этап и не считаются в «открытых сделках участника» (`apps/api/src/pipelines/stage-deals.ts`, `apps/api/src/deals/transfer.ts`).
- Откат из журнала проекта: кнопка «Скасувати об'єднання» у записи `deal.merged` моложе 30 дней; можно ли откатить, решает API.

Общая часть для тикета 01: таблицы `merge_record` и `merge_moved_item` и реестр переноса (`apps/api/src/merge/registry.ts`, `store.ts`) вводит этот тикет (миграция 0026), из PR #39 без изменений там, где код общий; время слияния — `clock_timestamp()` после блокировок. `POST /api/v1/merges/:id/undo` ветвится по `entity_type`, права проверяются внутри ветки. PR #39 (тикет 01) после этого переносится на эти таблицы и меняет номер своей миграции.

Вне раздела «Where in code»: `apps/api/src/middleware/permissions.ts` (экспорт `requestAccess` для ветвления отката по типу), `apps/api/src/pipelines/stage-deals.ts` и `apps/api/src/deals/transfer.ts` (скрытые сделки), `apps/web/src/routes/settings/audit-page.tsx` и `apps/web/src/locales/{uk,ru}/audit.json` (журнал).

Подтверждено владельцем:

- 02 идёт раньше PR #39: общие таблицы слияния вводит PR #40 — подтверждено владельцем 2026-11-26.
- Окончательное удаление контакта (ручное и фоновая очистка) стирает его скрытые сделки вместе с цепочкой, в том числе сделки других контактов, и отменяет откат этих слияний — подтверждено владельцем 2026-11-26.

Доработка, круг 2 (расширенная проверка PR #40, https://github.com/ripandtear21/alpi-crm/pull/40#issuecomment-7203861626):

- Загрузка файла больше не держит блокировку FOR SHARE на строке сделки весь поток тела: на входе — проверка без блокировки (`entityFor(…, 'write', { lock: false })`), после `storage.put` — повторная проверка с FOR SHARE прямо перед записью строки `file`. Если запись за время потока слили, убрали в корзину или вывели из охвата — сохранённый файл удаляется из хранилища, ответ как при проверке на входе (404). Заметки и другие короткие записи блокируют, как раньше.
- Сброс демо-данных (`pnpm seed --reset`) не удаляет сделку seed, в которую слита другая сделка: иначе внешний ключ `deal_merged_into_fkey` срывал сброс проекта.

Долг (из расширенной проверки PR #40, https://github.com/ripandtear21/alpi-crm/pull/40#issuecomment-7203861626):

- debt: [low] `apps/api/src/merge/deals.ts:446-452` — откат и слияние блокируют сделки, потом контакт, а удаление контакта в корзину — в обратном порядке: возможна взаимоблокировка 40P01 → 500.
- debt: [low] `apps/api/src/merge/deals.ts:465`, `:482-484` — 409 `MERGE_UNDO_DEAL_CONFLICT` отдаёт `dealId` сделки, которую пользователь может не видеть, в отличие от `OPEN_DEAL_EXISTS` (`apps/api/src/deals/store.ts:478-481`); не утечка, только несогласованность.
- debt: [low] `apps/api/src/deals/store.ts:233` — запись в слитую сделку отвечает `DEAL_NOT_FOUND`, а не `DEAL_MERGED`.
- debt: упрощение — повтор запроса `hidingMerge` (`apps/api/src/merge/deals.ts:406`) и `mergedDealRefusal` (`apps/api/src/deals/store.ts:301-309`).
- debt: упрощение — обход цепочки слияний циклом (`apps/api/src/deals/store.ts:285`) вместо рекурсивного запроса.
- debt: упрощение — удаление скрытых сделок написано дважды (`apps/api/src/trash/purgers.ts:71-82`, `apps/api/src/deals/dependents.ts:180-191`).
- debt: упрощение — `errorText` повторяет `useMergeErrorText` (`merge-deal-dialog.tsx:83-86`).
- debt: упрощение — копия `UNDO_DAYS` и двойной вызов `undoableDealMerge` (`apps/web/src/routes/settings/audit-page.tsx:27`, `:341`).
- debt: упрощение — приведение типа `mergedDealId` (`deal-changes.tsx:120-124`, тип в `timeline-api.ts:28`).
- debt: упрощение — `openDealConflict` повторяет `openDealExists`.
- debt: упрощение — поиск сделок в `deal-merges-api.tsx:61-67` повторяет `search-api.ts`.
- debt: упрощение — второй запрос названий в `dealMerges` (`apps/api/src/merge/deals.ts:353-371`).
- debt: упрощение — лишний массив `ordered` (`apps/api/src/deals/dependents.ts:178-184`).
