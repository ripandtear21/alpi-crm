# alpi-crm

Своя CRM вместо Pipedrive. Спецификация MVP — `.scratch/crm-mvp/spec.md`, термины — `GLOSSARY.md`, решения — `docs/adr/`.

## Состав

pnpm-монорепозиторий, TypeScript strict во всех пакетах.

| Путь | Что это |
|---|---|
| `apps/api` | API на Hono (Node.js). `GET /health` → `{"status":"ok"}` |
| `apps/web` | Клиент: React SPA на Vite, TanStack Router и TanStack Query |
| `packages/db` | Доступ к PostgreSQL через Kysely, мигратор (`packages/db/migrations`), тестовая база |
| `packages/shared` | Общие типы сервера и клиента |

Проверки: Biome (линтер и форматирование), `tsc` (типы), Vitest (тесты).

## Что нужно

- Node.js 22.18 или новее (разработка ведётся на 24): API запускается из исходников TypeScript без сборки, Node сам отбрасывает типы.
- pnpm 11 (`npm install -g pnpm@11`).
- Docker и PostgreSQL для разработки **не нужны**: тесты с базой поднимают настоящий PostgreSQL 18 из npm-пакета `embedded-postgres` во временной папке.

## Установка и проверки

```sh
pnpm install
pnpm verify      # lint + typecheck + test; должен завершиться с кодом 0
```

Отдельные команды:

| Команда | Что делает |
|---|---|
| `pnpm lint` | `biome check .` — линтер и проверка форматирования |
| `pnpm format` | то же, но исправляет форматирование и порядок импортов |
| `pnpm typecheck` | `tsc` в каждом пакете |
| `pnpm test` | все тесты Vitest, один прогон (без watch) |
| `pnpm vitest run <файл>` | один файл тестов |
| `pnpm build` | сборка `apps/api` (`dist/index.js`) и `apps/web` (`dist/`) |

## Запуск в разработке

```sh
pnpm --filter @alpi/api dev   # API на http://localhost:3000 (перезапуск при изменениях)
pnpm --filter @alpi/web dev   # клиент на http://localhost:5173, /api/* проксируется на API
```

API и мигратор читают настройки из `.env` в корне (образец — `.env.example`). Без `DATABASE_URL`, `BETTER_AUTH_SECRET` и `BETTER_AUTH_URL` API не запускается.

### Роли базы

Изоляция проектов держится на row-level security (`docs/adr/0001-izolyatsiya-proektov.md`), а на суперпользователя, роль с `BYPASSRLS` и владельца таблиц политики не действуют. Поэтому ролей две:

| Переменная | Роль | Кто ходит |
|---|---|---|
| `MIGRATION_DATABASE_URL` | служебная, владелец таблиц | мигратор |
| `DATABASE_URL` | роль входа API, член `alpi_app`, без `SUPERUSER` и `BYPASSRLS` | API, `pnpm create-owner` |

```sh
pnpm --filter @alpi/db migrate   # миграции; затем создаёт роль входа из DATABASE_URL или обновляет ей пароль
```

Пароль роли входа берётся только из `DATABASE_URL` (в docker-compose — `APP_DB_USER` и `APP_DB_PASSWORD`), в репозитории его нет. При старте API проверяет свою роль и не запускается, если это суперпользователь, роль с `BYPASSRLS`, владелец таблиц или не член `alpi_app`.

В docker-compose миграции и создание роли выполняет разовая служба `migrate` перед стартом API.

## Вход

Открытой регистрации нет. Первого пользователя — владельца системы — создаёт скрипт:

```sh
pnpm create-owner owner@example.com "Ім'я"   # пароль спросит без эха
```

Пароль вводится без эха или подаётся на стандартный ввод (например, из менеджера паролей: `… | pnpm create-owner …`). Переменная `OWNER_PASSWORD` тоже работает, но для автоматизации: набранная в командной строке, она остаётся в истории shell.

При первом входе владелец настраивает двухфакторную аутентификацию (приложение кодов, QR-код); пока она не включена, API отвечает 403 на всё, кроме её настройки. Включение 2FA удаляет все сессии пользователя, открытые по одному паролю; доступ к API есть только у сессий, прошедших код. «Запомнить устройство» не поддерживается: каждый вход — с кодом.

## Тестовая база в своих тестах

```ts
import { createDb } from '@alpi/db'
import { startTestDatabase } from '@alpi/db/testing'

const testDb = await startTestDatabase() // в beforeAll
const db = createDb(testDb.connectionString)
// …
await db.destroy() // в afterAll
await testDb.stop()
```

Первый запуск занимает несколько секунд (initdb), поэтому в проекте Vitest пакета нужен увеличенный `hookTimeout` — пример в `packages/db/vitest.config.ts`.

## Сервер

`docker-compose.yml` поднимает PostgreSQL 18, API и клиент за Caddy (обратный прокси с TLS):

```sh
cp .env.example .env   # заполнить пароли и SITE_ADDRESS
docker compose up -d --build
```
