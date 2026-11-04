import { type Kysely, sql } from 'kysely'
import type { Database } from './schema.ts'

// Роль, под которой работает приложение. Изоляция проектов держится на row-level security
// (docs/adr/0001-izolyatsiya-proektov.md), а на суперпользователя, роль с BYPASSRLS и владельца
// таблиц политики не действуют. Поэтому API входит отдельной ролью — членом alpi_app.

/** Групповая роль приложения; создаёт миграция 0001_project_isolation. */
export const APP_GROUP_ROLE = 'alpi_app'

interface RoleFacts {
  name: string
  rolsuper: boolean
  rolbypassrls: boolean
  in_app_group: boolean
  owned_tables: string[]
}

/**
 * Проверяет роль подключения: не суперпользователь, без BYPASSRLS, не владеет таблицами (и не
 * член роли владельца), член alpi_app. Иначе бросает исключение со списком нарушений —
 * API с такой ролью запускаться не должен.
 */
export async function assertRestrictedRole(db: Kysely<Database>): Promise<void> {
  const { rows } = await sql<RoleFacts>`
    select
      r.rolname as name,
      r.rolsuper,
      r.rolbypassrls,
      exists (select from pg_roles g where g.rolname = ${APP_GROUP_ROLE})
        and pg_has_role(r.oid, ${APP_GROUP_ROLE}, 'MEMBER') as in_app_group,
      coalesce(
        array_agg(t.schemaname || '.' || t.tablename order by t.tablename)
          filter (where t.tablename is not null),
        '{}'
      ) as owned_tables
    from pg_roles r
    left join pg_tables t
      on t.schemaname not in ('pg_catalog', 'information_schema')
      and pg_has_role(r.oid, t.tableowner, 'MEMBER')
    where r.rolname = current_user
    group by r.oid, r.rolname, r.rolsuper, r.rolbypassrls
  `.execute(db)
  const role = rows[0]
  if (!role) {
    throw new Error('Не удалось прочитать свойства роли подключения')
  }
  const problems: string[] = []
  if (role.rolsuper) problems.push('суперпользователь')
  if (role.rolbypassrls) problems.push('BYPASSRLS')
  if (role.owned_tables.length > 0) {
    problems.push(`владеет таблицами: ${role.owned_tables.slice(0, 5).join(', ')}`)
  }
  if (!role.in_app_group) problems.push(`не член роли ${APP_GROUP_ROLE}`)
  if (problems.length > 0) {
    throw new Error(
      `Роль базы «${role.name}» не годится для приложения: ${problems.join('; ')}. ` +
        'Приложению нужна отдельная роль — член alpi_app (см. README, раздел «Роли базы»).',
    )
  }
}

/** Имя роли входа: без кавычек и сюрпризов в журналах. */
const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/

/**
 * Создаёт роль входа приложения (LOGIN, член alpi_app, без SUPERUSER и BYPASSRLS) или, если
 * она есть, выставляет ей эти свойства и пароль. Вызывается служебным подключением после
 * миграций: роль alpi_app создаёт миграция 0001.
 */
export async function ensureAppLoginRole(
  serviceDb: Kysely<Database>,
  login: { user: string; password: string },
): Promise<void> {
  if (!ROLE_NAME.test(login.user)) {
    throw new Error(`Имя роли приложения должно быть вида [a-z_][a-z0-9_]*: «${login.user}»`)
  }
  if (login.password.length === 0) {
    throw new Error(`Не задан пароль роли приложения «${login.user}»`)
  }
  const { rows } = await sql<{ current: string; exists: boolean }>`
    select current_user as current, exists (select from pg_roles where rolname = ${login.user}) as exists
  `.execute(serviceDb)
  const facts = rows[0]
  if (facts?.current === login.user) {
    throw new Error('Роль приложения совпадает со служебной ролью миграций — нужны разные роли')
  }
  // Пароль нельзя передать параметром в CREATE ROLE; format() с %I и %L экранирует имя и
  // пароль средствами PostgreSQL.
  const template = facts?.exists
    ? 'alter role %I with login nosuperuser nobypassrls password %L'
    : 'create role %I with login nosuperuser nobypassrls password %L'
  const statement = await sql<{ stmt: string }>`
    select format(${template}, ${login.user}::text, ${login.password}::text) as stmt
  `.execute(serviceDb)
  const grant = await sql<{ stmt: string }>`
    select format('grant %I to %I', ${APP_GROUP_ROLE}::text, ${login.user}::text) as stmt
  `.execute(serviceDb)
  await serviceDb.transaction().execute(async (trx) => {
    await sql.raw(statement.rows[0]?.stmt ?? '').execute(trx)
    await sql.raw(grant.rows[0]?.stmt ?? '').execute(trx)
  })
}
