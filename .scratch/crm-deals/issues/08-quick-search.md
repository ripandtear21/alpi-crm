# Быстрый поиск

Type: task
Status: done 2026-11-24T05:59Z
PR: #9
Blocked by: 05
Source: .scratch/crm-build/issues/01-deals-epic-scope.md (Answer, волна 3); .scratch/crm-mvp/spec.md, разделы 5.4, 9.1, 13.0.3 (пункты 7 и 32)

## Что сделать

`GET /api/v1/search?q=…` — поиск в пределах текущего проекта по названию сделки, имени и фамилии контакта, телефону в любом формате, email и названию организации. Средства PostgreSQL: расширение `pg_trgm` и индексы (GIN по триграммам) в миграции со следующим свободным номером; отдельного поискового сервиса нет.

- Запрос, похожий на телефон, приводится к E.164 функцией из тикета 03 и ищется по нормализованному номеру.
- Запрос с `@` ищется по email.
- Результаты сгруппированы по типу (сделки, контакты, организации), до 10 в группе, с признаком «есть ещё». Архивные сделки находятся (с пометкой), удалённые в корзину — нет.
- Охват соблюдается в самом запросе: сделки — по охвату на чтение плюс общая очередь; контакты — по охвату контактов из тикетов 03 и 05; организации — по праву «организации: смотреть». Найденное вне охвата не возвращается и не попадает в счётчик «есть ещё».
- Минимум 2 символа; короче — пустой ответ.

Строка поиска в шапке с выпадающими результатами — тикет 15 (результаты ведут на ссылки с проектом).

Тикет не отправляет событий и ничего не меняет в данных (ADR 0003).

## Where in code

packages/db/migrations/**, apps/api/src/search/**, apps/api/src/app.ts.

## Done when

- [x] Тест: контакт с номером `+380671234567` находится по `0671234567`, `067 123 45 67`, `(067) 123-45-67`, `+38 067 123 4567`; по email в другом регистре; по части фамилии с опечаткой в одну букву (триграммы).
  - evidence: test-run pass · `pnpm vitest run apps/api/src/search/search.test.ts` exit 0 · windows - · 9012c6901ac240cdee69b19f90ce1366038e1b2e
  - evidence: test-run pass · `pnpm vitest run apps/api/src/search/search.test.ts` exit 0 · windows - · 3f9afa1cea75b3f8f7af96b8266d2e7a5b051484
  - evidence: review pass · PR #9 · - - · df8e8f521d024fcc78e06e2716764cc9cfa7aa29
- [x] Тест изоляции: контакт проекта B с тем же телефоном не находится в проекте A.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/search/search.test.ts` exit 0 · windows - · 9012c6901ac240cdee69b19f90ce1366038e1b2e
  - evidence: test-run pass · `pnpm vitest run apps/api/src/search/search.test.ts packages/db/src/project-isolation.test.ts` exit 0 · windows - · 3f9afa1cea75b3f8f7af96b8266d2e7a5b051484
  - evidence: review pass · PR #9 · - - · df8e8f521d024fcc78e06e2716764cc9cfa7aa29
- [x] Тест охвата: менеджер «свои» не находит сделку и контакт коллеги, находит сделку общей очереди; счётчик «есть ещё» не учитывает скрытое.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/search/search.test.ts` exit 0 · windows - · 9012c6901ac240cdee69b19f90ce1366038e1b2e
  - evidence: test-run pass · `pnpm vitest run apps/api/src/search/search.test.ts` exit 0 · windows - · 3f9afa1cea75b3f8f7af96b8266d2e7a5b051484
  - evidence: review pass · PR #9 · - - · df8e8f521d024fcc78e06e2716764cc9cfa7aa29
- [x] Тест: архивная сделка находится с пометкой; сделка в корзине — нет.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/search/search.test.ts` exit 0 · windows - · 9012c6901ac240cdee69b19f90ce1366038e1b2e
  - evidence: test-run pass · `pnpm vitest run apps/api/src/search/search.test.ts` exit 0 · windows - · 3f9afa1cea75b3f8f7af96b8266d2e7a5b051484
  - evidence: review pass · PR #9 · - - · df8e8f521d024fcc78e06e2716764cc9cfa7aa29
- [x] Тест: `EXPLAIN` поиска по телефону и по имени на 10 000 сгенерированных контактах использует индекс, а не полный просмотр таблицы.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/search/search.test.ts` exit 0 · windows - · 9012c6901ac240cdee69b19f90ce1366038e1b2e
  - evidence: test-run pass · `pnpm vitest run apps/api/src/search/search.test.ts` exit 0 · windows - · 3f9afa1cea75b3f8f7af96b8266d2e7a5b051484
  - evidence: review pass · PR #9 · - - · df8e8f521d024fcc78e06e2716764cc9cfa7aa29
- [x] `pnpm verify` зелёный.
  - evidence: test-run pass · `pnpm verify` exit 0 · windows - · 9012c6901ac240cdee69b19f90ce1366038e1b2e
  - evidence: test-run pass · `pnpm verify` exit 0 · windows - · 3f9afa1cea75b3f8f7af96b8266d2e7a5b051484
  - evidence: gate pass · `gate fast` exit 0 · windows - · 3f9afa1cea75b3f8f7af96b8266d2e7a5b051484
  - evidence: ci-check pass · https://github.com/ripandtear21/alpi-crm/actions/runs/45335379163 · ci - · df8e8f521d024fcc78e06e2716764cc9cfa7aa29

## Результат

- Миграция `packages/db/migrations/0015_search.ts`: расширение `pg_trgm`, GIN-индексы `gin_trgm_ops` по `deal.title`, по выражению «имя фамилия» контакта, по `contact_phone.phone`, `contact_email.email`, `organization.name`, и представления `deal_search`, `contact_search`, `contact_phone_search`, `contact_email_search`, `organization_search` (id и текст поиска строк текущего проекта, `select` выдан `alpi_app`).
- Почему представления: операторы ILIKE и `<%` не помечены LEAKPROOF, и под политикой row-level security PostgreSQL не делает их условиями индекса — запрос ролью приложения всегда просматривал все строки проекта (проверено планом запроса). Представление выполняется с правами владельца таблиц, само ограничивает строки проектом из `app.project_id` (то же условие, что у политики) и отдаёт только id; корзину, охват и сами строки запрос API читает из таблиц под политикой. Подзапрос кандидатов отделён `OFFSET 0`: иначе PostgreSQL 18 сливает представление с той же таблицей (устранение самосоединения) и индекс снова не работает — это ловит тест плана.
- `GET /api/v1/search?q=…` (`apps/api/src/search/search.ts`, в `v1Routes`): группы `deals`, `contacts`, `organizations` — до 10 в группе и `hasMore`. Короче 2 символов — пустые группы; длиннее 200 — 400 `INVALID_SEARCH`. Группа без права «смотреть» — пустая. Охват — в запросе (берётся 11 строк уже после охвата), корзина не находится, архивная сделка — с `archivedAt`.
- Вид запроса: с «@» — подстрока email контакта (без регистра); цифры с пробелами, скобками, «+», «-», «.» — телефон: приводится к E.164 и ищется точно (обычный индекс `contact_phone_search_idx`), а если не приводится — по цифрам как подстроке номера; остальное — подстрока или похожие слова в названии сделки, имени контакта, названии организации, похожие выше.
- Порог похожести слов (`pg_trgm.word_similarity_threshold`) на время запроса — 0.4 вместо стандартных 0.6: при 0.6 часть фамилии с одной опечаткой в середине не находится («Вигоданенк» к «Вигаданенко» — 0.5).
- Доработка, раунд 1: условие проекта в представлениях `*_search` закрыто тестом в `packages/db/src/project-isolation.test.ts` (раздел «представления поиска *_search для роли приложения»): под ролью приложения внутри проекта A каждое представление отдаёт только строки A, внутри B — только B, без `app.project_id` — ни одной; список представлений `*_search` в схеме сверяется с проверенным. Мутация «условие проекта → `true`» роняет два теста из 22 (exit 1).
- `apps/api/src/deals/deals.test.ts` (вне списка файлов тикета, с согласия оркестратора): тест отката 0010 сначала откатывает 0015_search — представление `deal_search` зависит от `deal`. Порядок откатов в тесте: 0015, 0012, 0011, 0010 (0014_saved_filters на `deal` не ссылается).
- Доработка, раунд 1 (продолжение), после перебазирования на main с тикетами 09–16:
  - Миграция переименована из `0013_search` в `0015_search`. Мигратор Kysely (`packages/db/src/migrate.ts`) создан без `allowUnorderedMigrations`: база, где уже выполнена `0014_saved_filters` (тикет 12), отказалась бы применять `0013`. Тест порядка миграций в `project-isolation.test.ts` ловит обратное переименование: файл `0013_search.ts` роняет два теста из 22 (exit 1).
  - В `e2e/acceptance.spec.ts` сняты оба `test.fixme` тикета 16: шаг 6 (поиск в шапке находит контакт по телефону в трёх форматах) и поисковая часть шага 8 (менеджер «свои» не находит чужих сделок). `pnpm e2e` — 10 из 10. Строка поиска (тикет 15) и ответ API совпали без правок. Мутации проверены: без условия охвата в поиске сделок падает поисковый шаг 8; без ветки «запрос-телефон» падает шаг 6.

Решено без владельца — подтвердить:

- Неполный номер (`067123`, `45 67` — то, что `normalizePhone` не приводит к E.164) ищется по цифрам как подстроке номера в E.164 через триграммы `contact_phone.phone`.
- Запрос-телефон и запрос с «@» ищут только контакты; сделки и организации по ним не ищутся (сделку по телефону её контакта поиск не находит).
- Порог похожести 0.4 (см. выше); «Петренко» к «Вигаданенко» — 0.3, не находится.

### Доведение PR #9 (2026-11-24)

- Ветка перебазирована на main 3677c1a (конфликты в `apps/api/src/app.ts`, `apps/api/src/deals/deals.test.ts`, `packages/db/src/project-isolation.test.ts` решены без потерь кода main). Миграция переименована в `0015_search`: мигратор не принимает миграции не по порядку, а `0014_saved_filters` уже в main. Локальные базы с выполненной `0013_search` нужно пересоздать.
- В тесте приёмки (тикет 16) сняты `test.fixme` с шага 6 и поисковой части шага 8: `pnpm e2e` — 10 passed, CI-задание e2e проверяет поиск.
- Второй раунд проверки: VERIFIED (замечание первого раунда исправлено: подмена условия проекта в `*_search` на `true` краснит 2 теста изоляции). `GATE_SCOPE=all` gate full зелёный, слит squash-коммитом 972043a; CI на `main`: https://github.com/ripandtear21/alpi-crm/actions/runs/45336591460 — success.
- Noted: строки evidence с SHA до перебазирования (bdac89a) убраны этим коммитом документов.
