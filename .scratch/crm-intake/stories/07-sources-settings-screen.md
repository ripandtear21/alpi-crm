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

Code: `apps/web/src/routes/settings/intake-sources/intake-sources-page.tsx:131-151` · key lines: 138, 141, 145
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
- Что делает: смена ключа уходит в API только после подтверждения («старий ключ перестане працювати одразу»). Новый ключ кладётся в состояние `issued`, его показывает окно ключа. Когда окно закрыли, `issued` сбрасывается, и ключа на странице больше нет: в списке остаются только первые 12 символов из ответа API. Отключение и включение идут тем же подтверждением, а список перечитывается.
- Почему здесь: тикет требует окно с ключом, кнопкой «скопіювати» и текстом «більше не буде показано», а смену ключа и отключение — с подтверждением. Где держать ключ, тикет не записывает; так же устроен экран вебхуков (тикет crm-api/07).
- Без него: ключ остался бы в кэше списка или на странице после закрытия окна.
- Требование: [Что сделать](../issues/07-sources-settings-screen.md#что-сделать)
- Риски и пробелы test-ов: тесты проверяют `document.body.innerHTML` без ключа после закрытия окна, при создании и при смене ключа. Результат мутации TanStack Query держит ответ в кэше мутаций до следующего изменения или до сборки мусора, как у экрана вебхуков; это не проверялось.

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

Code: `apps/api/src/intake/replay-status.ts:28-42` · key lines: 30, 35, 36, 40
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
- Риски и пробелы test-ов: если задача упала и pg-boss её не повторил, итога не будет, и экран всё время показывает «Виконується»; срок, после которого запуск считать упавшим, не задан.

## 6. Экран: 403 — раздела нет; дата проверяется до запроса

Code: `apps/web/src/routes/settings/intake-sources/inbound-replay.tsx:67-79` · key lines: 68, 75, 78
```tsx
  // Не администратор (403), ещё не ответили или не смогли ответить — раздела нет.
  if (!status.data) return null

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setNotice(null)
    const time = since === '' ? Number.NaN : new Date(since).getTime()
    if (Number.isNaN(time)) return setFieldError(t('replay.required'))
    if (time < earliest()) return setFieldError(t('replay.tooOld'))
    if (time > Date.now()) return setFieldError(t('replay.inFuture'))
    setFieldError(null)
    setConfirming(new Date(time).toISOString())
  }
```
- Что делает: ответ 403 на запрос хода клиент превращает в null (`intake-sources-api.ts`, replayStatus), и раздела «Провести заново» нет. Пустой момент, момент старше 30 дней (с минутой запаса) и момент в будущем отклоняются у поля, без запроса к API. Иначе открывается подтверждение «Повтор безпечний: вже прийняті реєстрації не задвояться». Пока итога нет, ход перечитывается раз в 3 с.
- Почему здесь: тикет требует кнопку только для администратора, дату не старше 30 дней, подтверждение с пояснением, ход и итог.
- Без него: дата старше 30 дней дошла бы до API и вернулась бы ответом 422.
- Требование: [Что сделать](../issues/07-sources-settings-screen.md#что-сделать)
- Риски и пробелы test-ов: тесты `не администратору проекта раздела и кнопки нет`, `дата старше 30 дней не принимается: запрос не уходит`, `подтверждение с пояснением, ход, затем итог`. Ход «идёт» в тесте даёт подставной API. Настоящая задача проверена временным сценарием Playwright: итог «прийнято: 0, повторів: 2, помилок: 1».

## 7. Строка «проведено заново» ссылается на исходную

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

## 8. Что сознательно не меняли

Регистрация в строке журнала показана началом id без ссылки: страницы регистрации нет, регистрации в карточках делает тикет 09. Подпись канала показывается только для каналов кроме регистраций. Подписи итога «без реєстрації» (`unmatched`) и канала «Перегляд вебінару» добавлены заранее под тикет 08. `app-nav.tsx` не менялся.

## 9. Как проверено

`pnpm vitest run apps/web/src/routes/settings/intake-sources` — exit 0 (18 тестов). `pnpm vitest run apps/api/src/intake/replay-status.test.ts` — exit 0 (2 теста на настоящем PostgreSQL). `pnpm verify` — exit 0. `gate fast` — exit 0; в первом прогоне упал только известный нестабильный `webhook-endpoints/catch-up.test.ts`, повтор зелёный. Снимки на 375 px (uk и ru) сделал временный сценарий Playwright на стенде e2e/global-setup.ts: создание, окно ключа, подтверждение «провести заново», журнал после настоящего проведения заново; `scrollWidth` не больше 375. В PR этот сценарий не входит.

## Проверить себя

1. Как экран узнаёт, показывать ли кнопку «Провести заново», если `GET /project/access` не говорит, администратор ли пользователь?
   - Ответ: он запрашивает ход `GET /v1/inbound/replay`; не администратору API отвечает 403, клиент превращает его в null, и раздел не показывается.
   - Строки: `apps/api/src/intake/replay.ts:63-68`
2. Почему экран показывает «Виконується», пока итога нет, и как он понимает, что задача закончилась?
   - Ответ: запуск и итог пишутся в журнал проекта отдельными записями; итог ищется по тем же since и until, и пока записи итога нет, задача считается идущей.
   - Строки: `apps/api/src/intake/replay-status.ts:28-42`
3. Почему после закрытия окна ключа его нет на странице?
   - Ответ: ключ лежит только в состоянии `issued` окна; закрытие сбрасывает его, а список показывает только `keyPrefix` из ответа API.
   - Строки: `apps/web/src/routes/settings/intake-sources/intake-sources-page.tsx:131-151`
