import { type Kysely, sql } from 'kysely'

// Журнал входов и опасных действий (тикет crm-foundation/07; spec.md, раздел 3.4, audit_log).
//
// Две таблицы, потому что у событий два хозяина:
// - audit_log — события проекта (роли, участники; дальше — выгрузка, массовые операции,
//   удаление). Метка проекта и row-level security, как у остальных таблиц проекта
//   (docs/adr/0001-izolyatsiya-proektov.md): администратор проекта A журнал проекта B не видит.
// - system_audit_log — события вне проекта: вход, неудачный вход, выход, включение и
//   отключение 2FA. Их видит только владелец системы. Роль приложения в эту таблицу только
//   добавляет строки и читать её не может: читает её функция system_audit_events (SECURITY
//   DEFINER), которая сама проверяет, что спрашивает владелец системы, — как create_project
//   из 0003_projects.
//
// Только добавление: у роли приложения нет UPDATE, DELETE и TRUNCATE ни на одной из таблиц,
// поэтому ни ошибка в API, ни SQL-инъекция не перепишут и не сотрут журнал. Строки уходят
// только вместе с проектом (каскад от project, его удаляет служебная роль).
//
// Неудачный вход (решение владельца): пишется email попытки (attempted_email), даже если
// такой учётной записи нет, и адрес клиента; учётная запись, если есть, — в actor_id. Записи
// о неудачных входах старше 90 дней удаляет служебная функция purgeExpiredFailedSignIns
// (packages/db/src/audit.ts) под служебной ролью — единственное исключение из «только
// добавление»; у роли приложения права удалять нет и здесь.

/** Роль владельца системы в плагине admin Better Auth (apps/api/src/auth/owner.ts). */
const OWNER_ROLE = 'admin'

/**
 * Общий потолок записей о неудачном входе за минуту, после которого email попытки не
 * пишется (триггер system_audit_log_flood_guard). Снимок на момент миграции.
 */
const FAILED_SIGN_IN_FLOOD = 100

/** Столбцы, общие для обеих таблиц. */
const COLUMNS = `
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  -- Кто действовал. null — неизвестный пользователь (неудачный вход с несуществующим email)
  -- или система. Пользователей не удаляют, а банят, поэтому ссылка не обрывается.
  actor_id text references "user" (id),
  -- Адрес клиента так, как его определил Better Auth (с учётом TRUSTED_PROXIES).
  ip inet,
  -- Код действия из packages/shared/src/audit.ts: «раздел.действие».
  action text not null check (action ~ '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$'),
  entity_type text check (char_length(entity_type) <= 40),
  entity_id text check (char_length(entity_id) <= 100),
  -- Подробности: например, «было — стало» при смене роли.
  details jsonb not null default '{}' check (jsonb_typeof(details) = 'object')
`

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(`
      create table audit_log (
        project_id uuid not null references project (id) on delete cascade,
        ${COLUMNS}
      )
    `)
    .execute(db)
  // Экран журнала: новые сверху, страница за страницей по (occurred_at, id).
  await sql`
    create index audit_log_page_idx on audit_log (project_id, occurred_at desc, id desc)
  `.execute(db)
  await sql`alter table audit_log enable row level security`.execute(db)
  await sql`
    create policy project_isolation on audit_log
      using (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
      with check (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
  `.execute(db)
  await sql`grant select, insert on audit_log to alpi_app`.execute(db)

  await sql
    .raw(`
      create table system_audit_log (
        ${COLUMNS},
        -- Email, который вводили при неудачном входе (в том числе несуществующий).
        attempted_email text check (char_length(attempted_email) <= 254)
      )
    `)
    .execute(db)
  await sql`
    create index system_audit_log_page_idx on system_audit_log (occurred_at desc, id desc)
  `.execute(db)
  // Очистка старых неудачных входов идёт по этому индексу.
  await sql`
    create index system_audit_log_action_idx on system_audit_log (action, occurred_at)
  `.execute(db)
  // Только INSERT: ни SELECT, ни RLS-политики не нужно — читать таблицу роль приложения не может.
  await sql`grant insert on system_audit_log to alpi_app`.execute(db)

  // Общий потолок неудачных входов (не по адресу клиента): ограничитель Better Auth считает
  // попытки с одного адреса, и с тысячи адресов email попыток лились бы в журнал без границы.
  // Если за последнюю минуту уже FAILED_SIGN_IN_FLOOD записей о неудачном входе, новая запись
  // всё равно пишется (попытка считается: время, адрес, причина), но без email — пометка
  // attemptedEmailRejected = 'flood'. Триггер в базе, а не в API: роль приложения не читает
  // таблицу и не может сама посчитать записи; SECURITY DEFINER — только ради этого подсчёта.
  // Строки без email короткие, и записи о неудачных входах удаляются через 90 дней.
  await sql
    .raw(`
      create function public.system_audit_log_flood_guard()
        returns trigger
        language plpgsql
        security definer
        set search_path = pg_catalog, pg_temp
      as $$
      begin
        if new.action = 'auth.sign_in_failed' and new.attempted_email is not null and (
          select count(*) from public.system_audit_log l
          where l.action = 'auth.sign_in_failed' and l.occurred_at > now() - interval '1 minute'
        ) >= ${FAILED_SIGN_IN_FLOOD} then
          new.attempted_email := null;
          new.details := new.details || '{"attemptedEmailRejected": "flood"}'::jsonb;
        end if;
        return new;
      end
      $$
    `)
    .execute(db)
  await sql`
    revoke all on function public.system_audit_log_flood_guard() from public
  `.execute(db)
  await sql`
    create trigger system_audit_log_flood_guard before insert on system_audit_log
      for each row execute function public.system_audit_log_flood_guard()
  `.execute(db)

  // Страница системного журнала для владельца системы: новые сверху, до курсора
  // (p_before_at, p_before_id), с фильтром по действию и пользователю. Владельца функция
  // проверяет сама по таблице "user" (не заблокирован, роль admin). Граница доверия — та же,
  // что у create_project из 0003_projects: id спрашивающего (p_viewer_id) передаёт API из
  // сессии, и функция ему верит. Это защищает от ошибки логики API (маршрут без проверки
  // владельца не откроет журнал обычному пользователю), но не от скомпрометированной роли
  // приложения: тот, кто выполняет SQL от её имени, подставит id владельца. Правила
  // SECURITY DEFINER — как в 0003_projects.
  await sql`
    create function public.system_audit_events(
      p_viewer_id text,
      p_before_at timestamptz,
      p_before_id uuid,
      p_action text,
      p_actor_id text,
      p_limit integer
    )
      returns setof public.system_audit_log
      language plpgsql
      stable
      security definer
      set search_path = pg_catalog, pg_temp
    as $$
    begin
      if not exists (
        select from public."user" u
        where u.id = p_viewer_id
          and not u.banned
          and ${sql.lit(OWNER_ROLE)} = any (
            select btrim(r) from unnest(string_to_array(coalesce(u.role, ''), ',')) r
          )
      ) then
        raise exception 'системный журнал видит только владелец системы'
          using errcode = 'insufficient_privilege';
      end if;

      return query
        select l.*
        from public.system_audit_log l
        where (p_before_at is null or (l.occurred_at, l.id) < (p_before_at, p_before_id))
          and (p_action is null or l.action = p_action)
          and (p_actor_id is null or l.actor_id = p_actor_id)
        order by l.occurred_at desc, l.id desc
        limit least(greatest(coalesce(p_limit, 50), 1), 200);
    end
    $$
  `.execute(db)
  await sql`
    revoke all on function public.system_audit_events(text, timestamptz, uuid, text, text, integer)
      from public
  `.execute(db)
  await sql`
    grant execute on function public.system_audit_events(text, timestamptz, uuid, text, text, integer)
      to alpi_app
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop function public.system_audit_events(text, timestamptz, uuid, text, text, integer)
  `.execute(db)
  await sql`drop table system_audit_log`.execute(db)
  await sql`drop function public.system_audit_log_flood_guard()`.execute(db)
  await sql`drop table audit_log`.execute(db)
}
