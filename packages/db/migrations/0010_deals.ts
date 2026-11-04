import { type Kysely, sql } from 'kysely'

// Сделки и участники сделок (тикет crm-deals/05; spec.md MVP, разделы 3.2 и 4; GLOSSARY.md —
// «Сделка», «Общая очередь»; ADR 0003 — CRM сама сделки не меняет).
//
// - deal — сделка проекта. Ровно один этап (stage_id) — этап своей воронки: составной внешний
//   ключ (project_id, pipeline_id, stage_id) на stage. Основной контакт обязателен, организация
//   и ответственный (owner_id) — не больше одного; owner_id null — сделка в общей очереди.
//   Ответственный — участник этого же проекта (ключ на project_member).
// - Статус open / won / lost. Проиграна ⇔ есть причина проигрыша; выиграна ⇔ есть won_at;
//   проиграна ⇔ есть lost_at — проверки таблицы. Причина — из справочника своего проекта
//   (составной ключ) и не архивная в момент, когда её ставят (триггер deal_lost_reason_active:
//   старая сделка сохраняет причину, которую потом заархивировали).
// - Архив — отметка archived_at, а не статус. Корзина — deleted_at.
// - «Одна открытая сделка у человека в воронке» — частичный уникальный индекс
//   deal_one_open_per_contact: открытая, не в архиве, не в корзине. Он же разводит
//   одновременные запросы: второй получает нарушение уникальности, API отвечает 409.
// - Открытая сделка стоит только на действующем этапе (триггер deal_stage_live): этап
//   блокируется FOR SHARE, а удаление этапа (apps/api/src/pipelines) — FOR UPDATE и проверка
//   открытых сделок, так что сделка не встанет на этап, пока его удаляют. Открытые сделки в
//   корзине тоже держат этап: иначе такую сделку было бы не восстановить.
// - deal_participant — участники сделки с ролью (текст). Основной контакт здесь не дублируется
//   (проверяет API). Участник уходит вместе со сделкой или контактом при окончательном удалении.
// - История — change_log (0009_contacts) с entity_type 'deal'; участники пишутся полем
//   participants сделки.
//
// Как у контактов: у роли приложения нет DELETE на deal, INSERT — списком столбцов без id и без
// отметок корзины и архива, UPDATE — только столбцов данных. Окончательно удаляет сделку только
// purge_from_trash, вместе с её историей: иначе сделку можно было бы удалить и вставить заново
// с тем же id — живая запись без истории.

const projectTables = ['deal', 'deal_participant'] as const

/** SQLSTATE: открытая сделка на удалённом этапе. */
const STAGE_DELETED = 'DL001'
/** SQLSTATE: причина проигрыша (или её группа) в архиве. */
const LOST_REASON_ARCHIVED = 'DL002'
/** SQLSTATE: окончательно удаляют запись, которой нет в корзине (как в 0009_contacts). */
const NOT_IN_TRASH = 'CL001'

/** Столбцы, которые роль приложения задаёт при вставке сделки. */
const DEAL_INSERTABLE = [
  'project_id',
  'title',
  'pipeline_id',
  'stage_id',
  'status',
  'lost_reason_id',
  'amount',
  'currency',
  'owner_id',
  'primary_contact_id',
  'organization_id',
  'won_at',
  'lost_at',
  'expected_close_date',
  'created_by',
]

/** Столбцы сделки, которые роль приложения может менять (не id, не проект, не автор). */
const DEAL_UPDATABLE = [
  'title',
  'pipeline_id',
  'stage_id',
  'status',
  'lost_reason_id',
  'amount',
  'currency',
  'owner_id',
  'primary_contact_id',
  'organization_id',
  'won_at',
  'lost_at',
  'stage_changed_at',
  'expected_close_date',
  'archived_at',
  'updated_at',
  'deleted_at',
  'deleted_by',
]

/** purge_from_trash: ветки по типу сущности. `withDeal` — с веткой сделок (0010). */
function purgeFunction(withDeal: boolean): string {
  const dealBranch = withDeal
    ? `
        elsif p_entity_type = 'deal' then
          delete from public.deal d
            where d.id = p_id and d.project_id = current_project and d.deleted_at is not null;`
    : ''
  return `
    create or replace function public.purge_from_trash(p_entity_type text, p_id uuid)
      returns void
      language plpgsql
      security definer
      set search_path = pg_catalog, pg_temp
    as $$
    declare
      current_project uuid := nullif(current_setting('app.project_id', true), '')::uuid;
    begin
      if current_project is null then
        raise exception 'проект не выставлен' using errcode = 'insufficient_privilege';
      end if;
      if p_entity_type = 'contact' then
        delete from public.contact c
          where c.id = p_id and c.project_id = current_project and c.deleted_at is not null;
      elsif p_entity_type = 'organization' then
        delete from public.organization o
          where o.id = p_id and o.project_id = current_project and o.deleted_at is not null;${dealBranch}
      else
        raise exception 'сущность % так не удаляется', p_entity_type
          using errcode = 'insufficient_privilege';
      end if;
      if not found then
        raise exception 'записи нет в корзине проекта' using errcode = '${NOT_IN_TRASH}';
      end if;
      delete from public.change_log l
        where l.project_id = current_project
          and l.entity_type = p_entity_type
          and l.entity_id = p_id;
    end
    $$
  `
}

export async function up(db: Kysely<unknown>): Promise<void> {
  // Этап своей воронки: ключ (project_id, pipeline_id, id) для составного внешнего ключа сделки.
  await sql`
    alter table stage add constraint stage_project_pipeline_id_key unique (project_id, pipeline_id, id)
  `.execute(db)

  await sql`
    create table deal (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references project (id) on delete cascade,
      title text not null check (btrim(title) <> '' and char_length(title) <= 200),
      pipeline_id uuid not null,
      stage_id uuid not null,
      status text not null default 'open' check (status in ('open', 'won', 'lost')),
      lost_reason_id uuid,
      amount numeric(14, 2) not null default 0 check (amount >= 0),
      currency text not null default 'EUR' check (currency in ('EUR', 'UAH', 'USD')),
      -- Ответственный; null — сделка в общей очереди.
      owner_id text,
      primary_contact_id uuid not null,
      organization_id uuid,
      won_at timestamptz,
      lost_at timestamptz,
      stage_changed_at timestamptz not null default now(),
      expected_close_date date,
      archived_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by text,
      deleted_at timestamptz,
      deleted_by text,
      unique (project_id, id),
      constraint deal_lost_has_reason check ((status = 'lost') = (lost_reason_id is not null)),
      constraint deal_won_at check ((status = 'won') = (won_at is not null)),
      constraint deal_lost_at check ((status = 'lost') = (lost_at is not null)),
      constraint deal_pipeline_fkey foreign key (project_id, pipeline_id)
        references pipeline (project_id, id),
      constraint deal_stage_fkey foreign key (project_id, pipeline_id, stage_id)
        references stage (project_id, pipeline_id, id),
      constraint deal_lost_reason_fkey foreign key (project_id, lost_reason_id)
        references lost_reason (project_id, id),
      constraint deal_owner_fkey foreign key (project_id, owner_id)
        references project_member (project_id, user_id),
      constraint deal_primary_contact_fkey foreign key (project_id, primary_contact_id)
        references contact (project_id, id),
      constraint deal_organization_fkey foreign key (project_id, organization_id)
        references organization (project_id, id) on delete set null (organization_id)
    )
  `.execute(db)
  await sql`
    create unique index deal_one_open_per_contact on deal (project_id, pipeline_id, primary_contact_id)
      where status = 'open' and archived_at is null and deleted_at is null
  `.execute(db)
  await sql`create index deal_owner_idx on deal (project_id, owner_id)`.execute(db)
  await sql`create index deal_contact_idx on deal (project_id, primary_contact_id)`.execute(db)
  // Открытые сделки этапа, в том числе в корзине: проверка удаления этапа
  // (apps/api/src/pipelines/stage-deals.ts).
  await sql`
    create index deal_open_stage_idx on deal (project_id, stage_id) where status = 'open'
  `.execute(db)
  await sql`
    create index deal_organization_idx on deal (project_id, organization_id)
  `.execute(db)

  await sql`
    create table deal_participant (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references project (id) on delete cascade,
      deal_id uuid not null,
      contact_id uuid not null,
      -- Роль участника в сделке: «оплачує», «колега»…; null — не указана.
      role text check (btrim(role) <> '' and char_length(role) <= 100),
      created_at timestamptz not null default now(),
      created_by text,
      unique (deal_id, contact_id),
      foreign key (project_id, deal_id) references deal (project_id, id) on delete cascade,
      foreign key (project_id, contact_id) references contact (project_id, id) on delete cascade
    )
  `.execute(db)
  await sql`
    create index deal_participant_contact_idx on deal_participant (project_id, contact_id)
  `.execute(db)

  // Открытая сделка — только на действующем этапе. FOR SHARE ждёт удаления этапа (FOR UPDATE в
  // API) и после него не находит этап. Проверка — когда сделка становится открытой на этапе:
  // создание, смена этапа, повторное открытие, восстановление из корзины.
  await sql
    .raw(`
      create function public.deal_stage_live()
        returns trigger
        language plpgsql
      as $$
      begin
        if new.status = 'open' and new.deleted_at is null and (
          tg_op = 'INSERT'
          or new.stage_id is distinct from old.stage_id
          or old.status <> 'open'
          or old.deleted_at is not null
        ) then
          perform 1 from public.stage s
            where s.id = new.stage_id and s.deleted_at is null
            for share;
          if not found then
            raise exception 'этап сделки удалён' using errcode = '${STAGE_DELETED}';
          end if;
        end if;
        return new;
      end
      $$
    `)
    .execute(db)
  await sql`
    create trigger deal_stage_live before insert or update of stage_id, status, deleted_at on deal
      for each row execute function public.deal_stage_live()
  `.execute(db)

  // Причину проигрыша ставят только действующую: ни она, ни её группа не в архиве.
  await sql
    .raw(`
      create function public.deal_lost_reason_active()
        returns trigger
        language plpgsql
      as $$
      begin
        if new.lost_reason_id is not null
          and (tg_op = 'INSERT' or new.lost_reason_id is distinct from old.lost_reason_id) then
          perform 1 from public.lost_reason r
            join public.lost_reason_group g on g.id = r.group_id
            where r.id = new.lost_reason_id and r.archived_at is null and g.archived_at is null;
          if not found then
            raise exception 'причина проигрыша в архиве' using errcode = '${LOST_REASON_ARCHIVED}';
          end if;
        end if;
        return new;
      end
      $$
    `)
    .execute(db)
  await sql`
    create trigger deal_lost_reason_active before insert or update of lost_reason_id on deal
      for each row execute function public.deal_lost_reason_active()
  `.execute(db)

  for (const table of projectTables) {
    await sql`alter table ${sql.table(table)} enable row level security`.execute(db)
    await sql`
      create policy project_isolation on ${sql.table(table)}
        using (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
        with check (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
    `.execute(db)
  }
  await sql`grant select on deal to alpi_app`.execute(db)
  await sql.raw(`grant insert (${DEAL_INSERTABLE.join(', ')}) on deal to alpi_app`).execute(db)
  await sql.raw(`grant update (${DEAL_UPDATABLE.join(', ')}) on deal to alpi_app`).execute(db)
  // Id участника ни с чем не связан (история пишется полем сделки): строки заменяются свободно.
  await sql`grant select, insert, update, delete on deal_participant to alpi_app`.execute(db)

  // Окончательное удаление сделки из корзины — тем же purge_from_trash, вместе с историей;
  // участники уходят каскадом. Права на функцию сохраняются при create or replace.
  await sql.raw(purgeFunction(true)).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(purgeFunction(false)).execute(db)
  // История сделок уходит вместе с ними: без таблицы deal её не удалить через purge_from_trash.
  await sql`delete from change_log where entity_type = 'deal'`.execute(db)
  for (const table of [...projectTables].reverse()) {
    await sql`drop table ${sql.table(table)}`.execute(db)
  }
  await sql`drop function public.deal_stage_live()`.execute(db)
  await sql`drop function public.deal_lost_reason_active()`.execute(db)
  await sql`alter table stage drop constraint stage_project_pipeline_id_key`.execute(db)
}
