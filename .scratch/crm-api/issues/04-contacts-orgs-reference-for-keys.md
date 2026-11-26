# Контакты, организации, заметки и справочники для ключей API

Type: task
Status: claimed 2026-11-26T00:24Z
Blocked by: 01, 02
Source: .scratch/crm-build/issues/03-automation-api-contract.md (Answer: «Действия в MVP», волна 2); .scratch/crm-mvp/spec.md, раздел 4 («чужой клиент», охват контактов); .scratch/crm-deals/issues/02-pipelines-stages-lost-reasons.md, 03-contacts-organizations.md, 07-notes-files.md; .scratch/crm-foundation/issues/06-teams-and-users.md (команды); .scratch/crm-api/spec.md

## Что сделать

Как тикет 03, но для контактов, организаций, заметок и справочников: открыть ключу API действия из решения владельца, описать их в OpenAPI, доказать тестами те же правила, что для пользователя.

Контакты и организации — отметить «доступно ключу» и описать:

- `GET /api/v1/contacts/:id`, `POST /api/v1/contacts`, `PATCH /api/v1/contacts/:id` — имя, фамилия, язык общения, телефоны, email, организация, `custom` по кодам. Телефон приводится к E.164 общей функцией эпика `crm-deals` (номер без кода страны — Украина); неразбираемый — 422.
- Поиск: `GET /api/v1/contacts?phone=…` и `GET /api/v1/contacts?email=…` — точное совпадение по нормализованному телефону (в любом формате записи) или email без учёта регистра; ответ — список (обычно 0 или 1 запись) в формате курсора тикета 02. Контакт вне охвата ключа — ответ «чужой клиент» без данных контакта, как для менеджера.
- Создание контакта ключом идёт по правилам ручного создания эпика `crm-deals`: совпал телефон с видимым контактом — 409 со ссылкой на найденный; совпал только email — контакт создаётся с пометкой «возможный дубль».
- `GET`, `POST`, `PATCH` для `/api/v1/organizations` и `GET /api/v1/organizations?name=…` (поиск по названию, как в списке).
- Удаление и восстановление контактов и организаций ключу не открываются (решение владельца: удаления через API нет).

Заметки — `/api/v1/{deals|contacts|organizations}/:id/notes`: список и создание по ключу; изменить и удалить ключ может только заметку, автор которой он сам (решено без владельца — подтвердить). Автор заметки — ключ, в интерфейсе — его название с пометкой «ключ API». Файлы ключу не открываются.

Справочники только для чтения (новые маршруты там, где их ещё нет; право — «сделки: смотреть»):

- `GET /api/v1/pipelines` и этапы воронки, `GET /api/v1/lost-reasons` (группа → причина, с отметкой архива) — уже есть в тикете 02 эпика `crm-deals`; открыть ключу только чтение.
- `GET /api/v1/users` — участники проекта: id, имя, команда, активен ли. Email — только если у роли есть «пользователи и роли: смотреть» (решено без владельца — подтвердить: автоматизации нужен email, чтобы сопоставить менеджеров с внешними системами, но это персональные данные). Пароли, 2FA и роли не отдаются.
- `GET /api/v1/teams` — команды: id, название, тимлид, участники (id).

Пользовательские поля в ответах — с правами роли ключа на группы полей (скрытые группы не отдаются). Изменения пишутся в `change_log` и `audit_log` с автором-ключом (тикет 01). Тикет не отправляет событий: их пишет тикет 05.

Проверка: нужна линза безопасности (`security`): поиск по телефону и email не должен выдавать данные контакта вне охвата и чужого проекта.

Из тикета 05 (PR #30), учесть здесь: `apps/api/src/contacts/contacts.ts` (`contactContext`) берёт автора из `c.get('session').user.id` — при открытии контактов ключу нужен `requestAuthor(c.get('actor'))`, иначе событие `contact.created`/`contact.updated` не назовёт ключ автором (и запрос по ключу без сессии упадёт).

## Where in code

apps/api/src/contacts/**, apps/api/src/organizations/**, apps/api/src/notes/**, apps/api/src/pipelines/**, apps/api/src/members/**, apps/api/src/teams/** (маршруты чтения для ключа), apps/api/src/openapi/**, packages/shared/src/** (типы ответов справочников).

## Done when

- [ ] Тест изоляции: ключ проекта A не находит по телефону и email контакт проекта B с теми же данными; справочники отдают только воронки, причины, участников и команды своего проекта.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/contacts/api-key.test.ts` exit 0 · windows - · e50e585aae9f17706dff5317fc747f4a3f248918
- [ ] Тест прав: без «контакты: создавать / изменять» — 403; без «сделки: смотреть» — 403 на справочники; email участников без «пользователи и роли: смотреть» в ответе отсутствует.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/contacts/api-key.test.ts` exit 0 · windows - · e50e585aae9f17706dff5317fc747f4a3f248918
- [ ] Тест поиска: `067 123 45 67`, `+380671234567` и `(067) 123-45-67` находят один и тот же выдуманный контакт; email в другом регистре — тоже; контакт вне охвата — ответ «чужой клиент» без имени, телефона и email.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/contacts/api-key.test.ts` exit 0 · windows - · e50e585aae9f17706dff5317fc747f4a3f248918
- [ ] Тест создания ключом: совпадение по телефону — 409 со ссылкой; только по email — контакт с пометкой «возможный дубль».
  - evidence: test-run pass · `pnpm vitest run apps/api/src/contacts/api-key.test.ts` exit 0 · windows - · e50e585aae9f17706dff5317fc747f4a3f248918
- [ ] Тест заметок: ключ создаёт заметку, автор — ключ; изменить или удалить чужую заметку — 403; свою — проходит.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/contacts/api-key.test.ts` exit 0 · windows - · e50e585aae9f17706dff5317fc747f4a3f248918
- [ ] Тест: удаление контакта и организации по ключу — 403 `API_KEY_NOT_ALLOWED`.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/contacts/api-key.test.ts` exit 0 · windows - · e50e585aae9f17706dff5317fc747f4a3f248918
- [ ] Описание OpenAPI содержит все маршруты тикета с выдуманными примерами.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/contacts/api-key.test.ts` exit 0 · windows - · e50e585aae9f17706dff5317fc747f4a3f248918
- [ ] `pnpm verify` зелёный.
  - evidence: test-run pass · `pnpm verify` exit 0 · windows - · e50e585aae9f17706dff5317fc747f4a3f248918
  - evidence: gate pass · `gate fast` exit 0 · windows - · e50e585aae9f17706dff5317fc747f4a3f248918

## Результат

Ветка `crm-api/04`. Маршруты, открытые ключу, объявлены через `keyRoute`: контакты и организации — `apps/api/src/contacts/openapi.ts`, заметки — `apps/api/src/notes/openapi.ts`, воронки и причины проигрыша — `apps/api/src/pipelines/openapi.ts`, участники и команды — `apps/api/src/members/directory.ts`. Те же маршруты обслуживают и сессию apps/web. Тесты — `apps/api/src/contacts/api-key.test.ts`. Миграция `0023_note_api_key_author` (номер 0022 занят веткой тикета 06; пропуск мигратор принимает).

Открыто ключу: `GET /contacts?phone=&email=`, `GET /contacts/:id`, `POST /contacts`, `PATCH /contacts/:id`; `GET /organizations?name=`, `GET /organizations/:id`, `POST /organizations`, `PATCH /organizations/:id`; `GET|POST /{deals|contacts|organizations}/:id/notes`, `PATCH|DELETE …/notes/:noteId`; `GET /pipelines`, `GET /pipelines/:id/stages`, `GET /lost-reasons`, `GET /users`, `GET /teams`. Удаление, восстановление и `PUT` контактов, организаций и заметок, файлы, списки `/list` — 403 `API_KEY_NOT_ALLOWED`.

Решено без владельца — подтвердить:

- Поиск контакта: ответ `{ data, next_cursor: null, outOfScope }`; совпадение вне охвата ключа в `data` не попадает, вместо него `outOfScope: { managerName }` — без id, имени, телефонов и email (как 409 `CONTACT_OUT_OF_SCOPE`). Совпадения отдаются одной страницей (до 200), без курсора.
- `GET /contacts` без `phone` и `email` и `GET /organizations` без `name` — прежняя выдача apps/web (массив), ключу — 400. Сессия с `phone`/`email` теперь получает тот же ответ-страницу, что ключ.
- Автор-ключ в ленте и в заметке — название ключа с пометкой «(ключ API)»; в ответах — `authorApiKeyId` / `actorApiKeyId`. Записи журнала изменений от ключа в ленте тоже называют ключ.
- `/v1/users` и `/v1/teams` — новые маршруты рядом с прежними `/members` и `/teams` (они остаются только для сессии); право — «сделки: смотреть». Справочники (воронки, причины, участники, команды) отдаются целиком массивом, без курсора.
- Охват контактов «свои» и «команда» у ключа — контакты, созданные этим ключом (`contact.created_by_api_key_id`). Так ключ с таким охватом видит созданный им контакт и создаёт сделку с новым контактом (долг max-review тикета 03 закрыт, тест через `POST /api/v1/deals`). Контакты, созданные другим ключом или системой, ему не видны.
- Заметку ключа меняет только сам ключ; удалить её может и пользователь с правом «удалять». Ключ не удаляет чужие заметки даже с правом «удалять».
- Список заметок `GET …/notes` переведён на курсорную выдачу `{ data, next_cursor }` (apps/web его не читает).
- `audit_log` по изменениям ключа не пишется: как у сделок тикета 03, автор-ключ — в `change_log`; в журнал опасных действий попадает только окончательное удаление, а оно ключу закрыто.
