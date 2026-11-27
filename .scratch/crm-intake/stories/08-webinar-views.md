# Code story — crm-intake 08: Просмотры вебинара

Kind: pr · Epic: crm-intake · Ticket: 08 · PR: - · Language: ru

## 1. Что было не так

Данные вебинарной платформы о том, как человек смотрел вебинар, в CRM не попадали. Пункт 7 ответов владельца: просмотр ничего не создаёт, он дополняет уже существующую регистрацию. Пункт 17: последние значения заменяют прежние. Без регистрации — строка журнала «без регистрации», контакт не создаётся. Тикет добавляет `POST /api/intake/webinar-views` тем же ключом источника, с тем же журналом входящих и «провести заново», что у регистраций (тикет 06).
- Требование: [Что сделать](../issues/08-webinar-views.md#что-сделать)

## 2. Повтор event_id — та же таблица intake_event, новый вид

Code: `packages/db/migrations/0030_webinar_views.ts:42-51` · key lines: 44, 50
```ts
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
```
- Что делает: пара «источник, event_id» просмотра хранится в той же таблице `intake_event`, что у регистраций, с видом `webinar_view`. Журнал входящих получает итог `unmatched` — «без регистрации».
- Почему здесь: тикет требует уникальности `event_id` просмотра «отдельной таблицей или индексом» (решено без владельца — подтвердить). В 0028 у `intake_event` уже есть столбец `kind` с пометкой «просмотры вебинара — тикет 08». Файл миграции — в разделе файлов тикета.
- Без него: «провести заново» с момента до двух просмотров провело бы первый просмотр ещё раз, и его старые значения легли бы поверх значений второго.
- Требование: [Что сделать](../issues/08-webinar-views.md#что-сделать)
- Риски и пробелы test-ов: миграция вверх и вниз проверена `project-isolation.test.ts` (откат до пустой схемы и обратно). Откат 0030 при уже записанных просмотрах удаляет их строки журнала и `intake_event`. Тест с такими данными на откат не написан.

## 3. Регистрация просмотра: контакт, потом его последняя регистрация на этот вебинар

Code: `apps/api/src/intake/webinar.ts:115-136` · key lines: 121, 130, 133
```ts
async function findRegistration(trx: Kysely<Database>, view: ParsedWebinarView) {
  const keys = {
    phones: view.phone === null ? [] : [view.phone],
    emails: view.email === null ? [] : [view.email],
  }
  for (let attempt = 0; attempt < MATCH_ATTEMPTS; attempt++) {
    const match = await findContactMatch(trx, keys)
    if (match === null) return null
    // Слияние и корзина ключей не блокируют: найденный мог уйти до блокировки строки.
    const live = await trx
      .selectFrom('contact')
      .select('id')
      .where('id', '=', match.contactId)
      .where('deleted_at', 'is', null)
      .where('merged_into_id', 'is', null)
      .forShare()
      .executeTakeFirst()
    if (!live) continue
    return (await lockLatestRegistration(trx, live.id, view.webinar)) ?? null
  }
  throw new Error('контакт просмотра не найден: найденный каждый раз уходил до блокировки')
}
```
- Что делает: ищет контакт по телефону, затем по email (`findContactMatch`). Найденный контакт блокируется `FOR SHARE`, после чего берётся его последняя по времени создания регистрация с тем же `webinar`, тоже под блокировкой (`FOR UPDATE` в `lockLatestRegistration`).
- Почему здесь: тикет называет `findContactMatch` и правило «последняя регистрация этого контакта с тем же webinar». Блокировка контакта перед регистрацией повторяет порядок слияния (контакт, потом его регистрации, тикет 12) — это решение этого PR, в тикете не записано. Совпадение `webinar` — строка целиком (решено без владельца — подтвердить).
- Без него: слияние, которое между поиском и блокировкой переносит регистрации контакта, могло бы увести регистрацию из-под запроса. Просмотр тогда ответил бы `matched: false`, хотя регистрация есть.
- Требование: [Что сделать](../issues/08-webinar-views.md#что-сделать)
- Риски и пробелы test-ов: случай с одновременным слиянием тестом не покрыт. Покрыты: последняя регистрация на этот вебинар, а не на другой; поиск по email у контакта без телефона; контакт проекта B ключом проекта A не находится.

## 4. Замена значений и история регистрации

Code: `apps/api/src/intake/webinar.ts:178-199` · key lines: 179, 184, 187, 191, 199
```ts
  const registration = await findRegistration(trx, view)
  if (!registration) return UNMATCHED

  const after = await trx
    .updateTable('registration')
    .set({
      view_started_at: view.startedAt,
      view_finished_at: view.finishedAt,
      view_minutes: view.minutes,
      view_extra: JSON.stringify(view.extra),
      view_updated_at: sql`now()`,
    })
    .where('id', '=', registration.id)
    .returning(Object.values(VIEW_HISTORY))
    .executeTakeFirstOrThrow()
  // Обе стороны — из базы: jsonb хранит ключи в своём порядке, сравнение по JSON не ошибётся.
  const changes = diffFields(
    historyOf(registration),
    historyOf(after),
    Object.keys(VIEW_HISTORY) as ViewHistoryField[],
  )
  await recordChanges(author, { type: 'registration', id: registration.id }, changes)
```
- Что делает: без регистрации ничего не пишет — `UNMATCHED`, в журнал идёт `unmatched`. С регистрацией заменяет все четыре значения просмотра, в том числе пустыми. История «было → стало» пишется в `change_log` регистрации с автором-источником.
- Почему здесь: тикет — «заменяются значениями запроса», «История регистрации — в change_log с автором-источником», «ничего не создаётся, контакт тоже». Тип `ChangeLogEntity` получил `'registration'` (apps/api/src/change-log/record.ts, вне раздела файлов тикета; правку разрешил оркестратор).
- Без него: при сравнении присланного объекта с прочитанным из jsonb порядок ключей мог бы различаться, и в историю попала бы «правка» без изменений.
- Требование: [Что сделать](../issues/08-webinar-views.md#что-сделать)
- Риски и пробелы test-ов: тест второго просмотра проверяет и значения, и восемь строк истории, все с `actor_intake_source_id`. Сам просмотр событий не шлёт: в решении владельца их нет.

## 5. История уходит вместе с регистрацией

Code: `packages/db/migrations/0030_webinar_views.ts:53-67` · key lines: 56, 60, 61, 62, 63
```ts
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
```
- Что делает: после удаления регистрации (окончательное удаление контакта удаляет её каскадом) удаляет историю этой регистрации. Функция выполняется с правами владельца: у роли приложения нет DELETE на `change_log`.
- Почему здесь: в 0027 окончательное удаление контакта стирает и его историю, потому что в «было → стало» лежат персональные данные. Что история регистрации должна уходить так же — решение этого PR, в тикете не записано.
- Без него: после окончательного удаления контакта в `change_log` остались бы строки просмотров (`view_extra` — что угодно от платформы) без записи, к которой они относятся.
- Требование: не записано
- Риски и пробелы test-ов: тест «контакт удалён из корзины навсегда» проверяет, что история пуста, а повтор просмотра отвечает `matched: false`.

## 6. «Провести заново» — оба канала одним списком по времени прихода

Code: `apps/api/src/intake/replay.ts:145-153` · key lines: 150, 151, 152
```ts
  const counts: ReplayCounts = { accepted: 0, repeat: 0, error: 0, unmatched: 0 }
  let last: ReplayRow | null = null
  for (;;) {
    const rows = await replayBatch(db, message, last)
    for (const row of rows) {
      const source = { id: row.source_id, projectId: row.project_id, pipelineId: row.pipeline_id }
      const handle = row.channel === WEBINAR_VIEW_CHANNEL ? handleWebinarView : handleRegistration
      const answer = await handle(db, source, row.body, { replayOf: row.id })
      counts[answer.outcome]++
```
- Что делает: задача «провести заново» берёт строки обоих каналов (запрос выбирает `channel in (...)`) по времени прихода. Каждую строку она проводит функцией её канала. Счётчик итогов знает `unmatched`, и в журнал проекта он уходит полем `unmatched`.
- Почему здесь: тикет требует для просмотров того же «провести заново», что у регистраций. Порядок по времени прихода для обоих каналов сразу — решение этого PR: после отката базы регистрация проводится раньше просмотра, который в неё ляжет.
- Без него: просмотры не проводились бы вовсе. А если проводить каналы по отдельности, просмотр после отката базы мог бы прийти раньше своей регистрации и ответить «без регистрации».
- Требование: [Done when](../issues/08-webinar-views.md#done-when)
- Риски и пробелы test-ов: тест проводит заново дважды. Первый раз просмотры на месте, и все три строки — повторы. Второй раз после «отката» (удалены регистрация и пары `intake_event`) все три строки снова приняты, и значения второго просмотра остаются.

## 7. Что сознательно не меняли

Регистрации (`process.ts`) и их ответ не тронуты. Экран журнала и подписи итога `unmatched` — тикет 07. Показ просмотра в карточке — тикет 09: имена столбцов согласованы с ним (`view_started_at`, `view_finished_at`, `view_minutes`, `view_extra`, `view_updated_at`). Страница журнала проекта (`audit-page.tsx`) пока не показывает число `unmatched` в итоге «провести заново».

## 8. Как проверено

`pnpm vitest run apps/api/src/intake/webinar-views.test.ts` — exit 0, 9 тестов на настоящем PostgreSQL. Два мутанта — exit 1: регистрация «первая», а не «последняя», и «провести заново» только по каналу регистраций. `pnpm vitest run apps/api/src/intake packages/db/src/project-isolation.test.ts apps/api/src/http/http.test.ts packages/shared` — exit 0. `pnpm verify` — exit 0. `gate fast` — exit 0.

## Проверить себя

1. Почему повтор просмотра хранится в `intake_event` вечно, хотя просмотр ничего не создаёт?
   - Ответ: иначе «провести заново» с момента до двух просмотров провело бы первый ещё раз, и его значения легли бы поверх значений второго.
   - Строки: `packages/db/migrations/0030_webinar_views.ts:42-51`
2. Почему история сравнивает строку до правки со строкой, которую вернул UPDATE, а не с присланными значениями?
   - Ответ: jsonb хранит ключи в своём порядке. Сравнение присланного объекта с прочитанным из базы по JSON нашло бы «изменение» там, где его нет.
   - Строки: `apps/api/src/intake/webinar.ts:178-199`
3. Почему «провести заново» проводит регистрации и просмотры одним списком?
   - Ответ: после отката базы просмотр должен лечь в регистрацию, которую проводят тем же запуском. По времени прихода регистрация идёт раньше своего просмотра.
   - Строки: `apps/api/src/intake/replay.ts:145-153`
