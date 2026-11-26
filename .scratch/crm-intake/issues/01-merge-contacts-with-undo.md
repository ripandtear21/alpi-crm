# Слияние контактов с откатом

Type: task
Status: claimed 2026-11-26T23:46Z
Branch: crm-intake/01
Risk: high
Blocked by: —
Source: .scratch/crm-build/issues/07-intake-epic-scope.md (Ответы владельца, пункты 6, 15, 23, 25, 26, 29, 35, 36); docs/adr/0005-sliyanie-s-otkatom.md; docs/adr/0003-crm-ne-menyaet-sdelki-sama.md; GLOSSARY.md («Слияние», «Возможный дубль»); .scratch/crm-intake/spec.md

## Что сделать

Начинается после слияния эпика `crm-api` целиком (`.scratch/crm-intake/spec.md`, «Зависимость от эпика `crm-api`»).

Слияние — ручное объединение двух контактов в один. Второй контакт не стирается: он скрыт с отметкой «слит с X», а CRM запоминает, что перешло, чтобы 30 дней можно было отменить слияние.

Миграция (следующий свободный номер миграции), таблицы с `project_id` и RLS:

- `contact.merged_into_id`, `contact.merged_at` — скрытый контакт и с кем он слит. Скрытый контакт не попадает в списки, поиск, `findContactMatch` (`apps/api/src/contacts/match.ts`), корзину и выборки охвата.
- `contact.possible_duplicate_of` — с каким контактом связана пометка «возможный дубль» (пункт 15; решено без владельца — подтвердить). Создание и правка контакта (`apps/api/src/contacts/contacts.ts`) ставят сюда id найденного по email контакта, когда ставят `possible_duplicate`.
- `merge_record` — общая для контактов и сделок (тикет 02 добавляет тип `deal`): тип записи, id оставшейся и слитой, родительское слияние (для сделок, объединённых в том же действии, — тикет 04), кто и когда объединил, `undo_until` (через 30 дней), кто и когда откатил. Строка не удаляется.
- `merge_moved_item` — что перешло: вид (сделка как основной контакт, участие в сделке, заметка, файл, телефон, email; регистрация — тикет 06), id; заполненные пустые поля оставшегося — поле и значение, которое поставило слияние; снятая пометка «возможный дубль».

Реестр того, что переходит (`apps/api/src/merge/`, по образцу `apps/api/src/contacts/dependents.ts`): каждая связанная с контактом таблица — одна строка реестра с функциями «перенести» и «вернуть». Эпики платежей, задач и Unitalk добавят свои строки.

Слияние — `POST /api/v1/contacts/:id/merge` с `{ merge_contact_id }` (по сессии; `:id` — оставшийся):

- Оба контакта своего проекта, не в корзине, не слиты, разные. Право — «контакты: изменять» с охватом изменения, в который входят оба (пункт 26); иначе 403.
- Если у обоих есть открытые неархивные сделки в одной воронке — пока 409 `MERGE_DEAL_CONFLICT` со списком пар. Тикет 04 заменяет этот отказ слиянием сделок.
- Поля оставшегося не меняются; пустые (фамилия, язык, организация, пустые пользовательские поля) заполняются из второго (пункт 23). Телефоны и email второго, которых нет у оставшегося, переходят к нему не основными.
- Сделки второго (основной контакт и участие), заметки и файлы переходят к оставшемуся — все, и вне охвата пользователя (решено без владельца — подтвердить).
- Если пара связана пометкой «возможный дубль» — пометка снимается (решено без владельца — подтвердить).
- Всё — одной транзакцией: перенос, `merge_record`, `merge_moved_item`, история обоих контактов в `change_log`, запись в журнал проекта (`contact.merged` в `packages/shared/src/audit.ts`), событие `contact.merged` (`contact_id` — оставшийся, `merged_contact_id` — слитый) через `emitEvent`.
- `POST /api/v1/contacts/:id/merge/preview` — то же без записи: что перейдёт, какие поля заполнятся, сколько сделок вне охвата.

Откат — `POST /api/v1/merges/:id/undo` (по сессии; право — как на слияние этих двух контактов сейчас; решено без владельца — подтвердить):

- Возвращает ровно то, что записано в `merge_moved_item`; появившееся у оставшегося после слияния остаётся у него (пункт 29). Скрытый контакт снова виден и доступен по своему id.
- Поле, заполненное слиянием и изменённое после него, не трогается и показывается в итоге отката. Перешедшая запись, которую потом удалили в корзину, возвращается в корзине; окончательно удалённая — пропускается и показывается в итоге (решено без владельца — подтвердить).
- 409 с понятным кодом: прошло 30 дней (`MERGE_UNDO_EXPIRED`); после этого слияния одна из записей слилась ещё раз — сначала откатить позднее (`MERGE_UNDO_BLOCKED` со ссылкой); оставшийся контакт в корзине; вернувшаяся открытая сделка нарушит правило «одна открытая сделка в воронке» (решено без владельца — подтвердить).
- Одной транзакцией: история, журнал (`contact.unmerged`), событие `contact.unmerged` (`contact_id`, `merged_contact_id`).

Слитый контакт по id:

- `GET /api/v1/contacts/:id` и любой запрос к нему по ключу или сессии — 404 с кодом `CONTACT_MERGED` и `merged_into_id` (пункт 25). В цепочке слияний — id последнего оставшегося (решено без владельца — подтвердить).
- Окончательное удаление оставшегося контакта из корзины удаляет и скрытые контакты, слитые в него (`purge_from_trash`; решено без владельца — подтвердить).

Экран (uk, ru; 375 px):

- Карточка контакта: «Об'єднати з…» — поиск контакта, окно подтверждения с направлением (какой остаётся видно, кнопка «поміняти місцями»), предпросмотр, число сделок вне охвата.
- Карточка оставшегося: список слияний за 30 дней с «Скасувати об'єднання» и подтверждением; итог отката с пропущенными и не тронутыми полями.
- Прямая ссылка на слитый контакт: «Контакт об'єднано з X» со ссылкой и кнопкой отката, если она доступна.
- Журнал проекта: запись слияния с «Скасувати об'єднання».

## Where in code

packages/db/migrations/**, packages/db/src/schema.ts, packages/shared/src/audit.ts, packages/shared/src/events/index.ts, apps/api/src/merge/** (новое: слияние, откат, реестр), apps/api/src/contacts/** (скрытые контакты, `CONTACT_MERGED`, `possible_duplicate_of`), apps/api/src/search/**, apps/api/src/trash/**, apps/api/src/deals/** (выборки с контактом), apps/api/src/openapi/**, apps/web/src/routes/contacts/**, apps/web/src/routes/settings/audit-page.tsx, apps/web/src/locales/{uk,ru}/**. Доработка после MAX-REVIEW (круг 3): apps/api/src/timeline/entity.ts, apps/api/src/files/files.ts, apps/api/src/seed/store.ts, apps/api/src/cli/seed.test.ts, apps/api/src/events/events.test.ts.

## Done when

- [ ] Миграция применяется на чистую базу и откатывается.
- [ ] Тест изоляции: `merge_record` и `merge_moved_item` проекта A не видны в контексте B без фильтра в коде; слить контакт A с контактом B другого проекта нельзя (404).
- [ ] Тест прав: без «контакты: изменять» — 403; с охватом «свои», когда один контакт чужой, — 403; откат — те же проверки.
- [ ] Тест слияния: заполненные поля оставшегося не изменились, пустые заполнились; телефоны и email объединились без повторов; сделки (основной контакт и участие), заметки и файлы второго — у оставшегося, в том числе сделка вне охвата пользователя.
- [ ] Тест скрытия: слитый контакт не находится списком, поиском, `findContactMatch` и в корзине; `GET` по его id — 404 `CONTACT_MERGED` с id оставшегося, в цепочке — с id последнего.
- [ ] Тест отката: вернулось ровно перешедшее; заметка и телефон, добавленные после слияния, остались у оставшегося; поле, изменённое после слияния, не тронуто и есть в итоге; слитый контакт снова доступен по id.
- [ ] Тест отказов: открытые сделки в одной воронке — 409 `MERGE_DEAL_CONFLICT`; откат через 31 день — 409 `MERGE_UNDO_EXPIRED`; откат при более позднем слиянии — 409 `MERGE_UNDO_BLOCKED`.
- [ ] Тест событий и журнала: слияние — одно событие `contact.merged`, откат — одно `contact.unmerged`, тела проходят схему каталога; записи в журнале проекта и в истории обоих контактов; слияние, упавшее посередине, не оставляет ни переноса, ни события.
- [ ] Тест пометки: пара «возможный дубль» после слияния без пометки, после отката — снова с пометкой и ссылкой.
- [ ] Экран: «Об'єднати з…» с направлением и предпросмотром, «Скасувати об'єднання» в карточке и журнале, страница слитого контакта; тексты uk и ru; работает на 375 px.
- [ ] `pnpm verify` зелёный.

### Итог (2026-11-26)

Не слит: заблокирован расширенной проверкой. PR #39 (ветка `crm-intake/01`, head 122b239) открыт.

- Обычная проверка: круг 1 — REJECTED (заголовок проекта терялся в `merges-api.tsx`, нет теста блокировки контактов; https://github.com/ripandtear21/alpi-crm/pull/39#issuecomment-7196739925); доработка с переименованием миграции в `0026_merge`; круг 2 — VERIFIED (https://github.com/ripandtear21/alpi-crm/pull/39#issuecomment-7197601813).
- MAX-REVIEW: REJECTED (https://github.com/ripandtear21/alpi-crm/pull/39#issuecomment-7197908199). Три находки уровня med устояли у скептиков, каждая воспроизведена тестом на настоящей базе:
  - откат слияния при цепочке слияний: `merged_at` — время начала транзакции, а откат не проверяет, что оставшийся контакт сам не слит (`packages/db/migrations/0026_merge.ts:140`, `apps/api/src/merge/store.ts:100-114`, `apps/api/src/merge/contacts.ts:519`) — откат проходит, вернувшийся контакт пуст;
  - фоновая очистка корзины удаляет контакт, восстановленный в тот же момент: `delete` в `purge_from_trash` потерял условие `deleted_at is not null` (`packages/db/migrations/0026_merge.ts:41-59`, `apps/api/src/trash/purgers.ts:45-66`);
  - файл или заметка, созданные во время слияния, уходят к скрытому контакту: проверка контакта без блокировки строки (`apps/api/src/timeline/entity.ts:108-121`).
- Решение владельца: доработать эти три пункта (исправления названы в вердикте) или слить как есть. Без решения тикет 02 (слияние сделок) и тикеты, ждущие 01, не запускаются.
- Долги (Consider) и замечания (Noted) — в вердикте расширенной проверки; вопрос владельцу: заметки, файлы и лента слитого контакта отвечают `CONTACT_NOT_FOUND`, а не `CONTACT_MERGED`.

### Доработка, круг 3 (2026-11-27)

Владелец выбрал доработку после слияния тикета 02. Ветка перенесена на `main` с общей инфраструктурой слияния тикета 02 (PR #40): общие файлы — как в `main`, у PR остаётся только часть контактов.

- Миграция контактов — новая `packages/db/migrations/0027_contact_merge.ts` (0026 занят слиянием сделок): столбцы и права контакта, ветка контакта `purge_from_trash`; ветка сделки — байт в байт как в 0026.
- Откат — один маршрут `POST /api/v1/merges/:id/undo` (`apps/api/src/merge/deals.ts`, `mergesRoutes`) с веткой `contact` рядом с `deal`; право «контакты: изменять» проверяет ветка (`undoContactMerge`).
- Находка 1: откат отказывает 409 `MERGE_UNDO_BLOCKED`, если оставшийся сам слит; время слияния — `clock_timestamp()` после блокировок (и в `merge_record`, и в `contact.merged_at`).
- Находка 2: ветка контакта `purge_from_trash` блокирует корень FOR UPDATE, удаляет корень с условием «в корзине» и проверяет его по числу удалённых строк; цепочка слитых — после блокировки корня. Фоновая очистка (`CONTACT_PURGER`) не менялась: скрытые сделки контакта — по-прежнему первыми.
- Находка 3: `entityFor` (`apps/api/src/timeline/entity.ts`) берёт FOR SHARE на строку контакта для записи; загрузка файла — без блокировки на входе и с блокировкой перед записью строки, как у сделки.
- Находка 4: `seed --reset` оставляет контакт seed, в который слит контакт, созданный руками.
- Вместе с переносом: скрытые сделки (тикет 02) не считаются в `MERGE_DEAL_CONFLICT` и в `MERGE_UNDO_DEAL_CONFLICT` — правило «одна открытая сделка в воронке» их не считает.

Долги из вердикта расширенной проверки (https://github.com/ripandtear21/alpi-crm/pull/39#issuecomment-7197908199), не исправлены:

- debt: `GET /contacts/:id/merges` отдаёт имя слитого контакта по охвату только оставшегося (`apps/api/src/merge/contacts.ts`, `contactMerges`) — https://github.com/ripandtear21/alpi-crm/pull/39#issuecomment-7197908199
- debt: отметка «возможный дубль» у третьих контактов, указывающая на скрытый, не перенацеливается на оставшийся (`apps/api/src/merge/contact-registry.ts`, `POSSIBLE_DUPLICATE`) — https://github.com/ripandtear21/alpi-crm/pull/39#issuecomment-7197908199
- debt: «Скасувати об'єднання» в журнале показывается и у уже откаченного слияния (`apps/web/src/routes/settings/audit-page.tsx`, `undoableMerge`) — https://github.com/ripandtear21/alpi-crm/pull/39#issuecomment-7197908199
- debt: повторное чтение и `contactView` оставшегося после слияния (`apps/api/src/merge/contacts.ts`, `mergeContacts`) — https://github.com/ripandtear21/alpi-crm/pull/39#issuecomment-7197908199
- debt: `mergedContactRefusal(...) ?? refuse(404, …)` трижды (`apps/api/src/contacts/contacts.ts`, `apps/api/src/merge/contacts.ts`) — https://github.com/ripandtear21/alpi-crm/pull/39#issuecomment-7197908199
- debt: необязательный `viewer` с недостижимой веткой (`apps/api/src/contacts/contacts.ts`) — https://github.com/ripandtear21/alpi-crm/pull/39#issuecomment-7197908199
- debt: `MERGE_UNDO_DAYS` в журнале копирует `UNDO_DAYS` (`apps/web/src/routes/settings/audit-page.tsx`, `apps/api/src/merge/store.ts`) — место ему в `@alpi/shared` — https://github.com/ripandtear21/alpi-crm/pull/39#issuecomment-7197908199
- debt: подписи полей дважды (`apps/web/src/routes/contacts/merge/merge-dialog.tsx`, `undo-merge.tsx`) — https://github.com/ripandtear21/alpi-crm/pull/39#issuecomment-7197908199
- debt: `participantsOf` копирует `apps/api/src/deals/dependents.ts` (`apps/api/src/merge/contact-registry.ts`) — https://github.com/ripandtear21/alpi-crm/pull/39#issuecomment-7197908199
- debt: `canonical` копирует `apps/api/src/fields/values.ts` (`apps/api/src/merge/registry.ts`) — https://github.com/ripandtear21/alpi-crm/pull/39#issuecomment-7197908199
- debt: откат телефона и email через удаление и вставку вместо `UPDATE` (`apps/api/src/merge/contact-registry.ts`) — https://github.com/ripandtear21/alpi-crm/pull/39#issuecomment-7197908199
- debt: параметр `lock` у `findMerge` всегда `true` (`apps/api/src/merge/store.ts`) — https://github.com/ripandtear21/alpi-crm/pull/39#issuecomment-7197908199
- debt: контекст клиента слияний через `useState` (`apps/web/src/routes/contacts/merge/merges-api.tsx`) — https://github.com/ripandtear21/alpi-crm/pull/39#issuecomment-7197908199
- debt: `onClose` окна отката всегда вызывает `onUndone()` — лишний запрос (`apps/web/src/routes/contacts/merge/undo-merge.tsx`) — https://github.com/ripandtear21/alpi-crm/pull/39#issuecomment-7197908199
- debt: `undoableMerge` считается дважды на строку журнала (`apps/web/src/routes/settings/audit-page.tsx`) — https://github.com/ripandtear21/alpi-crm/pull/39#issuecomment-7197908199
- debt: `permissions` и `viewer` в `MergeActor` реестр контактов не использует (`apps/api/src/merge/registry.ts`) — https://github.com/ripandtear21/alpi-crm/pull/39#issuecomment-7197908199
- debt: цепочка слияний обходится по запросу на шаг (`apps/api/src/contacts/merged.ts`) — https://github.com/ripandtear21/alpi-crm/pull/39#issuecomment-7197908199
- debt: вопрос владельцу — заметки, файлы и лента слитого контакта отвечают `CONTACT_NOT_FOUND`, а не `CONTACT_MERGED` — https://github.com/ripandtear21/alpi-crm/pull/39#issuecomment-7197908199
