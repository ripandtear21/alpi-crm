# Слияние контактов вместе с конфликтующими сделками

Type: task
Status: done 2026-11-27T11:32Z
PR: #42
Blocked by: 01, 02
Source: .scratch/crm-build/issues/07-intake-epic-scope.md (Ответы владельца, пункты 26, 29, 31, 35, 36); docs/adr/0005-sliyanie-s-otkatom.md; GLOSSARY.md («Слияние», «Сделка»); .scratch/crm-mvp/spec.md, раздел 3.2 (допущение о запрете слияния — заменено пунктом 31); .scratch/crm-intake/spec.md

## Что сделать

Тикет 01 отказывает в слиянии контактов, если у обоих есть открытые неархивные сделки в одной воронке (409 `MERGE_DEAL_CONFLICT`): две такие сделки у одного контакта запрещает база (`deal_one_open_per_contact`). Владелец решил: запрета нет, окно предлагает в том же действии объединить и эти сделки (пункт 31).

Слияние контактов (`POST /api/v1/contacts/:id/merge` и `…/merge/preview` тикета 01):

- Предпросмотр возвращает пары конфликтующих сделок: воронка, обе сделки, какая остаётся.
- По умолчанию остаётся сделка оставшегося контакта; для каждой пары это можно поменять параметром запроса (решено без владельца — подтвердить).
- Конфликтующие пары объединяются в том же действии обязательно: отказаться можно, только отменив всё слияние (решено без владельца — подтвердить; иначе база не даст перенести сделку).
- Нужно ещё «сделки: изменять» с охватом изменения, в который входят обе сделки каждой пары; иначе 403 с кодом `MERGE_DEAL_FORBIDDEN` и без данных чужих сделок (решено без владельца — подтвердить; пункт 26).
- Всё — одной транзакцией: слияние каждой пары сделок функцией тикета 02 (`merge_record` с родительским слиянием контактов), затем слияние контактов. События — `deal.merged` на каждую пару и `contact.merged`.

Откат слияния контактов откатывает и слияния сделок, сделанные в том же действии, одной транзакцией (решено без владельца — подтвердить); события `deal.unmerged` и `contact.unmerged`. Отдельно откатить такое слияние сделок нельзя — 409 со ссылкой на слияние контактов.

Ответ 409 `MERGE_DEAL_CONFLICT` тикета 01 больше не возвращается.

Экран (uk, ru; 375 px): в окне «Об'єднати з…» — блок «Угоди, які теж буде об'єднано»: воронка, две сделки, какая остаётся, «поміняти»; если на сделку нет права — понятное объяснение.

## Where in code

apps/api/src/merge/**, apps/api/src/contacts/**, apps/api/src/deals/**, apps/api/src/openapi/**, apps/web/src/routes/contacts/**, apps/web/src/locales/{uk,ru}/**.

## Done when

- [ ] Тест: два контакта с открытыми сделками в одной воронке объединяются; у оставшегося одна открытая сделка в этой воронке, вторая скрыта «слита с Y»; сделки в разных воронках просто переходят.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/merge/` exit 0 · windows - · bffeeaf710fbfc73f16dcfb02f60c76b3d96ed0b
- [ ] Тест направления: по умолчанию остаётся сделка оставшегося контакта; с параметром — сделка второго.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/merge/` exit 0 · windows - · bffeeaf710fbfc73f16dcfb02f60c76b3d96ed0b
- [ ] Тест прав: без «сделки: изменять» или с охватом, в который не входит одна сделка пары, — 403 `MERGE_DEAL_FORBIDDEN`, ничего не изменилось, данных чужой сделки в ответе нет.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/merge/` exit 0 · windows - · bffeeaf710fbfc73f16dcfb02f60c76b3d96ed0b
- [ ] Тест отката: откат слияния контактов вернул оба контакта и обе сделки как были; отдельный откат вложенного слияния сделок — 409.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/merge/` exit 0 · windows - · bffeeaf710fbfc73f16dcfb02f60c76b3d96ed0b
- [ ] Тест транзакции: ошибка на второй паре откатывает и первую пару, и слияние контактов; событий нет.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/merge/` exit 0 · windows - · bffeeaf710fbfc73f16dcfb02f60c76b3d96ed0b
- [ ] Тест событий: одно действие — `deal.merged` на каждую пару и один `contact.merged`; откат — `deal.unmerged` и `contact.unmerged`.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/merge/` exit 0 · windows - · bffeeaf710fbfc73f16dcfb02f60c76b3d96ed0b
- [ ] Тест изоляции: предпросмотр и слияние не видят сделок другого проекта.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/merge/` exit 0 · windows - · bffeeaf710fbfc73f16dcfb02f60c76b3d96ed0b
- [ ] Экран: блок конфликтующих сделок с выбором остающейся; тексты uk и ru; работает на 375 px.
  - evidence: review pass · PR #42: снимки Playwright verify-04 (светлая и тёмная тема, 375 px и 1440 px, uk и ru, до и после «Поміняти») — https://github.com/ripandtear21/alpi-crm/pull/42#issuecomment-7216689356 · - - · e5c2a6fdaad08f62aa844b4b3caa22edd14d9ed8
- [ ] `pnpm verify` зелёный.
  - evidence: test-run pass · `pnpm verify` exit 0 · windows - · bffeeaf710fbfc73f16dcfb02f60c76b3d96ed0b
  - evidence: gate pass · `gate fast` exit 0 · windows - · bffeeaf710fbfc73f16dcfb02f60c76b3d96ed0b
