# Общие правила `/api/v1`: ошибки RFC 9457, курсоры, Idempotency-Key, лимит запросов, OpenAPI

Type: task
Status: done 2026-11-25T21:48Z
PR: #29
Blocked by: —
Source: .scratch/crm-build/issues/03-automation-api-contract.md (Answer: «Общие правила», волна 1); .scratch/crm-mvp/spec.md, раздел 13.0.4 («REST API под любой инструмент автоматизации»); .scratch/crm-deals/issues/11-kanban.md, 12-lists-filters-bulk.md (курсоры); .scratch/crm-api/spec.md

## Что сделать

Начинается после слияния эпиков `crm-deals` и `crm-fields` целиком (`.scratch/crm-api/spec.md`, «Зависимость от эпиков»). Тикет вводит общие для всех маршрутов `/api/v1` правила и приводит к ним уже существующие маршруты эпиков `crm-deals` и `crm-fields`. Новых действий со сделками здесь нет.

Формат:

- JSON в теле запроса и ответа, `application/json; charset=utf-8`; время — ISO 8601 в UTC. Версия в пути: в `/api/v1` изменения только добавляют поля и маршруты; ломающее изменение — новая версия.

Ошибки — RFC 9457 (problem details), `Content-Type: application/problem+json`:

- Члены `type`, `title`, `status`, `detail` и расширения `code` (машинный код, как сейчас: `PERMISSION_DENIED`, `OPEN_DEAL_EXISTS`…) и `errors` — список `{ field, code, message }` для ошибок проверки (поле — путь в теле, например `custom.holovnyi_motyv`). Ошибка обязательных полей этапа (тикет 04 эпика `crm-fields`) отдаёт список полей в `errors`.
- Одна функция ответа ошибкой в `apps/api/src/http/`; ответы `c.json({ code }, …)` переходят на неё на всех маршрутах `/api/v1` — и для сессии, и для ключа. Поле `code` остаётся, поэтому клиент `apps/web` продолжает читать ошибку по нему (решено без владельца — подтвердить, что формат общий и для сессии).
- 500 не раскрывает подробностей: `code: INTERNAL`, без стека.

Курсорная выдача — один формат для всех списков:

- Запрос `?limit=` (1–200, по умолчанию 50) и `?cursor=`; ответ `{ "data": [...], "next_cursor": "…" | null }`. Курсор непрозрачный (base64url от сортировки и id), стабилен при равных значениях сортировки. Неверный курсор — 400.
- Списки эпиков `crm-deals` и `crm-fields`, которые уже отдают курсор, приводятся к этому формату вместе с клиентом `apps/web`.

`Idempotency-Key` (решено без владельца — подтвердить: методы, срок, область, правила):

- Необязательный заголовок у `POST` и `PATCH`, 1–255 символов. Таблица `idempotency_record` (следующий свободный номер миграции, `project_id`, RLS): автор (ключ API или пользователь), значение заголовка, отпечаток запроса (метод, путь, тело), код и тело ответа, время. Уникальна по (проект, автор, значение).
- Повтор с тем же значением и тем же запросом в течение 24 часов возвращает сохранённый ответ с заголовком `Idempotent-Replayed: true` и ничего не меняет. То же значение с другим запросом — 422 `IDEMPOTENCY_KEY_REUSED`. Два одновременных одинаковых запроса дают одно изменение: второй ждёт первого и получает его ответ, либо получает 409 `IDEMPOTENCY_IN_PROGRESS`.
- Сохраняются ответы 2xx и 4xx; 5xx не сохраняется — такой запрос можно повторить.
- Запись ответа — в той же транзакции проекта, что изменение: откат изменения откатывает и запись.
- Ночная задача pg-boss удаляет записи старше 24 часов.

Лимит запросов:

- 600 запросов в минуту на ключ API (запросы по сессии лимитом не ограничены). Сверх лимита — 429 `RATE_LIMITED` с `Retry-After` в секундах; в каждом ответе ключу — заголовки `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`.
- Счётчик — в памяти процесса API, окно в одну минуту (решено без владельца — подтвердить: в MVP процесс API один; при нескольких процессах счётчик переезжает в базу).

Описание API — OpenAPI 3.1, построенное из кода:

- Маршрут описывается схемой, которая же проверяет запрос: описание не может разойтись с проверкой. Библиотеку выбирает тикет (например `hono-openapi` или `@hono/zod-openapi`); условие выбора — одна схема на проверку и описание, совместимость с Hono RPC клиента.
- `GET /api/v1/openapi.json` и страница `/api/v1/docs` для браузера, n8n и Make. Открыты без входа, данных не содержат, описывают только маршруты, доступные ключу (решено без владельца — подтвердить). Схема безопасности — `bearer`. Описание маршрутов наполняют тикеты 03 и 04; здесь — механизм и описание ошибок, курсора, `Idempotency-Key` и лимита.
- Примеры в описании — только выдуманные данные.

Проверка: нужна линза безопасности (`security`): `Idempotency-Key` одного автора не должен вернуть ответ другому автору или проекту.

## Where in code

apps/api/src/http/** (ошибки, курсор, идемпотентность, лимит), apps/api/src/openapi/**, apps/api/src/app.ts, apps/api/src/deals/**, apps/api/src/contacts/**, apps/api/src/fields/** и прочие маршруты `/api/v1` (переход на общую функцию ошибок и формат курсора), apps/api/src/jobs/** (очистка), packages/db/migrations/**, packages/db/src/schema.ts, packages/shared/src/** (типы ошибки и страницы), apps/web/src/** (чтение ошибки и курсора).

## Done when

- [ ] Миграция применяется на чистую базу и откатывается.
  - evidence: test-run pass · `pnpm vitest run packages/db/src/project-isolation.test.ts` exit 0 (pnpm verify) · windows - · 82baa11
  - evidence: review pass · PR #29 · - - · 70b6ff15748b4e23a0bc53f06c3d6023b881d2b5
- [ ] Тест изоляции: записи `idempotency_record` проекта A не видны в контексте B; одинаковое значение `Idempotency-Key` у двух авторов или двух проектов — два независимых запроса.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/http/http.test.ts` exit 0 · windows - · 82baa11
  - evidence: review pass · PR #29 · - - · 70b6ff15748b4e23a0bc53f06c3d6023b881d2b5
- [ ] Тест ошибок: 400, 401, 403, 404, 409, 422 и 429 отдают `application/problem+json` с `type`, `title`, `status`, `code`; ошибка проверки — с `errors[].field`; 500 — без стека. Тест проходит по всем маршрутам `/api/v1` (обход списка маршрутов, а не выборочно).
  - evidence: test-run pass · `pnpm vitest run apps/api/src/http/http.test.ts` exit 0 · windows - · 82baa11
  - evidence: test-run pass · `pnpm verify` exit 0 (тела ошибок сравниваются строго, мутант leakedRowId красный) · windows - · 9f99c943ad65c157d0a648d061486a635c56096e
  - evidence: review pass · PR #29 · - - · 70b6ff15748b4e23a0bc53f06c3d6023b881d2b5
- [ ] Тест курсора: 120 записей с равным значением сортировки читаются страницами по 50 ровно по одному разу; неверный курсор — 400.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/http/http.test.ts` exit 0 · windows - · 82baa11
  - evidence: review pass · PR #29 · - - · 70b6ff15748b4e23a0bc53f06c3d6023b881d2b5
- [ ] Тест идемпотентности: повтор `POST` с тем же ключом и телом возвращает тот же ответ с `Idempotent-Replayed: true`, вторая сделка не создана; тот же ключ с другим телом — 422; 10 параллельных одинаковых запросов создают одну сделку; ответ 500 не сохранён; запись старше 24 часов удаляется задачей.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/http/http.test.ts apps/api/src/jobs/jobs.test.ts` exit 0 · windows - · 82baa11
  - evidence: review pass · PR #29 · - - · 70b6ff15748b4e23a0bc53f06c3d6023b881d2b5
- [ ] Тест лимита: 601-й запрос ключа за минуту — 429 с `Retry-After`; другой ключ в ту же минуту не ограничен; запросы по сессии не ограничены.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/http/http.test.ts` exit 0 · windows - · 82baa11
  - evidence: review pass · PR #29 · - - · 70b6ff15748b4e23a0bc53f06c3d6023b881d2b5
- [ ] `GET /api/v1/openapi.json` без входа отдаёт описание, которое проходит проверку валидатором OpenAPI 3.1; в нём нет маршрутов, недоступных ключу; страница `/api/v1/docs` открывается.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/http/http.test.ts` exit 0 · windows - · 82baa11
  - evidence: test-run pass · `pnpm vitest run apps/api/src/http/http.test.ts -t docs` exit 0 (integrity, crossorigin, CSP) · windows - · 9f99c943ad65c157d0a648d061486a635c56096e
  - evidence: review pass · PR #29 · - - · 70b6ff15748b4e23a0bc53f06c3d6023b881d2b5
- [ ] Клиент `apps/web` показывает ошибки и подгружает списки в новом формате (существующие тесты и `pnpm e2e` зелёные).
  - evidence: test-run pass · `pnpm e2e` exit 0, `pnpm --filter @alpi/web exec vitest run` exit 0 · windows - · 82baa11
  - evidence: review pass · PR #29 · - - · 70b6ff15748b4e23a0bc53f06c3d6023b881d2b5
- [ ] `pnpm verify` зелёный.
  - evidence: test-run pass · `pnpm verify` exit 0 · windows - · 82baa11
  - evidence: gate pass · `gate fast` exit 0 · windows - · 82baa11
  - evidence: test-run pass · `pnpm verify` exit 0 · windows - · 9f99c943ad65c157d0a648d061486a635c56096e
  - evidence: gate pass · `gate fast` exit 0 · windows - · 9f99c943ad65c157d0a648d061486a635c56096e
  - evidence: review pass · PR #29 · - - · 70b6ff15748b4e23a0bc53f06c3d6023b881d2b5
  - evidence: ci-check pass · https://github.com/ripandtear21/alpi-crm/actions/runs/45704456904 · ci - · 70b6ff15748b4e23a0bc53f06c3d6023b881d2b5

## Результат

PR #29, squash 0fdbed3 (2026-11-25).

- Проверка, круг 1 (verify-02): REJECTED — две находки med: (1) замена `toEqual` на `toMatchObject` в ~140 проверках тел ошибок перестала ловить лишние поля (мутация `details.leakedRowId` не краснела в `access.test.ts` и `roles.test.ts`, в том числе тест crm-fields/03 «скрытое поле отвечает так же, как несуществующее»); (2) `/api/v1/docs` грузил Scalar с CDN без `integrity` и без CSP на адресе приложения, где действует сессионная cookie.
- Доработка (раунд 1): помощник `apps/api/src/testing/problem.ts` проверяет `type`/`title`/`status` и отдаёт остаток в строгий `toEqual`; тесты маршрутов вне `/v1` вернулись к `toEqual({ code })`. `/api/v1/docs` грузит точный файл `standalone.js` 1.84.0 с `integrity` sha384 и `crossorigin`, ответ несёт CSP (`script-src` — только этот файл и хеш встроенного элемента, `connect-src 'self'`, `default-src 'none'`), шрифты Scalar отключены.
- Проверка, круг 2 (verify-02-r2): VERIFIED — мутация `leakedRowId` во всех ошибках делает красными 102 теста, хеш sha384 совпал с файлом с CDN и из npm, страница под CSP отрисовывается в Chromium.
- Перед мержем: CI ci-ok зелёный, `GATE_SCOPE=all` gate full на 70b6ff1 — exit 0, `[gate] green (full)`.
- Решено без владельца, подтвердить: под CSP на `/api/v1/docs` не работают функции Scalar, которые ходят на его серверы (прокси «Test Request» к чужим адресам, вход, Ask AI); «Test Request» к своему адресу работает.
- Открытый вопрос из spec.md («Расхождения источников»): маршруты фундамента вне `/api/v1` (`/roles`, `/members`, `/teams`, `/projects`, `/audit`) отвечают ошибками своих обработчиков в прежнем виде `{ code }`, а ошибки общих слоёв — уже problem+json; формат смешанный.

Consider (долги):
- [low] `HTTPException` 4xx внутри `/v1` откатывает транзакцию вместе с записью идемпотентности — повтор выполнится заново, а не вернёт сохранённый ответ (`apps/api/src/app.ts`, `apps/api/src/http/idempotency.ts`); двойного изменения нет.
- [low] параллельные запросы с одним `Idempotency-Key` держат по соединению пула (max 10) до 10 с — при большом числе одинаковых запросов пул может кончиться.
- [low] ветка 409 `IDEMPOTENCY_IN_PROGRESS` не покрыта тестом.

Noted:
- [low] поле `problem` в 400 `INVALID_PARAMS` массовой операции переименовано в `detail` (`apps/api/src/bulk/routes.ts`), web его не читает.
- [low] ветка удаления записи идемпотентности при 5xx не срабатывает — все 5xx идут исключением и откатываются вместе с транзакцией.
- [low] debt: нестрогие сравнения тел ошибок остались в строках, не тронутых веткой (`deals/list-actions.test.ts`, `filters/custom-fields.test.ts`, `auth/auth.test.ts`).
- Новые зависимости: `@hono/zod-openapi`, `zod` 4; dev — `@seriousme/openapi-schema-validator`.
- Описание OpenAPI пока без путей: `GET /v1/deals` открыт ключу, но описан будет в тикете 03.
