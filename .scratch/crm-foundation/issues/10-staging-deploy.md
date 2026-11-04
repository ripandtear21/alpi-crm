# Staging на Railway и выкладка

Type: task
Status: blocked 2026-11-04T12:38Z
Blocked reason: Отложено владельцем 2026-11-04: до готовности MVP работаем локально, выкладка на Railway — после MVP
Waits: owner
Blocked by: 09
Source: .scratch/crm-mvp/spec.md, раздел 12, эпик 1

## Что сделать

Хостинг — Railway (решение владельца 2026-11-04, docs/adr/0002-hosting-railway.md). Владелец: аккаунт Railway, проект с окружением staging (регион ЕС), токен проекта в секретах репозитория GitHub (сам токен в чат не передаётся). Агент: службы PostgreSQL 18 (с томом), API и web из существующих Dockerfile; миграции отдельным шагом служебной ролью до запуска API, API — ролью входа без обхода RLS (packages/db/src/app-role.ts); секреты — переменными Railway; выкладка на staging после слияния в main и зелёной проверки GitHub; `idle_in_transaction_session_timeout` для роли приложения (долг тикета 04); пароль роли приложения не попадает в журнал PostgreSQL (долг тикета 03). Проверить и записать: версия PostgreSQL, резервные копии и восстановление на момент времени, цена.

## Where in code

deploy/** (или railway.json / railway.toml), .github/workflows/deploy-staging.yml, Dockerfile служб.

## Done when

- [ ] После слияния в main staging обновляется автоматически, `/health` отвечает 200 по HTTPS (вставить ответ curl).
- [ ] Секреты только в секретах GitHub и в переменных Railway.
- [ ] Записано, как делаются и восстанавливаются резервные копии базы.
