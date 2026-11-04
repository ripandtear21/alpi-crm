import { type Kysely, sql } from 'kysely'

// Заметки и файлы к сделке, контакту или организации (тикет crm-deals/07; spec.md MVP,
// разделы 3.2 и 5.2).
//
// - note и file ссылаются ровно на одну запись: сделку, контакт или организацию (проверка
//   *_one_target). Ссылки — составные внешние ключи (project_id, …_id): запись своего проекта.
// - Заметки и файлы уходят вместе с записью при её окончательном удалении (purge_from_trash,
//   каскад). Объекты хранилища при этом остаются: их уборка — эпик эксплуатации.
// - Автор — учётная запись (как actor_id в change_log): пользователей не удаляют, а банят.
// - file.storage_key — ключ объекта в хранилище (apps/api/src/storage): начинается с id проекта,
//   имя файла от пользователя в ключ не попадает. Проверка таблицы держит первое.
// - Права роли приложения: заметку можно создать, поменять текст и удалить; файл — создать и
//   удалить (содержимое не меняется). Кто из пользователей что может — решает API.

const projectTables = ['note', 'file'] as const

/** Наибольший файл: 25 МБ (тот же предел у загрузки в API). */
const MAX_FILE_BYTES = 25 * 1024 * 1024

/** Столбцы ссылки на запись и их внешние ключи — одинаковые у заметки и файла. */
function targetColumns(table: string): string {
  return `
      deal_id uuid,
      contact_id uuid,
      organization_id uuid,
      constraint ${table}_one_target check (num_nonnulls(deal_id, contact_id, organization_id) = 1),
      constraint ${table}_deal_fkey foreign key (project_id, deal_id)
        references deal (project_id, id) on delete cascade,
      constraint ${table}_contact_fkey foreign key (project_id, contact_id)
        references contact (project_id, id) on delete cascade,
      constraint ${table}_organization_fkey foreign key (project_id, organization_id)
        references organization (project_id, id) on delete cascade`
}

/** Выдача по записи — новые сверху; по одному частичному индексу на вид записи. */
async function targetIndexes(db: Kysely<unknown>, table: string): Promise<void> {
  for (const column of ['deal_id', 'contact_id', 'organization_id']) {
    await sql
      .raw(`
        create index ${table}_${column}_idx on ${table} (${column}, created_at desc, id desc)
          where ${column} is not null
      `)
      .execute(db)
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(`
      create table note (
        id uuid primary key default gen_random_uuid(),
        project_id uuid not null references project (id) on delete cascade,
        text text not null check (btrim(text) <> '' and char_length(text) <= 20000),
        author_id text not null references "user" (id),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),${targetColumns('note')}
      )
    `)
    .execute(db)
  await targetIndexes(db, 'note')

  await sql
    .raw(`
      create table file (
        id uuid primary key default gen_random_uuid(),
        project_id uuid not null references project (id) on delete cascade,
        -- Исходное имя без пути: только для показа и Content-Disposition.
        name text not null check (btrim(name) <> '' and char_length(name) <= 255),
        -- Тип по содержимому (сигнатура файла), не по расширению и не по заголовку запроса.
        content_type text not null check (char_length(content_type) <= 100),
        size bigint not null check (size > 0 and size <= ${MAX_FILE_BYTES}),
        storage_key text not null unique check (starts_with(storage_key, project_id::text || '/')),
        author_id text not null references "user" (id),
        created_at timestamptz not null default now(),${targetColumns('file')}
      )
    `)
    .execute(db)
  await targetIndexes(db, 'file')

  for (const table of projectTables) {
    await sql`alter table ${sql.table(table)} enable row level security`.execute(db)
    await sql`
      create policy project_isolation on ${sql.table(table)}
        using (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
        with check (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
    `.execute(db)
  }
  await sql`grant select, delete on note to alpi_app`.execute(db)
  await sql`
    grant insert (project_id, deal_id, contact_id, organization_id, text, author_id) on note
      to alpi_app
  `.execute(db)
  await sql`grant update (text, updated_at) on note to alpi_app`.execute(db)
  await sql`grant select, delete on file to alpi_app`.execute(db)
  // id задаёт API: он же — часть ключа объекта, который пишется до строки.
  await sql`
    grant insert (id, project_id, deal_id, contact_id, organization_id, name, content_type, size,
      storage_key, author_id) on file to alpi_app
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [...projectTables].reverse()) {
    await sql`drop table ${sql.table(table)}`.execute(db)
  }
}
