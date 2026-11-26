import { type Kysely, sql } from 'kysely'

// Ключ API — автор заметки и создатель контакта (тикет crm-api/04).
//
// - note: автор — пользователь (author_id) или ключ API проекта (author_api_key_id), ровно один
//   из двух (проверка note_one_author). Ключ — того же проекта, что заметка (составной внешний
//   ключ, как actor_api_key_id журналов в 0019_api_keys). Строки ключа не удаляются, поэтому
//   ссылка на автора не рвётся.
// - contact: created_by_api_key_id — ключ, создавший контакт. У ключа нет своих записей и
//   команды, поэтому охват контактов «свои» и «команда» у ключа — контакты, созданные этим ключом
//   (apps/api/src/contacts/scope.ts; решено без владельца — подтвердить). Создатель —
//   пользователь или ключ, не оба сразу.
// - Номер 0022 пропущен: его занимала ветка тикета crm-api/06, теперь её миграция — 0024;
//   пропуск номера мигратор Kysely принимает (0013 пропущен так же).

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table note alter column author_id drop not null`.execute(db)
  await sql`alter table note add column author_api_key_id uuid`.execute(db)
  await sql
    .raw(`
      alter table note
        add constraint note_author_api_key_fkey foreign key (project_id, author_api_key_id)
          references api_key (project_id, id),
        add constraint note_one_author check (num_nonnulls(author_id, author_api_key_id) = 1)
    `)
    .execute(db)
  await sql`grant insert (author_api_key_id) on note to alpi_app`.execute(db)

  await sql`alter table contact add column created_by_api_key_id uuid`.execute(db)
  await sql
    .raw(`
      alter table contact
        add constraint contact_created_by_api_key_fkey foreign key (project_id, created_by_api_key_id)
          references api_key (project_id, id),
        add constraint contact_one_creator check (created_by is null or created_by_api_key_id is null)
    `)
    .execute(db)
  await sql`
    create index contact_created_by_api_key_idx on contact (created_by_api_key_id)
      where created_by_api_key_id is not null
  `.execute(db)
  await sql`grant insert (created_by_api_key_id) on contact to alpi_app`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table contact drop column created_by_api_key_id`.execute(db)
  // Заметки ключей без автора-пользователя не пережили бы возврат author_id not null.
  await sql`delete from note where author_id is null`.execute(db)
  await sql`alter table note drop column author_api_key_id`.execute(db)
  await sql`alter table note alter column author_id set not null`.execute(db)
}
