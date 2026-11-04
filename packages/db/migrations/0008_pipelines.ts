import { type Kysely, sql } from 'kysely'

// Воронки, этапы и справочник причин проигрыша (тикет crm-deals/02; spec.md MVP, разделы 3.2
// и 5.5; GLOSSARY.md — «Воронка», «Этап», «Причина проигрыша»).
//
// Все четыре таблицы — данные проекта: project_id и row-level security по app.project_id, как
// в 0001_project_isolation.ts. Ссылки между ними — составные внешние ключи (project_id, id):
// этап не может принадлежать воронке другого проекта, причина — группе другого проекта.
//
// - pipeline.code — латиница, уникален в проекте (внешние системы и команды ссылаются на
//   воронку по коду). pipeline.is_upsell — «воронка допродаж»: не больше одной в проекте
//   (частичный уникальный индекс; решено без владельца — подтвердить). Отметка держится и у
//   архивной воронки: архивация ничего, кроме archived_at, не меняет (ADR 0003).
// - stage.deleted_at — этап удаляется мягко: пропадает из канбана и из списков этапов, а
//   закрытые сделки на нём остаются. Открытые сделки на этапе запрещают удаление — это
//   проверяет API (apps/api/src/pipelines/stage-deals.ts), сделки появятся в тикете 05.
// - lost_reason_group → lost_reason: группа и причина, у обеих порядок и archived_at.
//   Архивная причина (или причина в архивной группе) не предлагается при проигрыше, но
//   остаётся у старых сделок. Названия групп уникальны в проекте, причин — в группе: по ним
//   стартовая настройка проекта не создаёт дублей.
// - position — порядок вывода (1, 2, 3…); переставляет его API одним запросом на весь список.

const projectTables = ['pipeline', 'stage', 'lost_reason_group', 'lost_reason'] as const

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table pipeline (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references project (id) on delete cascade,
      code text not null check (code ~ '^[a-z][a-z0-9_-]{0,39}$'),
      name text not null check (btrim(name) <> '' and char_length(name) <= 80),
      position integer not null default 0,
      is_upsell boolean not null default false,
      archived_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by text,
      unique (project_id, id),
      unique (project_id, code)
    )
  `.execute(db)
  await sql`
    create unique index pipeline_one_upsell_per_project on pipeline (project_id) where is_upsell
  `.execute(db)

  await sql`
    create table stage (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references project (id) on delete cascade,
      pipeline_id uuid not null,
      name text not null check (btrim(name) <> '' and char_length(name) <= 80),
      position integer not null default 0,
      deleted_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by text,
      unique (project_id, id),
      foreign key (project_id, pipeline_id) references pipeline (project_id, id) on delete cascade
    )
  `.execute(db)
  await sql`create index stage_pipeline_idx on stage (pipeline_id, position)`.execute(db)

  await sql`
    create table lost_reason_group (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references project (id) on delete cascade,
      name text not null check (btrim(name) <> '' and char_length(name) <= 80),
      position integer not null default 0,
      archived_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by text,
      unique (project_id, id),
      unique (project_id, name)
    )
  `.execute(db)

  await sql`
    create table lost_reason (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references project (id) on delete cascade,
      group_id uuid not null,
      name text not null check (btrim(name) <> '' and char_length(name) <= 80),
      position integer not null default 0,
      archived_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by text,
      unique (project_id, id),
      unique (project_id, group_id, name),
      foreign key (project_id, group_id) references lost_reason_group (project_id, id)
        on delete cascade
    )
  `.execute(db)

  for (const table of projectTables) {
    await sql`alter table ${sql.table(table)} enable row level security`.execute(db)
    await sql`
      create policy project_isolation on ${sql.table(table)}
        using (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
        with check (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
    `.execute(db)
    // Удалять строки приложению незачем: этап удаляется отметкой, остальное архивируется.
    await sql`grant select, insert, update on ${sql.table(table)} to alpi_app`.execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [...projectTables].reverse()) {
    await sql`drop table ${sql.table(table)}`.execute(db)
  }
}
