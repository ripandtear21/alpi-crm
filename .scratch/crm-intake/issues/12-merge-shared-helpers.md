# Общий код слияния контактов и сделок; порядок блокировок

Type: task
Status: open
Blocked by: —
Source: расширенные проверки PR #40 (тикет 02, https://github.com/ripandtear21/alpi-crm/pull/40#issuecomment-7203861626) и PR #39 (тикет 01, https://github.com/ripandtear21/alpi-crm/pull/39#issuecomment-7206484228), группы Consider и Noted; docs/adr/0005-sliyanie-s-otkatom.md

## Что сделать

Слияние контактов (тикет 01) и слияние сделок (тикет 02) написаны копиями друг друга: тикет 02 вводил общие таблицы слияния в форме PR #39, чтобы тот перебазировался без конфликтов. Дефекта копии не несут, но каждое новое правило слияния и отката приходится писать дважды. Поведение не меняется; тесты гонок обоих тикетов (`apps/api/src/merge/merge.test.ts`, `apps/api/src/merge/deal-merge.test.ts`) остаются зелёными без правок ожиданий.

Вынести с параметром вида записи (`contact` | `deal`):

- API: `mergeContext`, `readMergedId`, видимые пользовательские поля предпросмотра, `changesOf`, запрос откатываемых слияний, `hidingMerge`, проверки отката (`apps/api/src/merge/contacts.ts` и `apps/api/src/merge/deals.ts`) — в `apps/api/src/merge/store.ts`; `mergedContactRefusal` (`apps/api/src/contacts/merged.ts`) и `mergedDealRefusal` (`apps/api/src/deals/store.ts`) — одна функция, обход цепочки слитых одним рекурсивным запросом вместо цикла с пределом 100.
- Реестры переноса: `attachedRow(kind, column)` для заметок и файлов и помощник пользовательских полей (`apps/api/src/merge/contact-registry.ts`, `apps/api/src/merge/deal-registry.ts`) — в `apps/api/src/merge/registry.ts`; удаление скрытых сделок контакта — одна функция для `apps/api/src/trash/purgers.ts` и `apps/api/src/deals/dependents.ts`.
- Веб: клиент слияний, окно отката, тексты ошибок, CSS и фейковый API (`apps/web/src/routes/contacts/merge/*`, `apps/web/src/routes/deals/$dealId/merge/*`) — в `apps/web/src/components/merge/`; в журнале (`apps/web/src/routes/settings/audit-page.tsx`) один ключ текста кнопки отката, `undoableMerge` вычисляется один раз на строку, срок отката берётся из `@alpi/shared`, а не копией `UNDO_DAYS`.

Порядок блокировок. Сейчас слияние и откат контактов берут контакты FOR UPDATE, потом пишут в сделки и заметки; слияние и откат сделок, правка заметки, добавление участника, смена основного контакта и восстановление сделки берут сделку или заметку, потом контакт FOR SHARE. Одновременно — взаимоблокировка 40P01 и ответ 500 (данные не меняются). Свести к одному порядку «контакт, потом сделки и заметки» или ловить 40P01 в слиянии и откате и отвечать 409 с повтором; так же для пары «откат слияния сделок — окончательное удаление сделки» и «фоновая очистка контакта — ручное удаление контакта».

## Where in code

apps/api/src/merge/**, apps/api/src/contacts/merged.ts, apps/api/src/deals/store.ts, apps/api/src/deals/dependents.ts, apps/api/src/trash/purgers.ts, apps/api/src/notes/notes.ts, apps/api/src/deals/deals.ts (блокировки участника, основного контакта, восстановления), apps/web/src/routes/contacts/merge/**, apps/web/src/routes/deals/$dealId/merge/**, apps/web/src/components/merge/** (новая), apps/web/src/routes/settings/audit-page.tsx, packages/shared/src/**.

## Done when

- [ ] Общие части слияния контактов и сделок — по одной функции с параметром вида записи; копий в `merge/contacts.ts`, `merge/deals.ts`, реестрах и вебе нет.
- [ ] Тесты слияния и отката контактов и сделок зелёные без изменения ожиданий.
- [ ] Тест на настоящей базе: слияние контактов одновременно с правкой заметки, добавлением участника сделки и откатом слияния сделок того же человека не даёт 500.
- [ ] `pnpm verify` зелёный.
