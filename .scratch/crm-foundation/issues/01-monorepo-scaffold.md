# Монорепозиторий, инструменты и проверки

Type: task
Status: done 2026-11-03T23:56Z
Blocked by: —
Source: .scratch/crm-mvp/spec.md, раздел 12, эпик 1

## Что сделать

Создать pnpm-монорепозиторий: `apps/api` (Hono на Node, эндпоинт `GET /health`), `apps/web` (React + Vite + TanStack Router/Query, одна страница-заглушка), `packages/db` (Kysely, мигратор, подключение), `packages/shared` (общие типы). TypeScript strict во всех пакетах, Biome, Vitest. Тестовый помощник в `packages/db`: поднимает настоящий PostgreSQL через `embedded-postgres` во временной папке, отдаёт строку подключения, гасит базу после тестов. Корневые скрипты: `lint`, `typecheck`, `test` (однократный прогон, без watch), `build`, `verify` (= lint + typecheck + test). `docker-compose.yml` (PostgreSQL, api, web за обратным прокси) и `.env.example` — без запуска. README: как поставить и запустить.

## Where in code

Корень: package.json, pnpm-workspace.yaml, biome.json, tsconfig.base.json, docker-compose.yml, .env.example, README.md, .gitignore; apps/api/**, apps/web/**, packages/db/**, packages/shared/**.

## Done when

- [ ] `pnpm install && pnpm verify` проходит с кодом 0 на Windows без Docker.
- [ ] Тест в `packages/db` поднимает embedded PostgreSQL, выполняет `select version()` и видит PostgreSQL 16+ (лучше 18).
- [ ] Тест `apps/api`: `GET /health` → 200.
- [ ] `pnpm build` собирает api и web.

## Результат

- pnpm-монорепозиторий: `apps/api` (Hono 4.13, `GET /health`), `apps/web` (React 19, Vite 8, TanStack Router/Query), `packages/db` (Kysely 0.29, мигратор, тестовый PostgreSQL 18.6 через `embedded-postgres`), `packages/shared`. TypeScript 7 strict, Biome 2.6, Vitest 5. Команды: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm verify` — внесены в профиль проекта и реестр проверок.
- `.gitattributes` (`eol=lf`): на машине `core.autocrlf=true`, без него Biome падает на CRLF.
- Проверка: раунд 1 — REJECTED (зависание помощника базы при сбое запуска; тест мигратора проходил с пустышкой), раунд 2 — VERIFIED. `gate full` зелёный (lint, typecheck, test, build).
- Долг: [low] ни один тест не применяет настоящие миграции из `packages/db/migrations` — добавить, когда появятся миграции (тикет 02).
- Не проверено: `docker-compose.yml`, Dockerfile и Caddyfile не запускались (нет Docker); `embedded-postgres` на Linux — покажет CI (тикет 09).
