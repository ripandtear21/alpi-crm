# Code story — crm-intake 02: Слияние сделок с откатом

Kind: pr · Epic: crm-intake · Ticket: 02 · PR: - · Language: ru

## 1. Что было не так

Две сделки одного клиента нельзя было объединить: дубли оставались в канбане, и откатить ошибочное объединение было нечем. Тикет вводит ручное слияние сделок по правилам ADR 0005 (слияние с откатом): вторая сделка не удаляется, а скрывается и ссылается на оставшуюся; её заметки, файлы, строки товаров и участники переходят в оставшуюся, и откат возвращает ровно перешедшее. Расширенная проверка PR #40 (два круга доработки) добавила две правки: загрузка файла не должна держать блокировку сделки весь поток тела, а сброс демо-данных не должен падать на сделке, в которую что-то слито.
- Требование: [Что сделать](../issues/02-merge-deals-with-undo.md#что-сделать)

## 2. Скрытая сделка — две колонки и ссылка без каскада

Code: `packages/db/migrations/0026_merge.ts:147-160` · key lines: 151, 152, 154
```ts
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table deal
      add column merged_into_id uuid,
      add column merged_at timestamptz,
      add constraint deal_merged_into_fkey foreign key (project_id, merged_into_id)
        references deal (project_id, id),
      add constraint deal_merged_pair check ((merged_into_id is null) = (merged_at is null)),
      add constraint deal_merged_not_self check (merged_into_id <> id)
  `.execute(db)
  await sql`
    create index deal_merged_into_idx on deal (project_id, merged_into_id)
      where merged_into_id is not null
  `.execute(db)
```
- Что делает: слитая сделка помечается `merged_into_id` и `merged_at`; ссылка составная, с `project_id`, поэтому сделку не слить со сделкой другого проекта на уровне базы.
- Почему здесь: тикет требует эти колонки в миграции (раздел «Что сделать»); почему ключ без `on delete` — не записано.
- Без него: скрытую сделку нечем отличить от видимой, и откату не к чему вернуться.
- Требование: [Что сделать](../issues/02-merge-deals-with-undo.md#что-сделать)
- Риски и пробелы test-ов: ключ без каскада требует, чтобы любое удаление сделки сначала убирало скрытые, слитые в неё; так сделаны окончательное удаление из корзины и сброс демо-данных (шаг 7). Новый код, удаляющий сделки, должен помнить об этом.

## 3. Слияние начинается с блокировки обеих сделок

Code: `apps/api/src/merge/deals.ts:167-181` · key lines: 175, 176, 178
```ts
async function checkedPair(
  ctx: DealMergeContext,
  survivorId: string,
  mergedId: string,
): Promise<Result<{ pair: MergePair; survivor: DealRow; merged: DealRow }>> {
  if (!UUID.test(survivorId)) return refuse(404, 'DEAL_NOT_FOUND')
  const id = survivorId.toLowerCase()
  if (id === mergedId) return refuse(422, 'MERGE_SAME_DEAL')
  const rows = await lockDeals(ctx.db, [id, mergedId])
  const survivor = await mergeable(ctx, rows, id)
  if (!survivor.ok) return survivor
  const merged = await mergeable(ctx, rows, mergedId)
  if (!merged.ok) return merged
  return ok({ pair: { survivorId: id, mergedId }, survivor: survivor.value, merged: merged.value })
}
```
- Что делает: обе сделки блокируются FOR UPDATE до всех проверок; проверки «не в корзине, не слита, в охвате изменения» читают уже заблокированные строки.
- Почему здесь: расширенная проверка PR #39 (слияние контактов) нашла гонки транзакций в этом устройстве; тикет 02 повторяет его правила (ADR 0005).
- Без него: две одновременные операции над одной сделкой (слияние и правка, два слияния) видели бы устаревшее состояние.
- Требование: [Что сделать](../issues/02-merge-deals-with-undo.md#что-сделать)
- Риски и пробелы test-ов: порядок блокировок «сделки, потом контакт» обратный удалению контакта в корзину — возможная взаимоблокировка записана долгом в разделе «Результат» тикета.

## 4. Перенос, скрытие, запись слияния, история и событие — одной транзакцией

Code: `apps/api/src/merge/deals.ts:281-301` · key lines: 289, 292, 296, 297
```ts
async function mergeDeals(
  ctx: DealMergeContext,
  survivorId: string,
  mergedId: string,
): Promise<Result<DealMergeResult>> {
  const checked = await checkedPair(ctx, survivorId, mergedId)
  if (!checked.ok) return checked
  const { pair } = checked.value
  const items = await planAll(DEAL_MERGE_REGISTRY, ctx, pair)
  const survivorBefore = await snapshot(ctx, pair.survivorId)
  const mergedBefore = await snapshot(ctx, pair.mergedId)
  await applyAll(DEAL_MERGE_REGISTRY, ctx, pair, items)
  await ctx.db
    .updateTable('deal')
    .set({
      merged_into_id: pair.survivorId,
      merged_at: sql`clock_timestamp()`,
      updated_at: sql`now()`,
    })
    .where('id', '=', pair.mergedId)
    .execute()
```
- Что делает: реестр переноса (`deal-registry.ts`) сначала планирует, что перейдёт, потом переносит; вторая сделка скрывается, время слияния — `clock_timestamp()` после блокировок. Дальше в той же функции — запись слияния, история обеих сделок, журнал проекта и событие `deal.merged`.
- Почему здесь: тикет требует «одной транзакцией: перенос, записи слияния, история обеих сделок, журнал проекта, событие»; общие таблицы `merge_record` и `merge_moved_item` вводит этот PR (подтверждено владельцем 2026-11-26).
- Без него: упавшее слияние оставляло бы половину переноса или событие без переноса.
- Требование: [Что сделать](../issues/02-merge-deals-with-undo.md#что-сделать)
- Риски и пробелы test-ов: переносится только то, что нашёл план; запись, добавленная к второй сделке во время слияния, должна дождаться его и получить 404 — это держит блокировка FOR SHARE в шагах 5 и 6.

## 5. Загрузка файла проверяет сделку на входе без блокировки

Code: `apps/api/src/files/files.ts:166-171` · key lines: 170
```ts
  const declared = c.req.header('content-length')
  if (declared !== undefined && Number(declared) > MAX_FILE_BYTES) return tooLarge(c)
  // Вход — без блокировки строки сделки: поток тела (до 25 МБ) идёт долго, и FOR SHARE на всё
  // это время держал бы правку, этапы, корзину и слияние сделки (FOR UPDATE).
  const entity = await entityFor(c, type, c.req.param('id') ?? '', 'write', { lock: false })
  if (!entity.ok) return fail(c, entity)
```
- Что делает: проверяет существование, корзину и охват без блокировки строки: отказ (404 или 403) приходит сразу, но строка сделки не держится, пока идёт тело.
- Почему здесь: находка расширенной проверки PR #40 (среднее): ранний FOR SHARE в `entityFor` держал правку, этапы, корзину, товары, слияние и массовые операции сделки весь поток файла, а `lock_timeout` нет.
- Без него: правка сделки ждёт, пока клиент дошлёт файл до 25 МБ.
- Требование: [Результат](../issues/02-merge-deals-with-undo.md#результат)
- Риски и пробелы test-ов: тест `правка сделки не ждёт загрузку файла, пока идёт тело` в `apps/api/src/merge/deal-merge.test.ts` красный на мутанте с ранней блокировкой; заметки и другие короткие записи блокируют, как раньше.

## 6. Повторная проверка с блокировкой — после хранилища, перед строкой файла

Code: `apps/api/src/files/files.ts:213-221` · key lines: 217, 219
```ts
  // Повторная проверка с блокировкой FOR SHARE до конца транзакции — прямо перед записью строки:
  // за время потока запись могли слить (тикет crm-intake/02), убрать в корзину или вывести из
  // охвата. Слияние, начатое раньше, держит сделку FOR UPDATE — проверка ждёт его и получает
  // 404, файл не остаётся у скрытой сделки.
  const current = await entityFor(c, type, entity.value.id, 'write')
  if (!current.ok) {
    await storage.delete(key)
    return fail(c, current)
  }
```
- Что делает: после `storage.put` проверяет запись ещё раз, уже с FOR SHARE до конца транзакции запроса; при отказе удаляет сохранённый объект и отвечает отказом проверки.
- Почему здесь: исправление, предложенное расширенной проверкой PR #40: блокировка — только на короткую запись строки `file`.
- Без него: файл, загруженный во время слияния, оставался бы у скрытой сделки, а у сделки в корзине появлялся бы новый файл.
- Требование: [Результат](../issues/02-merge-deals-with-undo.md#результат)
- Риски и пробелы test-ов: тесты `заметка, файл, … добавленные ко второй сделке во время слияния` и `сделку убрали в корзину, пока шло тело файла` красные на мутантах без повторной проверки, без её блокировки и без удаления объекта. Если `storage.delete` сам упадёт, объект останется в хранилище без строки — как и в уже существовавшей ветке ошибки вставки.

## 7. Сброс демо-данных не удаляет сделку, в которую слита другая

Code: `apps/api/src/seed/store.ts:606-615` · key lines: 613, 614
```ts
      // Сделка seed остаётся, если к ней руками добавили заметку, файл, строку товара или
      // участника: иначе они ушли бы каскадом вместе со сделкой. Сделка, в которую слита другая
      // (тикет crm-intake/02), тоже остаётся: скрытая ссылается на неё без каскада
      // (deal_merged_into_fkey), удаление сорвало бы сброс проекта.
      const deals = await sql<{ id: string }>`
        delete from deal d
        where d.project_id = ${pid} and ${marked('deal', 'd.id')} and ${notes('deal_id', 'd')}
          and not exists (
            select 1 from deal h where h.project_id = d.project_id and h.merged_into_id = d.id
          )
```
- Что делает: `pnpm seed --reset` оставляет демо-сделку, если в неё слита любая сделка, — как оставляет сделку с ручными заметками и строками.
- Почему здесь: находка расширенной проверки PR #40 (низкое, владелец попросил включить): внешний ключ `deal_merged_into_fkey` без каскада давал 23503, и сброс проекта откатывался.
- Без него: сброс демо-данных падает в проекте, где настоящую сделку слили в демо-сделку.
- Требование: [Результат](../issues/02-merge-deals-with-undo.md#результат)
- Риски и пробелы test-ов: тест `--reset оставляет сделку seed, в которую слили ручную сделку` в `apps/api/src/cli/seed.test.ts` красный на мутанте без условия (ошибка внешнего ключа). Слияние двух демо-сделок оставит оставшуюся до следующего сброса — не проверено отдельным тестом.

## 8. Как проверено

`pnpm vitest run apps/api/src/merge/deal-merge.test.ts` и `pnpm vitest run apps/api/src/cli/seed.test.ts` — exit 0 на настоящем PostgreSQL; мутанты шагов 5–7 дают exit 1. `pnpm verify` и `gate fast` — с кодами выхода в отчёте PR.

## Проверить себя

1. Почему загрузка проверяет сделку дважды, а не один раз с блокировкой в конце?
   - Ответ: первая проверка без блокировки сразу отказывает чужой или удалённой записи, не читая тело; вторая, с FOR SHARE, ловит слияние или корзину, случившиеся за время потока.
   - Строки: `apps/api/src/files/files.ts:170`, `apps/api/src/files/files.ts:217-221`
2. Что мешает файлу, загруженному во время слияния, остаться у скрытой сделки?
   - Ответ: слияние держит обе сделки FOR UPDATE до конца своей транзакции; FOR SHARE повторной проверки ждёт его, перечитывает строку, видит `merged_into_id` и отвечает 404, удалив объект.
   - Строки: `apps/api/src/merge/deals.ts:175`, `apps/api/src/files/files.ts:217-221`
3. Почему сброс демо-данных падал без условия шага 7?
   - Ответ: скрытая сделка ссылается на оставшуюся ключом без каскада, и удаление оставшейся нарушало `deal_merged_into_fkey`.
   - Строки: `packages/db/migrations/0026_merge.ts:152-153`, `apps/api/src/seed/store.ts:613-615`
