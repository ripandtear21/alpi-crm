# Code story — crm-intake 09: Регистрации в карточках и в API

Kind: pr · Epic: crm-intake · Ticket: 09 · PR: - · Language: ru

## 1. Что было не так

Регистрации (тикет 06) писались в таблицу `registration`, но прочитать их было негде: в карточке сделки стояла заглушка «Реєстрації з’являться…», в карточке контакта блока не было, а внешняя автоматизация не могла получить регистрацию ключом API. Тикет добавляет три запроса чтения, открытых ключу, и блок «Реєстрації» в обе карточки.
- Требование: [Что сделать](../issues/09-registrations-in-cards-and-api.md#что-сделать)

## 2. Регистрация видна тому, кто видит её сделку

Code: `apps/api/src/registrations/registrations.ts:72-85` · key lines: 81, 82, 83
```ts
function selectVisible({ db, dealScope, viewer }: Reader) {
  return db
    .selectFrom('registration as r')
    .innerJoin('intake_source as s', 's.id', 'r.intake_source_id')
    .leftJoin('deal as d', 'd.id', 'r.deal_id')
    .selectAll('r')
    .select(['s.name as source_name', 'd.title as deal_title'])
    .select(isoMicros('r.created_at').as('cursor_at'))
    .where(
      sql<SqlBool>`case when r.deal_id is null then ${dealScope === 'all' ? sql`true` : sql`false`}
        else d.deleted_at is null and d.merged_into_id is null
          and ${dealInScope(sql.ref('d.owner_id'), dealScope, viewer)} end`,
    )
}
```
- Что делает: одно условие видимости на все три запроса: сделка регистрации не в корзине, не слита и в охвате чтения сделок (`dealInScope` из deals/scope.ts — та же общая очередь, что у карточки сделки). Регистрация без сделки (сделку удалили окончательно) видна только с охватом «все». Чужой проект отсекает RLS транзакции проекта.
- Почему здесь: тикет: «регистрация видна тому, кто видит её сделку (`deals: view` с охватом чтения); иначе 404» (решено без владельца). Правило для регистрации без сделки — решение этого PR, в тикете не записано.
- Без него: менеджер с охватом «свои» прочитал бы по id регистрацию — с телефоном и email — чужой сделки.
- Требование: [Что сделать](../issues/09-registrations-in-cards-and-api.md#что-сделать)
- Риски и пробелы test-ов: тесты `охват «свои»: регистрация чужой сделки — 404, своей — видна` и `регистрация без сделки видна только с охватом сделок «все»`. Регистрация сделки в корзине — 404; отдельного теста на корзину нет.

## 3. Имя, телефон и email — только в охвате контактов

Code: `apps/api/src/registrations/registrations.ts:90-100` · key lines: 92, 97
```ts
async function visibleContacts(reader: Reader, ids: string[]): Promise<Set<string>> {
  const { contactScope } = reader
  if (contactScope === null || ids.length === 0) return new Set()
  const rows = await reader.db
    .selectFrom('contact')
    .select('id')
    .where('id', 'in', [...new Set(ids)])
    .where((eb) => contactScopePredicate(eb, contactScope, reader.viewer))
    .execute()
  return new Set(rows.map((row) => row.id))
}
```
- Что делает: для страницы регистраций одним запросом находит контакты, которые читатель видит; у остальных `toView` отдаёт `name`, `phone`, `phoneRaw`, `dialCode`, `email` как null. Без права «контакти: дивитися» скрыты все.
- Почему здесь: так же канбан не показывает имя контакта вне охвата (deals/board.ts); в тикете это не записано — решение этого PR (решено без владельца — подтвердить).
- Без него: роль с охватом контактов «свои» видела бы через регистрацию телефон и email человека, карточку которого ей не открыть.
- Требование: [Что сделать](../issues/09-registrations-in-cards-and-api.md#что-сделать)
- Риски и пробелы test-ов: тест `контакт вне охвата чтения контактов: имя, телефон и email — null, остальное видно`. Ключи в `extra` не скрываются: если форма шлёт там персональные данные, они видны.

## 4. Списки сделки и контакта: новые сверху, курсор

Code: `apps/api/src/registrations/registrations.ts:183-195` · key lines: 183, 187, 188, 193
```ts
  const entity = await entityFor(c, type, id, 'read')
  if (!entity.ok) return entity
  const reader = await readerOf(c)
  let query = selectVisible(reader)
    .where(type === 'deal' ? 'r.deal_id' : 'r.contact_id', '=', entity.value.id)
    .orderBy('r.created_at', 'desc')
    .orderBy('r.id', 'desc')
    .limit(limit + 1)
  if (cursor) {
    query = query.where(
      sql<SqlBool>`(r.created_at, r.id) < (${cursor.v}::timestamptz, ${cursor.id}::uuid)`,
    )
  }
```
- Что делает: сначала проверяет сделку или контакт (`entityFor`: в охвате чтения, не в корзине, не слит — иначе 404), затем отдаёт видимые регистрации по `(created_at, id)` по убыванию; курсор — та же пара последней строки (`filters/page.ts`), поэтому строки с одним временем не теряются и не повторяются.
- Почему здесь: тикет: списки «новые сверху», курсор по общим правилам `crm-api`; регистрации слитой сделки — у оставшейся. Слияние переносит их само (тикет 06, merge/deal-registry.ts), поэтому слитая сделка просто отвечает 404.
- Без него: при равном времени двух регистраций сортировка только по времени отдавала бы их в разном порядке на разных страницах.
- Требование: [Что сделать](../issues/09-registrations-in-cards-and-api.md#что-сделать)
- Риски и пробелы test-ов: тест `новые сверху; курсор отдаёт все регистрации без повторов и пропусков` (семь строк, две с одним временем, страницы по 3 и по 2) и `после слияния сделок регистрации второй — в списке оставшейся`.

## 5. Просмотр вебинара пока всегда null

Code: `apps/api/src/registrations/registrations.ts:140-144` · key lines: 144
```ts
    // shortcut: просмотр вебинара всегда null — столбцы view_* добавляет миграция 0030 тикета
    // crm-intake/08, её ещё нет в main; подключить (view_started_at, view_finished_at,
    // view_minutes, view_extra, view_updated_at; null view_updated_at — просмотра не было),
    // когда тикет 08 сольётся.
    view: null,
```
- Что делает: поле `view` есть в ответе и в описании API (`RegistrationView`), карточка его показывает, но значения пока нет.
- Почему здесь: тикет просит просмотр «тикета 08», а миграция 0030 с его столбцами идёт параллельно и в main её нет. Имена столбцов согласованы с исполнителем тикета 08.
- Без него: запрос к несуществующим столбцам падал бы на базе main.
- Требование: [Что сделать](../issues/09-registrations-in-cards-and-api.md#что-сделать)
- Риски и пробелы test-ов: пункт «просмотр приходит» проверен только как `view: null`; экран с заполненным просмотром — тестами карточек на подставном API.

## 6. Блок в карточке контакта — только с правом на сделки

Code: `apps/web/src/routes/contacts/$contactId/contact-card-page.tsx:273-280` · key lines: 273, 278
```tsx
          {can(access.data.permissions, 'deals', 'view') && (
            <section className="record-card__block" aria-labelledby="contact-registrations">
              <h2 id="contact-registrations" className="record-card__block-head">
                {tDeal('registrations.title')}
              </h2>
              <Registrations projectId={projectId} owner={{ kind: 'contact', id: record.id }} />
            </section>
          )}
```
- Что делает: карточка контакта показывает тот же компонент, что карточка сделки, но по контакту — со строкой «Угода» и ссылкой на сделку. Без права «угоди: дивитися» блока и запроса нет: API ответил бы 403.
- Почему здесь: тикет называет routes/contacts/$contactId; компонент лежит в routes/deals/$dealId/registrations — тоже в разделе файлов тикета.
- Без него: пользователь без права на сделки видел бы в карточке контакта ошибку загрузки.
- Требование: [Что сделать](../issues/09-registrations-in-cards-and-api.md#что-сделать)
- Риски и пробелы test-ов: тесты карточки контакта `регистрации по всем сделкам контакта, со ссылкой на сделку…` и `без права «угоди: дивитися» блока нет и запроса нет`.

## 7. Подгрузка по курсору в карточке

Code: `apps/web/src/routes/deals/$dealId/registrations/registrations.tsx:164-170` · key lines: 166, 168
```tsx
  const query = useInfiniteQuery({
    queryKey: registrationsQueryKey(projectId, owner),
    queryFn: ({ pageParam }) => api.list(projectId, owner, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    retry: false,
  })
```
- Что делает: первая страница — 20 регистраций; «Показати ще» запрашивает следующую по `next_cursor` и дописывает её снизу.
- Почему здесь: тикет: «подгрузка по курсору, если регистраций много».
- Без него: в карточке была бы только первая страница.
- Требование: [Что сделать](../issues/09-registrations-in-cards-and-api.md#что-сделать)
- Риски и пробелы test-ов: тест карточки сделки `много регистраций — «Показати ще» подгружает следующую страницу по курсору` (подставной API, страницы по 2).

## 8. Что сознательно не меняли

Слияние и окончательное удаление (тикет 06 переносит и удаляет регистрации сам), приём регистраций и журнал входящих, файлы тикетов 07 и 08. В `app.ts` — одна строка монтирования маршрутов от корня `/v1`. Тексты — в пространстве `deal-card` (новое пространство потребовало бы правки i18n/resources.ts вне тикета); ключ `registrations.stub` удалён вместе с заглушкой.

## 9. Как проверено

`pnpm vitest run apps/api/src/registrations/registrations.test.ts` — exit 0 (9 тестов на настоящем PostgreSQL: изоляция, права, охват, списки, слияние, ответ по строгой схеме описания). `pnpm vitest run` карточек сделки и контакта (apps/web) — exit 0 (57 тестов, из них 7 новых, uk и ru, ширина 375). `pnpm verify` и `gate fast` — exit 0. Снимки карточек (1440 и 375 px, uk и ru) — временный сценарий Playwright, в PR не входит.

## Проверить себя

1. Почему список регистраций слитой сделки не нужно собирать по цепочке слияний?
   - Ответ: слияние переносит регистрации к оставшейся сделке, а слитая сделка скрыта: `entityFor` отвечает 404, и список строится только по `deal_id` оставшейся.
   - Строки: `apps/api/src/registrations/registrations.ts:183-195`
2. Кто увидит регистрацию, у которой сделку удалили окончательно?
   - Ответ: только роль с охватом сделок «все»: при `deal_id is null` условие видимости — признак охвата «все».
   - Строки: `apps/api/src/registrations/registrations.ts:72-85`
3. Почему у роли с охватом контактов «свои» регистрация видна, а телефон в ней — null?
   - Ответ: видимость регистрации решает сделка, а персональные данные — охват контактов: контакт вне охвата не попадает в набор `visibleContacts`.
   - Строки: `apps/api/src/registrations/registrations.ts:90-100`
