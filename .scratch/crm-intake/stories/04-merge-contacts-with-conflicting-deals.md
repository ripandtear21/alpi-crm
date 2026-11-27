# Code story — crm-intake 04: Слияние контактов вместе с конфликтующими сделками

Kind: pr · Epic: crm-intake · Ticket: 04 · PR: - · Language: ru

## 1. Что было не так

Тикет 01 отказывал в слиянии контактов (409 `MERGE_DEAL_CONFLICT`), если у обоих есть открытые неархивные сделки в одной воронке: две такие у одного контакта запрещает уникальный индекс `deal_one_open_per_contact`. Владелец решил (пункт 31): запрета нет, такие сделки объединяются в том же действии. Тикет 04 добавляет это: пары конфликтующих сделок сливаются функцией тикета 02 с родительским слиянием контактов, выбор остающейся сделки — параметром `keep_deal_ids`, откат слияния контактов откатывает и слияния сделок.
- Требование: [Что сделать](../issues/04-merge-contacts-with-conflicting-deals.md#что-сделать)

## 2. Порядок внутри одного действия: проверки, блокировки, точка сохранения

Code: `apps/api/src/merge/contacts.ts:572-594` · key lines: 581, 584, 588, 593
```ts
async function mergeContacts(
  ctx: MergeContext,
  survivorId: string,
  request: MergeRequest,
): Promise<Result<MergeResult>> {
  const checked = await checkedPair(ctx, survivorId, request.mergedId)
  if (!checked.ok) return checked
  const { pair, conflicts } = checked.value
  // До любой записи и без данных сделок в ответе.
  if (!conflicts.every((conflict) => conflictAllowed(ctx, conflict))) {
    return refuse(403, 'MERGE_DEAL_FORBIDDEN')
  }
  const kept = keptDeals(ctx, conflicts, request.keepDealIds)
  if (!kept.ok) return kept
  const dealPairs = kept.value
  // Сделки всех пар — одним списком по id (lockDeals): одновременные слияния не сцепятся.
  if (dealPairs.length > 0) {
    await lockDeals(
      ctx.db,
      dealPairs.flatMap((deals) => [deals.survivorId, deals.mergedId]),
    )
  }
  return atomically(ctx.db, () => mergeLocked(ctx, pair, dealPairs))
```
- Что делает: до любой записи — право на обе сделки каждой пары (иначе 403 `MERGE_DEAL_FORBIDDEN` без данных сделок), затем выбор остающихся сделок (422 `MERGE_KEEP_DEAL_INVALID`), затем блокировка сделок всех пар одним списком по id и запись внутри `atomically`.
- Почему здесь: порядок «контакты, затем все сделки одним отсортированным списком» и проверка права — решения брифа без владельца (пункты 2 и 4); тикет требует 403 без данных чужой сделки.
- Без него: пользователь без права на чужую сделку объединил бы её; блокировки в разном порядке у двух одновременных слияний сцепились бы.
- Требование: [Что сделать](../issues/04-merge-contacts-with-conflicting-deals.md#что-сделать)
- Риски и пробелы test-ов: пути, которые блокируют сделку, потом контакт (`deals/deals.ts`, liveContact; откат слияния сделок), могут сцепиться с этим порядком (40P01, ответ 500, данные целы) — принятый долг тикета 12. Тест гонки двух одновременных слияний с конфликтующими сделками не написан.

## 3. Строка слияния контактов первой, слияния сделок — до переноса

Code: `apps/api/src/merge/contacts.ts:598-612` · key lines: 604, 606, 611, 612
```ts
async function mergeLocked(
  ctx: MergeContext,
  pair: MergePair,
  dealPairs: readonly MergePair[],
): Promise<MergeResult> {
  const survivorBefore = await snapshot(ctx, pair.survivorId)
  const mergedBefore = await snapshot(ctx, pair.mergedId)
  const record = await insertMergeRecord(ctx, 'contact', pair)
  const deals = dealContext(ctx)
  for (const { survivorId, mergedId } of dealPairs) {
    unwrap(await mergeDeals(deals, survivorId, mergedId, record.id))
  }
  // Перешедшее контакта — после слияний сделок: слитые сделки пар уже скрыты, и перенос сделок
  // (contact-registry.ts, DEALS) не нарушит индекс; участие, которое добавило слияние сделок,
  // учтено.
```
- Что делает: пишет `merge_record` контакта без перешедшего (`insertMergeRecord`), сливает каждую пару с `parent_id` этой строки и только потом планирует и переносит перешедшее контакта; перешедшее записывается после (`insertMovedItems`).
- Почему здесь: UPDATE `merge_record` роли приложения разрешён только для отметок отката (миграция 0026), поэтому `parent_id` нельзя поставить задним числом — родитель пишется первым (решение брифа, пункт 1). Индекс `deal_one_open_per_contact` не отложенный: слитая сделка пары должна быть уже скрыта, когда перенос сделок контакта (contact-registry.ts, DEALS) переведёт её к оставшемуся (пункт 2).
- Без него: перенос дал бы 23505 и ответ 500; без `parent_id` откат контакта не нашёл бы свои слияния сделок.
- Требование: [Что сделать](../issues/04-merge-contacts-with-conflicting-deals.md#что-сделать)
- Риски и пробелы test-ов: отказ `mergeDeals` внутри цикла после проверок шага 2 возможен только при гонке; он становится исключением `Refused` и откатывается до точки сохранения (шаг 4).

## 4. Отказ на любом шаге откатывает всё действие

Code: `apps/api/src/merge/contacts.ts:348-360` · key lines: 349, 355, 357
```ts
async function atomically<T>(db: Kysely<Database>, fn: () => Promise<T>): Promise<Result<T>> {
  await sql`savepoint contact_merge`.execute(db)
  try {
    const value = await fn()
    await sql`release savepoint contact_merge`.execute(db)
    return ok(value)
  } catch (error) {
    if (!(error instanceof Refused)) throw error
    await sql`rollback to savepoint contact_merge`.execute(db)
    return error.refusal
  }
}

```
- Что делает: точка сохранения `contact_merge` вокруг всех записей слияния и отката; отказ (`Refused`, его бросает `unwrap`) откатывает до неё и становится ответом 4xx, любая другая ошибка — 500 и откат всей транзакции запроса.
- Почему здесь: бриф требует, чтобы ошибка на второй паре откатывала и первую, а `refuse()` только возвращает значение и транзакцию не откатывает. Своё имя точки сохранения — потому что `inSavepoint` (roles/roles.ts) внутри отката сделок ставит `role_change`, и `rollback to` общего имени вернул бы к внутренней точке.
- Без него: отказ вложенного отката сделок (например, `MERGE_UNDO_BLOCKED`) оставил бы контакт уже возвращённым, а слияние сделок — нет.
- Требование: [Done when](../issues/04-merge-contacts-with-conflicting-deals.md#done-when)
- Риски и пробелы test-ов: тест «ошибка на второй паре» ломает вторую пару триггером базы — это путь 500; путь `Refused` проверен тестом отката, где вложенное слияние сделок отказывает.

## 5. Откат: сначала контакт, потом вложенные сделки — с поправкой на участие

Code: `apps/api/src/merge/contacts.ts:879-898` · key lines: 879, 884, 896, 897
```ts
  const added = await nestedParticipations(ctx.db, nested)
  const skipped = await restoreAll(
    CONTACT_MERGE_REGISTRY,
    ctx,
    pair,
    items.filter((item) => {
      const key = participationKey(pair, item)
      return key === null || !added.has(key)
    }),
  )
  await ctx.db
    .updateTable('contact')
    .set({ merged_into_id: null, merged_at: null, updated_at: sql`now()` })
    .where('id', '=', pair.mergedId)
    .execute()
  const undone = await markUndone(ctx, record.id)
  const deals = dealContext(ctx)
  for (const row of [...nested].reverse()) {
    unwrap(await undoDealMerge(deals, row.id, record.id))
  }
```
- Что делает: возвращает перешедшее к контакту, затем откатывает вложенные слияния сделок в обратном порядке (`undoDealMerge` с ожидаемым родителем). Участие, которое добавило слияние сделок (основной контакт слитой сделки — участник оставшейся) и сняло слияние контактов, откат контакта не возвращает: его убирает откат сделок.
- Почему здесь: порядок — решение брифа (пункт 5): если вернуть скрытую сделку раньше контакта, у оставшегося окажутся две открытые сделки в воронке. Фильтр участия — находка test-а направления «осталась сделка второго»: без него контакт оставался участником сделки после отката.
- Без него: откат оставлял бы лишнего участника в сделке или падал бы на уникальном индексе.
- Требование: [Done when](../issues/04-merge-contacts-with-conflicting-deals.md#done-when)
- Риски и пробелы test-ов: откат вложенного слияния сделок записывает в журнал `deal.unmerged` строку участия как `gone` (её уже удалило слияние контактов); итог отката контакта (`skipped`) пропуски вложенных слияний сделок не показывает.

## 6. Вложенное слияние сделок отдельно не откатить

Code: `apps/api/src/merge/deal-core.ts:285-287` · key lines: 285, 286
```ts
  if (record.parent_id !== parentId) {
    return refuse(409, 'MERGE_UNDO_NESTED', { mergeId: record.parent_id })
  }
```
- Что делает: откат слияния сделок, сделанного вместе со слиянием контактов, отдельно — 409 `MERGE_UNDO_NESTED` с id слияния контактов; откат контакта передаёт свой id и проходит.
- Почему здесь: тикет требует 409 со ссылкой на слияние контактов; почему проверка стоит после проверок охвата — не записано.
- Без него: отдельный откат вернул бы скрытую сделку, пока контакт слит, и разорвал бы откат контакта.
- Требование: [Что сделать](../issues/04-merge-contacts-with-conflicting-deals.md#что-сделать)
- Риски и пробелы test-ов: список слияний сделки (`dealMerges`) и карточка скрытой сделки (`mergedDealRefusal`, `merge_id: null`) вложенные слияния не предлагают; страница журнала (`settings/audit-page.tsx`) показывает «откатить» по любому `deal.merged` — ответ будет 409 с понятным текстом.

## 7. Экран: выбор остающейся сделки пары

Code: `apps/web/src/routes/contacts/merge/merge-dialog.tsx:192-202` · key lines: 196, 197, 198, 199
```tsx
              <DealPairs
                pairs={preview.data.dealPairs}
                onSwap={(pair) => {
                  const ids = [pair.survivorDeal?.id, pair.mergedDeal?.id]
                  const other = pair.keepDealId === pair.survivorDeal?.id ? pair.mergedDeal : null
                  setKeep((value) => [
                    ...value.filter((id) => !ids.includes(id)),
                    ...(other ? [other.id] : []),
                  ])
                }}
              />
```
- Что делает: «Поміняти» в паре кладёт в `keep_deal_ids` сделку второго контакта или убирает её; выбор уходит и в предпросмотр (экран показывает, какая остаётся), и в слияние. При смене направления контактов выбор сбрасывается; на пару без права «Об'єднати» недоступна.
- Почему здесь: тикет называет блок «Угоди, які теж буде об'єднано» в окне «Об'єднати з…» и требует выбор и объяснение без права; файл — в разделе «Where in code».
- Без него: остающуюся сделку нельзя было бы выбрать.
- Требование: [Что сделать](../issues/04-merge-contacts-with-conflicting-deals.md#что-сделать)
- Риски и пробелы test-ов: ширина 375 px задана CSS (одна колонка при `max-width: 480px`), снимка экрана нет — проверено только тестами разметки.

## 8. Как проверено

`pnpm vitest run apps/api/src/merge/` — exit 0 на настоящем PostgreSQL (61 тест, из них 9 новых тикета 04); `pnpm vitest run apps/web/src/routes/contacts` — exit 0; `pnpm verify` — exit 0. `gate fast` — с кодом выхода в отчёте PR.

## Проверить себя

1. Почему строка слияния контактов пишется до слияний сделок, а её перешедшее — после?
   - Ответ: на строку ссылается `parent_id` слияний сделок, а UPDATE `parent_id` задним числом роли приложения запрещён; перешедшее же планируется после слияний сделок, иначе перенос сделок нарушил бы не отложенный индекс.
   - Строки: `apps/api/src/merge/contacts.ts:604`, `apps/api/src/merge/contacts.ts:609-612`
2. Что произойдёт, если вложенный откат слияния сделок откажет после того, как контакт уже возвращён?
   - Ответ: `unwrap` бросит `Refused`, `atomically` откатит до точки сохранения `contact_merge`, ответ — 409 с кодом отказа, ничего не изменится.
   - Строки: `apps/api/src/merge/contacts.ts:896-897`, `apps/api/src/merge/contacts.ts:355-357`
3. Почему у `atomically` своё имя точки сохранения?
   - Ответ: откат сделок внутри ставит `role_change` через `inSavepoint`; при общем имени `rollback to` вернул бы к внутренней точке, и возврат контакта остался бы.
   - Строки: `apps/api/src/merge/contacts.ts:349`, `apps/api/src/merge/contacts.ts:357`
