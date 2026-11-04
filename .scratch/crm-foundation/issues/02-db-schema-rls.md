# Схема базы и изоляция проектов (row-level security)

Type: task
Status: done 2026-11-04T00:24Z
Blocked by: 01
Source: .scratch/crm-mvp/spec.md, раздел 12, эпик 1

## Что сделать

Первая миграция: `project`, `project_member` (пользователь, проект, роль — ссылка на роль появится в тикете 05, пока nullable), `external_link` (проект, тип сущности, id сущности, источник, внешний id; уникальность (проект, тип, источник, внешний id)). Пользователи — таблица Better Auth (тикет 03): здесь ссылка на неё по id, без внешнего ключа, если таблицы ещё нет, либо создать её схему заранее по документации Better Auth. Изоляция: каждая таблица с данными проекта имеет `project_id` и политику RLS «project_id = current_setting('app.project_id')::uuid»; приложение работает под ролью базы без BYPASSRLS и без владения таблицами; помощник `withProject(projectId, fn)` открывает транзакцию и делает `set_config('app.project_id', …, true)`. Служебный доступ без проекта (миграции, курсы НБУ) — отдельной ролью. kysely-codegen (или вручную описанные типы) для типов таблиц.

## Where in code

packages/db/** (migrations/, src/), при необходимости packages/shared/**.

## Done when

- [x] Миграции применяются на чистую базу и откатываются.
- [x] Тест: строки двух проектов в `external_link`; `select * from external_link` без where внутри `withProject(A)` возвращает только строки A; без установленного проекта — ноль строк или ошибка, но не все строки.
- [x] Тест: роль приложения не может отключить RLS и не владеет таблицами.
- [x] `pnpm verify` зелёный.

## Результат

- Миграция `packages/db/migrations/0001_project_isolation.ts`: глобальная `project` (без RLS — список проектов), `project_member` и `external_link` с политикой RLS `project_id = nullif(current_setting('app.project_id', true), '')::uuid` (`using` и `with check`). Роль приложения `alpi_app` без BYPASSRLS, не владеет таблицами; на `project` у неё только SELECT.
- `withProject(db, projectId, fn)` — транзакция с `set_config('app.project_id', …, true)`; `createProject(serviceDb, values)` — создание проекта служебной ролью (владельцем). Обе в `@alpi/db`.
- Типы таблиц описаны вручную в `packages/db/src/schema.ts` (без kysely-codegen — его нет смысла поднимать до появления базы в CI).
- `user_id` пока текст без внешнего ключа: таблица пользователей появится в тикете 03 (Better Auth).
- 17 тестов изоляции (`packages/db/src/project-isolation.test.ts`) на настоящем PostgreSQL 18 (embedded-postgres): чтение только своего проекта, ноль строк без проекта, запрет переноса строки в чужой проект, запрет DELETE/UPDATE/INSERT на `project` для роли приложения, отсутствие владения и BYPASSRLS. Мутации прав делают тесты красными.
- Проверка: первый раунд REJECTED (роль приложения могла удалить чужой проект каскадом через `project`), исправлено; второй раунд VERIFIED. Gate full зелёный.

Заметки для следующих тикетов:
- Тикеты 04 и 10: в docker-compose `DATABASE_URL` — суперпользователь. Нужна отдельная роль входа (член `alpi_app`) для приложения и отдельный адрес для миграций.
- Тикет 04: `project_member` изолирована по проекту, поэтому переключателю проектов («в каких проектах я состою») нужен служебный путь или политика по `user_id`.
- Список проектов (`project`) видят все пользователи — решено без владельца, подтвердить.
