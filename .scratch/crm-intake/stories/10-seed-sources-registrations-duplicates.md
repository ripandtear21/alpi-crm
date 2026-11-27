# Code story — crm-intake 10: Тестовые данные: источники, регистрации, журнал и готовые дубли

Kind: pr · Epic: crm-intake · Ticket: 10 · PR: - · Language: ru

## 1. Что было не так

`pnpm seed` создавал людей, сделки и пользователей, но ничего из эпика crm-intake. Экраны «Джерела» и «Дублі», регистрации в карточках и откат слияния на чистой базе были пустыми: владельцу и автотесту приёмки (тикет 11) не на чем смотреть. Тикет просит источники с ключами, тысячи регистраций, журнал входящих за 30 дней, готовые дубли каждого правила тикета 05 и слияния — детерминированно от зерна, только выдуманные данные, по возможности через функции приложения.
- Требование: [Что сделать](../issues/10-seed-sources-registrations-duplicates.md#что-сделать)

## 2. Готовые дубли — контакты и сделки плана

Code: `apps/api/src/seed/intake-plan.ts:486-518` · key lines: 488, 492, 495, 500
```ts
  // Телефон в разной записи: `+380 70…` и `070 …` — один номер.
  add('dup-phone-1', { phone: phone(1) })
  add('dup-phone-2', { phone: national(phone(1)) })
  // Email в разном регистре.
  const email = `${latin()}.dup@example.com`
  add('dup-email-1', { phone: phone(3), email })
  add('dup-email-2', { phone: phone(4), email: email.toUpperCase() })
  // Отметка «возможный дубль»: второй контакт отмечен, ссылается на первый.
  add('dup-mark-1', { phone: phone(5) })
  add('dup-mark-2', { phone: phone(6) }, { duplicateOfKey: 'dup-mark-1' })
  // Одинаковые имя и фамилия, последние 9 цифр совпадают, телефоны разные (+48 70x — платные
  // услуги Польши, не абонентский номер).
  const twin = person(random)
  add('dup-name-1', { phone: phone(7) }, { name: twin })
  add('dup-name-2', { phone: `+48${phone(7).slice(-9)}` }, { name: twin })
  // Архивная и открытая сделки контакта в одной воронке — пара сделок.
  add('dup-archived', { phone: phone(9) })
  deal('dup-archived', 1, true)
  deal('dup-archived', 2, false)
  // Пара контактов с открытыми сделками в одной воронке (слияние с выбором сделки, тикет 04).
  const shared = `${latin()}.deals@example.com`
  add('dup-deals-1', { phone: phone(10), email: shared })
  add('dup-deals-2', { phone: phone(11), email: shared })
  deal('dup-deals-1', 1, false)
  deal('dup-deals-2', 1, false)
  // Группа из трёх: первый со вторым — по телефону, второй с третьим — по email.
  const three = `${latin()}.three@example.com`
  add('dup-three-1', { phone: phone(12) })
  add('dup-three-2', { phone: national(phone(12)), email: three })
  add('dup-three-3', { phone: phone(13), email: three })
  // Пара с отметкой «не дубль»: один телефон, но предлагаться не должна.
  add('dup-not-1', { phone: phone(14) })
  add('dup-not-2', { phone: phone(14) })
```
- Что делает: добавляет в план каждого проекта по паре записей на каждое правило тикета 05, группу из трёх и пару «не дубль». Телефоны и email в разной записи приводятся к единому виду `normalizePhone` и `normalizeEmail` — теми же функциями, что у приёма и ручного создания. Записи пишет та же `writeProject`, что людей плана, с пометкой seed.
- Почему здесь: список дублей — из раздела «Что сделать» тикета. Почему фикстуры идут через план, а не через `insertContact`: решение этого PR — один путь записи, повторный запуск и `--reset` работают для них без отдельного кода.
- Без него: «Дублі» на данных seed были бы пустыми: случайные люди плана не совпадают ни по одному правилу.
- Требование: [Что сделать](../issues/10-seed-sources-registrations-duplicates.md#что-сделать)
- Риски и пробелы test-ов: правило «имя и 9 цифр» требует номера другой страны. Тест «телефоны тестовые» теперь пропускает и `+4870…`. Генератор данных приёма — свой (зерно + 10), поэтому люди и сделки прежнего плана не меняются; это проверяет только тест детерминированности плана.

## 3. Функции приложения — ролью приложения со своей очередью

Code: `apps/api/src/cli/seed.ts:230-255` · key lines: 232, 233, 243
```ts
  // Роль приложения и очередь pg-boss: приём регистраций и слияние ставят задачи событий и
  // поиска дублей той же транзакцией (обрабатывает их потом фоновый процесс API).
  const appDb = createDb(deps.appDatabaseUrl)
  const queue = await startEventQueue(deps.appDatabaseUrl)
  try {
    for (const project of plan.projects) {
      const counts = await writeProject(deps.serviceDb, project, users.ids, plan.adminKey)
      out.log(
        `«${project.name}»: создано товаров ${counts.products}, организаций ${counts.organizations}, контактов ${counts.contacts}, сделок ${counts.deals}` +
          (counts.skippedDeals > 0
            ? `; пропущено сделок ${counts.skippedDeals} (у человека уже есть открытая сделка в воронке)`
            : ''),
      )
      const intake = await writeIntake(deps.serviceDb, appDb, project, adminId, knownKeys)
      sourceKeys = [...sourceKeys, ...intake.keys]
      // Ключи — в файл сразу: при сбое следующего проекта ключи этого не теряются.
      await writeSourceKeys(credentialsFile, sourceKeys)
      const c = intake.counts
      out.log(
        `«${project.name}»: создано источников ${c.sources}, регистраций ${c.registrations}, строк журнала входящих ${c.inbound}, слияний ${c.merges}; пар дублей в проекте ${c.pairs}`,
      )
    }
  } finally {
    await queue.stop()
    await appDb.destroy()
  }
```
- Что делает: приём регистраций, слияние и проход надсмотрщика идут подключением ролью приложения (`DATABASE_URL`, как у API). Задачи событий и поиска дублей ставит своя очередь pg-boss на время запуска.
- Почему здесь: служебная роль — владелец таблиц, на неё row-level security не действует. Первая версия этого PR работала служебной ролью: проход надсмотрщика по проекту «Франч» нашёл пары «ALPI» и записал их в «Франч». Повторный запуск давал на 8 пар больше. Это поймали тест повторного запуска и тест изоляции.
- Без него: пары дублей и поиск контакта при приёме видели бы чужой проект. Без очереди приём падал бы с «очередь поиска дублей не подключена», и строка журнала была бы ошибкой 500.
- Требование: [Done when](../issues/10-seed-sources-registrations-duplicates.md#done-when)
- Риски и пробелы test-ов: `SeedDeps` получил обязательный `appDatabaseUrl` — вызовы обновлены в приёмочном тесте API и в `e2e/support/stack.ts`. e2e в этом PR не запускался.

## 4. Журнал входящих — через функции приёма, ответ сверяется

Code: `apps/api/src/seed/intake-store.ts:376-384` · key lines: 378, 380
```ts
    const answer =
      entry.channel === 'registration'
        ? await handleRegistration(appDb, source, raw)
        : await handleWebinarView(appDb, source, raw)
    if (answer.status !== entry.expected.status || answer.outcome !== entry.expected.outcome) {
      throw new Error(
        `запрос журнала ${entry.key}: ответ ${answer.status} ${answer.outcome}, ожидался ${entry.expected.status} ${entry.expected.outcome}`,
      )
    }
```
- Что делает: каждый запрос журнала (новые люди, люди плана, повторы, 400 без телефона и email, просмотры с регистрацией и без) проходит теми же `handleRegistration` и `handleWebinarView`, что запрос источника. Неожиданный ответ останавливает seed. После этого служебная роль сдвигает время получения в последние 30 дней и помечает созданные приёмом контакт и сделку как seed.
- Почему здесь: тикет просит создавать данные «через функции приложения, где это не мешает скорости». Журнал — около сотни запросов на проект. Тысячи регистраций сделок плана пишутся напрямую (`writeRegistrations`): функция приёма тратит десятки запросов на каждую и не умеет привязать регистрацию к уже закрытой сделке.
- Без него: сбой приёма тихо превратился бы в строку журнала с ошибкой 500 вместо принятой регистрации.
- Требование: [Что сделать](../issues/10-seed-sources-registrations-duplicates.md#что-сделать)
- Риски и пробелы test-ов: регистрации сделок плана не проходят поиск контакта и правила приёма — только правила базы (сделка и контакт своего проекта, единственность `event_id`). Это проверяет тест изоляции.

## 5. Слияния — функцией слияния, старое сдвигается в прошлое

Code: `apps/api/src/seed/intake-store.ts:327-356` · key lines: 329, 348, 355
```ts
  if (mergeId === null) {
    const result = await withProject(appDb, pid, async (trx) =>
      mergeContacts(await adminMergeContext(trx, pid, adminId), found.survivorId, {
        mergedId: found.mergedId,
        keepDealIds: [],
      }),
    )
    if (!result.ok) throw new Error(`слияние ${merge.key}: отказ ${result.code}`)
    mergeId = result.value.merge.id
  }
  const id = mergeId
  await serviceDb.transaction().execute(async (trx) => {
    if (merge.ageDays > 0) {
      // Старое слияние: время слияния и срок отката — в прошлом, вместе с вложенными слияниями
      // сделок и отметкой скрытых записей.
      const shift = sql`make_interval(days => ${merge.ageDays})`
      await sql`
        update deal set merged_at = merged_at - ${shift}
        where id in (select merged_id from merge_record where parent_id = ${id})
      `.execute(trx)
      await sql`
        update merge_record set merged_at = merged_at - ${shift}, undo_until = undo_until - ${shift}
        where id = ${id} or parent_id = ${id}
      `.execute(trx)
      await sql`
        update contact set merged_at = merged_at - ${shift} where id = ${found.mergedId}
      `.execute(trx)
    }
    await link(trx, pid, 'merge_record', [{ id, key: merge.key }])
  })
```
- Что делает: сливает пары плана функцией `mergeContacts` (её экспортирует этот PR) от имени администратора seed. Пара с открытыми сделками в одной воронке даёт вложенное слияние сделок. Старое слияние сдвигается на 40 дней вместе с вложенными, его откат уже недоступен. Если запуск оборвался между слиянием и пометкой, повторный находит слияние по паре и только помечает его.
- Почему здесь: тикет требует свежих слияний, слияний старше 30 дней и одного с вложенным слиянием сделок. Роль приложения не может менять `merged_at` и `undo_until`, поэтому сдвиг идёт служебной ролью.
- Без него: проверять откат на данных seed было бы не на чем.
- Требование: [Что сделать](../issues/10-seed-sources-registrations-duplicates.md#что-сделать)
- Риски и пробелы test-ов: сдвиг времени не пишет историю изменений — в истории контакта слияние останется сегодняшним.

## 6. --reset: слитые записи seed удаляются проходами

Code: `apps/api/src/seed/store.ts:676-686` · key lines: 681, 685
```ts
      // Слияния seed (тикет crm-intake/10): скрытая запись seed держит оставшуюся. Проход удаляет
      // свободные записи, следующий — те, что держали только удалённые; до прохода без удалений.
      const deals = { rows: [] as { id: string }[] }
      const contacts = { rows: [] as { id: string }[] }
      for (;;) {
        const dealPass = await deleteDeals()
        const contactPass = await deleteContacts()
        deals.rows.push(...dealPass.rows)
        contacts.rows.push(...contactPass.rows)
        if (dealPass.rows.length + contactPass.rows.length === 0) break
      }
```
- Что делает: прежние запросы удаления сделок и контактов seed повторяются, пока что-то удаляется. Скрытая запись seed уходит первым проходом, оставшаяся — следующим. Перед этим удаляется всё, что пришло через источник seed: журнал, события приёма, регистрации, история с автором-источником. После — сами источники, слияния, пары и отметки «не дубль» удалённых записей.
- Почему здесь: файл и `--reset` — из тикета crm-deals/10. Запись, в которую слита ручная, по-прежнему остаётся. Почему `--reset` должен убирать и новые данные: в тикете не записано, это решение этого PR, чтобы не сломать прежнее поведение команды.
- Без него: после слияний seed `--reset` никогда не удалял бы проекты целиком: оставшаяся запись держалась бы скрытой.
- Требование: [Что сделать](../issues/10-seed-sources-registrations-duplicates.md#что-сделать)
- Риски и пробелы test-ов: регистрация, внесённая руками через ключ источника seed, удаляется вместе с источником; её контакт и сделка остаются. Отдельного теста на этот случай нет.

## 7. Ключи источников — только в файле учётных данных

Code: `apps/api/src/seed/users.ts:65-77` · key lines: 67, 76
```ts
/** Пользователи файла; ключи источников остаются как были. */
export async function writeCredentials(file: string, users: SeedCredential[]): Promise<void> {
  await writeFileOf(file, { users, sources: (await readFileOf(file)).sources ?? [] })
}

export async function readSourceKeys(file: string): Promise<SourceKey[]> {
  return (await readFileOf(file)).sources ?? []
}

/** Ключи источников файла; пользователи остаются как были. */
export async function writeSourceKeys(file: string, sources: SourceKey[]): Promise<void> {
  await writeFileOf(file, { users: (await readFileOf(file)).users, sources })
}
```
- Что делает: ключи источников лежат в `.seed-credentials.json` рядом с паролями, в поле `sources`. Запись пользователей не стирает ключи, запись ключей — пользователей. Источник, чей ключ в файле потерян, получает новый ключ: в базе только отпечаток.
- Почему здесь: тикет — «ключи источников печатаются в файл учётных данных рядом с паролями, а не в вывод».
- Без него: файл пользователей перезаписывался бы без ключей при каждом новом пользователе.
- Требование: [Done when](../issues/10-seed-sources-registrations-duplicates.md#done-when)
- Риски и пробелы test-ов: тест ловит вывод команды и `console.*` процесса и не находит в них ни префикса `alpi_src_`, ни тела ключа. Журнал настоящего сервера (stdout API) не проверяется: seed запускается отдельным процессом.

## 8. Что сознательно не меняли

Экран «Джерела» и журнал входящих (тикет 07), регистрации в карточках (тикет 09) — их кода в main нет. Seed создаёт для них данные на схеме и сервисах main, но открыть экраны на данных seed этот PR не может. Скорость ночного прохода надсмотрщика (тикет 05) не трогали: на полном объёме seed он укладывается в порог.

## 9. Как проверено

`pnpm vitest run apps/api/src/cli apps/api/src/acceptance` — exit 0, 34 теста. `pnpm vitest run apps/api/src/cli/seed-nightly.test.ts --silent=false` — exit 0: полный объём seed (4513 контактов, 5423 сделки, 7046 регистраций), ночной проход 19160 мс при пороге 300 000 мс. `pnpm verify` — exit 0. `gate fast` — exit 0. Тесты идут на локальной базе в WIN1251: кириллица seed записывается в ней без ошибок.

## Проверить себя

1. Почему приём, слияние и надсмотрщик в seed идут не служебным подключением, которое у seed уже есть?
   - Ответ: на владельца таблиц row-level security не действует. Надсмотрщик и поиск контакта видели бы другой проект, а пары «ALPI» записывались бы в «Франч».
   - Строки: `apps/api/src/cli/seed.ts:230-255`
2. Что случится, если функция приёма ответит не так, как ожидает план журнала?
   - Ответ: seed остановится с ошибкой, а не оставит строку журнала 500 вместо принятой регистрации.
   - Строки: `apps/api/src/seed/intake-store.ts:376-384`
3. Почему `--reset` удаляет сделки и контакты seed в цикле?
   - Ответ: скрытая слитая запись держит оставшуюся. Первый проход удаляет скрытые, следующий — оставшиеся, пока проход что-то удаляет.
   - Строки: `apps/api/src/seed/store.ts:676-686`
