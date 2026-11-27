# Code story — crm-intake 06: Приём регистраций и журнал входящих

Kind: pr · Epic: crm-intake · Ticket: 06 · PR: - · Language: ru

## 1. Что было не так

Источник (форма, лендинг, n8n) уже имел ключ (тикет 03), но отправить регистрацию было некуда. Тикет вводит `POST /api/intake/registrations`: обработка в том же запросе — найти или создать контакт, положить регистрацию в открытую сделку воронки источника или создать новую; ответ несёт id регистрации, контакта и сделки. Каждый запрос с сырым телом лежит 30 дней в журнале входящих, администратор может провести их заново с выбранного момента (ADR 0006, защита от потери данных).
- Требование: [Что сделать](../issues/06-registration-intake-and-inbound-journal.md#что-сделать)

## 2. Пара «источник, event_id» — отдельно и навсегда

Code: `packages/db/migrations/0028_registration_intake.ts:97-108` · key lines: 104, 106, 107
```ts
    create table intake_event (
      project_id uuid not null references project (id) on delete cascade,
      intake_source_id uuid not null,
      kind text not null check (kind in ('registration')),
      event_id text not null check (char_length(event_id) between 1 and 255),
      registration_id uuid,
      created_at timestamptz not null default now(),
      primary key (project_id, intake_source_id, kind, event_id),
      foreign key (project_id, intake_source_id) references intake_source (project_id, id),
      foreign key (project_id, registration_id) references registration (project_id, id)
        on delete set null (registration_id)
    )
```
- Что делает: первичный ключ хранит каждый `event_id` источника; ссылка на регистрацию обнуляется, когда регистрацию удаляют вместе с контактом из корзины, а сама пара остаётся.
- Почему здесь: тикет требует хранить `event_id` вечно (пункт 4), а регистрация несёт персональные данные и уходит при окончательном удалении; отдельная таблица без персональных данных — решение без владельца, записано в разделе «Результат» тикета.
- Без него: после удаления из корзины повтор того же события создал бы человека заново.
- Требование: [Результат](../issues/06-registration-intake-and-inbound-journal.md#результат)
- Риски и пробелы test-ов: тест `контакт удалён из корзины навсегда …` проверяет ответ 200 с `RECORDS_DELETED`; столбец `kind` пока принимает только `registration` (для тикета 08).

## 3. Повтор: захват события вставкой, а не проверкой

Code: `apps/api/src/intake/process.ts:328-340` · key lines: 337, 340
```ts
  }
  const claimed = await trx
    .insertInto('intake_event')
    .values({
      project_id: source.projectId,
      intake_source_id: source.id,
      kind: 'registration',
      event_id: reg.eventId,
    })
    .onConflict((oc) => oc.columns([...INTAKE_EVENT_KEY]).doNothing())
    .returning('event_id')
    .executeTakeFirst()
  if (!claimed) return repeated(trx, source, reg.eventId)
```
- Что делает: первая транзакция вставляет пару; вторая с тем же `event_id` ждёт её на первичном ключе и после фиксации первой получает «ничего не вставлено» — ответ 200 с теми же id.
- Почему здесь: тикет требует «два одновременных одинаковых запроса — одна регистрация».
- Без него: проверка «есть ли уже» и вставка после неё дают гонку — мутант с такой парой отвечал [201, 500] вместо [200, 201].
- Требование: [Done when](../issues/06-registration-intake-and-inbound-journal.md#done-when)
- Риски и пробелы test-ов: тест `два одновременных одинаковых запроса …` на настоящем PostgreSQL красный на мутанте.

## 4. Блокировка ключей человека и перепроверка найденного контакта

Code: `apps/api/src/intake/process.ts:199-221` · key lines: 201, 212, 213
```ts
  for (let attempt = 0; attempt < MATCH_ATTEMPTS; attempt++) {
    const match = await findContactMatch(author.db, { phones, emails })
    if (match === null || (match.by === 'email' && reg.phone !== null)) {
      const row = await insertContact(author, {
        firstName: reg.text.name?.slice(0, MAX_NAME_LENGTH) ?? keyName(reg.phone, reg.email),
        phones,
        emails,
        duplicateOf: match?.contactId ?? null,
      })
      return { row, created: true }
    }
    // Слияние и корзина ключей не блокируют: найденный мог уйти до блокировки строки.
    const locked = await lockLiveContact(author.db, match.contactId)
    if (!locked) continue
    await fillContact(author, locked, reg)
    const row = await author.db
      .selectFrom('contact')
      .selectAll()
      .where('id', '=', locked.id)
      .executeTakeFirstOrThrow()
    return { row, created: false }
  }
  throw new Error('контакт регистрации не найден: найденный каждый раз уходил до блокировки')
```
- Что делает: до цикла `processRegistration` блокирует телефон и email (`lockContactKeys`); найденный контакт блокируется FOR UPDATE с условием «не в корзине и не слит», иначе поиск повторяется. Телефон пришёл, а найден только email — новый контакт с пометкой «возможный дубль».
- Почему здесь: две регистрации одного нового человека одновременно не должны создать два контакта; слияние контактов ключи не блокирует, поэтому найденный контакт может уйти до блокировки строки.
- Без него: мутант без `lockContactKeys` создавал три контакта из трёх одновременных запросов; мутант без условия `merged_into_id` клал регистрацию в скрытый контакт.
- Требование: [Done when](../issues/06-registration-intake-and-inbound-journal.md#done-when)
- Риски и пробелы test-ов: ручные пути контактов теперь тоже блокируют email, а `updateContact` берёт блокировки ключей до строки контакта — изменение поведения вне приёма.

## 5. Существующая сделка не меняется, новая — только если открытой нет

Code: `apps/api/src/intake/process.ts:283-315` · key lines: 284, 298, 308
```ts
  const open = await lockOpenDeal(trx, contact.id, source.pipelineId)
  if (open) return { ok: true, id: open.id, created: false }
  const place = await placement(author, source.pipelineId, undefined)
  if (!place.ok) {
    // Воронку источника удалить нельзя (внешний ключ): остаются архив и «нет этапов».
    return {
      ok: false,
      status: 422,
      code:
        place.code === 'PIPELINE_HAS_NO_STAGES' ? 'PIPELINE_HAS_NO_STAGES' : 'PIPELINE_ARCHIVED',
    }
  }
  const ownerId = reg.ownerEmail === null ? null : await memberByEmail(trx, reg.ownerEmail)
  const title = await dealTitle(trx, source, contact, reg.text.form)
  try {
    const { id } = await inSavepoint(trx, () =>
      insertDealRow(author, { title, placement: place.value, contactId: contact.id, ownerId }),
    )
    if (reg.ownerGiven && ownerId === null) warnings.push('OWNER_NOT_FOUND')
    await finishNewDeal(author, id)
    return { ok: true, id, created: true }
  } catch (error) {
    // Открытую сделку контакта в воронке создали одновременно мимо блокировки контакта
    // (например, открыли заново проигранную): регистрация — в неё.
    const constraint = (error as { constraint?: unknown }).constraint
    if (sqlState(error) !== UNIQUE_VIOLATION || constraint !== 'deal_one_open_per_contact') {
      throw error
    }
    const again = await lockOpenDeal(trx, contact.id, source.pipelineId)
    if (!again) throw error
    return { ok: true, id: again.id, created: false }
  }
}
```
- Что делает: открытая неархивная сделка контакта в воронке источника получает регистрацию без правок; иначе новая сделка на первом этапе, ответственный — по `owner_email`, неизвестный email — без ответственного и `OWNER_NOT_FOUND`.
- Почему здесь: ADR 0003 — CRM сама не меняет этап, статус и ответственного сделки; правило «одна открытая сделка у человека в воронке» (`deal_one_open_per_contact`) может сработать, если сделку открыли одновременно.
- Без него: вторая открытая сделка срывала бы приём ошибкой 500.
- Требование: [Done when](../issues/06-registration-intake-and-inbound-journal.md#done-when)
- Риски и пробелы test-ов: ветка 23505 тестом не покрыта — нужен одновременный «открыть заново»; откат слияния сделок блокирует сделку раньше контакта, возможна взаимоблокировка (тикет 12).

## 6. Ошибка обработки: данных нет, строка журнала есть

Code: `apps/api/src/intake/journal.ts:136-162` · key lines: 141, 158, 161
```ts
  const parsed = parseRegistration(body)
  if (!parsed.ok) return failed(400, parsed.code)
  try {
    return await withProject(db, source.projectId, async (trx) => {
      const result = await processRegistration(trx, source, parsed.value)
      if (!result.ok) throw new ProcessingRefusal(result)
      const journalId = await writeInbound(trx, source.projectId, {
        ...entry,
        statusCode: result.status,
        outcome: result.outcome,
        errorCode: null,
        result: {
          registration_id: result.body.registration_id,
          contact_id: result.body.contact_id,
          deal_id: result.body.deal_id,
        },
        warnings: result.body.warnings,
      })
      return { status: result.status, outcome: result.outcome, body: result.body, journalId }
    })
  } catch (error) {
    if (error instanceof ProcessingRefusal) {
      return failed(error.refusal.status, error.refusal.code)
    }
    console.error(`приём регистрации источника ${source.id}: сбой обработки`, error)
    return failed(500, 'INTERNAL')
  }
```
- Что делает: отказ бросается из транзакции и откатывает всё записанное; строка журнала с ошибкой и сырым телом пишется отдельной транзакцией после отката. Принятый запрос и повтор пишутся той же транзакцией, что их данные.
- Почему здесь: тикет — «ошибка обработки не оставляет данных, но оставляет строку журнала».
- Без него: частично созданный контакт без сделки или пропавший запрос, который нечем провести заново.
- Требование: [Done when](../issues/06-registration-intake-and-inbound-journal.md#done-when)
- Риски и пробелы test-ов: сбой (500) проверен триггером, падающим на вставке регистрации; 401 и 429 в журнал не пишутся — решение без владельца.

## 7. «Провести заново» — только исходные строки, с T до запуска

Code: `apps/api/src/intake/replay.ts:110-125` · key lines: 115, 116, 117, 118
```ts
  return withProject(db, message.projectId, async (trx) => {
    const { rows } = await sql<ReplayRow>`
      select r.id, r.body, s.id as source_id, s.project_id, s.pipeline_id,
        to_char(r.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at
      from inbound_request r
      join intake_source s on s.id = r.intake_source_id and s.project_id = r.project_id
      where r.channel = ${REGISTRATION_CHANNEL}
        and r.replay_of is null
        and r.received_at >= ${message.since}::timestamptz
        and r.received_at < ${message.until}::timestamptz
        and ${
          after
            ? sql`(r.received_at, r.id) > (${after.at}::timestamptz, ${after.id}::uuid)`
            : sql`true`
        }
      order by r.received_at, r.id
```
- Что делает: берёт строки канала регистраций от `since` до момента запуска, без строк самих повторных проведений; каждая проходит ту же `handleRegistration` — уже принятое отвечает повтором и не задваивается.
- Почему здесь: ADR 0006 и тикет — вернуть регистрации после отката базы; источник берётся по id, отключённый не мешает (решение без владельца).
- Без него: второй запуск проводил бы заново и свои же строки; запросы, пришедшие во время проведения, проводились бы в нём же.
- Требование: [Done when](../issues/06-registration-intake-and-inbound-journal.md#done-when)
- Риски и пробелы test-ов: T старше 30 дней — 422 `REPLAY_TOO_OLD` (`apps/api/src/intake/replay.ts:69-72`); T передаётся с точностью до миллисекунды.

## 8. Удаление одной сделки оставляет регистрацию у контакта

Code: `packages/db/migrations/0028_registration_intake.ts:82-84` · key lines: 82, 84
```ts
      foreign key (project_id, contact_id) references contact (project_id, id) on delete cascade,
      foreign key (project_id, deal_id) references deal (project_id, id)
        on delete set null (deal_id)
```
- Что делает: окончательное удаление контакта удаляет его регистрации; окончательное удаление одной сделки (вручную или ночной очисткой корзины) обнуляет у регистрации только `deal_id`, `project_id` составного ключа остаётся. Повтор такого события отвечает 200 с id регистрации и контакта, `deal_id` null и предупреждением `RECORDS_DELETED` (`apps/api/src/intake/process.ts:97`).
- Почему здесь: уточнение оркестратора после проверки PR #41, записано в разделе «Результат» тикета; решено без владельца.
- Без него: при `on delete cascade` удаление одной сделки стирало регистрации контакта, который остаётся, — мутант с cascade красный на двух тестах.
- Требование: [Результат](../issues/06-registration-intake-and-inbound-journal.md#результат)
- Риски и пробелы test-ов: тесты `удалена навсегда только сделка …` и `ночная очистка корзины удаляет сделку …` на настоящем PostgreSQL; мутант без `deal_id === null` в условии предупреждения — красный.

## 9. Восстановление контакта: ключи до строки

Code: `apps/api/src/contacts/contacts.ts:764-769` · key lines: 768, 769
```ts
async function restoreContact(ctx: ContactContext, id: string): Promise<Result<ContactView>> {
  // Ключи — до строки контакта, как у updateContact и приёма регистраций: иначе одновременные
  // восстановление и правка ждали бы друг друга (40P01). Ключи контакта в корзине не меняются;
  // checkKeys ниже берёт те же блокировки повторно (в той же транзакции — сразу).
  if (UUID.test(id)) await lockStoredKeys(ctx, id)
  const found = await writableContact(ctx, id)
```
- Что делает: восстановление сначала блокирует записанные телефоны и email контакта (`lockStoredKeys`), потом строку контакта.
- Почему здесь: `updateContact` в этом PR стал брать ключи до строки; восстановление брало строку, потом ключи — встречный порядок.
- Без него: одновременные восстановление и правка того же контакта — взаимоблокировка 40P01.
- Требование: [Результат](../issues/06-registration-intake-and-inbound-journal.md#результат)
- Риски и пробелы test-ов: тест `восстановление контакта из корзины берёт блокировки его ключей до строки …` держит ключ и проверяет, что строка свободна (`for update nowait`); мутант без `lockStoredKeys` — красный.

## 10. Время регистрации: только годы 1–9999 по UTC

Code: `packages/shared/src/intake/registration.ts:190-200` · key lines: 194, 199
```ts
/**
 * Время регистрации в ISO 8601, если год по UTC 1–9999; иначе null. `timestamptz` не примет
 * запись toISOString с годом 0, отрицательным или пятизначным — вставка упала бы.
 */
function registeredAtOf(raw: string | null): string | null {
  const time = raw === null ? Number.NaN : Date.parse(raw)
  if (Number.isNaN(time)) return null
  const date = new Date(time)
  const year = date.getUTCFullYear()
  return year >= 1 && year <= 9999 ? date.toISOString() : null
}
```
- Что делает: дата с годом вне 1–9999 по UTC считается нераспознанной: столбец `registered_at` пустой, присланное значение — в `extra.registered_at`.
- Почему здесь: расширенная проверка PR нашла, что `Date.parse` принимает годы 0000, -000001 и +010000, а вставка в `timestamptz` их отвергает; тело отклоняется только без `event_id` или без ключей контакта (пункты 4 и 19).
- Без него: ответ 500, регистрации нет, и проведение строки журнала заново падает так же.
- Требование: [Что сделать](../issues/06-registration-intake-and-inbound-journal.md#что-сделать)
- Риски и пробелы test-ов: тест API `registered_at с годом вне 1–9999 …` проверяет три плохих года и границы 0001 и 9999; тест разбора — ещё сдвиг часового пояса в год 0. Мутант `year >= 0` — красный.

## 11. Строки и ключи extra, которые PostgreSQL сохранит

Code: `packages/shared/src/intake/registration.ts:146-163` · key lines: 147, 158, 159
```ts
function storableText(value: string): string {
  return value.replaceAll(NUL, '').replace(LONE_SURROGATE, REPLACEMENT)
}

/**
 * Значение JSON для `extra`: строки и ключи — storableText. Объекты — без прототипа: ключ
 * `__proto__` из тела остаётся обычным ключом, и JSON.stringify его выводит.
 */
function storableJson(value: unknown): unknown {
  if (typeof value === 'string') return storableText(value)
  if (Array.isArray(value)) return value.map(storableJson)
  if (isObject(value)) {
    const result: Record<string, unknown> = Object.create(null)
    for (const [key, item] of Object.entries(value)) result[storableText(key)] = storableJson(item)
    return result
  }
  return value
}
```
- Что делает: убирает NUL и заменяет одиночную половинку суррогатной пары (обрезанный эмодзи, `"abc\ud83d"`) на U+FFFD в строках и ключах `extra` и в строковых полях; объекты `extra` собираются без прототипа.
- Почему здесь: расширенная проверка PR: jsonb отвергает такую половинку (22P02), а ключ `__proto__` при записи в обычный объект менял прототип и пропадал. `toWellFormed` нет в lib ES2023 — замена регулярным выражением; почему lib ES2023 — not recorded.
- Без него: обрезанный эмодзи в неизвестном ключе — ответ 500 и потеря регистрации; ключ `__proto__` молча терялся (сырое тело оставалось только в журнале).
- Требование: [Что сделать](../issues/06-registration-intake-and-inbound-journal.md#что-сделать)
- Риски и пробелы test-ов: тест API с половинкой читает U+FFFD из базы только в базе UTF8: встроенная база на Windows в WIN1251 этот символ не хранит, и там тест пропускается; замену проверяет тест разбора в `packages/shared` (мутанты: ключи без `storableText`, объект с прототипом — красные).

## 12. Один `event_id` у журнала и у регистрации

Code: `packages/shared/src/intake/registration.ts:184-188` · key lines: 186, 187
```ts
export function registrationEventId(body: unknown): string | null {
  if (!isObject(body)) return null
  const eventId = scalarText(body.event_id)
  return typeof eventId === 'string' && eventId.length <= MAX_EVENT_ID_LENGTH ? eventId : null
}
```
- Что делает: одна функция даёт `event_id` и разбору тела, и строке журнала входящих (`apps/api/src/intake/journal.ts`, поле `eventId`).
- Почему здесь: расширенная проверка PR: журнал считал `event_id` своей копией правила — `"event_id": true` журнал писал как null, а длину проверял до удаления NUL.
- Без него: строка журнала и регистрация расходятся по `event_id`, по журналу не найти регистрацию.
- Требование: [Done when](../issues/06-registration-intake-and-inbound-journal.md#done-when)
- Риски и пробелы test-ов: тест журнала `event_id не строкой и с NUL …` сравнивает `event_id` строки журнала и регистрации и проводит строку заново: 200 с теми же id.

## 13. Что сознательно не меняли

`purge_from_trash` (0027) — регистрации уходят каскадом внешнего ключа контакта, у сделки обнуляется `deal_id`. Порядок блокировок слияния сделок — тикет 12: само слияние сделок и его откат блокируют сделку, потом контакт, а приём — контакт, потом сделку; возможна взаимоблокировка. Предпросмотр слияния регистрации не считает — тикет 09. Обязательные поля «всегда» при приёме не проверяются.

## 14. Как проверено

`pnpm vitest run apps/api/src/intake` — exit 0 (48 тестов на настоящем PostgreSQL); три мутанта гонок — exit 1. Доработка: `pnpm vitest run apps/api/src/intake/registrations.test.ts` — exit 0 (27 тестов), три мутанта (cascade у `deal_id`, предупреждение без `deal_id`, восстановление без `lockStoredKeys`) — exit 1. `pnpm vitest run packages/db/src/project-isolation.test.ts` — exit 0. `pnpm verify` и `gate fast` — exit 0. Второй круг доработки (годы, суррогаты, `event_id`, `__proto__`, `findEmailContact` через `findContactMatch`): новые тесты красные до исправления; `pnpm vitest run packages/shared/src/intake/registration.test.ts apps/api/src/intake apps/api/src/contacts` — exit 0, три мутанта разбора — exit 1; `pnpm verify` и `gate fast` — exit 0.

## Проверить себя

1. Почему повтор захватывает событие вставкой с `onConflict`, а не проверкой «есть ли уже»?
   - Ответ: вторая транзакция ждёт первую на первичном ключе и видит её итог; проверка без блокировки пропускает обе и даёт 500 на уникальности.
   - Строки: `apps/api/src/intake/process.ts:328-340`
2. Почему строка журнала с ошибкой пишется отдельной транзакцией?
   - Ответ: транзакция обработки откатывается целиком, чтобы не оставить данных; строка в ней откатилась бы тоже.
   - Строки: `apps/api/src/intake/journal.ts:136-162`
3. Почему «провести заново» не берёт строки с `replay_of`?
   - Ответ: это строки прошлых проведений того же запроса; провести их — значит провести исходный запрос ещё раз и задвоить журнал.
   - Строки: `apps/api/src/intake/replay.ts:110-125`
