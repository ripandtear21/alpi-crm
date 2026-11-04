import { type Kysely, sql } from 'kysely'

// Команды проекта и участие в проекте (тикет crm-foundation/06; spec.md, раздел 4;
// GLOSSARY.md — «Команда»).
//
// - team — команда проекта (row-level security по проекту, как role). У команды ровно один
//   тимлид: team.lead_user_id NOT NULL — один столбец, второго тимлида записать некуда.
// - Менеджер состоит не больше чем в одной команде: project_member.team_id — один столбец,
//   команда — того же проекта (составной внешний ключ, как у роли).
// - Тимлид сам состоит в своей команде (решение без владельца, подтвердить): составной внешний
//   ключ team (project_id, id, lead_user_id) → project_member (project_id, team_id, user_id).
//   Почему так: «команда — группа менеджеров во главе с тимлидом» — тимлид тоже ведёт сделки,
//   и они видны его команде с охватом «команда»; тимлид не может одновременно состоять в другой
//   команде, и охват «команда» одинаков у тимлида и менеджеров одной команды. Отсюда же: один
//   пользователь ведёт не больше одной команды. Ключ отложенный (DEFERRABLE INITIALLY
//   DEFERRED): создание команды — вставка team, затем перевод тимлида в неё — проверяется в
//   конце транзакции или по SET CONSTRAINTS … IMMEDIATE. Вывести тимлида из команды (сменить
//   ему команду, удалить участие), пока он тимлид, ключ не даёт.
// - Отключённый участник (disabled_at) не тимлид: назначить его тимлидом и отключить тимлида
//   нельзя (триггеры ниже). Отключённый остаётся в команде — его закрытые сделки остаются
//   историей команды.
// - Участие отключается мягко: disabled_at. Отключённый не входит в проект (проверку участия
//   делает API), его нет в списке «мои проекты» (user_projects), и он не считается
//   администратором для защиты последнего администратора (project_member_keep_admin).
// - «Принимает новые сделки» — флаг участника, по умолчанию да; читать его будет распределение
//   сделок (второй эпик).
//
// - "user".must_change_password — учётная запись с временным паролем (её создал администратор
//   проекта): пока пароль не сменён, API пускает только к смене пароля и выходу
//   (apps/api/src/auth/access-guard.ts). Решение владельца 2026-11-04: сначала смена пароля,
//   потом настройка 2FA.
//
// Ошибки защит — свои SQLSTATE: API превращает их в 409.

/** SQLSTATE: тимлидом назначен отключённый участник. */
const TEAM_LEAD_DISABLED = 'TM001'
/** SQLSTATE: отключают участника, который ведёт команду. */
const MEMBER_IS_TEAM_LEAD = 'TM002'
const LAST_ADMIN = 'AR002'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table team (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references project (id) on delete cascade,
      name text not null check (btrim(name) <> '' and char_length(name) <= 60),
      lead_user_id text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by text,
      unique (project_id, id),
      unique (project_id, name),
      -- Один пользователь ведёт не больше одной команды. Следует и из ключа ниже (тимлид состоит
      -- в своей команде, а команда у участника одна), но уникальность отвечает сразу и понятным
      -- кодом, а не в конце транзакции.
      unique (project_id, lead_user_id)
    )
  `.execute(db)
  await sql`alter table team enable row level security`.execute(db)
  await sql`
    create policy project_isolation on team
      using (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
      with check (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
  `.execute(db)
  await sql`grant select, insert, update, delete on team to alpi_app`.execute(db)

  await sql`
    alter table project_member
      add column team_id uuid,
      add column accepts_new_deals boolean not null default true,
      add column disabled_at timestamptz,
      add column disabled_by text,
      -- Команда — только своего проекта. Удаление команды выводит из неё участников
      -- (обнуляется только team_id, project_id остаётся).
      add constraint project_member_team_fkey foreign key (project_id, team_id)
        references team (project_id, id) on delete set null (team_id),
      -- Цель ключа «тимлид состоит в своей команде».
      add constraint project_member_team_user_key unique (project_id, team_id, user_id)
  `.execute(db)
  await sql`
    alter table team
      add constraint team_lead_in_team foreign key (project_id, id, lead_user_id)
        references project_member (project_id, team_id, user_id)
        deferrable initially deferred
  `.execute(db)

  // Тимлид — не отключённый участник. Строка участия тимлида блокируется FOR SHARE: отключение
  // (UPDATE строки участия) ждёт конца этой транзакции, и его триггер ниже увидит команду.
  // Обратный порядок тоже безопасен: после ожидания блокировки READ COMMITTED перечитывает
  // строку и видит disabled_at. Обычная функция: row-level security показывает ей участников
  // текущего проекта.
  await sql`
    create function public.team_lead_enabled()
      returns trigger
      language plpgsql
      set search_path = pg_catalog, pg_temp
    as $$
    begin
      perform from public.project_member m
        where m.project_id = new.project_id and m.user_id = new.lead_user_id
          and m.disabled_at is not null
        for share;
      if found then
        raise exception 'тимлидом не может быть отключённый участник'
          using errcode = ${sql.lit(TEAM_LEAD_DISABLED)};
      end if;
      return new;
    end
    $$
  `.execute(db)
  await sql`
    create trigger team_lead_enabled before insert or update of lead_user_id on team
      for each row execute function public.team_lead_enabled()
  `.execute(db)
  await sql`
    create function public.project_member_lead_not_disabled()
      returns trigger
      language plpgsql
      set search_path = pg_catalog, pg_temp
    as $$
    begin
      if new.disabled_at is not null and old.disabled_at is null and exists (
        select from public.team t
        where t.project_id = new.project_id and t.lead_user_id = new.user_id
      ) then
        raise exception 'участник ведёт команду: сначала назначьте команде другого тимлида'
          using errcode = ${sql.lit(MEMBER_IS_TEAM_LEAD)};
      end if;
      return new;
    end
    $$
  `.execute(db)
  await sql`
    create trigger project_member_lead_not_disabled before update of disabled_at on project_member
      for each row execute function public.project_member_lead_not_disabled()
  `.execute(db)

  // Защита последнего администратора (0004_roles) теперь считает только включённых
  // администраторов: отключить последнего нельзя так же, как снять с него роль.
  await keepAdminFunction(db, 'and m.disabled_at is null')

  // Отключённое участие не даёт проекта в списке «мои проекты».
  await userProjectsFunction(db, 'and m.disabled_at is null')

  // Флаг ставит API после создания учётной записи и снимает после смены пароля: роли
  // приложения нужно право менять этот столбец (права на "user" — по столбцам, 0004_roles).
  await sql`alter table "user" add column must_change_password boolean not null default false`.execute(
    db,
  )
  await sql`grant update (must_change_password) on "user" to alpi_app`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`revoke update (must_change_password) on "user" from alpi_app`.execute(db)
  await sql`alter table "user" drop column must_change_password`.execute(db)
  await userProjectsFunction(db, '')
  await keepAdminFunction(db, '')
  await sql`drop trigger project_member_lead_not_disabled on project_member`.execute(db)
  await sql`drop function public.project_member_lead_not_disabled()`.execute(db)
  await sql`drop trigger team_lead_enabled on team`.execute(db)
  await sql`drop function public.team_lead_enabled()`.execute(db)
  await sql`alter table team drop constraint team_lead_in_team`.execute(db)
  await sql`
    alter table project_member
      drop constraint project_member_team_user_key,
      drop constraint project_member_team_fkey,
      drop column disabled_by,
      drop column disabled_at,
      drop column accepts_new_deals,
      drop column team_id
  `.execute(db)
  await sql`drop table team`.execute(db)
}

/**
 * project_member_keep_admin из 0004_roles; `enabledOnly` — дополнительное условие на
 * оставшегося администратора (пусто — как в 0004).
 */
async function keepAdminFunction(db: Kysely<unknown>, enabledOnly: string) {
  await sql
    .raw(`
      create or replace function public.project_member_keep_admin()
        returns trigger
        language plpgsql
        set search_path = pg_catalog, pg_temp
      as $$
      declare
        admin_role uuid;
      begin
        -- Проект удаляется целиком — защищать нечего.
        if not exists (select from public.project p where p.id = old.project_id) then
          return null;
        end if;
        select r.id into admin_role
          from public.role r
          where r.project_id = old.project_id and r.is_admin
          for no key update;
        if admin_role is null or old.role_id is distinct from admin_role then
          return null;
        end if;
        if not exists (
          select from public.project_member m
          where m.project_id = old.project_id and m.role_id = admin_role ${enabledOnly}
        ) then
          raise exception 'в проекте должен остаться хотя бы один администратор'
            using errcode = '${LAST_ADMIN}';
        end if;
        return null;
      end
      $$
    `)
    .execute(db)
}

/** user_projects из 0003_projects; `enabledOnly` — условие на участие (пусто — как в 0003). */
async function userProjectsFunction(db: Kysely<unknown>, enabledOnly: string) {
  await sql
    .raw(`
      create or replace function public.user_projects(p_user_id text)
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
          where m.project_id = p.id and m.user_id = p_user_id ${enabledOnly}
        )
        order by p.name, p.code
      $$
    `)
    .execute(db)
}
