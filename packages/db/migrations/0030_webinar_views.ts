import { type Kysely, sql } from 'kysely'

// Просмотры вебинара (тикет crm-intake/08; .scratch/crm-intake/spec.md, «Просмотры вебинара»;
// GLOSSARY.md, «Просмотр вебинара»). Просмотр ничего не создаёт: он дописывается в последнюю
// регистрацию контакта на тот же вебинар (пункты 7 и 17 ответов владельца).
//
// - registration.view_* — последний просмотр: «начал смотреть», «вышел», «минут просмотрено»,
//   остальные поля просмотра (`view_extra`) и время последнего обновления просмотра. Пока
//   просмотра не было — все null. Новый просмотр заменяет все пять (последние значения заменяют
//   прежние): роли приложения — UPDATE этих столбцов.
// - intake_event.kind 'webinar_view' — пара «источник, event_id» просмотра хранится вечно, как у
//   регистраций: повтор и «провести заново» не вернут старые значения просмотра поверх новых
//   (решено без владельца — подтвердить). `registration_id` — регистрация, в которую лёг
//   просмотр; null — просмотр без регистрации или регистрацию удалили.
// - inbound_request.outcome 'unmatched' — итог «без регистрации»: контакт или его регистрация
//   на этот вебинар не найдены, ничего не записано. Канал 'intake.webinar_view' проверка
//   канала из 0028 уже пропускает.
// - История регистрации (change_log, entity_type 'registration') уходит вместе с регистрацией:
//   при окончательном удалении контакта регистрация удаляется каскадом, а в «было → стало»
//   просмотра — данные вебинарной платформы о человеке. Удаляет триггер с правами владельца:
//   у роли приложения нет DELETE на change_log.

/** Наибольшее число минут просмотра: больше суток вебинар не идёт, запас — на ошибки платформы. */
const MAX_VIEW_MINUTES = 100_000

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table registration
      add column view_started_at timestamptz,
      add column view_finished_at timestamptz,
      add column view_minutes integer
        check (view_minutes between 0 and ${sql.lit(MAX_VIEW_MINUTES)}),
      add column view_extra jsonb check (jsonb_typeof(view_extra) = 'object'),
      add column view_updated_at timestamptz
  `.execute(db)
  await sql`
    grant update (view_started_at, view_finished_at, view_minutes, view_extra, view_updated_at)
      on registration to alpi_app
  `.execute(db)

  await sql`
    alter table intake_event
      drop constraint intake_event_kind_check,
      add constraint intake_event_kind_check check (kind in ('registration', 'webinar_view'))
  `.execute(db)
  await sql`
    alter table inbound_request
      drop constraint inbound_request_outcome_check,
      add constraint inbound_request_outcome_check
        check (outcome in ('accepted', 'repeat', 'error', 'unmatched'))
  `.execute(db)

  await sql`
    create function registration_history_purge() returns trigger
      language plpgsql
      security definer
      set search_path = pg_catalog, pg_temp
    as $$
    begin
      delete from public.change_log l
        where l.project_id = old.project_id
          and l.entity_type = 'registration'
          and l.entity_id = old.id;
      return null;
    end
    $$
  `.execute(db)
  await sql`revoke all on function registration_history_purge() from public`.execute(db)
  await sql`
    create trigger registration_history_purge after delete on registration
      for each row execute function registration_history_purge()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop trigger registration_history_purge on registration`.execute(db)
  await sql`drop function registration_history_purge()`.execute(db)
  // Строки, которых схема 0028 не знает: просмотры, их журнал и история регистраций.
  await sql`delete from change_log where entity_type = 'registration'`.execute(db)
  await sql`delete from inbound_request where outcome = 'unmatched'`.execute(db)
  await sql`delete from intake_event where kind = 'webinar_view'`.execute(db)
  await sql`
    alter table inbound_request
      drop constraint inbound_request_outcome_check,
      add constraint inbound_request_outcome_check
        check (outcome in ('accepted', 'repeat', 'error'))
  `.execute(db)
  await sql`
    alter table intake_event
      drop constraint intake_event_kind_check,
      add constraint intake_event_kind_check check (kind in ('registration'))
  `.execute(db)
  await sql`
    alter table registration
      drop column view_started_at,
      drop column view_finished_at,
      drop column view_minutes,
      drop column view_extra,
      drop column view_updated_at
  `.execute(db)
}
