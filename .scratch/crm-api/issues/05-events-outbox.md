# События: запись в той же транзакции, что изменение, и каталог сделок и контактов

Type: task
Status: claimed 2026-11-25T21:50Z
Blocked by: 01
Source: .scratch/crm-build/issues/03-automation-api-contract.md (Answer: «События», «Доставка», волна 2); .scratch/crm-build/issues/04-webhook-delivery-research.md (Answer); docs/research/webhook-delivery.md на ветке origin/research/webhook-delivery, разделы 1.2, 4.1, 4.2; docs/adr/0003-crm-ne-menyaet-sdelki-sama.md; GLOSSARY.md («Событие», «Возможный дубль»); .scratch/crm-deals/issues/03-contacts-organizations.md, 04-jobs-bulk-trash.md, 05-deals.md, 09-deal-handover.md; .scratch/crm-api/spec.md

## Что сделать

Событие — сообщение внешней автоматизации о том, что произошло в CRM. Тикет делает так, чтобы событие появлялось тогда и только тогда, когда изменение зафиксировано в базе (шаблон transactional outbox — таблица исходящих событий в той же транзакции). Отправку на адреса делает тикет 06.

Миграция (следующий свободный номер миграции), таблица с `project_id` и RLS:

- `webhook_event` — id (`evt_` и UUID), проект, тип, время события, тип и id сущности, тело события (JSONB), автор (`user` или `api_key` и id), `created_at`. Только добавление; удаляет старые строки ночная задача тикета 06 (30 дней).

Функция записи — `apps/api/src/events/emit.ts`, одна для всех эпиков:

- Принимает транзакцию проекта, тип, сущность, факты изменения и автора; пишет строку `webhook_event` и ставит задачу pg-boss в очередь `webhook-fanout` с `{ eventId }` той же транзакцией (`boss.send(…, { db: fromKysely(trx) })`, pg-boss 12). Откат транзакции откатывает и событие, и задачу. Своего опрашивающего процесса нет.
- Обработчика очереди `webhook-fanout` здесь нет — его добавляет тикет 06; до него задачи лежат в очереди.
- Тело проверяется по схеме своего типа из `packages/shared/src/events/` (общий каталог для сервера, описания API и тестов) и не больше 20 КБ.

Формат тела (по Standard Webhooks, тонкое событие):

```json
{
  "type": "deal.stage_changed",
  "timestamp": "2026-11-04T10:15:00Z",
  "data": {
    "event_id": "evt_…",
    "project_id": "…",
    "deal_id": "…",
    "from": { "pipeline_id": "…", "stage_id": "…" },
    "to": { "pipeline_id": "…", "stage_id": "…" },
    "actor": { "type": "api_key", "id": "…" }
  }
}
```

В теле только id и неизменяемые факты изменения; ни имён, ни телефонов, ни email, ни значений пользовательских полей. Актуальное состояние автоматизация читает через API ключом со своими правами. Автор — только тип и id, без имени (решено без владельца — подтвердить). Тело меняется только добавлением полей; ломающее изменение — новый тип.

Каталог этого эпика — вызовы функции записи в функциях сделок и контактов эпика `crm-deals`, на всех путях: интерфейс, запрос по ключу, фоновая задача (массовый архив, передача сделок при отключении сотрудника — автор там инициатор операции):

| Тип | Когда | Факты в `data` |
|---|---|---|
| `deal.created` | создана сделка | `deal_id`, `pipeline_id`, `stage_id`, `contact_id` |
| `deal.stage_changed` | сменился этап, в том числе при переносе в другую воронку (решено без владельца — подтвердить: отдельного типа для переноса нет) | `deal_id`, `from`, `to` (воронка и этап) |
| `deal.won` | выиграна | `deal_id`, `stage_id` |
| `deal.lost` | проиграна | `deal_id`, `stage_id`, `lost_reason_id` |
| `deal.reopened` | открыта заново | `deal_id`, `stage_id` |
| `deal.owner_changed` | сменился ответственный, в том числе снят (общая очередь) или взят в работу | `deal_id`, `from_user_id`, `to_user_id` (null — без ответственного) |
| `deal.archived` | архивирована | `deal_id` |
| `deal.unarchived` | возвращена из архива (решено без владельца — подтвердить) | `deal_id` |
| `contact.created` | создан контакт | `contact_id` |
| `contact.possible_duplicate` | контакт получил пометку «возможный дубль» (модель есть в эпике `crm-deals`; её же ставит приём регистраций) | `contact_id` |

Изменение суммы, названия и пользовательских полей событий не создаёт: их нет в решении владельца.

События регистраций, платежей, звонков и задач (`registration.added`, `payment.succeeded`, `payment.refunded`, `call.completed`, `call.missed`, `task.created`, `task.completed`) добавляют эпики приёма, платежей, Unitalk и задач по этому образцу: схема типа в `packages/shared/src/events/`, вызов функции записи в той же транзакции, строка в этой таблице каталога. Так же поступает каждая новая сущность.

Проверка ADR 0003: функция записи только сообщает; ни одно событие внутри CRM ничего не меняет.

## Where in code

packages/db/migrations/**, packages/db/src/schema.ts, packages/shared/src/events/** (каталог типов и схемы тел), apps/api/src/events/**, apps/api/src/deals/**, apps/api/src/contacts/**, apps/api/src/jobs/** (передача сделок, массовые операции — автор события), apps/api/src/openapi/** (описание тел событий в разделе webhooks описания API).

## Done when

- [ ] Миграция применяется на чистую базу и откатывается.
  - evidence: test-run pass · `pnpm vitest run packages/db/src/project-isolation.test.ts` exit 0 (in pnpm verify) · windows - · e1351868d11810185c5c7227be6093c5ed9bbc2f
- [ ] Тест изоляции: события проекта A не видны в контексте B без фильтра в коде.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/events/events.test.ts` exit 0 (in pnpm verify) · windows - · e1351868d11810185c5c7227be6093c5ed9bbc2f
- [ ] Тест транзакции: изменение сделки, которое откатилось (например, 409 «одна открытая сделка» или 422 обязательных полей), не оставляет ни строки `webhook_event`, ни задачи `webhook-fanout`; зафиксированное — оставляет ровно по одной.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/events/events.test.ts` exit 0 (in pnpm verify) · windows - · e1351868d11810185c5c7227be6093c5ed9bbc2f
  - evidence: test-run pass · `pnpm vitest run apps/api/src/jobs/stop.test.ts` exit 0 (in pnpm verify), events written during shutdown · windows - · ba3e435e06d66a9313f93890e10dca8d41c8f435
- [ ] Тест каталога: каждое действие из таблицы создаёт ровно одно событие своего типа с фактами из таблицы; тело проходит схему типа; изменение суммы и названия событий не создаёт.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/events/events.test.ts` exit 0 (in pnpm verify) · windows - · e1351868d11810185c5c7227be6093c5ed9bbc2f
- [ ] Тест автора: действие менеджера — `actor.type = user`, запрос по ключу — `actor.type = api_key` с id ключа, массовый архив — инициатор операции.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/events/events.test.ts` exit 0 (in pnpm verify) · windows - · e1351868d11810185c5c7227be6093c5ed9bbc2f
- [ ] Тест персональных данных: тела событий тестового прогона не содержат имён, телефонов, email и значений пользовательских полей (поиск по строкам выдуманных данных).
  - evidence: test-run pass · `pnpm vitest run apps/api/src/events/events.test.ts` exit 0 (in pnpm verify) · windows - · e1351868d11810185c5c7227be6093c5ed9bbc2f
- [ ] Описание API содержит раздел событий (OpenAPI `webhooks`) со схемой каждого типа.
  - evidence: test-run pass · `pnpm vitest run apps/api/src/events/events.test.ts` exit 0, test of the webhooks section · windows - · e1351868d11810185c5c7227be6093c5ed9bbc2f
- [ ] `pnpm verify` зелёный.
  - evidence: test-run pass · `pnpm verify` exit 0 · windows - · e1351868d11810185c5c7227be6093c5ed9bbc2f
  - evidence: gate pass · `gate fast` exit 0 · windows - · e1351868d11810185c5c7227be6093c5ed9bbc2f
  - evidence: test-run pass · `pnpm verify` exit 0 · windows - · ba3e435e06d66a9313f93890e10dca8d41c8f435
  - evidence: gate pass · `gate fast` exit 0 · windows - · ba3e435e06d66a9313f93890e10dca8d41c8f435
