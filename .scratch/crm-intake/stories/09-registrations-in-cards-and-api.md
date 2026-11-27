# Code story — crm-intake 09: Регистрации в карточках и в API

Kind: pr · Epic: crm-intake · Ticket: 09 · PR: - · Language: ru

## 1. Что было не так

Регистрации (тикет 06) писались в таблицу `registration`, но прочитать их было негде. В карточке сделки стояла заглушка «Реєстрації з’являться…», в карточке контакта блока не было, а внешняя автоматизация не могла получить регистрацию ключом API. Тикет добавляет три запроса чтения, открытых ключу, и блок «Реєстрації» в обе карточки; просмотр вебинара (тикет 08) приходит в регистрации.
- Требование: [Что сделать](../issues/09-registrations-in-cards-and-api.md#что-сделать)

## 2. Регистрация видна тому, кто видит её сделку

Code: `apps/api/src/registrations/registrations.ts:75-88` · key lines: 84, 85, 86
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
- Что делает: одно условие видимости на все три запроса. Сделка регистрации должна быть не в корзине, не слита и в охвате чтения сделок (`dealInScope` из deals/scope.ts — с той же общей очередью, что у карточки сделки). Регистрация без сделки (сделку удалили окончательно) видна только с охватом «все». Чужой проект отсекает RLS транзакции проекта.
- Почему здесь: тикет: «регистрация видна тому, кто видит её сделку (`deals: view` с охватом чтения); иначе 404» (решено без владельца). Правило для регистрации без сделки — решение этого PR, в тикете не записано.
- Без него: менеджер с охватом «свои» прочитал бы по id регистрацию чужой сделки вместе с телефоном и email.
- Требование: [Что сделать](../issues/09-registrations-in-cards-and-api.md#что-сделать)
- Риски и пробелы test-ов: тесты `охват «свои»: регистрация чужой сделки — 404, своей — видна`, `регистрация без сделки видна только с охватом сделок «все»` и `регистрация сделки в корзине — 404 по id и нет в списке контакта`. Мутант с условием корзины и слияния, заменённым на `true`, — красный.

## 3. Какие контакты читатель видит

Code: `apps/api/src/registrations/registrations.ts:93-103` · key lines: 95, 100
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
- Что делает: для страницы регистраций одним запросом находит контакты, которые читатель видит. Без права «контакти: дивитися» не виден ни один.
- Почему здесь: так же канбан не показывает имя контакта вне охвата (deals/board.ts). В тикете это не записано — решение этого PR (решено без владельца — подтвердить).
- Без него: роль с охватом контактов «свои» видела бы через регистрацию телефон и email человека, карточку которого ей не открыть.
- Требование: [Что сделать](../issues/09-registrations-in-cards-and-api.md#что-сделать)
- Риски и пробелы test-ов: тест `контакт вне охвата чтения контактов: имя, телефон и email — null, остальное видно`.

## 4. Вне охвата контактов скрыто всё, где бывают персональные данные; просмотр вебинара

Code: `apps/api/src/registrations/registrations.ts:140-156` · key lines: 142, 146, 152
```ts
    fbc: row.fbc,
    userAgent: row.user_agent,
    extra: contactVisible ? row.extra : {},
    // Просмотр вебинара (тикет crm-intake/08, миграция 0030): null view_updated_at — просмотра не
    // было. Лишние ключи платформы (view_extra) скрыты вне охвата контактов, как `extra`.
    view:
      row.view_updated_at === null
        ? null
        : {
            startedAt: iso(row.view_started_at),
            finishedAt: iso(row.view_finished_at),
            minutes: row.view_minutes,
            extra: contactVisible ? row.view_extra : null,
            updatedAt: new Date(row.view_updated_at).toISOString(),
          },
  }
}
```
- Что делает: у контакта вне охвата `extra` — пустой объект, `view.extra` — null. Выше в той же функции через `person()` в null уходят имя, телефон, email, адрес страницы и referrer. Просмотр вебинара берётся из столбцов `view_*` миграции 0030; пока просмотра не было, `view` — null.
- Почему здесь: проверка PR (REJECTED, первый круг): в `extra` попадают неизвестные ключи и поля не той формы — телефон массивом лёг бы в `extra.phone`; в строке запроса адреса страницы и referrer бывают email и телефон. Просмотр в ответе требует тикет; тикет 08 влит.
- Без него: роль с охватом контактов «свои» увидела бы номер через `extra.phone` или `?email=` в адресе страницы.
- Требование: [Что сделать](../issues/09-registrations-in-cards-and-api.md#что-сделать)
- Риски и пробелы test-ов: тесты `контакт вне охвата: extra, адрес страницы и referrer тоже скрыты (телефон массивом лёг в extra)` и `просмотр вебинара (тикет 08) приходит в регистрации…` идут через настоящие `/intake/registrations` и `/intake/webinar-views`. Мутанты без скрытия `extra`, адреса страницы, referrer, `view.extra`, с `view` всегда null и с минутами null — красные. Метки utm и user_agent не скрываются.

## 5. Списки сделки и контакта: новые сверху, курсор

Code: `apps/api/src/registrations/registrations.ts:193-205` · key lines: 193, 197, 198, 203
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
- Что делает: сначала проверяет сделку или контакт (`entityFor`: в охвате чтения, не в корзине, не слит — иначе 404). Затем отдаёт видимые регистрации по `(created_at, id)` по убыванию. Курсор — та же пара последней строки (`filters/page.ts`), поэтому строки с одним временем не теряются и не повторяются.
- Почему здесь: тикет: списки «новые сверху», курсор по общим правилам `crm-api`; регистрации слитой сделки — у оставшейся. Слияние переносит их само (тикет 06, merge/deal-registry.ts), поэтому слитая сделка просто отвечает 404.
- Без него: при равном времени двух регистраций на границе страниц вторая из них пропала бы.
- Требование: [Что сделать](../issues/09-registrations-in-cards-and-api.md#что-сделать)
- Риски и пробелы test-ов: тест `новые сверху; курсор отдаёт все регистрации без повторов и пропусков` (одинаковое время — третья и четвёртая строки, страница по 3; мутант курсора без id — красный) и `после слияния сделок регистрации второй — в списке оставшейся`.

## 6. Карточка перечитывает регистрации после слияния и отката

Code: `apps/web/src/routes/deals/$dealId/deal-card-page.tsx:173-180` · key lines: 177, 178
```tsx
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: dealKey })
    void queryClient.invalidateQueries({ queryKey: timelineQueryKey(projectId, 'deals', dealId) })
    // Слияние и его откат переносят регистрации между сделками (тикет crm-intake/09).
    void queryClient.invalidateQueries({
      queryKey: registrationsQueryKey(projectId, { kind: 'deal', id: dealId }),
    })
  }
```
- Что делает: `refresh` карточки сделки (его зовут слияние, где остаётся эта сделка, и откат) сбрасывает и запрос регистраций. `refreshAll` карточки контакта делает то же для регистраций контакта.
- Почему здесь: проверка PR (REJECTED, первый круг): после слияния регистрации второй сделки не появлялись, после отката висели у оставшейся до ухода со страницы.
- Без него: блок показывал бы список до слияния или до отката.
- Требование: [Что сделать](../issues/09-registrations-in-cards-and-api.md#что-сделать)
- Риски и пробелы test-ов: тесты `регистрации перечитываются после слияния и после отката` (карточка сделки) и `после отката слияния регистрации контакта перечитываются` (карточка контакта) были красными без этих строк. Подставной API, не настоящий.

## 7. Блок в карточке контакта — только с правом на сделки

Code: `apps/web/src/routes/contacts/$contactId/contact-card-page.tsx:278-285` · key lines: 278, 283
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
- Что делает: карточка контакта показывает тот же компонент, что карточка сделки, но по контакту — со строкой «Угода» и ссылкой на сделку. Без права «угоди: дивитися» нет ни блока, ни запроса: API ответил бы 403.
- Почему здесь: тикет называет routes/contacts/$contactId; компонент лежит в routes/deals/$dealId/registrations — тоже в разделе файлов тикета.
- Без него: пользователь без права на сделки видел бы в карточке контакта ошибку загрузки.
- Требование: [Что сделать](../issues/09-registrations-in-cards-and-api.md#что-сделать)
- Риски и пробелы test-ов: тесты карточки контакта `регистрации по всем сделкам контакта, со ссылкой на сделку…` и `без права «угоди: дивитися» блока нет и запроса нет`.

## 8. Подгрузка по курсору в карточке

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

## 9. Что сознательно не меняли

Слияние и окончательное удаление: тикет 06 переносит и удаляет регистрации сам. Приём регистраций, приём просмотров (тикет 08) и журнал входящих. В `app.ts` — одна строка монтирования маршрутов от корня `/v1`. Тексты — в пространстве `deal-card`: новое пространство потребовало бы правки i18n/resources.ts вне тикета. Ключ `registrations.stub` удалён вместе с заглушкой.

## 10. Как проверено

`pnpm vitest run apps/api/src/registrations/registrations.test.ts` — exit 0 (12 тестов на настоящем PostgreSQL: изоляция, права, охват, корзина, списки, слияние, скрытие персональных данных, просмотр вебинара, ответ по строгой схеме описания). Восемь мутантов этого файла — exit 1. Тесты карточек сделки и контакта (apps/web) — exit 0. `pnpm verify` и `gate fast` — exit 0. Снимки карточек (1440 и 375 px, uk и ru) сделаны временным сценарием Playwright, в PR он не входит.

## Проверить себя

1. Почему список регистраций слитой сделки не нужно собирать по цепочке слияний?
   - Ответ: слияние переносит регистрации к оставшейся сделке, а слитая сделка скрыта: `entityFor` отвечает 404, и список строится только по `deal_id` оставшейся.
   - Строки: `apps/api/src/registrations/registrations.ts:193-205`
2. Почему при скрытом контакте `extra` пустой, хотя имя, телефон и email уже скрыты?
   - Ответ: в `extra` попадают неизвестные ключи и поля не той формы — например, телефон массивом; без этого номер был бы виден через `extra.phone`.
   - Строки: `apps/api/src/registrations/registrations.ts:140-156`
3. Кто увидит регистрацию, у которой сделку удалили окончательно?
   - Ответ: только роль с охватом сделок «все»: при `deal_id is null` условие видимости — признак охвата «все».
   - Строки: `apps/api/src/registrations/registrations.ts:75-88`
