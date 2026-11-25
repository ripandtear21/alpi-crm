import { type Kysely, sql } from 'kysely'

// Ответы для повтора по заголовку `Idempotency-Key` (тикет crm-api/02; .scratch/crm-api/spec.md,
// «Общие правила»; apps/api/src/http/idempotency.ts).
//
// - Строка — один запрос `POST` или `PATCH` с заголовком: автор (ключ API или пользователь),
//   значение заголовка, отпечаток запроса (SHA-256 метода, пути и тела, hex) и сохранённый
//   ответ. Уникальна по (проект, автор, значение): одно значение у двух авторов или двух
//   проектов — два независимых запроса.
// - Строка пишется той же транзакцией проекта, что изменение: сначала без ответа (её вставка
//   держит одинаковый параллельный запрос, пока первый не закончится), потом с ответом. Откат
//   изменения откатывает и её.
// - Ответы 5xx не сохраняются (response_status — только 2xx–4xx): такой запрос можно повторить.
// - Автор — тип и id без внешнего ключа: строка живёт 24 часа, ночная задача удаляет старые
//   (apps/api/src/jobs/jobs.ts), а удаление пользователя или ключа не должно на неё натыкаться.
// - Метка проекта и row-level security, как в 0001_project_isolation.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table idempotency_record (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references project (id) on delete cascade,
      author_type text not null check (author_type in ('user', 'api_key')),
      author_id text not null check (author_id <> ''),
      key text not null check (char_length(key) between 1 and 255),
      fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
      response_status smallint check (response_status between 200 and 499),
      response_content_type text,
      response_body text,
      created_at timestamptz not null default now(),
      unique (project_id, author_type, author_id, key),
      check ((response_status is null) = (response_body is null))
    )
  `.execute(db)
  await sql`
    create index idempotency_record_created_idx on idempotency_record (project_id, created_at)
  `.execute(db)

  await sql`alter table idempotency_record enable row level security`.execute(db)
  await sql`
    create policy project_isolation on idempotency_record
      using (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
      with check (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
  `.execute(db)
  await sql`grant select, insert, delete on idempotency_record to alpi_app`.execute(db)
  await sql`
    grant update (response_status, response_content_type, response_body)
      on idempotency_record to alpi_app
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table idempotency_record`.execute(db)
}
