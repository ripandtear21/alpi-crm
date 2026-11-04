import { type Kysely, sql } from 'kysely'

// Создание проекта и список «мои проекты» для роли приложения (тикет crm-foundation/04).
//
// Роль приложения alpi_app таблицу project только читает (0001_project_isolation), а
// project_member видит только в контексте одного проекта (row-level security). Два действия
// ей нужны за пределами этих прав, и каждое дано узкой функцией SECURITY DEFINER: функция
// выполняется с правами своего владельца — роли миграций, владельца таблиц, на которого
// политики не действуют, — и делает ровно одно действие с фиксированным SQL.
//
// Правила для таких функций (документация PostgreSQL, «Writing SECURITY DEFINER Functions
// Safely»):
// - search_path задан в самой функции и не содержит схем, куда может писать вызывающий;
//   все таблицы названы со схемой public, временная схема pg_temp стоит последней;
// - EXECUTE отозван у PUBLIC и выдан только alpi_app.

/** Роль владельца системы в плагине admin Better Auth (apps/api/src/auth/owner.ts). */
const OWNER_ROLE = 'admin'

export async function up(db: Kysely<unknown>): Promise<void> {
  // Проект и участие создателя — одной транзакцией. Создатель обязан быть владельцем
  // системы: API проверяет это по сессии, функция — ещё раз по таблице user, чтобы ошибка
  // в коде API не дала создать проект от имени обычного пользователя.
  await sql`
    create function public.create_project(p_code text, p_name text, p_creator_id text)
      returns public.project
      language plpgsql
      security definer
      set search_path = pg_catalog, pg_temp
    as $$
    declare
      created public.project;
    begin
      if not exists (
        select from public."user" u
        where u.id = p_creator_id
          and not u.banned
          and ${sql.lit(OWNER_ROLE)} = any (
            select btrim(r) from unnest(string_to_array(coalesce(u.role, ''), ',')) r
          )
      ) then
        raise exception 'создавать проекты может только владелец системы'
          using errcode = 'insufficient_privilege';
      end if;

      insert into public.project (code, name)
        values (p_code, p_name)
        returning * into created;
      insert into public.project_member (project_id, user_id, created_by)
        values (created.id, p_creator_id, p_creator_id);
      return created;
    end
    $$
  `.execute(db)

  // Проекты, в которых состоит пользователь: только строки project, без чужих участий.
  // id пользователя передаёт API из сессии; другого пути узнать чужие участия у роли
  // приложения нет — project_member вне контекста проекта она не видит.
  await sql`
    create function public.user_projects(p_user_id text)
      returns setof public.project
      language sql
      stable
      security definer
      set search_path = pg_catalog, pg_temp
    as $$
      select p.*
      from public.project p
      where exists (
        select from public.project_member m
        where m.project_id = p.id and m.user_id = p_user_id
      )
      order by p.name, p.code
    $$
  `.execute(db)

  for (const fn of ['public.create_project(text, text, text)', 'public.user_projects(text)']) {
    await sql.raw(`revoke all on function ${fn} from public`).execute(db)
    await sql.raw(`grant execute on function ${fn} to alpi_app`).execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop function public.user_projects(text)`.execute(db)
  await sql`drop function public.create_project(text, text, text)`.execute(db)
}
