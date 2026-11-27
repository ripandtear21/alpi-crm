import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ApiHarness, startApiHarness } from '../testing/api-harness.ts'
import { scanAllDuplicates } from './finder.ts'

// Ночной проход надсмотрщика за дублями на 100 тыс. сгенерированных контактов (тикет
// crm-intake/05): укладывается в 5 минут (порог — решено без владельца — подтвердить; тикет 10
// повторяет замер на данных `pnpm seed`). Время прохода тест печатает. Данные — вымышленные,
// пишутся одним запросом служебным подключением.

const CONTACTS = 100_000
/** Контактов с двумя открытыми сделками в одной воронке (одна архивная). */
const WITH_DEALS = 10_000
const LIMIT_MS = 5 * 60 * 1000

describe('ночной проход на 100 тыс. контактов', () => {
  let h: ApiHarness
  let projectId: string

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_duplicates_nightly')
    const admin = await h.signIn('owner')
    projectId = (await h.createProject(admin, 'Навантаження')).id
    const { id: pipelineId } = await h.owner
      .insertInto('pipeline')
      .values({ project_id: projectId, code: 'load', name: 'Воронка', position: 100 })
      .returning('id')
      .executeTakeFirstOrThrow()
    const { id: stageId } = await h.owner
      .insertInto('stage')
      .values({ project_id: projectId, pipeline_id: pipelineId, name: 'Новий', position: 1 })
      .returning('id')
      .executeTakeFirstOrThrow()
    // Каждый 50-й контакт повторяет телефон предыдущего, каждый 100-й — email, каждый 200-й —
    // имя и последние 9 цифр с другим кодом страны.
    await sql`
      insert into contact (project_id, first_name, last_name)
      select ${projectId}::uuid, 'Клієнт ' || (i % 7000), 'Прізвище ' || (i % 300)
      from generate_series(1, ${CONTACTS}::int) as i
    `.execute(h.owner)
    await sql`
      with numbered as (
        select id, row_number() over (order by created_at, id) as n from contact
        where project_id = ${projectId}::uuid
      )
      insert into contact_phone (project_id, contact_id, phone, is_primary)
      select ${projectId}::uuid, id,
        case when n % 200 = 0 then '+48' else '+38' end
          || '067' || lpad((case when n % 50 = 0 then n - 1 else n end)::text, 7, '0'),
        true
      from numbered
    `.execute(h.owner)
    await sql`
      with numbered as (
        select id, row_number() over (order by created_at, id) as n from contact
        where project_id = ${projectId}::uuid
      )
      insert into contact_email (project_id, contact_id, email, is_primary)
      select ${projectId}::uuid, id,
        'load-' || (case when n % 100 = 0 then n - 1 else n end) || '@example.test', true
      from numbered
    `.execute(h.owner)
    await sql`
      with picked as (
        select id from contact where project_id = ${projectId}::uuid order by id limit ${WITH_DEALS}
      )
      insert into deal (project_id, title, pipeline_id, stage_id, primary_contact_id, archived_at)
      select ${projectId}::uuid, 'Угода', ${pipelineId}::uuid, ${stageId}::uuid, id, archived
      from picked, (values (now()), (null::timestamptz)) as a (archived)
    `.execute(h.owner)
    await sql`analyze`.execute(h.owner)
  })

  afterAll(async () => {
    await h?.stop()
  })

  it('укладывается в 5 минут; время — в отчёте', { timeout: 2 * LIMIT_MS }, async () => {
    const started = performance.now()
    const first = await scanAllDuplicates(h.appDb)
    const firstMs = Math.round(performance.now() - started)
    const again = performance.now()
    const second = await scanAllDuplicates(h.appDb)
    const secondMs = Math.round(performance.now() - again)
    console.info(
      `ночной проход, ${CONTACTS} контактов: первый ${firstMs} мс (пар добавлено ${first.added}),` +
        ` повторный ${secondMs} мс (добавлено ${second.added}, удалено ${second.removed})`,
    )
    expect(first.added).toBeGreaterThan(WITH_DEALS)
    expect(second).toEqual({ added: 0, removed: 0 })
    expect(firstMs).toBeLessThan(LIMIT_MS)
    expect(secondMs).toBeLessThan(LIMIT_MS)
  })
})
