import { type Kysely, sql } from 'kysely'

// Источники регистраций и ключи источников (тикет crm-intake/03; .scratch/crm-intake/spec.md;
// GLOSSARY.md, «Источник регистраций», «Ключ источника»).
//
// - intake_source — внешний сервис (лендинг, форма, n8n), который присылает регистрации в
//   проект: название, воронка (новые сделки приёма — на её первом этапе) и ключ источника.
//   Метка проекта и row-level security, как в 0001_project_isolation. Ключ в базе не хранится:
//   только отпечаток SHA-256 (key_hash, hex) и первые 12 символов для показа в списке.
//   Строка не удаляется (у роли приложения нет DELETE): регистрации и журналы ссылаются на неё.
// - Воронка — своего проекта (составной внешний ключ). Название и воронка после создания не
//   меняются: роль приложения не может их обновить (права на изменение — по списку столбцов).
// - Роль приложения не читает столбец key_hash: найти источник по ключу можно только функцией
//   intake_source_by_key_hash. До неё проект ещё не известен, поэтому она SECURITY DEFINER —
//   правила как у api_key_by_secret_hash (0019_api_keys) и функций 0003_projects.
// - change_log получает автора-источник (actor_intake_source_id): изменения приёма регистраций
//   делает источник, а не пользователь и не ключ API. Автор записи — пользователь, ключ API,
//   источник или никто (система), но не двое сразу. webhook_event — тип автора intake_source.

/** Столбцы источника, которые роль приложения читает (всё, кроме отпечатка ключа). */
const READABLE = [
  'id',
  'project_id',
  'name',
  'pipeline_id',
  'key_prefix',
  'created_by',
  'created_at',
  'disabled_at',
  'disabled_by',
  'last_used_at',
]

/** Столбцы, которые роль приложения задаёт при создании источника. */
const INSERTABLE = ['project_id', 'name', 'pipeline_id', 'key_hash', 'key_prefix', 'created_by']

/** Столбцы, которые роль приложения меняет: смена ключа, отключение, последний запрос. */
const UPDATABLE = ['key_hash', 'key_prefix', 'disabled_at', 'disabled_by', 'last_used_at']

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table intake_source (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references project (id) on delete cascade,
      name text not null check (btrim(name) <> '' and char_length(name) <= 100),
      pipeline_id uuid not null,
      key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
      key_prefix text not null check (char_length(key_prefix) = 12),
      created_by text not null references "user" (id),
      created_at timestamptz not null default now(),
      disabled_at timestamptz,
      disabled_by text references "user" (id),
      last_used_at timestamptz,
      unique (project_id, id),
      check ((disabled_at is null) = (disabled_by is null)),
      foreign key (project_id, pipeline_id) references pipeline (project_id, id)
    )
  `.execute(db)
  // Название уникально в проекте, без учёта регистра; отключённые источники тоже в счёт —
  // их можно включить снова.
  await sql`
    create unique index intake_source_name_idx on intake_source (project_id, lower(name))
  `.execute(db)

  await sql`alter table intake_source enable row level security`.execute(db)
  await sql`
    create policy project_isolation on intake_source
      using (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
      with check (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
  `.execute(db)
  await sql.raw(`grant select (${READABLE.join(', ')}) on intake_source to alpi_app`).execute(db)
  await sql.raw(`grant insert (${INSERTABLE.join(', ')}) on intake_source to alpi_app`).execute(db)
  await sql.raw(`grant update (${UPDATABLE.join(', ')}) on intake_source to alpi_app`).execute(db)

  // Источник по отпечатку ключа — до того, как известен проект запроса приёма. Отдаёт id
  // источника, проект и воронку только включённого источника. Неизвестный и отключённый ключ
  // неразличимы — пустой результат. Больше функция ничего не читает и не меняет.
  await sql`
    create function public.intake_source_by_key_hash(p_key_hash text)
      returns table (id uuid, project_id uuid, pipeline_id uuid)
      language sql
      stable
      security definer
      set search_path = pg_catalog, pg_temp
    as $$
      select s.id, s.project_id, s.pipeline_id
      from public.intake_source s
      where s.key_hash = p_key_hash
        and s.disabled_at is null
    $$
  `.execute(db)
  await sql`revoke all on function public.intake_source_by_key_hash(text) from public`.execute(db)
  await sql`grant execute on function public.intake_source_by_key_hash(text) to alpi_app`.execute(
    db,
  )

  // Автор-источник в истории изменений: источник того же проекта, что запись (составной
  // внешний ключ). Прежнее ограничение «не пользователь и ключ сразу» — шире: не двое сразу.
  await sql`alter table change_log add column actor_intake_source_id uuid`.execute(db)
  await sql`
    alter table change_log
      drop constraint change_log_one_actor,
      add constraint change_log_actor_intake_source_fkey
        foreign key (project_id, actor_intake_source_id) references intake_source (project_id, id),
      add constraint change_log_one_actor
        check (num_nonnulls(actor_id, actor_api_key_id, actor_intake_source_id) <= 1)
  `.execute(db)

  await sql`
    alter table webhook_event
      drop constraint webhook_event_actor_type_check,
      add constraint webhook_event_actor_type_check
        check (actor_type in ('user', 'api_key', 'intake_source'))
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // События с автором-источником не прошли бы прежнюю проверку типа автора; события живут
  // 30 дней и только сообщают, их доставки удаляются вместе с ними.
  await sql`delete from webhook_event where actor_type = 'intake_source'`.execute(db)
  await sql`
    alter table webhook_event
      drop constraint webhook_event_actor_type_check,
      add constraint webhook_event_actor_type_check check (actor_type in ('user', 'api_key'))
  `.execute(db)
  // Записи истории с автором-источником остаются без автора (как изменения системы).
  await sql`alter table change_log drop constraint change_log_one_actor`.execute(db)
  await sql`alter table change_log drop column actor_intake_source_id`.execute(db)
  await sql`
    alter table change_log
      add constraint change_log_one_actor check (actor_id is null or actor_api_key_id is null)
  `.execute(db)
  await sql`drop function public.intake_source_by_key_hash(text)`.execute(db)
  await sql`drop table intake_source`.execute(db)
}
