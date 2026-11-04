# Фоновые задачи, массовые операции, корзина и очистка журнала

Type: task
Status: claimed 2026-11-04T13:31Z
Blocked by: —
Source: .scratch/crm-build/issues/01-deals-epic-scope.md (Answer, волна 1); .scratch/crm-mvp/spec.md, разделы 3.1, 3.2 (`bulk_job`, удаление и архив), 5.3, 13.0 (журнал — 90 дней)

## Что сделать

Фоновые задачи на pg-boss (актуальная мажорная версия на момент работы). Таблицы pg-boss — служебные, вне проектов (раздел 3.1 спецификации), в своей схеме; роль приложения получает к ним ровно те права, что нужны очереди. Каждая задача данных проекта несёт `project_id` и выполняется внутри `withProject`, поэтому видит только свой проект. Обработчик работает в процессе API (решено без владельца, подтвердить); остановка API дожидается текущих задач.

Каркас массовых операций:

- Таблица `bulk_job` (следующий свободный номер миграции, `project_id`, RLS): инициатор, действие, выбор (список id или условия фильтра), статус, всего / обработано / ошибок, журнал ошибок по записям, время начала и конца.
- Запуск только с правом «массовые операции» (`bulk_operations`). Записи обрабатываются порциями; права и охват инициатора проверяются на каждой порции по его текущей роли; запись вне охвата попадает в журнал ошибок, а не меняется.
- `GET /api/v1/bulk-jobs/:id` — прогресс и журнал; список своих операций. Инициатор видит свои операции; администратор — все в проекте.
- Реестр действий: конкретные действия (архив, передача, смена этапа, удаление) регистрируют тикеты 09 и 12. Здесь — тестовое действие на тестовой таблице.
- Запуск пишется в журнал опасных действий функцией записи из тикета 07 эпика `crm-foundation` (`apps/api/src/audit/record.ts`).

Корзина: окончательное удаление записей, пролежавших в корзине (`deleted_at`) больше 30 дней, — ежедневная задача по расписанию с реестром «тип сущности → функция окончательного удаления». Контакты, организации и сделки в реестр добавляет тикет 12; здесь — тест на тестовой таблице. Задача обходит проекты по одному, каждый — в своём `withProject`.

Очистка журнала: ежедневная задача удаляет записи о неудачных входах (email попытки и IP) старше 90 дней. Журнал для роли приложения только на добавление, поэтому удаление — служебной функцией базы с правами владельца, которая удаляет только этот вид записей.

Тикет не отправляет событий; задачи по расписанию трогают только корзину и журнал входов и никогда не меняют сделки (ADR 0003). Экранов нет: прогресс и корзина на экране — тикет 12.

## Where in code

packages/db/migrations/**, packages/db/src/schema.ts, apps/api/src/jobs/** (подключение pg-boss, расписание), apps/api/src/bulk/**, apps/api/src/trash/**, apps/api/src/index.ts.

## Done when

- [ ] Миграция применяется на чистую базу и откатывается; pg-boss создаёт свою схему при старте.
  - evidence: test-run pass · `pnpm vitest run packages/db/src/project-isolation.test.ts apps/api/src/jobs/jobs.test.ts` exit 0 · windows - · 5386afab6ed0b40384b0ddc930b2ef9183e9a685
  - evidence: test-run pass · `pnpm verify` exit 0 · windows - · ee7bd0d78b5382a95f34a1e1506d9df6133e741b
- [ ] Тест изоляции: задача проекта A, которая читает тестовую таблицу без фильтра, видит только строки A; `bulk_job` проекта A не виден в проекте B.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/bulk/bulk.test.ts` exit 0 · windows - · 5386afab6ed0b40384b0ddc930b2ef9183e9a685
  - evidence: test-run pass · `pnpm verify` exit 0 · windows - · ee7bd0d78b5382a95f34a1e1506d9df6133e741b
- [ ] Тест прав: без права «массовые операции» запуск — 403; запись вне охвата инициатора не меняется и попадает в журнал ошибок; пользователь без роли администратора не видит чужую операцию.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/bulk/bulk.test.ts` exit 0 · windows - · 5386afab6ed0b40384b0ddc930b2ef9183e9a685
  - evidence: test-run pass · `pnpm verify` exit 0 · windows - · ee7bd0d78b5382a95f34a1e1506d9df6133e741b
- [ ] Тест массовой операции на 1 000 записях тестовой таблицы: прогресс растёт порциями, итог «обработано 1 000, ошибок 0»; ошибка одной записи не останавливает остальные.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/bulk/bulk.test.ts` exit 0 · windows - · 5386afab6ed0b40384b0ddc930b2ef9183e9a685
  - evidence: test-run pass · `pnpm verify` exit 0 · windows - · ee7bd0d78b5382a95f34a1e1506d9df6133e741b
- [ ] Тест корзины: запись, удалённая 31 день назад, удаляется окончательно; удалённая 29 дней назад — остаётся; запись другого проекта не трогается.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/jobs/jobs.test.ts` exit 0 · windows - · 5386afab6ed0b40384b0ddc930b2ef9183e9a685
  - evidence: test-run pass · `pnpm verify` exit 0 · windows - · ee7bd0d78b5382a95f34a1e1506d9df6133e741b
- [ ] Тест очистки: неудачный вход старше 90 дней удалён, младше — на месте, другие виды записей журнала не тронуты; роль приложения сама удалить запись журнала не может.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/jobs/jobs.test.ts apps/api/src/audit/audit.test.ts` exit 0 · windows - · 5386afab6ed0b40384b0ddc930b2ef9183e9a685
  - evidence: test-run pass · `pnpm verify` exit 0 · windows - · ee7bd0d78b5382a95f34a1e1506d9df6133e741b
- [ ] `pnpm verify` зелёный.
  - evidence: test-run pass · `pnpm verify` exit 0 · windows - · 5386afab6ed0b40384b0ddc930b2ef9183e9a685
  - evidence: gate pass · `gate fast` exit 0 · windows - · 5386afab6ed0b40384b0ddc930b2ef9183e9a685
  - evidence: test-run pass · `pnpm verify` exit 0 · windows - · ee7bd0d78b5382a95f34a1e1506d9df6133e741b
  - evidence: gate pass · `gate fast` exit 0 · windows - · ee7bd0d78b5382a95f34a1e1506d9df6133e741b
