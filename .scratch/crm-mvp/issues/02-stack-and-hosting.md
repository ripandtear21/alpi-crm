# Стек, хостинг и требования к объёму

Labels: wayfinder:research
Type: research
Status: done
Blocked by: —
Map: [Карта: MVP своей CRM вместо Pipedrive](../map.md)

## Question

На каком стеке и где строить CRM, если её пишет один владелец вместе с Claude Code, уклон — TypeScript целиком + PostgreSQL, объём — сотни тысяч сделок и около 30 пользователей, пользовательские поля через конструктор (JSONB или EAV), нужны вебхуки от WayForPay и Ringostat, интерфейс на украинском и русском? Сравнить 2–3 варианта фреймворка (например Next.js, Remix/React Router, NestJS + SPA), ORM (Prisma, Drizzle, Kysely), аутентификацию, очередь фоновых задач, хостинг (VPS в ЕС, managed PostgreSQL, PaaS) с ценой в месяц. Дать рекомендацию с обоснованием.

## Answer

Полный отчёт: ветка `research/stack-and-hosting` (не сливается), файл `docs/research/stack-and-hosting.md`, коммит `479cf63`. Это рекомендация исследования; окончательное утверждение стека — за владельцем.

- Сервер: Hono на Node.js (API, вебхуки, фоновые задачи). Клиент: React SPA на Vite + TanStack Router + TanStack Query. SSR и React Server Components не нужны внутренней CRM за логином и несут лишние риски безопасности.
- База: PostgreSQL 18, доступ через Kysely 0.29 + kysely-codegen. Prisma отброшена (слабая работа с JSON), Drizzle — (1.0 ещё в RC).
- Пользовательские поля: JSONB-колонка + таблица описаний полей + GIN-индекс `jsonb_path_ops` + индексы на «горячие» поля. EAV отброшен.
- Аутентификация: Better Auth 1.7.x с плагином admin, всегда последний патч.
- Фоновые задачи: pg-boss в том же PostgreSQL (без Redis).
- Вебхуки: запись события в таблицу входящих с защитой от дублей → быстрый ответ → обработка в фоне.
- Переводы: i18next, языки uk и ru.
- Хостинг: Hetzner CX43 (8 vCPU / 16 ГБ, €16,49) + бэкапы + Docker Compose, ≈ €20–25/мес. Запасной вариант — управляемая база DigitalOcean или Supabase.
- Не проверено: можно ли сейчас заказать тарифы Hetzner CX, задержка из Украины, требования к персональным данным (GDPR, закон Украины), размер базы.
