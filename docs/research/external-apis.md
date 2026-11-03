# API внешних сервисов MVP: WayForPay, Ringostat, НБУ

Дата исследования: 2026-11-03.
Тикет: «API внешних сервисов MVP: WayForPay, Ringostat, НБУ».

Контекст. Своя CRM для AI-школы, которая продаёт курсы по цепочке «вебинар → бронь → счёт → доплата».
Вопрос: как устроены три интеграции, без которых MVP не работает:

- WayForPay — приём оплаты;
- Ringostat — телефония и коллтрекинг;
- НБУ — официальный курс гривны.

Источники только первичные: wiki.wayforpay.com и help.wayforpay.com, help.ringostat.com и ringostat.readme.io, bank.gov.ua.
Каждое утверждение ссылается на источник из списка в конце. Ссылки даны в виде [W1], [R3], [N2].
Пометка «не проверено» значит: в первичных источниках подтверждения нет, это вывод или предположение.
Пометка «проверено запросом» значит: утверждение проверено живым запросом к API 2026-11-03.

---

## Короткий итог для дизайна CRM

1. **Один `orderReference` — один платёж в WayForPay.**
   Повторный `orderReference` отклоняется с кодом 1112 «Duplicate Order ID» [W7].
   Понятия «частичная оплата одного заказа» в API нет.
   Значит, бронь, счёт и доплата — это разные `orderReference`.
   Связь их с одной сделкой хранит CRM: таблица платежей со ссылкой на сделку.
   Это вывод из документации, отдельной статьи о частичных оплатах нет.
2. **Колбэк WayForPay приходит повторно до 4 суток**, пока сервер CRM не ответит правильным подписанным JSON [W1][W2].
   Обработчик колбэка должен быть идемпотентным: повторная доставка того же события не меняет результат.
   Кроме того, колбэк приходит при каждой смене статуса, а не только при оплате [W1].
3. **Валюта.**
   В API поле `currency` описано как «UAH». USD и EUR передаются только как `alternativeCurrency` [W1][W2].
   Списание с карты идёт в гривне с конвертацией. Выплаты продавцу — только в гривне [W9][W11].
   Курс конвертации WayForPay по умолчанию — наличный курс; его можно заменить своим курсом в кабинете [W10].
   Значит, CRM должна хранить отдельно цену в EUR/USD, сумму в UAH к списанию и курс, по которому сумма посчитана.
4. **Подписи WayForPay — HMAC-MD5 на SecretKey.**
   Набор полей в строке подписи свой для каждого метода. Разделитель «;», кодировка UTF-8 [W1][W3][W4][W12].
   Подпись нужно проверять и у входящего колбэка, и ставить на свой ответ.
5. **Ringostat не ищет контакт в CRM по номеру через «внешний API».**
   Есть два механизма.
   Первый — «Webhook forwarding number»: при входящем звонке Ringostat спрашивает URL CRM, куда направить звонок, и ждёт номер, SIP-логин или ID схемы [R6].
   Второй — CRM сама отправляет контакты в адресную книгу Ringostat Smart Phone методом `minicrm/contacts/sync` [R10].
   Карточку клиента CRM показывает по вебхуку «Incoming call», который приходит в момент снятия трубки или до звонка [R1][R3].
6. **Доставка вебхуков Ringostat ненадёжна.**
   При ответе 4XX–5XX Ringostat повторяет запрос ещё 3 раза. После этого событие попадает в список ошибок, откуда его можно отправить вручную [R5].
   Обзорная статья при этом говорит, что повторов нет вовсе [R1].
   Значит, нужна ночная сверка через `GET /calls/list` [R8].
   Записи разговоров гарантированно хранятся 1 год [R11]. Если записи нужны дольше, CRM должна сохранять у себя копию или ссылку.
7. **Курс НБУ назначается на календарную дату, в том числе на выходные.**
   Курс, установленный на пятницу, действует в субботу и воскресенье. Курс, рассчитанный в пятницу, действует с понедельника [N3].
   Проверено запросом: на 31.10 и 01.11.2026 API отдаёт курс с `calcdate` 29.10.2026.
   Курс на завтра публикуется не позже 16:00 по Киеву [N3]. После 15:30 «текущий» курс в API — уже курс на следующий рабочий день [N1].
   CRM должна запрашивать курс по явной дате, а не по «текущей».
8. **Аутентификация у всех трёх сервисов разная.**
   - WayForPay: подпись HMAC-MD5 в теле запроса. Для API регулярных платежей — `merchantPassword` [W1][W6].
   - Ringostat: заголовок `Auth-key`; для части методов ещё `x-project-id` [R7][R10].
     Входящие вебхуки Ringostat можно защитить Basic-аутентификацией или OAuth 2.0 [R2].
   - НБУ: аутентификации нет, API открытый [N1].

---

## 1. WayForPay

### 1.1 Аутентификация и общие правила

- Ключ подписи — SecretKey продавца. Алгоритм — HMAC_MD5 [W1].
- Строка для подписи — значения полей, соединённые через «;», в кодировке UTF-8 [W1].
- Серверные методы (CREATE_INVOICE, REFUND, CHECK_STATUS, REMOVE_INVOICE, TRANSACTION_LIST, CURRENCY_RATES) — это `POST https://api.wayforpay.com/api` с JSON-телом [W2][W3][W4][W12][W13][W14].
- API регулярных платежей — отдельный адрес: `POST https://api.wayforpay.com/regularApi`.
  Он аутентифицируется не подписью, а полем `merchantPassword` [W6][W15].
  В примере `merchantPassword` выглядит как MD5-хеш. Как его получить — не проверено.

### 1.2 Создание оплаты

**Purchase** — платёжная форма на стороне WayForPay [W1].

- Запрос: `POST https://secure.wayforpay.com/pay`, отправка HTML-формой.
- Обязательные поля: `merchantAccount`, `merchantDomainName`, `merchantTransactionSecureType=AUTO`, `merchantSignature`, `orderReference`, `orderDate`, `amount`, `currency`, `productName[]`, `productPrice[]`, `productCount[]` [W1].
- Полезные необязательные поля [W1]:
  - `serviceUrl` — адрес колбэка;
  - `returnUrl` — куда вернуть покупателя после оплаты;
  - `orderTimeout` — сколько секунд заказ можно оплатить повторно;
  - `orderLifetime` — сколько секунд заказ вообще можно оплатить;
  - `clientEmail`, `clientPhone`, `clientAccountId`;
  - `paymentSystems` — способы оплаты, в том числе рассрочки: `payParts`, `payPartsMono` и другие;
  - `apiVersion=2` — расширенные данные в колбэке;
  - `language`.
- Ссылку на оплату без HTML-формы можно получить так: `POST https://secure.wayforpay.com/pay?behavior=offline` с теми же полями.
  Ответ: `{"url": "https://secure.wayforpay.com/page?vkh=..."}` [W1].

**CREATE_INVOICE** — счёт со ссылкой. Этот метод ближе всего к шагу «счёт» [W2].

- Запрос: `transactionType=CREATE_INVOICE`. Поля почти те же, что у Purchase, плюс `notifyMethod`: `sms`, `email`, `bot` или `all`.
- Ответ: `reason`, `reasonCode`, `invoiceUrl`, `qrCode` [W2].
- Если не передать `clientEmail`, клиент уведомление не получит. Но `invoiceUrl` в ответе всё равно будет [W2].
- **Подводный камень:** по умолчанию счёт живёт 1 час (`orderTimeout`) [W2].
  Для счёта, который отправляют клиенту после вебинара, `orderTimeout` нужно задавать явно. В примере документации — 86400 секунд.
  Максимальное значение не указано — не проверено.
- Неоплаченный счёт удаляется методом `REMOVE_INVOICE`. Подпись: `merchantAccount;orderReference` [W12].

**Подпись Purchase и CREATE_INVOICE** [W1][W2]:

```
merchantAccount;merchantDomainName;orderReference;orderDate;amount;currency;
productName[0..n];productCount[0..n];productPrice[0..n]
```

Порядок такой: сначала все названия товаров, потом все количества, потом все цены.
Это не тот порядок, в котором поля идут в запросе.
Пример строки из документации: `test_merchant;www.market.ua;DH783023;1415379863;1547.36;UAH;Процесор…;Пам'ять…;1;1;1000;547.36` [W1].

### 1.3 Колбэк на serviceUrl и ответ на него

- WayForPay отправляет HTTP POST на `serviceUrl` в двух случаях: для авторизованных и проверенных заказов и при смене статуса заказа [W1][W2].
- Тело запроса — JSON. В примере документации его читают через `php://input`, а не как поля формы [W1].
- Поля колбэка [W1][W2]:
  - `merchantAccount`, `orderReference`, `merchantSignature`, `amount`, `currency`, `authCode`;
  - `email`, `phone`;
  - `createdDate`, `processingDate` — Unix-время;
  - `cardPan` (маскированный номер), `cardType`, `issuerBankCountry`, `issuerBankName`;
  - `recToken` — токен карты;
  - `transactionStatus`, `reason`, `reasonCode`, `fee`, `paymentSystem`;
  - `repayUrl` — передаётся, если оплата неуспешна.
- Проверка подписи колбэка [W1]:
  ```
  merchantAccount;orderReference;amount;currency;authCode;cardPan;transactionStatus;reasonCode
  ```
- Ответ CRM [W1]:
  ```json
  {"orderReference":"DH783023","status":"accept","time":1415379863,"signature":"<hmac>"}
  ```
  Подпись ответа: `orderReference;status;time`.
- Если WayForPay не получает правильный ответ, он повторяет запрос в течение 4 суток или до получения правильного ответа [W1][W2].
- **Подводный камень:** в примерах документации `amount` приходит то числом (`1547.36`), то строкой (`"1547.36"`) [W1][W2].
  Подпись считается от текстового представления числа.
  Если ваша библиотека переформатирует число (`1547.3600`, `1.54736E3`), подпись не совпадёт.
  Подпись надо проверять по исходной строке из JSON. Это вывод, не проверено.

### 1.4 Статусы транзакции [W7]

| Статус | Значение |
|---|---|
| `InProcessing` | заказ ещё обрабатывается |
| `WaitingAuthComplete` | успешный hold — средства заблокированы и ждут списания (Settle) |
| `Approved` | успешная оплата |
| `Pending` | идёт антифрод-проверка |
| `Expired` | истёк срок оплаты |
| `Refunded` / `Voided` | возврат или разблокировка |
| `Declined` | отклонено |
| `RefundInProcessing` | возврат в обработке: на балансе магазина недостаточно средств |

Коды ответа: `1100` — успех. Остальные коды — причины отказа: `1104` — недостаточно средств, `1112` — дублирующий orderReference, `1113` — неверная подпись и другие [W7].

Если колбэк не пришёл, статус по `orderReference` можно запросить методом **CHECK_STATUS** [W4].
- Подпись запроса: `merchantAccount;orderReference`.
- Подпись ответа считается так же, как у колбэка.
- Ответ дополнительно содержит `settlementDate`, `settlementAmount`, `fee`, `refundAmount` (сумма всех возвратов) [W4].

Для ночной сверки подходит **TRANSACTION_LIST** — список транзакций за период.
Подпись: `merchantAccount;dateBegin;dateEnd` [W13].

### 1.5 Частичные оплаты и доплаты

- `orderReference` описан как «уникальный номер заказа в системе продавца» [W1]. Повтор даёт ошибку `1112 Duplicate Order ID` [W7].
- Механизма «несколько оплат на один orderReference» в документации нет — не проверено, что его нет вовсе.
- Предлагаемая схема — вывод, не из документации:
  - одна сделка в CRM — N платежей;
  - у каждого платежа свой `orderReference`, например `{dealId}-{seq}`;
  - бронь — это отдельный Purchase или Invoice на сумму брони;
  - доплата — новый CREATE_INVOICE на остаток.
- Рассрочки банков (`payParts*`) — это способ оплаты одного заказа, а не частичная оплата [W1].
  Банк перечисляет продавцу полную сумму — не проверено.

### 1.6 Возвраты (REFUND) [W3]

- Запрос: `transactionType=REFUND`, `merchantAccount`, `orderReference`, `amount`, `currency`, `comment` (обязательное поле), `apiVersion`.
- Подпись запроса: `merchantAccount;orderReference;amount;currency`.
- Ответ: `transactionStatus` принимает значения `Refunded`, `Voided` или `Declined`, плюс `reason` и `reasonCode`.
  Подпись ответа: `merchantAccount;orderReference;transactionStatus;reasonCode`.
- Частичный возврат. Поле `amount` называется «сумма возврата», а в CHECK_STATUS есть `refundAmount` — «сумма всех возвращённых средств» [W3][W4].
  Это указывает, что частичные и повторные возвраты возможны. Явного утверждения нет — не проверено.
- Если на балансе магазина не хватает денег, возврат получает статус `RefundInProcessing` [W7].
- Возврат возможен и через личный кабинет (M-portal) [W3]. CRM узнает о таком возврате только из колбэка или из сверки.

### 1.7 Регулярные платежи

- Регулярный платёж включается полями Purchase: `regularMode` (`once`, `daily`, `weekly`, `monthly`, `quarterly`, `halfyearly`, `yearly`…), `regularAmount`, `dateNext`, `dateEnd` или `regularCount`, `regularOn`, `regularBehavior=preset` [W1].
- Управление — через `regularApi` с методами STATUS, CHANGE, SUSPEND, RESUME, REMOVE. Аутентификация по `merchantPassword` [W6][W15].
  Состояния регулярного платежа: `Active`, `Suspended`, `Created`, `Removed`, `Confirmed`, `Completed` [W6].
- Если на карте не хватает средств, WayForPay повторит списание на следующий день и предупредит клиента [W16].
- Альтернатива — токен карты `recToken` [W17]. Он приходит в колбэке после успешной оплаты.
  По нему продавец списывает деньги сам, методом Charge host-to-host, без CVV и без 3-D Secure.
- Для MVP школы регулярные платежи не обязательны. Доплату проще выставлять новым счётом.

### 1.8 Валюты

- `currency` в Purchase, Invoice и Refund описан как «UAH». `alternativeCurrency` — «USD, EUR» [W1][W2][W3].
- База знаний: «Доступно 32 валюти для прийому платежів. Зарахування коштів можливо тільки в гривні. Списання коштів з іноземних карт відбувається в гривні, із застосуванням конвертації» [W9].
- Выплаты продавцу — только в гривне и только в банковские дни [W11].
- Курс конвертации настраивается в кабинете магазина: наличный (по умолчанию), карточный или свой [W10].
  Это курс WayForPay, а не курс НБУ.
- Метод `CURRENCY_RATES` возвращает курсы WayForPay на дату. Подпись: `merchantAccount;orderDate` [W14].
- Как ведут себя `amount` и `currency` в колбэке, если счёт выставлен с `alternativeCurrency=EUR`, — не проверено.
  Нужен тестовый платёж.

### 1.9 Тестовый режим

- Тестовый продавец: `merchantAccount=test_merch_n1`, `merchantSecretKey=flk3409refn54t54t*FNJRET` [W8].
- Отдельного «sandbox-флага» в API нет. Тестирование идёт через тестового продавца [W8].
- Список тестовых карт на странице не опубликован — не проверено.

### 1.10 Что хранить в CRM (WayForPay)

Таблица `payment`, по одной записи на `orderReference`:

- `deal_id`, `order_reference`, тип: бронь, счёт или доплата;
- `amount`, `currency`, `alternative_amount`, `alternative_currency`;
- `invoice_url`, `order_date`, `order_timeout`;
- последний `transaction_status`, `reason_code`;
- `auth_code`, `card_pan` (маскированный), `payment_system`, `fee`;
- `processing_date`, `refund_amount`;
- `rec_token` — только если нужны регулярные списания. Это чувствительное поле.

Журнал сырых колбэков: тело, результат проверки подписи, время получения. Он нужен для идемпотентности и разбора споров.
Номер карты целиком WayForPay не передаёт [W1]. Хранить данные карты, кроме маскированного номера, не нужно.

---

## 2. Ringostat

### 2.1 Аутентификация

- REST API: базовый адрес `https://api.ringostat.net/`, заголовок `Auth-key`.
  Ключ берётся в кабинете: «Settings → Integrations → Ringostat API» [R7].
- Методы `minicrm/*` дополнительно требуют заголовок `x-project-id` [R10].
- Методы колбэка нельзя вызывать с фронтенда. Это запрещено ради безопасности, вызов только с сервера [R9].
- Входящие вебхуки (Webhooks 2.0) можно защитить двумя способами [R2]:
  - Basic Auth — логин и пароль в заголовке;
  - OAuth 2.0 — Ringostat сам получает токен у сервера CRM.
- Ещё один вариант защиты — статический секрет в URL обработчика (параметры в Destination) [R3].
  Кроме того, в вебхук можно добавить параметр-хеш (md5, crc32, sha1, sha256) [R1].
  Участвует ли в этом хеше секрет — не проверено.
- Запросы приходят с IP-адресов Ringostat. Адрес выдаёт поддержка через чат [R5].

### 2.2 Вебхуки о звонках

- Настройка: в кабинете «Integrations → Webhooks (2.0) → Add event», через интерфейс, не через API [R1].
- Для каждого вебхука задаются [R1]:
  - URL;
  - HTTP-метод: GET, POST или PUT;
  - формат: json, raw, json-rpc или form;
  - формат даты;
  - заголовки;
  - список передаваемых параметров — их выбирают вручную.
- В интерфейсе есть кнопки «Show sample» и «Execute and show sample» [R1].
- События [R1][R3][R4]:
  - **Incoming call** — до звонка, после звонка, после меню оценки звонка, в момент снятия трубки, в момент переадресации;
  - **Outgoing call** — до и после звонка;
  - **Form submit**, открытие и закрытие диалога в мессенджере;
  - «Deal created/updated» — только для HubSpot и Pipedrive.
- Фильтры [R12]:
  - готовые: пропущенные, неуспешные, отвеченные, звонки через виджет обратного звонка, «целевые» (proper);
  - произвольные условия, как в журнале звонков.
- Пример полей входящего звонка [R3]:
  - `caller`, `callee`, `status`, `date`, `call_duration`, `type`, `waiting`, `dialog`;
  - `call_id`, `record`, `record_link`, `recording_wav`, `has_recording`;
  - `utm`-поля: `source`, `medium`, `campaign`, `content`, `term`;
  - `landing`, `referrer`, `replace_type`: dynamic, static или callback;
  - `manager_id`, `employee_fio`, `department`;
  - `proper`, `repeated`, `unique_first`, `call_card`, `project_id`, `full_num`.
  Полный список дан во внешнем файле по ссылке из статьи — не проверено.
- Исходящий звонок дополнительно передаёт `staffid` и `outbound_number` [R4].
- **Подводный камень: имена полей в разных событиях разные.**
  Например, `call_id` во входящем вебхуке и `callid` в forwarding number; `user_ip` и `userip` [R3][R6].
  Набор и имена полей задаются вручную в кабинете. Контракт надо фиксировать на стороне CRM.
- **Подводный камень: повторы.** Статья об ошибках говорит: при ответе 4XX–5XX будет ещё 3 повтора, затем событие попадёт в «Verify actions with errors» [R5].
  Обзорная статья говорит, что повторов нет вообще [R1]. Источники противоречат друг другу.
  В любом случае нужна сверка через `calls/list`.

### 2.3 Записи разговоров

- В вебхуке приходят `record_link` (ссылка на запись в кабинете) и `recording_wav` (прямая ссылка на WAV с `token` в query-строке) [R3][R4].
- Записи хранятся и доступны гарантированно 1 год для активных проектов. Более старые выдаются по запросу [R11].
- Как долго живёт `token` в `recording_wav` — не проверено.
  Если запись нужна в CRM надолго, файл стоит скачать к себе сразу после звонка.
- Записывать разговоры можно с предупреждением клиента о записи. Оно включается в настройках переадресации [R13].

### 2.4 Поиск контакта по номеру и маршрутизация

У Ringostat нет механизма «спроси у внешней CRM имя по номеру и покажи его». Есть три близких механизма:

1. **Webhook forwarding number** [R6].
   При входящем звонке Ringostat шлёт HTTP-запрос с параметрами звонка (`caller`, utm-метки, `callid` и другие).
   CRM отвечает JSON-ом с одним из полей:
   - `{"dst_phone":"380441111111"}`;
   - `{"dst_callee":"sip_login1,380..."}` — несколько адресатов через запятую;
   - `{"schema": 26076}` — ID схемы переадресации.
   Так звонок клиента уходит его ответственному менеджеру.
   Настраивается в разделе «Virtual PBX → Webhook forwarding».
   Таймаут задаётся в настройке, но описан как «таймаут отправки звонка на возвращённое направление», а не как таймаут HTTP-запроса.
   Что происходит, если CRM не ответила, — не проверено.
2. **Отправка контактов из CRM в Ringostat Smart Phone** [R10].
   `POST https://api.ringostat.net/minicrm/contacts/sync`, поля:
   - `fullName`, `origin`;
   - `externalId` или `leadId`;
   - `responsible`;
   - `contactLink`, `leadLink`, `dealLink`;
   - `contactDirections[]` — телефоны и email.
   Тогда менеджер видит имя и ссылку на сделку прямо в софтфоне.
3. **Вебхук «Incoming call» в момент снятия трубки или до звонка** [R3][R14].
   CRM сама находит контакт по `caller` и открывает карточку у менеджера.
   Связь звонка с менеджером — через `manager_id` или `employee_fio`.

**Подводный камень: формат номера.**
В примерах встречаются `380441112233`, `+380441112233` (`full_num`) и `E164` [R3][R6].
CRM должна приводить номера к единому виду, E.164, до поиска.

### 2.5 Click-to-call (callback API) [R9]

- Простой метод: `POST https://api.ringostat.net/callback/outward_call`, `Content-Type: application/x-www-form-urlencoded`, заголовок `Auth-key`.
  Тело: `extension=<номер проекта>&destination=<номер или SIP-логин>`.
  `extension` должен быть номером, подключённым к проекту как «incoming».
- Расширенный метод: `POST https://api.ringostat.net/a/v2`, JSON-RPC 2.0, метод `Api\\V2\\Callback.external`. Параметры:
  - `caller`, `callee`, `callee_type`: `default` или `scheme`;
  - `direction`: `in` или `out`;
  - `manager_dst` — кому звонить первым;
  - `projectId`;
  - `utm*`, `clientId`, `clientIp`.
  Для click-to-call из карточки CRM: `callee` — SIP-логин менеджера, `caller` — номер клиента, `direction=out`.
- Ошибки: `400` — не хватает параметра или неверный номер; `401` или `403` — неверный или отсутствующий `Auth-key` [R9].
- Значение `manager_dst` описано по-разному для `direction=in` и `direction=out`: 0 и 1 меняются местами [R9].
  Поведение нужно проверить на тестовом звонке.

### 2.6 Выгрузка журнала звонков (сверка)

- `GET https://api.ringostat.net/calls/list?export_type=json&from=YYYY-MM-DD HH:MM:SS&to=...&fields=calldate,caller,dst,disposition,billsec,utm_source,utm_medium,recording`, заголовок `Auth-key` [R8].
- Есть интерактивный справочник на ringostat.readme.io [R8][R9].
- Лимиты частоты запросов не документированы — не проверено.

### 2.7 Что хранить в CRM (Ringostat)

Таблица `call`:

- `call_id` — ключ идемпотентности;
- направление, `caller` и `callee` в формате E.164;
- `date` и `calldate_timestamp_micros`;
- `status` или `disposition`, `waiting`, `dialog`, `call_duration`;
- `manager_id` или `staffid`, `employee_fio`;
- `contact_id` и `deal_id` — сопоставление делает CRM;
- utm-поля, `replace_type`;
- ссылки `record_link` и `call_card`;
- путь к собственной копии записи, если записи копируются.

Сырые вебхуки стоит сохранять в журнал.

---

## 3. НБУ: официальный курс

### 3.1 Адреса и формат

Аутентификации нет [N1]. Проверено запросом: в ответе есть заголовок `Access-Control-Allow-Origin: *`, ответ отдаётся через Cloudflare.

Варианты запроса [N1][N2]:

| Задача | Запрос |
|---|---|
| Курс по валюте на дату | `GET https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=EUR&date=YYYYMMDD&json` |
| Все валюты на дату | `…/exchange?date=YYYYMMDD&json` |
| Диапазон дат | `GET https://bank.gov.ua/NBU_Exchange/exchange_site?start=YYYYMMDD&end=YYYYMMDD&valcode=usd&sort=exchangedate&order=asc&json` |

- Регистр `valcode` не важен [N2].
- Без параметра `json` ответ приходит в XML [N1][N2].
- Ответ «по дате» — массив [N2]:
  ```json
  [{"r030":840,"txt":"Долар США","rate":45.5348,"cc":"USD","exchangedate":"03.11.2026","special":"N"}]
  ```
  Проверено запросом 2026-11-03.
- Ответ «диапазон» дополнительно содержит `calcdate` (дата расчёта), `units`, `rate_per_unit`, `enname`, `group` [N2b].
- Запрос за период больше 3 лет по нескольким валютам блокируется [N2b].
- Курс указан в гривнах за 1 единицу валюты, точность 4 знака после запятой [N3].
  У USD и EUR `units=1`. У части валют масштаб другой: например, KRW — 100 единиц [N2].
- Поле `special` появилось с 21.01.2026. Оно показывает условия расчёта курса USD: `Y` — особые условия, `N` — обычные; `null` — для остальных валют [N1][N2b].
- С 04.11.2026 в структуру файлов API добавляется справочное значение курса гривны к евро на 12:00 [N1].
  Это изменение вступает в силу на следующий день после даты исследования. Парсер должен игнорировать незнакомые поля.

### 3.2 Частота обновления, выходные и праздники

- Официальный курс начинает действовать на следующий рабочий день после дня установления [N3].
- Курс, установленный **на** последний рабочий день недели или предпраздничный день, действует и в следующие выходные и праздники [N3].
  Курс, установленный **в** этот день, начинает действовать в первый рабочий день после них [N3].
- Публикация — не позже 16:00 в день установления [N3].
- API про «текущий» курс: до 15:30 он отдаёт курс на текущий рабочий день, после 15:30 — на следующий рабочий день [N1].
- Проверено запросом 2026-11-03, USD:
  - 30.10 (пятница), 31.10 и 01.11 — rate 45.5293, `calcdate` 29.10;
  - 02.11 (понедельник) — 45.3526, `calcdate` 30.10;
  - 04.11 — 45.666, уже опубликован 03.11.
  - На 05.11 ответ — пустой массив `[]`. Курс на будущую дату ещё не установлен.
- НБУ может установить курс на уровне предыдущего рабочего дня, если рабочие дни перенесены [N3].
- Ссылка с сайта НБУ ведёт на редакцию Положения от 01.06.2020. Есть ли более поздние изменения, например про поле `special` в 2026 году, — не проверено.

### 3.3 Подводные камни

- Пустой массив `[]` вместо ошибки, если курса на дату ещё нет. Это нужно обрабатывать явно.
- «Текущий» курс зависит от времени суток: граница — 15:30 по Киеву. Без явной `date` можно получить курс на завтра.
  Дату счёта надо считать в часовом поясе Europe/Kyiv.
- Лимиты частоты запросов не документированы — не проверено.
  Курс на прошедшую дату не меняется, его можно кешировать навсегда — это вывод.
- Курс НБУ ≠ курс конвертации WayForPay [W10].
  Если цена курса в EUR, а клиент платит гривной, CRM должна выбрать правило пересчёта и записать использованный курс в счёт.

### 3.4 Что хранить в CRM (НБУ)

Таблица `fx_rate` с полями `date`, `currency` (EUR или USD), `rate`, `calcdate`, `special`, `fetched_at`, с уникальностью по паре (`date`, `currency`).
В каждом счёте хранить: исходную цену и валюту, курс, дату курса и итоговую сумму в UAH. Курс фиксируется в момент выставления счёта.

---

## Пробелы и что проверить руками

1. **WayForPay, валюта.** Что приходит в колбэке (`amount`, `currency`) при счёте с `alternativeCurrency=EUR`, и чему равна сумма списания. Нужен тестовый платёж.
2. **WayForPay, частичный возврат.** Возможен ли он и сколько раз. Статьи с явным ответом нет.
3. **WayForPay, лимиты.** Максимальный `orderTimeout` у CREATE_INVOICE и тестовые карты для `test_merch_n1`.
4. **WayForPay, регулярные платежи.** Как получить `merchantPassword` для `regularApi`.
5. **Ringostat, повторы вебхуков.** Источники противоречат: 3 повтора [R5] или ни одного [R1].
6. **Ringostat, forwarding number.** Таймаут HTTP-запроса и поведение, если CRM не ответила.
7. **Ringostat, записи.** Время жизни `token` в `recording_wav` и полный список полей вебхука — он лежит во внешнем файле.
8. **Лимиты частоты.** Не документированы ни у `calls/list` Ringostat, ни у НБУ.
9. **НБУ, Положение.** Актуальная редакция Положения № 148 после 2020 года.

---

## Источники

WayForPay (wiki.wayforpay.com, help.wayforpay.com):

- [W1] Purchase — https://wiki.wayforpay.com/ru/view/852102
- [W2] Create invoice — https://wiki.wayforpay.com/ru/view/608996852
- [W3] Refund — https://wiki.wayforpay.com/ru/view/852115
- [W4] Check Status — https://wiki.wayforpay.com/ru/view/852117
- [W6] Статус регулярного платежа — https://wiki.wayforpay.com/ru/view/852526
- [W7] Коды ответов и статусы транзакции — https://wiki.wayforpay.com/ru/view/852131
- [W8] Тестовые реквизиты — https://wiki.wayforpay.com/ru/view/852472
- [W9] Приём оплаты из-за рубежа — https://help.wayforpay.com/view/1737828
- [W10] Управление курсом обмена для конвертации — https://help.wayforpay.com/view/989571713
- [W11] Возмещение (выплаты) — https://help.wayforpay.com/view/3342386
- [W12] Remove invoice — https://wiki.wayforpay.com/ru/view/1737356
- [W13] Transaction list — https://wiki.wayforpay.com/ru/view/1736786
- [W14] Currency rates — https://wiki.wayforpay.com/ru/view/1737715
- [W15] Редактирование регулярного платежа — https://wiki.wayforpay.com/ru/view/13271051
- [W16] Регулярные платежи — https://wiki.wayforpay.com/ru/view/852496
- [W17] Оплата в один клик (токены) — https://wiki.wayforpay.com/ru/view/852175

Ringostat (help.ringostat.com, ringostat.readme.io):

- [R1] How to realise the integration using webhooks — https://help.ringostat.com/en/articles/6313229
- [R2] Webhooks: authorization settings — https://help.ringostat.com/en/articles/6338053
- [R3] Webhooks: incoming call event — https://help.ringostat.com/en/articles/6559993
- [R4] Webhooks: outbound call event — https://help.ringostat.com/en/articles/6583751
- [R5] Webhooks: actions with errors — https://help.ringostat.com/en/articles/6559968
- [R6] Webhook forwarding number — https://help.ringostat.com/en/articles/6475030
- [R7] Integration via Ringostat API — https://help.ringostat.com/en/articles/6306981
- [R8] Export of statistics from the Call log — https://help.ringostat.com/en/articles/6312678 ; https://ringostat.readme.io/reference/get_calls-list
- [R9] Request to connect 2 numbers (callback) — https://help.ringostat.com/en/articles/6312685 ; https://ringostat.readme.io/reference/post_callback-outward-call
- [R10] Sending information to Smart Phone and contact book — https://help.ringostat.com/en/articles/9221318
- [R11] Call card — https://help.ringostat.com/en/articles/6416694
- [R12] Webhooks: filters — https://help.ringostat.com/en/articles/6420755
- [R13] General settings — https://help.ringostat.com/en/articles/6149584
- [R14] Integration using data transfer in webhooks — https://help.ringostat.com/en/articles/6518985

НБУ (bank.gov.ua):

- [N1] API для разработчиков, раздел 1 «Офіційний курс гривні…» — https://bank.gov.ua/ua/open-data/api-dev
- [N2] Инструкция к сервису курсов — https://bank.gov.ua/admin_uploads/article/Instr_API_KURS_VAL.pdf
- [N2b] Инструкция к сервису «диапазон дат» — https://bank.gov.ua/admin_uploads/article/Instr_API_KURS_VAL_data.pdf
- [N3] Положение об установлении официального курса гривны (постановление № 148 от 10.12.2019, ред. 01.06.2020), п. 9, 10, 11, 13 раздела III — https://bank.gov.ua/admin_uploads/law/Regulation_10122019_148_01062020.pdf
