# Code story — crm-intake 01: Слияние контактов с откатом

Kind: pr · Epic: crm-intake · Ticket: 01 · PR: - · Language: ru

## 1. Что было не так

Два контакта одного человека нельзя было объединить, а ошибочное объединение — отменить. Тикет вводит ручное слияние контактов по ADR 0005 (слияние с откатом): второй контакт не стирается, а скрывается со ссылкой на оставшийся; его сделки, заметки, файлы, телефоны и email переходят к оставшемуся, откат 30 дней возвращает ровно перешедшее. Общие таблицы и откат уже принёс тикет 02 (слияние сделок, PR #40), здесь — только часть контактов. Расширенная проверка (MAX-REVIEW) прошлого круга нашла три гонки транзакций и падение сброса демо-данных; этот круг их исправляет.
- Требование: [Что сделать](../issues/01-merge-contacts-with-undo.md#что-сделать)

## 2. Скрытый контакт — столбцы в новой миграции 0027

Code: `packages/db/migrations/0027_contact_merge.ts:146-158` · key lines: 149, 151, 152
```ts
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table contact
      add column merged_into_id uuid,
      add column merged_at timestamptz,
      add column possible_duplicate_of uuid,
      add constraint contact_merged_into_fkey foreign key (project_id, merged_into_id)
        references contact (project_id, id),
      add constraint contact_possible_duplicate_of_fkey foreign key (project_id, possible_duplicate_of)
        references contact (project_id, id) on delete set null (possible_duplicate_of),
      add constraint contact_merged_pair check ((merged_into_id is null) = (merged_at is null)),
      add constraint contact_merged_not_self check (merged_into_id <> id),
      add constraint contact_duplicate_not_self check (possible_duplicate_of <> id)
```
- Что делает: слитый контакт помечается `merged_into_id` и `merged_at`, ссылка составная, с `project_id`: контакт другого проекта слить нельзя на уровне базы. `possible_duplicate_of` связывает отметку «возможный дубль» с конкретным контактом.
- Почему здесь: номер 0026 занят слиянием сделок в `main`; бриф доработки велит положить столбцы и права контакта в новую миграцию 0027.
- Без него: скрытый контакт не отличить от видимого, откату некуда вернуться.
- Требование: [Что сделать](../issues/01-merge-contacts-with-undo.md#что-сделать)
- Риски и пробелы test-ов: ключ `contact_merged_into_fkey` без каскада — любое удаление контакта должно сначала убрать слитые в него (шаги 3 и 8). Применение и откат миграции проверяет `packages/db/src/project-isolation.test.ts`.

## 3. Окончательное удаление: корень под блокировкой и с условием «в корзине»

Code: `packages/db/migrations/0027_contact_merge.ts:36-64` · key lines: 38, 58, 62
```ts
        perform 1 from public.contact c
          where c.id = p_id and c.project_id = current_project and c.deleted_at is not null
          for update;
        if not found then
          raise exception 'записи нет в корзине проекта' using errcode = '${NOT_IN_TRASH}';
        end if;
        with recursive chain(id) as (
          select p_id
          union
          select c.id from public.contact c
            join chain on c.merged_into_id = chain.id
            where c.project_id = current_project
        )
        select array_agg(chain.id) into ids from chain;
        delete from public.merge_record m
          where m.project_id = current_project
            and m.entity_type = 'contact'
            and (m.survivor_id = any (ids) or m.merged_id = any (ids));
        with removed as (
          delete from public.contact c
            where c.project_id = current_project
              and c.id = any (ids)
              and (c.id <> p_id or c.deleted_at is not null)
            returning c.id
        )
        select coalesce(bool_or(removed.id = p_id), false) into root_removed from removed;
        if not root_removed then
          raise exception 'записи нет в корзине проекта' using errcode = '${NOT_IN_TRASH}';
        end if;
```
- Что делает: корень блокируется FOR UPDATE — одновременное восстановление из корзины дожидается, и условие перечитывается; цепочка слитых собирается уже после блокировки; корень удаляется только если он всё ещё в корзине, и это проверяется по удалённым строкам.
- Почему здесь: находка 2 расширенной проверки — проверка «в корзине» была без блокировки, а `delete` потерял условие `deleted_at is not null`. Ветка сделки в той же функции — байт в байт как в 0026.
- Без него: фоновая очистка корзины (`CONTACT_PURGER`) стирала контакт, восстановленный в тот же момент, каскадом с телефонами, заметками и файлами.
- Требование: [Доработка, круг 3](../issues/01-merge-contacts-with-undo.md#доработка-круг-3-2026-11-27)
- Риски и пробелы test-ов: тест `фоновая очистка корзины не стирает контакт, который в тот же момент восстановили` красный на мутанте прошлого круга (без блокировки и без условия). Блокировка и условие страхуют друг друга: мутант, убравший только одно из них, этот тест не роняет.

## 4. Время слияния — после блокировок

Code: `apps/api/src/merge/contacts.ts:368-378` · key lines: 373, 378
```ts
  await applyAll(CONTACT_MERGE_REGISTRY, ctx, pair, items)
  await ctx.db
    .updateTable('contact')
    .set({
      merged_into_id: pair.survivorId,
      merged_at: sql`clock_timestamp()`,
      updated_at: sql`now()`,
    })
    .where('id', '=', pair.mergedId)
    .execute()
  const record = await insertMerge(ctx, 'contact', pair, items)
```
- Что делает: отметка на скрытом контакте и запись слияния (`insertMerge` в общем `merge/store.ts`) получают `clock_timestamp()` — время записи, а не начала транзакции запроса.
- Почему здесь: находка 1 — транзакцию открывает middleware до блокировки контактов, и слияние, ждавшее чужую блокировку, получало время раньше того, кого ждало.
- Без него: откат сравнивал слияния по неверному времени и не видел более позднего.
- Требование: [Доработка, круг 3](../issues/01-merge-contacts-with-undo.md#доработка-круг-3-2026-11-27)
- Риски и пробелы test-ов: тест `цепочка слияний: оставшийся слит позже …` красный на мутанте с `now()`.

## 5. Откат отказывает, если оставшийся сам слит

Code: `apps/api/src/merge/contacts.ts:550-561` · key lines: 553, 555
```ts
  if (await undoExpired(ctx.db, record)) return refuse(409, 'MERGE_UNDO_EXPIRED')
  // Оставшийся сам слит с другим — сначала откатить то слияние: иначе то, что перешло к нему,
  // осталось бы у скрытого контакта.
  if (survivor.merged_into_id !== null) {
    return refuse(409, 'MERGE_UNDO_BLOCKED', {
      mergeId: await hidingMerge(ctx.db, survivor.id),
    })
  }
  const later = await laterMerge(ctx.db, record)
  if (later !== null || merged.merged_into_id !== pair.survivorId) {
    return refuse(409, 'MERGE_UNDO_BLOCKED', { mergeId: later })
  }
```
- Что делает: если оставшийся контакт уже слит с третьим, откат отвечает 409 `MERGE_UNDO_BLOCKED` со ссылкой на то слияние — сначала откатить его.
- Почему здесь: находка 1; так же уже делает откат сделок в `main` (`apps/api/src/merge/deals.ts`).
- Без него: вернувшийся контакт оставался пустым, а перешедшее лежало у скрытого оставшегося.
- Требование: [Доработка, круг 3](../issues/01-merge-contacts-with-undo.md#доработка-круг-3-2026-11-27)
- Риски и пробелы test-ов: тест той же цепочки ещё раз ставит позднему слиянию время раньше первого (как у записей до правки) и ждёт тот же отказ — красный на мутанте без проверки.

## 6. Один маршрут отката: ветка контакта рядом со сделкой

Code: `apps/api/src/merge/deals.ts:568-579` · key lines: 571, 572
```ts
    if (!access) return fail(c, refuse(403, 'PERMISSION_DENIED'))
    switch (record?.entity_type) {
      // Тикет crm-intake/01: право «контакты: изменять» проверяет ветка контакта.
      case 'contact':
        return undoContactMerge(c, id)
      case 'deal':
        if (!can(access.permissions, 'deals', 'edit')) {
          return fail(c, refuse(403, 'PERMISSION_DENIED'))
        }
        return respond(c, await undoDealMerge(await mergeContext(c), id))
      default:
        return fail(c, refuse(404, 'MERGE_NOT_FOUND'))
```
- Что делает: `POST /api/v1/merges/:id/undo` по типу записи слияния ведёт в ветку контакта; право «контакты: изменять» проверяет `undoContactMerge` (`apps/api/src/merge/contacts.ts`), охват — сам откат.
- Почему здесь: бриф доработки — маршрут отката один, ветка `contact` рядом с `deal`.
- Без него: слияние контактов отвечало бы 404 `MERGE_NOT_FOUND` на откат.
- Требование: [Доработка, круг 3](../issues/01-merge-contacts-with-undo.md#доработка-круг-3-2026-11-27)
- Риски и пробелы test-ов: без ветки падают тесты отката; без проверки права — тест `без «контакты: изменять» — 403; на откат — тоже`.

## 7. Заметка и файл ждут слияния контакта

Code: `apps/api/src/timeline/entity.ts:117-130` · key lines: 123, 130
```ts
  const contactIn = (contactScope: typeof scope.read, share = false) => {
    const query = db
      .selectFrom('contact')
      .select('id')
      .where('id', '=', ref.id)
      .where('deleted_at', 'is', null)
      .where((eb) => contactScopePredicate(eb, contactScope, viewer))
    return (share ? query.forShare() : query).executeTakeFirst()
  }
  // Слитый контакт скрыт (тикет crm-intake/01; contactScopePredicate). Для изменения строка
  // блокируется FOR SHARE, как сделка выше: заметка или файл, добавленные ко второму контакту во
  // время слияния (FOR UPDATE обоих контактов), ждут его и потом получают 404, а не остаются у
  // скрытого контакта.
  if (!(await contactIn(scope.read, lock))) return notFound
```
- Что делает: для записи (`need: 'write'`) строка контакта читается FOR SHARE до конца транзакции; слияние держит оба контакта FOR UPDATE, поэтому заметка или файл ко второму контакту ждут его и потом получают 404.
- Почему здесь: находка 3; так же сделано для сделки в той же функции. Загрузка файла по-прежнему зовёт `entityFor` на входе с `{ lock: false }` и повторяет проверку с блокировкой прямо перед строкой файла (`apps/api/src/files/files.ts`).
- Без него: файл или заметка, созданные во время слияния, оставались у скрытого контакта.
- Требование: [Доработка, круг 3](../issues/01-merge-contacts-with-undo.md#доработка-круг-3-2026-11-27)
- Риски и пробелы test-ов: тест `заметка и файл, добавленные ко второму контакту во время слияния, не остаются у скрытого` красный без FOR SHARE; тест `правка контакта не ждёт загрузку файла, пока идёт тело` красный, если блокировать на входе загрузки.

## 8. Сброс демо-данных оставляет контакт, в который слит другой

Code: `apps/api/src/seed/store.ts:625-633` · key lines: 630, 631, 632
```ts
      // Контакт, в который слит другой (тикет crm-intake/01), остаётся, как сделка выше:
      // скрытый ссылается на него без каскада (contact_merged_into_fkey).
      const contacts = await sql<{ id: string }>`
        delete from contact c
        where c.project_id = ${pid} and ${marked('contact', 'c.id')} and ${notes('contact_id', 'c')}
          and not exists (
            select 1 from contact h where h.project_id = c.project_id and h.merged_into_id = c.id
          )
          and not exists (select 1 from deal d where d.primary_contact_id = c.id)
```
- Что делает: `pnpm seed --reset` не удаляет демо-контакт, если в него слит любой контакт, — как уже не удаляет демо-сделку со слитой в неё.
- Почему здесь: находка расширенной проверки (низкая), бриф велит её исправить.
- Без него: сброс падал на `contact_merged_into_fkey` и откатывался целиком.
- Требование: [Доработка, круг 3](../issues/01-merge-contacts-with-undo.md#доработка-круг-3-2026-11-27)
- Риски и пробелы test-ов: тест `--reset оставляет контакт seed, в который слили ручной контакт` в `apps/api/src/cli/seed.test.ts` красный без условия.

## 9. Скрытые сделки не мешают слиянию контактов

Code: `apps/api/src/merge/contacts.ts:200-207` · key lines: 204, 205
```ts
    .where('s.archived_at', 'is', null)
    .where('m.archived_at', 'is', null)
    .where('s.deleted_at', 'is', null)
    .where('m.deleted_at', 'is', null)
    .where('s.merged_into_id', 'is', null)
    .where('m.merged_into_id', 'is', null)
    .orderBy('s.pipeline_id')
    .orderBy('s.id')
```
- Что делает: отказ 409 `MERGE_DEAL_CONFLICT` (и отказ отката `MERGE_UNDO_DEAL_CONFLICT`) не считает сделки, слитые с другими.
- Почему здесь: после переноса на `main` у сделок есть скрытые (тикет 02); правило «одна открытая сделка у человека в воронке» их не считает (`0026_merge`).
- Без него: скрытая открытая сделка второго контакта запрещала бы слияние и откат без причины.
- Требование: [Доработка, круг 3](../issues/01-merge-contacts-with-undo.md#доработка-круг-3-2026-11-27)
- Риски и пробелы test-ов: тест `скрытые сделки второго контакта в тех же воронках не мешают …` красный на мутантах обоих условий.

## 10. Что сознательно не меняли

Общие файлы слияния (`0026_merge`, `merge/registry.ts`, `merge/store.ts`, слияние и откат сделок) — как в `main`. Фоновая очистка `CONTACT_PURGER` не менялась: она по-прежнему сначала стирает скрытые сделки контакта, потом зовёт `purge_from_trash`, которая теперь уносит и цепочку скрытых контактов. Долги расширенной проверки записаны в тикете строками `debt:`.

## 11. Как проверено

`pnpm vitest run src/merge/merge.test.ts` и `pnpm vitest run src/cli/seed.test.ts` (в `apps/api`) — exit 0 на настоящем PostgreSQL; десять мутантов исправлений — exit 1. `pnpm verify` и `gate fast` — с кодами выхода в комментарии PR.

## Проверить себя

1. Почему проверки «оставшийся слит» недостаточно без `clock_timestamp()`, и наоборот?
   - Ответ: без верного времени `laterMerge` не видит более позднее слияние второй записи; без проверки оставшегося откат проходит на записях с неверным временем, сделанных до правки.
   - Строки: `apps/api/src/merge/contacts.ts:373`, `apps/api/src/merge/contacts.ts:553-557`
2. Почему фоновая очистка не может стереть контакт, восстановленный в тот же момент?
   - Ответ: функция ждёт блокировку строки, после восстановления условие «в корзине» перечитывается и не выполняется — исключение CL001 откатывает всё удаление.
   - Строки: `packages/db/migrations/0027_contact_merge.ts:36-41`, `packages/db/migrations/0027_contact_merge.ts:58-64`
3. Почему загрузка файла не блокирует контакт на входе?
   - Ответ: тело до 25 МБ идёт долго, FOR SHARE на всё это время держал бы правку контакта; блокировка берётся только перед записью строки файла.
   - Строки: `apps/api/src/timeline/entity.ts:130`, `apps/api/src/files/files.ts:170`
