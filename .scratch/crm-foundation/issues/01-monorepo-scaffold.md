# Монорепозиторий, инструменты и проверки

Type: task
Status: open
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
