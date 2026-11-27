# Code story — crm-intake 05: Надсмотрщик за дублями и экран «Дублі»

Kind: pr · Epic: crm-intake · Ticket: 05 · PR: - · Language: ru

## 1. Что было не так

Похожие контакты и сделки (импорт, приём регистраций, старые записи) никто не находил: слияние с откатом (тикеты 01, 02, 04) было, но кандидатов для него человек искал сам. Тикет вводит надсмотрщика — фоновую задачу, которая только находит пары и показывает их на экране «Дублі»; объединяет человек (ADR 0003, ADR 0005).
- Требование: [Что сделать](../issues/05-duplicate-supervisor-and-screen.md#что-сделать)

## 2. Пара — строка с причиной, в порядке id

Code: `packages/db/migrations/0029_duplicates.ts:27-39` · key lines: 35, 36, 37
```ts
    create table duplicate_pair (
      project_id uuid not null references project (id) on delete cascade,
      entity_type text not null check (entity_type in ('contact', 'deal')),
      a_id uuid not null,
      b_id uuid not null,
      reason text not null
        check (reason in ('phone', 'email', 'mark', 'name_phone', 'open_deals')),
      found_at timestamptz not null default now(),
      primary key (project_id, entity_type, a_id, b_id, reason),
      check (a_id < b_id),
      check ((entity_type = 'deal') = (reason = 'open_deals'))
    )
  `.execute(db)
```
- Что делает: одна строка — одна причина пары; пара хранится один раз (`a_id < b_id`); у сделок причина только `open_deals`. Внешних ключей на записи нет: тип записи — в `entity_type`.
- Почему здесь: тикет требует таблицу «тип, две записи в порядке id, причина, когда найдена; уникальна по (тип, записи, причина)»; файл миграции — в разделе файлов тикета.
- Без него: пара (А, Б) и (Б, А) жила бы двумя строками, и группа считала бы её дважды; «не дубль» пришлось бы искать в обоих порядках.
- Требование: [Что сделать](../issues/05-duplicate-supervisor-and-screen.md#что-сделать)
- Риски и пробелы test-ов: пара записи, удалённой окончательно, живёт до ночного прохода; запросы экрана читают пары только вместе с живыми записями. Миграция вверх и вниз — `project-isolation.test.ts` (откат до 0021 и снова вверх).

## 3. Правило «имя и последние 9 цифр»

Code: `apps/api/src/duplicates/finder.ts:86-95` · key lines: 90, 91, 94
```ts
    select 'contact'::text, least(k1.contact_id, k2.contact_id),
      greatest(k1.contact_id, k2.contact_id), 'name_phone'::text
    from contact_phone k1
    join contact_phone k2
      on k2.project_id = k1.project_id and right(k2.phone, 9) = right(k1.phone, 9)
        and k2.phone <> k1.phone
    join contact c1 on c1.id = k1.contact_id and ${LIVE('c1')}
    join contact c2 on c2.id = k2.contact_id and ${LIVE('c2')}
      and (${NAME('c2')}) = (${NAME('c1')})
    where ${keyPair('k1', 'k2')}
```
- Что делает: пара — разные телефоны с одинаковыми последними 9 цифрами и одинаковые имя и фамилия без учёта регистра и пробелов по краям (`NAME`). Одинаковый целиком телефон сюда не входит — это причина `phone`.
- Почему здесь: тикет задаёт правило; индекс `contact_phone_last9_idx` (0029) построен на том же выражении `right(phone, 9)`, что в условии соединения. Почему одинаковый телефон не повторяется второй причиной — решение этого PR, в тикете не записано.
- Без него: без индекса ночной проход по 100 тыс. контактов сравнивал бы каждый телефон с каждым.
- Требование: [Что сделать](../issues/05-duplicate-supervisor-and-screen.md#что-сделать)
- Риски и пробелы test-ов: тест `имя и фамилия без регистра и пробелов по краям и последние 9 цифр телефона`; другое имя с теми же цифрами — не пара. Время прохода — `nightly.test.ts` (около 2 с на 100 тыс.).

## 4. Пересчёт одной записью SQL: добавить новое, убрать устаревшее

Code: `apps/api/src/duplicates/finder.ts:130-155` · key lines: 133, 140, 152
```ts
    with candidate as (${candidates(contactId)}),
    fresh as (
      select distinct c.entity_type, c.a_id, c.b_id, c.reason
      from candidate c
      where not exists (
        select 1 from not_duplicate n
        where n.entity_type = c.entity_type and n.a_id = c.a_id and n.b_id = c.b_id
      )
    ),
    removed as (
      delete from duplicate_pair p
      where ${pairScope(contactId)}
        and not exists (
          select 1 from fresh f
          where f.entity_type = p.entity_type and f.a_id = p.a_id and f.b_id = p.b_id
            and f.reason = p.reason
        )
      returning 1
    ),
    added as (
      insert into duplicate_pair (project_id, entity_type, a_id, b_id, reason)
      select ${projectId}::uuid, entity_type, a_id, b_id, reason from fresh
      on conflict do nothing
      returning 1
    )
    select (select count(*) from added)::int as added, (select count(*) from removed)::int as removed
```
- Что делает: кандидаты по всем правилам минус пары с отметкой «не дубль»; из области пересчёта (контакт и его сделки или весь проект) удаляются пары, которых среди кандидатов нет, новые вставляются, у старых время находки не меняется.
- Почему здесь: тикет: задача на одну запись «пересчитывает пары этой записи и её сделок», ночной проход «удаляет пары, которые больше не совпадают». Одна функция на обе области — решение этого PR.
- Без него: пары слитых и изменённых записей оставались бы на экране; «не дубль» возвращался бы следующим проходом.
- Требование: [Что сделать](../issues/05-duplicate-supervisor-and-screen.md#что-сделать)
- Риски и пробелы test-ов: тесты `ночной проход убирает пары, которые больше не совпадают` и `«не дубль»: пара больше не предлагается ни по одной причине`. Одновременные пересчёт записи и ночной проход могут разойтись до следующего прохода.

## 5. Задача ставится той же транзакцией, что изменение

Code: `apps/api/src/duplicates/queue.ts:59-78` · key lines: 65, 76
```ts
export async function enqueueDuplicateScan(
  trx: Kysely<Database>,
  projectId: string,
  records: readonly { entity: DuplicateScanMessage['entity']; id: string }[],
): Promise<void> {
  const boss = attached.at(-1)
  if (boss === undefined) {
    throw new Error(
      'очередь поиска дублей не подключена: attachDuplicateQueue (duplicates/queue.ts)',
    )
  }
  const seen = new Set<string>()
  for (const { entity, id } of records) {
    const key = `${entity}:${id}`
    if (seen.has(key)) continue
    seen.add(key)
    const message: DuplicateScanMessage = { projectId, entity, id }
    await boss.send(DUPLICATE_SCAN_QUEUE, message, { db: fromKysely(trx), singletonKey: key })
  }
}
```
- Что делает: задача pg-boss пишется в базу транзакцией изменения (`fromKysely(trx)`): откат изменения откатывает и задачу. Очередь `short` с ключом записи — не больше одной ждущей задачи на запись. Нет подключённой очереди — ошибка, изменение откатывается.
- Почему здесь: тикет: «ставится той же транзакцией, что изменение»; образец — очередь событий `events/queue.ts`. Вызовы — в `replaceContactKeys` и `restoreContact` (contacts/contacts.ts), после каждой регистрации (intake/process.ts), в записи слияния и отката (merge/store.ts).
- Без него: откаченная правка оставляла бы задачу, а задача, поставленная после фиксации, терялась бы при падении процесса между ними.
- Требование: [Done when](../issues/05-duplicate-supervisor-and-screen.md#done-when)
- Риски и пробелы test-ов: тест `изменение телефона ставит задачу той же транзакцией; откат задачи не оставляет`: внутри транзакции задачи снаружи не видно, после фиксации — видно, после отката — нет. Мутант без вызова в `replaceContactKeys` — тест красный. Смена основного контакта сделки, закрытие и корзина сделки задачу не ставят — догоняет ночной проход.

## 6. Слияние и откат пересчитывают обе записи

Code: `apps/api/src/merge/store.ts:59-81` · key lines: 79
```ts
export async function insertMergeRecord(
  actor: MergeActor,
  entity: MergeEntity,
  pair: MergePair,
  parentId: string | null = null,
): Promise<MergeRow> {
  const row = await actor.db
    .insertInto('merge_record')
    .values({
      project_id: actor.projectId,
      entity_type: entity,
      survivor_id: pair.survivorId,
      merged_id: pair.mergedId,
      parent_id: parentId,
      merged_by: actor.actorId,
      merged_at: sql<Date>`clock_timestamp()`,
      undo_until: sql<Date>`clock_timestamp() + make_interval(days => ${UNDO_DAYS})`,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
  await scanPair(actor, entity, pair)
  return row
}
```
- Что делает: каждая запись слияния — контактов, сделок и сделок, объединённых вместе с контактами (тикет 04), — ставит поиск для оставшейся и слитой записи; отметка отката (`markUndone`) — тоже.
- Почему здесь: тикет требует «после слияния пара исчезает при следующем проходе»; слияние переносит телефоны и сделки мимо `replaceContactKeys` (merge/contact-registry.ts).
- Без него: пара со слитой записью висела бы на экране до ночи.
- Требование: [Done when](../issues/05-duplicate-supervisor-and-screen.md#done-when)
- Риски и пробелы test-ов: тест `после слияния пара исчезает при следующем проходе; откат слияния её возвращает`; мутант без вызова — тест красный.

## 7. Группа видна, только если все её записи в охвате изменения

Code: `apps/api/src/duplicates/routes.ts:139-144` · key lines: 143
```ts
async function visibleGroups(reader: Reader, type: DuplicateEntity): Promise<DuplicateGroup[]> {
  const groups = buildGroups(await livePairs(reader.db, type))
  const ids = groups.flatMap((group) => group.recordIds)
  const writable = await idsInScope(reader, type, ids, reader.scope.write)
  return groups.filter((group) => group.recordIds.every((id) => writable.has(id)))
}
```
- Что делает: группы — связные компоненты всех живых пар проекта (groups.ts); пользователь видит группу, только если может изменять каждую её запись.
- Почему здесь: тикет: «Видны только группы, все записи которых в охвате изменения пользователя». Компоненты считаются по всем парам, а не только по видимым: иначе группа А–Б–В с В вне охвата показалась бы как А–Б.
- Без него: группа выдала бы запись, которой пользователю не видно, а «Об'єднати» упёрлось бы в 403.
- Требование: [Done when](../issues/05-duplicate-supervisor-and-screen.md#done-when)
- Риски и пробелы test-ов: тест `права: …` — смешанная группа (своя и чужая запись) не показывается и не считается в счётчике. Группы считаются в коде из не больше 20 000 самых новых пар (shortcut в шапке routes.ts).

## 8. «Не дубль» снимает отметку и пишет историю

Code: `apps/api/src/duplicates/routes.ts:396-413` · key lines: 399, 405, 411
```ts
    ] as const) {
      const changes: FieldChange[] = [{ field: 'notDuplicateOf', before: null, after: other }]
      if (type === 'contact') {
        // Отметка «возможный дубль», которая связывает эту пару, снимается.
        const cleared = await r.db
          .updateTable('contact')
          .set({ possible_duplicate: false, possible_duplicate_of: null, updated_at: sql`now()` })
          .where('id', '=', id)
          .where('possible_duplicate', '=', true)
          .where('possible_duplicate_of', '=', other)
          .executeTakeFirst()
        if (cleared.numUpdatedRows > 0n) {
          changes.unshift({ field: 'possibleDuplicate', before: true, after: false })
        }
      }
      await recordChanges(author, { type, id }, changes)
    }
  }
```
- Что делает: у обеих записей в истории — `notDuplicateOf`; если отметка «возможный дубль» одного контакта указывает на другой — она снимается, и это тоже в истории. Повтор отметки историю не повторяет.
- Почему здесь: тикет: «если это пара „возможного дубля“ — пометка снимается… Отметка пишется в историю контактов».
- Без него: контакт остался бы с отметкой «возможный дубль», хотя человек решил, что это разные люди.
- Требование: [Что сделать](../issues/05-duplicate-supervisor-and-screen.md#что-сделать)
- Риски и пробелы test-ов: тест `«не дубль»: …` сравнивает строки change_log. Для сделок пишется только `notDuplicateOf`.

## 9. Окно объединения не пропадает вместе с группой

Code: `apps/web/src/routes/duplicates/duplicates-page.tsx:130-138` · key lines: 130, 134
```tsx
  // Окно — на одном месте дерева и при пустом списке: иначе React пересоздал бы его.
  if (all.length === 0) {
    return (
      <>
        {dialog}
        <EmptyState title={t(`empty.${type}`)} />
      </>
    )
  }
```
- Что делает: окно объединения живёт в списке групп и стоит на одном месте дерева и при пустом списке.
- Почему здесь: после слияния группа уходит из списка, а кнопки отката каждого слияния должны остаться (тикет: «каждое со своим откатом»).
- Без него: React пересоздавал окно при исчезновении группы — откат из окна был недоступен (так падал тест экрана до исправления).
- Требование: [Что сделать](../issues/05-duplicate-supervisor-and-screen.md#что-сделать)
- Риски и пробелы test-ов: тест экрана `«Об'єднати» группу из трёх…`: два слияния в выбранную запись, откат второго, первое остаётся. Откат после закрытия окна — из карточки записи.

## 10. Что сознательно не меняли

Логика слияния (merge/contact-registry.ts, merge/deal-core.ts) — экран зовёт существующие запросы предпросмотра, слияния и отката. Модуль сделок (deals/) задачу поиска не ставит: смену основного контакта, закрытие и корзину сделки догоняет ночной проход. Данные `pnpm seed` (тикет 10) пишут ключи напрямую и задач не ставят.

## 11. Как проверено

`pnpm vitest run apps/api/src/duplicates/duplicates.test.ts` — exit 0 (19 тестов на настоящем PostgreSQL); мутант без постановки в `replaceContactKeys` и `insertMergeRecord` — exit 1. `pnpm vitest run apps/api/src/duplicates/nightly.test.ts` — exit 0, 100 тыс. контактов: первый проход около 1,9 с, повторный около 1,6 с. `pnpm vitest run packages/db/src/project-isolation.test.ts` — exit 0. `pnpm vitest run src/routes/duplicates` (apps/web) — exit 0. `pnpm verify` и `gate fast` — exit 0. Снимки экрана (1440 и 375 px, uk и ru) — временный сценарий Playwright, в PR не входит.

## Проверить себя

1. Почему группы считаются по всем парам проекта, а видимость проверяется у группы целиком?
   - Ответ: тикет показывает группу, только если все её записи в охвате изменения; компоненты по одним видимым парам скрыли бы запись вне охвата и показали бы урезанную группу.
   - Строки: `apps/api/src/duplicates/routes.ts:139-144`
2. Что случится с задачей поиска, если правка контакта откатится?
   - Ответ: задача записана той же транзакцией через `fromKysely(trx)` и откатывается вместе с правкой.
   - Строки: `apps/api/src/duplicates/queue.ts:59-78`
3. Почему отметка «не дубль» не теряется при следующем ночном проходе?
   - Ответ: кандидаты проходят через `not exists` по `not_duplicate`, а пара удаляется из `duplicate_pair`, если её нет среди кандидатов.
   - Строки: `apps/api/src/duplicates/finder.ts:130-155`
