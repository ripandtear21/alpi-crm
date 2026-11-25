import { type Kysely, sql } from 'kysely'

// Ключи API проекта (тикет crm-api/01; GLOSSARY.md, «Ключ API»; docs/adr/0003).
//
// - api_key — доступ внешней автоматизации к одному проекту с ролью этого проекта. Метка
//   проекта и row-level security, как в 0001_project_isolation. Секрет в базе не хранится:
//   только его отпечаток SHA-256 (secret_hash, hex) и первые 8 символов для показа в списке.
//   Строка не удаляется (у роли приложения нет DELETE): журналы ссылаются на неё как на автора.
// - Роль приложения не читает столбец secret_hash (права на чтение — по списку столбцов):
//   найти ключ по отпечатку можно только функцией api_key_by_secret_hash. До неё проект ещё не
//   известен, поэтому она SECURITY DEFINER — правила как в 0003_projects.
// - Отозванный ключ не меняется больше никак (триггер api_key_guard): отзыв не отменить, ключ
//   не перевыпустить. Единственное исключение — обнуление роли при её удалении (внешний ключ
//   ON DELETE SET NULL).
// - Роль с действующим ключом (не отозван, срок не истёк) не удаляется (триггер
//   role_keep_api_keys): ключ без роли потерял бы права незаметно для того, кто его выдал.
//   Ошибка — SQLSTATE foreign_key_violation, как у роли с участниками: API отвечает 409
//   ROLE_IN_USE. Роль отозванного или истёкшего ключа удаляется, ключ остаётся без роли.
// - audit_log и change_log получают автора-ключ (actor_api_key_id). Автор записи — пользователь,
//   ключ или никто (система), но не оба сразу.

/** Столбцы ключа, которые роль приложения читает (всё, кроме отпечатка секрета). */
const READABLE = [
  'id',
  'project_id',
  'name',
  'role_id',
  'secret_prefix',
  'created_by',
  'created_at',
  'expires_at',
  'revoked_at',
  'revoked_by',
  'last_used_at',
]

/** Столбцы, которые роль приложения задаёт при создании ключа. */
const INSERTABLE = [
  'project_id',
  'name',
  'role_id',
  'secret_hash',
  'secret_prefix',
  'created_by',
  'expires_at',
]

/** Столбцы, которые роль приложения меняет: перевыпуск, отзыв, последний запрос. */
const UPDATABLE = ['secret_hash', 'secret_prefix', 'revoked_at', 'revoked_by', 'last_used_at']

const LOG_TABLES = ['audit_log', 'change_log'] as const

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table api_key (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references project (id) on delete cascade,
      name text not null check (btrim(name) <> '' and char_length(name) <= 100),
      -- null — только у отозванного или истёкшего ключа, чью роль потом удалили.
      role_id uuid,
      secret_hash text not null unique check (secret_hash ~ '^[0-9a-f]{64}$'),
      secret_prefix text not null check (char_length(secret_prefix) = 8),
      created_by text not null references "user" (id),
      created_at timestamptz not null default now(),
      expires_at timestamptz,
      revoked_at timestamptz,
      revoked_by text references "user" (id),
      last_used_at timestamptz,
      unique (project_id, id),
      check ((revoked_at is null) = (revoked_by is null)),
      foreign key (project_id, role_id) references role (project_id, id)
        on delete set null (role_id)
    )
  `.execute(db)
  // Название уникально среди неотозванных ключей проекта, без учёта регистра.
  await sql`
    create unique index api_key_name_idx on api_key (project_id, lower(name))
      where revoked_at is null
  `.execute(db)
  await sql`create index api_key_role_idx on api_key (project_id, role_id)`.execute(db)

  await sql`alter table api_key enable row level security`.execute(db)
  await sql`
    create policy project_isolation on api_key
      using (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
      with check (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
  `.execute(db)
  await sql.raw(`grant select (${READABLE.join(', ')}) on api_key to alpi_app`).execute(db)
  await sql.raw(`grant insert (${INSERTABLE.join(', ')}) on api_key to alpi_app`).execute(db)
  await sql.raw(`grant update (${UPDATABLE.join(', ')}) on api_key to alpi_app`).execute(db)

  await sql`
    create function public.api_key_guard()
      returns trigger
      language plpgsql
      set search_path = pg_catalog, pg_temp
    as $$
    declare
      same_role public.api_key;
    begin
      if old.revoked_at is null then
        return new;
      end if;
      same_role := new;
      same_role.role_id := old.role_id;
      if new.role_id is null and same_role is not distinct from old then
        return new;
      end if;
      raise exception 'отозванный ключ API не меняется' using errcode = 'check_violation';
    end
    $$
  `.execute(db)
  await sql`
    create trigger api_key_guard before update on api_key
      for each row execute function public.api_key_guard()
  `.execute(db)

  // Обычная функция (не SECURITY DEFINER): роли удаляют только в контексте их проекта, и
  // row-level security показывает ей как раз ключи этого проекта. Удаление проекта целиком
  // (каскад) не проверяется — как в role_guard из 0004_roles.
  await sql`
    create function public.role_keep_api_keys()
      returns trigger
      language plpgsql
      set search_path = pg_catalog, pg_temp
    as $$
    begin
      if exists (select from public.project p where p.id = old.project_id)
        and exists (
          select from public.api_key k
          where k.project_id = old.project_id
            and k.role_id = old.id
            and k.revoked_at is null
            and (k.expires_at is null or k.expires_at > now())
        ) then
        raise exception 'у роли есть действующий ключ API' using errcode = 'foreign_key_violation';
      end if;
      return old;
    end
    $$
  `.execute(db)
  await sql`
    create trigger role_keep_api_keys before delete on role
      for each row execute function public.role_keep_api_keys()
  `.execute(db)

  // Ключ по отпечатку секрета — до того, как известен проект запроса. Отдаёт ключ, проект и
  // роль только действующего ключа: не отозван, срок не истёк, роль есть. Неизвестный,
  // отозванный и истёкший ключ для API неразличимы — пустой результат.
  await sql`
    create function public.api_key_by_secret_hash(p_secret_hash text)
      returns table (id uuid, project_id uuid, role_id uuid)
      language sql
      stable
      security definer
      set search_path = pg_catalog, pg_temp
    as $$
      select k.id, k.project_id, k.role_id
      from public.api_key k
      where k.secret_hash = p_secret_hash
        and k.revoked_at is null
        and (k.expires_at is null or k.expires_at > now())
        and k.role_id is not null
    $$
  `.execute(db)
  await sql`revoke all on function public.api_key_by_secret_hash(text) from public`.execute(db)
  await sql`grant execute on function public.api_key_by_secret_hash(text) to alpi_app`.execute(db)

  for (const table of LOG_TABLES) {
    await sql`alter table ${sql.table(table)} add column actor_api_key_id uuid`.execute(db)
    // Ключ — того же проекта, что запись журнала (составной внешний ключ).
    await sql
      .raw(`
        alter table ${table}
          add constraint ${table}_actor_api_key_fkey foreign key (project_id, actor_api_key_id)
            references api_key (project_id, id),
          add constraint ${table}_one_actor check (actor_id is null or actor_api_key_id is null)
      `)
      .execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [...LOG_TABLES].reverse()) {
    await sql`alter table ${sql.table(table)} drop column actor_api_key_id`.execute(db)
  }
  await sql`drop function public.api_key_by_secret_hash(text)`.execute(db)
  await sql`drop trigger role_keep_api_keys on role`.execute(db)
  await sql`drop function public.role_keep_api_keys()`.execute(db)
  await sql`drop table api_key`.execute(db)
  await sql`drop function public.api_key_guard()`.execute(db)
}
