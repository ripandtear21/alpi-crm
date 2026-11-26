# Источники регистраций и ключи источников

Type: task
Status: claimed 2026-11-26T14:49Z
Risk: high
Blocked by: —
Source: .scratch/crm-build/issues/07-intake-epic-scope.md (Ответы владельца, пункты 1, 10, 11, 18, 35); docs/adr/0003-crm-ne-menyaet-sdelki-sama.md; GLOSSARY.md («Источник регистраций», «Ключ источника», «Ключ API»); .scratch/crm-mvp/spec.md, разделы 3.2 (`intake_source`), 6.1; .scratch/crm-api/issues/01-api-keys.md (образец ключа); .scratch/crm-intake/spec.md

## Что сделать

Начинается после слияния эпика `crm-api` целиком (`.scratch/crm-intake/spec.md`, «Зависимость от эпика `crm-api`»).

Источник регистраций — внешний сервис (лендинг, форма, n8n), который отправляет регистрации в CRM. У каждого источника свой ключ источника. Ключ умеет только принимать регистрации и просмотры вебинара (тикеты 06, 08); это не ключ API: ни читать, ни менять данные проекта он не может.

Миграция (следующий свободный номер миграции), таблица с `project_id` и RLS:

- `intake_source` — проект, название (обязательно, до 100 символов, уникально в проекте), воронка (обязательна, своего проекта), отпечаток ключа (SHA-256, уникален), первые 12 символов ключа для показа, кто и когда создал, `disabled_at`, кто отключил, `last_used_at`. Строка не удаляется: регистрации и журнал ссылаются на неё.
- Функция `SECURITY DEFINER` (по образцу `api_key_by_secret_hash`, `packages/db/migrations/0019_api_keys.ts`): по отпечатку возвращает id источника, проект и воронку, только если источник не отключён. Больше ничего она не умеет и ничего не читает.
- Автор-источник: у `change_log` — ссылка на источник (`actor_intake_source_id`); автор записи — пользователь, ключ API, источник или никто, но не двое сразу (ограничение в базе). У событий — `actor.type = "intake_source"` (`packages/shared/src/events/index.ts`, `webhook_event.actor_type`). Решено без владельца — подтвердить: изменения приёма должны иметь автора, а ни пользователя, ни ключа API у них нет.

Ключ:

- Формат `alpi_src_` и 32 случайных байта (`node:crypto`) в base64url (решено без владельца — подтвердить); отличается от ключа API (`alpi_`), чтобы проверка ключа API не путала их. Показывается один раз — в ответе на создание и смену ключа; в базе только отпечаток; ни в журнал, ни в логи сервера, ни в `idempotency_record` ключ не попадает (`omitFromIdempotentReplay`).
- Смена ключа — новый ключ, старый перестаёт работать сразу (решено без владельца — подтвердить).
- Функция проверки ключа для тикетов 06 и 08: заголовок `Authorization: Bearer <ключ источника>` → источник, проект, воронка; неизвестный и отключённый ключ — одинаковый результат «нет» (ответ `401` строит тикет 06).

Запросы `/api/v1/intake-sources` (только по сессии; ключу API — 403 `API_KEY_NOT_ALLOWED`): список (название, воронка, первые 12 символов, кто и когда создал, последний запрос, отключён ли), создать (название, воронка), сменить ключ, отключить, включить снова. Право — «интеграции» (`integrations`): смотреть — список; создавать, изменять — остальное. Название и воронка после создания не меняются; отключённый источник можно включить снова (решено без владельца — подтвердить).

Журнал проекта (`apps/api/src/audit/record.ts`, коды в `packages/shared/src/audit.ts`): создание, смена ключа, отключение и включение источника.

Экран — тикет 07.

Проверка: нужна линза безопасности (`security`).

## Where in code

packages/db/migrations/**, packages/db/src/schema.ts, packages/shared/src/audit.ts, packages/shared/src/events/index.ts (вид автора), packages/shared/src/intake/** (формат ключа), apps/api/src/intake/** (новое: источники, проверка ключа), apps/api/src/change-log/**, apps/api/src/events/emit.ts, apps/api/src/openapi/**, apps/api/src/app.ts.

## Done when

- [ ] Миграция применяется на чистую базу и откатывается.
  - evidence: test-run pass · `pnpm verify` exit 0 (packages/db/src/project-isolation.test.ts) · windows - · 2ddc0d8102c5f62f5c60c221b7d1e3e5b5147999
- [ ] Тест изоляции: источники проекта A не видны в контексте B без фильтра в коде; источник нельзя создать с воронкой другого проекта.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/intake/intake-sources.test.ts` exit 0 · windows - · 2ddc0d8102c5f62f5c60c221b7d1e3e5b5147999
- [ ] Тест прав: без `integrations: view` список — 403; без `integrations: create`/`edit` создание, смена ключа, отключение — 403; ключом API — 403 `API_KEY_NOT_ALLOWED`.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/intake/intake-sources.test.ts` exit 0 · windows - · 2ddc0d8102c5f62f5c60c221b7d1e3e5b5147999
- [ ] Тест ключа: ответ на создание содержит ключ, список — нет; в базе, журнале, `idempotency_record` и логах сервера ключа нет (поиск по строке ключа).
  - evidence: test-run pass · `pnpm vitest run apps/api/src/intake/intake-sources.test.ts` exit 0 · windows - · 2ddc0d8102c5f62f5c60c221b7d1e3e5b5147999
- [ ] Тест функции проверки: верный ключ даёт источник, проект и воронку; неизвестный, отключённый ключ и старый ключ после смены — одинаковое «нет»; ключ источника в запросе к `/api/v1` — 401 `API_KEY_INVALID`.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/intake/intake-sources.test.ts` exit 0 · windows - · 2ddc0d8102c5f62f5c60c221b7d1e3e5b5147999
- [ ] Тест автора: строка `change_log` с автором-источником проходит; с двумя авторами сразу — отклонена базой; событие с `actor.type = "intake_source"` проходит схему каталога.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/intake/intake-sources.test.ts` exit 0 · windows - · 2ddc0d8102c5f62f5c60c221b7d1e3e5b5147999
- [ ] Тест журнала: создание, смена ключа, отключение и включение — в журнале проекта.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/intake/intake-sources.test.ts` exit 0 · windows - · 2ddc0d8102c5f62f5c60c221b7d1e3e5b5147999
- [ ] `pnpm verify` зелёный.
  - evidence: gate pass · `gate fast` exit 0, `pnpm verify` exit 0 · windows - · 2ddc0d8102c5f62f5c60c221b7d1e3e5b5147999

## Результат

Решено без владельца — подтвердить:

- Проверка ключа и лимит стоят на всей группе `/api/intake/*` уже сейчас (`apps/api/src/intake/auth.ts`, `intakeRoutes`): группа зарегистрирована в `apps/api/src/app.ts` до проверки ключа API и сессии. Без ключа, с неизвестным, отключённым, старым после смены ключом и с ключом API — одинаковый 401 `INTAKE_KEY_INVALID` с `WWW-Authenticate: Bearer`. 600 запросов в минуту на источник — 429 `RATE_LIMITED` с `Retry-After`; счётчик в памяти процесса, свой у источников (не общий с ключами API). Маршрутов приёма ещё нет: принятый ключ на любой путь получает 404 `NOT_FOUND`; тикеты 06 и 08 добавляют маршруты внутрь `intakeRoutes`.
- Пути управления: `GET /api/v1/intake-sources`, `POST /api/v1/intake-sources`, `POST /api/v1/intake-sources/:id/reissue-key`, `…/:id/disable`, `…/:id/enable`. Создание — право «интеграции: создавать»; смена ключа, отключение и включение — «интеграции: изменять».
- Воронка источника — своего проекта и не в архиве; иначе 422 `PIPELINE_NOT_FOUND`.
- Название уникально в проекте без учёта регистра; отключённые источники тоже в счёт (409 `INTAKE_SOURCE_NAME_TAKEN`).
- Смена ключа разрешена и у отключённого источника: он остаётся отключённым. Отключить отключённый — 409 `INTAKE_SOURCE_DISABLED`, включить включённый — 409 `INTAKE_SOURCE_ENABLED`.
- Ответы с ключом — с `Cache-Control: no-store`.
- `last_used_at` обновляется при запросе с принятым ключом, не превысившем лимит, не чаще раза в минуту.
- Откат миграции удаляет события с автором-источником (`webhook_event`), а строки `change_log` с автором-источником оставляет без автора.
- Вне раздела «Where in code» (вынуждено проверкой типов): подписи новых действий журнала в `apps/web/src/routes/settings/audit-page.tsx` и `apps/web/src/locales/{uk,ru}/audit.json`; списки миграций и таблиц в `packages/db/src/project-isolation.test.ts`.
