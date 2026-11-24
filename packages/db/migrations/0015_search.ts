import { type Kysely, sql } from 'kysely'

// Быстрый поиск (тикет crm-deals/08; spec.md MVP, раздел 5.4): триграммы PostgreSQL (pg_trgm)
// и GIN-индексы по названию сделки, имени контакта, телефону, email и названию организации.
// Отдельного поискового сервиса нет: запрос строит apps/api/src/search/search.ts.
//
// - pg_trgm — доверенное расширение (trusted, PostgreSQL 13+): его создаёт и служебная роль
//   без SUPERUSER, если у неё есть CREATE на базу.
// - Операторы pg_trgm и ILIKE не помечены LEAKPROOF. Под политикой row-level security
//   (0001_project_isolation) планировщик не делает такие условия условиями индекса: сначала
//   должна выполниться политика, и поиск по таблице роли приложения — всегда полный просмотр
//   строк проекта. Поэтому кандидатов поиск выбирает через представления *_search ниже.
//   Представление выполняется с правами своего владельца — роли миграций, владельца таблиц, на
//   которого политики не действуют, — и само ограничивает строки проектом из app.project_id
//   (тем же значением, что и политика). Оно отдаёт только id и текст для поиска, без
//   security_barrier: условие поиска доходит до индекса. Корзину, охват и сами строки запрос
//   API читает уже из таблиц под политикой.
//   Над представлениями — только операторы pg_trgm, ILIKE и сравнения: функцию, которая может
//   выдать значение аргумента (ошибкой, NOTICE), планировщик вправе выполнить до условия проекта.
// - Имя контакта ищется одним выражением «имя фамилия»: индекс построен по тому же выражению,
//   что и столбец name представления contact_search.

/** Строки текущего проекта: то же условие, что у политики project_isolation. */
const CURRENT_PROJECT = `project_id = nullif(current_setting('app.project_id', true), '')::uuid`

/** Представление поиска: имя, таблица, id (столбец таблицы), текст поиска (выражение). */
const views = [
  ['deal_search', 'deal', 'id', 'title'],
  ['contact_search', 'contact', 'id', `first_name || ' ' || coalesce(last_name, '')`],
  ['contact_phone_search', 'contact_phone', 'contact_id', 'phone'],
  ['contact_email_search', 'contact_email', 'contact_id', 'email'],
  ['organization_search', 'organization', 'id', 'name'],
] as const

const indexName = (view: string) => `${view.replace(/_search$/, '')}_trgm_idx`

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create extension if not exists pg_trgm with schema public`.execute(db)
  for (const [view, table, id, text] of views) {
    await sql
      .raw(`create index ${indexName(view)} on public.${table} using gin ((${text}) gin_trgm_ops)`)
      .execute(db)
    await sql
      .raw(`
        create view public.${view} as
          select ${id} as id, ${text} as text from public.${table} where ${CURRENT_PROJECT}
      `)
      .execute(db)
    await sql.raw(`grant select on public.${view} to alpi_app`).execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const [view] of [...views].reverse()) {
    await sql.raw(`drop view public.${view}`).execute(db)
    await sql.raw(`drop index public.${indexName(view)}`).execute(db)
  }
  await sql`drop extension if exists pg_trgm`.execute(db)
}
