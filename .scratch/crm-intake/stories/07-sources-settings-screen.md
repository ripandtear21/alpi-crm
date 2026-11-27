# Code story — crm-intake 07: Экран «Налаштування → Джерела» и журнал входящих источника

Kind: pr · Epic: crm-intake · Ticket: 07 · PR: - · Language: ru

## 1. Что было не так

API источников регистраций (тикет 03), журнал входящих и «провести заново» (тикет 06) уже были, а экрана не было. Администратор не мог завести источник, получить его ключ или посмотреть, что источник присылал. Чтобы после восстановления базы провести входящие заново, нужен был прямой запрос к API. Тикет просит экран в настройках: список источников, ключ, который показывается один раз, журнал за 30 дней с сырым телом и «Провести заново вхідні з моменту…» только для администратора проекта.
- Требование: [Что сделать](../issues/07-sources-settings-screen.md#что-сделать)

## 2. Пункт меню «Джерела» — с тем же правом, что «Вебхуки»

Code: `apps/web/src/routes/settings/settings-page.tsx:93-99` · key lines: 93, 95
```tsx
          {integrationsAllowed && (
            <li>
              <Link to="/p/$code/settings/intake-sources" params={{ code }}>
                {tSources('title')}
              </Link>
            </li>
          )}
```
- Что делает: пункт показывается только с правом «інтеграції: дивитися» из `GET /project/access`. Прямая ссылка без права даёт «немає доступу»: экран сам проверяет право (`intake-sources-page.tsx:78`) и тогда не запрашивает список.
- Почему здесь: тикет требует пункт меню в настройках только с правом `integrations: view`. Сам индекс настроек тикет не называет, а `app-nav.tsx` из его списка файлов не менялся: в верхнем меню разделы, а пункты настроек живут в индексе настроек, как «Вебхуки».
- Без него: пункта не было бы, а экран открывался бы только по прямому адресу.
- Требование: [Что сделать](../issues/07-sources-settings-screen.md#что-сделать)
- Риски и пробелы test-ов: тесты `с правом «інтеграції» в настройках есть пункт «Джерела»`, `без права «інтеграції» пункта «Джерела» нет`, `без права прямая ссылка — «немає доступу», источники не запрашиваются`.

## 3. Ключ живёт только в состоянии окна

Code: `apps/web/src/routes/settings/intake-sources/intake-sources-page.tsx:134-155` · key lines: 141, 144, 149
```tsx
  const confirmAction = async () => {
    if (!confirm) return
    const { action, source } = confirm
    setConfirm(null)
    setNotice(null)
    try {
      if (action === 'reissue') {
        const result = (await change.mutateAsync(() =>
          api.reissueKey(projectId, source.id),
        )) as IntakeSourceWithKey
        setIssued({ ...result, rotated: true })
        change.reset()
        return
      }
      await change.mutateAsync(() =>
        action === 'disable' ? api.disable(projectId, source.id) : api.enable(projectId, source.id),
      )
      setNotice({ kind: 'status', text: t(`done.${action}`, { name: source.name }) })
    } catch (error) {
      setNotice({ kind: 'alert', text: errorText(error) })
    }
  }
```
- Что делает: смена ключа уходит в API только после подтверждения («старий ключ перестане працювати одразу»). Новый ключ кладётся в состояние `issued`, его показывает окно ключа. Сразу после этого `change.reset()` убирает ответ из состояния мутации, а `gcTime: 0` удаляет мутацию из кэша TanStack Query. Когда окно закрыли, `issued` сбрасывается, и ключа на странице больше нет: в списке остаются только первые 12 символов из ответа API. Отключение и включение идут тем же подтверждением, а список перечитывается.
- Почему здесь: тикет требует окно с ключом, кнопкой «скопіювати» и текстом «більше не буде показано», а смену ключа и отключение — с подтверждением. Где держать ключ, тикет не записывает; так же устроен экран вебхуков (тикет crm-api/07).
- Без него: ключ остался бы на странице после закрытия окна или в кэше мутаций, где его видно, например, в React DevTools (замечание проверки PR #47).
- Требование: [Что сделать](../issues/07-sources-settings-screen.md#что-сделать)
- Риски и пробелы test-ов: тесты проверяют `document.body.innerHTML` без ключа после закрытия окна, при создании и при смене ключа. Тесты проверяют и кэш мутаций (`cachedMutationsWith`); мутант без `reset()` — exit 1.

## 4. Кто администратор: запрос хода отвечает 403 всем остальным

Code: `apps/api/src/intake/replay.ts:63-68` · key lines: 65, 66, 67
```ts
    .get('/replay', async (c) => {
      // Ход и итог последнего запуска (тикет crm-intake/07): тоже только администратору.
      const access = await requestAccess(c)
      if (!access?.isAdmin) return fail(c, refuse(403, 'PERMISSION_DENIED' as InboundErrorCode))
      return c.json<InboundReplayStatus>(await latestReplay(c.get('db'), c.get('projectId')))
    })
```
- Что делает: новый `GET /v1/inbound/replay` отдаёт последний запуск «провести заново» и его итог. Как и запуск, он только для администратора проекта и только по сессии: маршрут без отметки apiKeyRoute, и ключ API получает 403.
- Почему здесь: тикет разрешает мелкие правки в `apps/api/src/intake/**`. `GET /project/access` не говорит, администратор ли пользователь, а у задачи «провести заново» нет состояния, которое читал бы экран. Решено без владельца — подтвердить.
- Без него: экран не знал бы, показывать ли кнопку, и не мог бы показать ход и итог задачи, которая идёт в фоне (pg-boss).
- Требование: [Что сделать](../issues/07-sources-settings-screen.md#что-сделать)
- Риски и пробелы test-ов: `replay-status.test.ts` на настоящем PostgreSQL: «запусков не было — latest: null; после запуска — идёт; после задачи — итог» и «не администратор — 403; ключ API — 403 API_KEY_NOT_ALLOWED».

## 5. Ход и итог — из журнала проекта, по паре since и until

Code: `apps/api/src/intake/replay-status.ts:33-47` · key lines: 35, 40, 41, 45
```ts
    from audit_log s
    left join "user" u on u.id = s.actor_id
    left join lateral (
      select occurred_at, details
      from audit_log
      where project_id = s.project_id
        and action = 'inbound.replay_finished'
        and details->>'since' = s.details->>'since'
        and details->>'until' = s.details->>'until'
      order by occurred_at desc, id desc
      limit 1
    ) f on true
    where s.project_id = ${projectId} and s.action = 'inbound.replay_started'
    order by s.occurred_at desc, s.id desc
    limit 1
```
- Что делает: берёт последнюю запись `inbound.replay_started` проекта и ищет к ней `inbound.replay_finished` с теми же `since` и `until`. Итога нет — задача ещё идёт. Числовые поля итога (accepted, repeats, errors и будущие) отдаются как есть.
- Почему здесь: тикет 06 пишет запуск и итог в журнал проекта (`intake/replay.ts`), и других следов задачи нет. Отдельная таблица состояния задач — решение больше, чем нужно этому экрану.
- Без него: пришлось бы заводить таблицу или читать внутренние таблицы pg-boss.
- Требование: [Что сделать](../issues/07-sources-settings-screen.md#что-сделать)
- Риски и пробелы test-ов: итог с `failed: true` пишет очередь мёртвых задач (следующий шаг); тогда `counts` — null, `failed` — true.

## 6. Задача упала окончательно — итог «не завершилось», а не «идёт» вечно

Code: `apps/api/src/jobs/jobs.ts:226-234` · key lines: 226, 231, 234
```ts
  await boss.createQueue(QUEUES.inboundReplayDead, { retryLimit: 5, retryDelay: 60 })
  const inboundReplayQueue = {
    retryLimit: options.inboundReplayRetryLimit ?? INBOUND_REPLAY_RETRY_LIMIT,
    retryDelay: 60,
    expireInSeconds: 60 * 60,
    deadLetter: QUEUES.inboundReplayDead,
  }
  await boss.createQueue(QUEUES.inboundReplay, inboundReplayQueue)
  await boss.updateQueue(QUEUES.inboundReplay, inboundReplayQueue)
```
- Что делает: задача `inbound-replay`, провалившая все попытки (сбой или истёк срок), попадает в очередь `inbound-replay-dead`. Её обработчик `failInboundReplay` (`replay-status.ts`) пишет `inbound.replay_finished` с `failed: true`, если итога ещё нет. `updateQueue` нужен базам, где очередь уже создана тикетом 06: `createQueue` существующую очередь не меняет.
- Почему здесь: проверка PR #47 (REJECTED) нашла, что упавший запуск выглядел идущим вечно. Образец — очередь мёртвых задач `bulk-job-dead` в том же файле.
- Без него: экран раз в 3 с опрашивал бы сервер и показывал «Виконується» без конца, а администратор не узнал бы, что входящие не проведены.
- Требование: [Что сделать](../issues/07-sources-settings-screen.md#что-сделать)
- Риски и пробелы test-ов: тест `задача упала окончательно — итог «не завершилось», а не «идёт» вечно` идёт с настоящим pg-boss: у роли приложения на время теста отнято чтение журнала входящих. Мутант без `deadLetter` — exit 1. Если попытка с истёкшим сроком всё же допишет итог после записи о сбое, `latestReplay` покажет последний итог.

## 7. Экран: только 403 прячет раздел; дата проверяется до запроса

Code: `apps/web/src/routes/settings/intake-sources/inbound-replay.tsx:69-82` · key lines: 71, 73, 77
```tsx
  // Не администратор (403) или ещё не ответили — раздела нет. Другой сбой запроса хода —
  // сообщение: кнопка не должна пропадать у администратора молча.
  if (status.data === null) return null
  if (status.data === undefined) {
    if (!status.isError) return null
    return (
      <section className="directory__card intake-sources__replay" aria-labelledby={titleId}>
        <h2 id={titleId}>{t('replay.title')}</h2>
        <p className="ui-notice" role="alert">
          {t('replay.statusFailed')}
        </p>
      </section>
    )
  }
```
- Что делает: ответ 403 на запрос хода клиент превращает в null (`intake-sources-api.ts`, replayStatus), и раздела «Провести заново» нет. Другой сбой запроса (500, сеть) показывает в разделе сообщение, чтобы кнопка не пропала у администратора молча. Итог с `failed` показывается как «Не завершилося», и ход больше не перечитывается. Пустой момент, момент старше 30 дней (с минутой запаса) и момент в будущем отклоняются у поля, без запроса к API. Иначе открывается подтверждение «Повтор безпечний: вже прийняті реєстрації не задвояться». Пока итога нет, ход перечитывается раз в 3 с.
- Почему здесь: тикет требует кнопку только для администратора, дату не старше 30 дней, подтверждение с пояснением, ход и итог.
- Без него: дата старше 30 дней дошла бы до API и вернулась бы ответом 422.
- Требование: [Что сделать](../issues/07-sources-settings-screen.md#что-сделать)
- Риски и пробелы test-ов: тесты `не администратору проекта раздела и кнопки нет`, `дата старше 30 дней не принимается: запрос не уходит`, `подтверждение с пояснением, ход, затем итог`, `задача не завершилась — «Не завершилося», ход больше не перечитывается`, `сбой запроса хода (не 403) — раздел с сообщением`. Ход «идёт» в тесте даёт подставной API. Настоящая задача проверена временным сценарием Playwright: итог «прийнято: 0, повторів: 2, помилок: 1».

## 8. Строка «проведено заново» ссылается на исходную

Code: `apps/web/src/routes/settings/intake-sources/inbound-journal.tsx:135-140` · key lines: 135, 138
```tsx
        {request.replayOf && (
          <span>
            {t('journal.replayed')} ·{' '}
            <a href={`#${inboundAnchor(request.replayOf)}`}>{t('journal.original')}</a>
          </span>
        )}
```
- Что делает: у строки с `replayOf` есть пометка «Проведено заново» и ссылка на элемент исходной строки журнала (`id="inbound-<id>"`), который подсвечивается через `:target`.
- Почему здесь: тикет требует показывать строки «проведено заново» со ссылкой на исходную. Ссылка-якорь внутри страницы — решено без владельца, подтвердить.
- Без него: проведённую заново строку нельзя было бы отличить от запроса источника.
- Требование: [Что сделать](../issues/07-sources-settings-screen.md#что-сделать)
- Риски и пробелы test-ов: исходная строка старше, и при подгрузке курсором её может ещё не быть на странице; тогда ссылка никуда не ведёт, пока не нажать «Показати ще». Тест проверяет только `href`.

## 9. Что сознательно не меняли

Регистрация в строке журнала показана началом id без ссылки: страницы регистрации нет, регистрации в карточках делает тикет 09. Подпись канала показывается только для каналов кроме регистраций. Подписи итога «без реєстрації» (`unmatched`) и канала «Перегляд вебінару» добавлены заранее под тикет 08. `app-nav.tsx` не менялся.

## 10. Как проверено

`pnpm vitest run apps/web/src/routes/settings/intake-sources` — exit 0 (20 тестов). `pnpm vitest run apps/api/src/intake/replay-status.test.ts` — exit 0 (3 теста на настоящем PostgreSQL, один с настоящим pg-boss). Мутанты доработки (без `deadLetter`, без `reset()`, раздел прячется при любой ошибке, «идёт» по `counts === null`) — exit 1. `pnpm verify` — exit 0. `gate fast` — exit 0; в первом прогоне упал только известный нестабильный `webhook-endpoints/catch-up.test.ts`, повтор зелёный. Снимки на 375 px (uk и ru) сделал временный сценарий Playwright на стенде e2e/global-setup.ts: создание, окно ключа, подтверждение «провести заново», журнал после настоящего проведения заново; `scrollWidth` не больше 375. В PR этот сценарий не входит.

## Проверить себя

1. Как экран узнаёт, показывать ли кнопку «Провести заново», если `GET /project/access` не говорит, администратор ли пользователь?
   - Ответ: он запрашивает ход `GET /v1/inbound/replay`; не администратору API отвечает 403, клиент превращает его в null, и раздел не показывается.
   - Строки: `apps/api/src/intake/replay.ts:63-68`
2. Почему экран показывает «Виконується», пока итога нет, и как он понимает, что задача закончилась?
   - Ответ: запуск и итог пишутся в журнал проекта отдельными записями; итог ищется по тем же since и until, и пока записи итога нет, задача считается идущей.
   - Строки: `apps/api/src/intake/replay-status.ts:33-47`
3. Почему после закрытия окна ключа его нет на странице?
   - Ответ: ключ лежит только в состоянии `issued` окна; ответ мутации сбрасывается `reset()` сразу после показа, закрытие окна сбрасывает `issued`, а список показывает только `keyPrefix` из ответа API.
   - Строки: `apps/web/src/routes/settings/intake-sources/intake-sources-page.tsx:134-155`
