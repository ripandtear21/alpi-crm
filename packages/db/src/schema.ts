import type { ColumnType, Generated } from 'kysely'

// Типы таблиц описаны вручную по migrations/0001_project_isolation.ts, 0002_auth.ts, 0004_roles.ts, 0005_audit.ts,
// 0006_teams.ts, 0007_jobs_bulk.ts, 0008_pipelines.ts, 0009_contacts.ts, 0010_deals.ts, 0011_products.ts и 0016_fields.ts; меняются
// вместе с миграциями. shortcut: без kysely-codegen расхождение с базой ловят только тесты на настоящей
// базе, перейти на codegen, когда таблиц станет больше нескольких.

/** Метка времени: читается как Date, при вставке необязательна (default now()). */
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>

/**
 * Проект — отдельный бизнес. Глобальная таблица, без row-level security: приложение её только
 * читает, создаёт и меняет проекты служебная роль (`createProject`).
 */
export interface ProjectTable {
  id: Generated<string>
  code: string
  name: string
  default_locale: Generated<string>
  timezone: Generated<string>
  created_at: Timestamp
  updated_at: Timestamp
}

/** Доступ пользователя к проекту. Видна только в контексте своего проекта. */
export interface ProjectMemberTable {
  id: Generated<string>
  project_id: string
  /** id учётной записи (`user.id`). */
  user_id: string
  /** Роль проекта (`role.id` того же проекта); у участника ровно одна роль. */
  role_id: string
  /** Команда (`team.id` того же проекта); у участника не больше одной команды. */
  team_id: string | null
  /** «Принимает новые сделки»: по умолчанию да. */
  accepts_new_deals: Generated<boolean>
  /** Участие отключено: пользователь не входит в проект. null — действует. */
  disabled_at: Date | string | null
  disabled_by: string | null
  created_at: Timestamp
  updated_at: Timestamp
  created_by: string | null
}

/**
 * Команда проекта. Видна только в контексте своего проекта. Тимлид один (`lead_user_id`) и сам
 * состоит в команде — защищает база (migrations/0006_teams.ts).
 */
export interface TeamTable {
  id: Generated<string>
  project_id: string
  name: string
  /** id учётной записи тимлида: участник проекта с `team_id` этой команды. */
  lead_user_id: string
  created_at: Timestamp
  updated_at: Timestamp
  created_by: string | null
}

/**
 * Роль проекта. Видна только в контексте своего проекта. Роль «администратор» (`is_admin`)
 * не удаляется и не меняется — защищает база (migrations/0004_roles.ts).
 */
export interface RoleTable {
  id: Generated<string>
  project_id: string
  name: string
  /** Шаблон-источник: 'admin' | 'head' | 'teamlead' | 'manager'; null — своя роль. */
  template_key: string | null
  is_admin: Generated<boolean>
  /**
   * Права роли (RolePermissions из @alpi/shared). Читается объектом, пишется строкой JSON:
   * форму проверяет parseRolePermissions до записи.
   */
  permissions: ColumnType<unknown, string, string>
  created_at: Timestamp
  updated_at: Timestamp
  created_by: string | null
}

/**
 * Воронка проекта (migrations/0008_pipelines.ts). `code` уникален в проекте, «воронка
 * допродаж» (`is_upsell`) — не больше одной в проекте.
 */
export interface PipelineTable {
  id: Generated<string>
  project_id: string
  code: string
  name: string
  position: Generated<number>
  is_upsell: Generated<boolean>
  archived_at: Date | string | null
  created_at: Timestamp
  updated_at: Timestamp
  created_by: string | null
}

/** Этап воронки. Удаляется отметкой `deleted_at`: закрытые сделки на нём остаются. */
export interface StageTable {
  id: Generated<string>
  project_id: string
  pipeline_id: string
  name: string
  position: Generated<number>
  deleted_at: Date | string | null
  created_at: Timestamp
  updated_at: Timestamp
  created_by: string | null
}

/** Группа причин проигрыша; название уникально в проекте. */
export interface LostReasonGroupTable {
  id: Generated<string>
  project_id: string
  name: string
  position: Generated<number>
  archived_at: Date | string | null
  created_at: Timestamp
  updated_at: Timestamp
  created_by: string | null
}

/** Причина проигрыша; название уникально в группе. */
export interface LostReasonTable {
  id: Generated<string>
  project_id: string
  group_id: string
  name: string
  position: Generated<number>
  archived_at: Date | string | null
  created_at: Timestamp
  updated_at: Timestamp
  created_by: string | null
}

/** Внешняя ссылка: запись CRM ↔ запись во внешней системе (pipedrive, bitrix). */
export interface ExternalLinkTable {
  id: Generated<string>
  project_id: string
  entity_type: string
  entity_id: string
  source: string
  external_id: string
  created_at: Timestamp
  updated_at: Timestamp
  created_by: string | null
}

// Таблицы Better Auth: глобальные, без row-level security. Пишет в них Better Auth
// (apps/api/src/auth/auth.ts); id строк генерирует он же.

/** Учётная запись пользователя, одна на всю систему. */
export interface UserTable {
  id: string
  name: string
  email: string
  email_verified: Generated<boolean>
  image: string | null
  created_at: Timestamp
  updated_at: Timestamp
  two_factor_enabled: Generated<boolean>
  /** Роль плагина admin (вне проектов): 'admin' — владелец системы. */
  role: string | null
  banned: Generated<boolean>
  ban_reason: string | null
  ban_expires: Date | null
  /** Временный пароль: до его смены API пускает только к смене пароля и выходу. */
  must_change_password: Generated<boolean>
}

export interface SessionTable {
  id: string
  expires_at: Date
  token: string
  created_at: Timestamp
  updated_at: Timestamp
  ip_address: string | null
  user_agent: string | null
  user_id: string
  impersonated_by: string | null
  /** Сессия прошла второй фактор: только у таких доступ к API при включённой 2FA. */
  two_factor_verified: Generated<boolean>
}

export interface AccountTable {
  id: string
  account_id: string
  provider_id: string
  user_id: string
  access_token: string | null
  refresh_token: string | null
  id_token: string | null
  access_token_expires_at: Date | null
  refresh_token_expires_at: Date | null
  scope: string | null
  /** Хэш пароля. */
  password: string | null
  created_at: Timestamp
  updated_at: Timestamp
}

export interface VerificationTable {
  id: string
  identifier: string
  value: string
  expires_at: Date
  created_at: Timestamp
  updated_at: Timestamp
}

export interface TwoFactorTable {
  id: string
  /** Зашифрованный секрет TOTP. */
  secret: string
  /** Зашифрованные резервные коды. */
  backup_codes: string
  user_id: string
  verified: Generated<boolean | null>
  failed_verification_count: Generated<number | null>
  locked_until: Date | null
}

export interface RateLimitTable {
  id: string
  key: string
  count: number
  /** Миллисекунды Unix; bigint `pg` читает строкой. */
  last_request: ColumnType<string, number | string, number | string>
}

/**
 * Запись журнала (migrations/0005_audit.ts). Только добавление: роль приложения не может ни
 * изменить, ни удалить строку.
 */
interface AuditColumns {
  id: Generated<string>
  occurred_at: Timestamp
  /** Кто действовал (`user.id`); null — неизвестный пользователь или система. */
  actor_id: string | null
  /** Адрес клиента (inet; `pg` читает строкой). */
  ip: string | null
  /** Код действия из `@alpi/shared` (AuditAction). */
  action: string
  entity_type: string | null
  entity_id: string | null
  /** Подробности. Читается объектом, пишется строкой JSON. */
  details: ColumnType<Record<string, unknown>, string | undefined, never>
}

/** Журнал проекта: виден только в контексте своего проекта. */
export interface AuditLogTable extends AuditColumns {
  project_id: string
  /**
   * Ключ API, по запросу которого действовали (migrations/0019_api_keys.ts); не вместе с
   * `actor_id`.
   */
  actor_api_key_id: ColumnType<string | null, string | null | undefined, never>
}

/**
 * Журнал событий вне проекта (входы, 2FA). Роль приложения только добавляет строки; читает их
 * владелец системы через функцию `system_audit_events`.
 */
export interface SystemAuditLogTable extends AuditColumns {
  /** Email, который вводили при неудачном входе; у остальных событий null. */
  attempted_email: string | null
}

/** Состояние массовой операции: в очереди, идёт, закончена, остановлена целиком. */
export type BulkJobStatus = 'queued' | 'running' | 'done' | 'failed'

/**
 * Массовая операция (migrations/0007_jobs_bulk.ts). Видна только в контексте своего проекта;
 * роль приложения строки не удаляет.
 */
export interface BulkJobTable {
  id: Generated<string>
  project_id: string
  /** Кто запустил (`user.id`). */
  initiator_id: string
  /** Код действия из реестра массовых действий. */
  action: string
  /** `{ ids: [...] }` или `{ filter: {...} }`. Читается объектом, пишется строкой JSON. */
  selection: ColumnType<Record<string, unknown>, string, never>
  params: ColumnType<Record<string, unknown>, string | undefined, never>
  /** Записи в порядке обработки; null — выбор ещё не развёрнут. */
  record_ids: string[] | null
  status: ColumnType<BulkJobStatus, BulkJobStatus | undefined, BulkJobStatus>
  total: number | null
  /** Обработано записей, с ошибкой — тоже. */
  processed: Generated<number>
  /** Записей с ошибкой. */
  failed: Generated<number>
  /** Почему операция остановилась целиком (`status = 'failed'`). */
  failure: string | null
  created_at: Timestamp
  started_at: Date | string | null
  finished_at: Date | string | null
}

/** Ошибка массовой операции по одной записи: запись не изменена. */
export interface BulkJobErrorTable {
  project_id: string
  bulk_job_id: string
  /** Место записи в `bulk_job.record_ids`. */
  position: number
  record_id: string
  code: string
  message: string | null
}

/**
 * Организация (migrations/0009_contacts.ts). Видна только в контексте своего проекта.
 * `deleted_at` — в корзине.
 */
export interface OrganizationTable {
  id: Generated<string>
  project_id: string
  name: string
  address: string | null
  website: string | null
  created_at: Timestamp
  updated_at: Timestamp
  created_by: string | null
  deleted_at: Date | string | null
  /** Значения пользовательских полей по коду (migrations/0016_fields.ts): объект JSON. */
  custom: ColumnType<Record<string, unknown>, string | undefined, string>
  deleted_by: string | null
}

/**
 * Контакт — человек в проекте. Организация не больше одной; ответственного нет, охват
 * считается от `created_by`. `deleted_at` — в корзине.
 */
export interface ContactTable {
  id: Generated<string>
  project_id: string
  first_name: string
  last_name: string | null
  /** Язык общения: 'uk' | 'ru'; null — не указан. */
  language: string | null
  organization_id: string | null
  possible_duplicate: Generated<boolean>
  created_at: Timestamp
  updated_at: Timestamp
  created_by: string | null
  deleted_at: Date | string | null
  /** Значения пользовательских полей по коду (migrations/0016_fields.ts): объект JSON. */
  custom: ColumnType<Record<string, unknown>, string | undefined, string>
  deleted_by: string | null
  /** Ключ API, создавший контакт (migrations/0023); не вместе с `created_by`. */
  created_by_api_key_id: string | null
  /**
   * Контакт слит с этим (migrations/0027_contact_merge.ts) и скрыт: нет в списках, поиске и корзине;
   * запрос по id — 404 CONTACT_MERGED. Вместе с `merged_at`.
   */
  merged_into_id: ColumnType<string | null, never, string | null>
  merged_at: ColumnType<Date | string | null, never, Date | string | null>
  /** С каким контактом связана отметка «возможный дубль»; null — не связана или его нет. */
  possible_duplicate_of: ColumnType<string | null, string | null | undefined, string | null>
}

/** Телефон контакта в E.164; не больше одного основного у контакта. */
export interface ContactPhoneTable {
  id: Generated<string>
  project_id: string
  contact_id: string
  phone: string
  is_primary: Generated<boolean>
  created_at: Timestamp
}

/** Email контакта в нижнем регистре; не больше одного основного у контакта. */
export interface ContactEmailTable {
  id: Generated<string>
  project_id: string
  contact_id: string
  email: string
  is_primary: Generated<boolean>
  created_at: Timestamp
}

/**
 * Журнал изменений «было → стало». Только добавление: роль приложения не может ни изменить, ни
 * удалить строку (историю стирает только `purge_from_trash` вместе с самой записью из корзины).
 */
export interface ChangeLogTable {
  id: Generated<string>
  project_id: string
  occurred_at: Timestamp
  actor_id: string | null
  /** Автор — ключ API (migrations/0019_api_keys.ts); не вместе с `actor_id`. */
  actor_api_key_id: ColumnType<string | null, string | null | undefined, never>
  /**
   * Автор — источник регистраций (migrations/0025_intake_sources.ts); не вместе с `actor_id` и
   * `actor_api_key_id`.
   */
  actor_intake_source_id: ColumnType<string | null, string | null | undefined, never>
  entity_type: string
  entity_id: string
  field: string
  /** Было и стало: значения JSON. Читаются значением, пишутся строкой JSON. */
  before: ColumnType<unknown, string | null, never>
  after: ColumnType<unknown, string | null, never>
}

/**
 * Сделка (migrations/0010_deals.ts). Видна только в контексте своего проекта. `owner_id`
 * null — сделка в общей очереди; `archived_at` — отметка архива (не статус); `deleted_at` — в
 * корзине. Не больше одной открытой неархивной сделки у основного контакта в воронке.
 */
export interface DealTable {
  id: Generated<string>
  project_id: string
  title: string
  pipeline_id: string
  stage_id: string
  /** 'open' | 'won' | 'lost'. */
  status: Generated<string>
  lost_reason_id: string | null
  /** numeric(14, 2): читается строкой, пишется числом или строкой. */
  amount: ColumnType<string, number | string | undefined, number | string>
  /** 'EUR' | 'UAH' | 'USD'. */
  currency: Generated<string>
  owner_id: string | null
  primary_contact_id: string
  organization_id: string | null
  won_at: Date | string | null
  lost_at: Date | string | null
  stage_changed_at: Timestamp
  /** date: читать как текст (to_char), иначе драйвер сдвинет её часовым поясом. */
  expected_close_date: string | null
  archived_at: Date | string | null
  created_at: Timestamp
  updated_at: Timestamp
  created_by: string | null
  deleted_at: Date | string | null
  /** Значения пользовательских полей по коду (migrations/0016_fields.ts): объект JSON. */
  custom: ColumnType<Record<string, unknown>, string | undefined, string>
  deleted_by: string | null
  /**
   * Сделка слита с этой (migrations/0026_merge.ts) и скрыта: нет в канбане, списке, поиске и
   * корзине; запрос по id — 404 DEAL_MERGED. Вместе с `merged_at`.
   */
  merged_into_id: ColumnType<string | null, never, string | null>
  merged_at: ColumnType<Date | string | null, never, Date | string | null>
}

/** Участник сделки с ролью; основной контакт сделки здесь не дублируется. */
export interface DealParticipantTable {
  id: Generated<string>
  project_id: string
  deal_id: string
  contact_id: string
  role: string | null
  created_at: Timestamp
  created_by: string | null
}

/**
 * Товар каталога (migrations/0011_products.ts). Виден только в контексте своего проекта. Цены
 * numeric(14, 2) — читаются строкой, null — цены в этой валюте нет. Не удаляется: archived_at.
 */
export interface ProductTable {
  id: Generated<string>
  project_id: string
  name: string
  price_eur: ColumnType<string | null, number | string | null | undefined, number | string | null>
  price_uah: ColumnType<string | null, number | string | null | undefined, number | string | null>
  price_usd: ColumnType<string | null, number | string | null | undefined, number | string | null>
  archived_at: Date | string | null
  created_at: Timestamp
  updated_at: Timestamp
  created_by: string | null
}

/** Строка товара в сделке: количество больше нуля, цена за единицу в валюте сделки. */
export interface DealProductTable {
  id: Generated<string>
  project_id: string
  deal_id: string
  product_id: string
  quantity: number
  /** numeric(14, 2): читается строкой, пишется числом или строкой. */
  unit_price: ColumnType<string, number | string, number | string>
  created_at: Timestamp
  updated_at: Timestamp
  created_by: string | null
}

/** Заметка к сделке, контакту или организации (migrations/0012_notes_files.ts): ровно одна ссылка. */
export interface NoteTable {
  id: Generated<string>
  project_id: string
  deal_id: string | null
  contact_id: string | null
  organization_id: string | null
  text: string
  /** Автор — пользователь или ключ API (migrations/0023): ровно одно из двух. */
  author_id: string | null
  author_api_key_id: string | null
  created_at: Timestamp
  updated_at: Timestamp
}

/**
 * Файл к сделке, контакту или организации: строка о файле, содержимое — объект в хранилище
 * (apps/api/src/storage) по ключу `storage_key`. Содержимое не меняется.
 */
export interface FileTable {
  /** Задаёт API: id входит в ключ объекта, который пишется до строки. */
  id: string
  project_id: string
  deal_id: string | null
  contact_id: string | null
  organization_id: string | null
  name: string
  content_type: string
  /** bigint: читается строкой. */
  size: ColumnType<string, number, never>
  storage_key: string
  author_id: string
  created_at: Timestamp
}

/**
 * Сохранённый фильтр списка (migrations/0014_saved_filters.ts): дерево условий формата
 * packages/shared/src/filters. Видимость team — у фильтра есть team_id.
 */
export interface SavedFilterTable {
  id: Generated<string>
  project_id: string
  entity: 'deals' | 'contacts' | 'organizations'
  name: string
  visibility: 'personal' | 'team' | 'project'
  team_id: string | null
  owner_id: string
  /** Читается объектом, пишется строкой JSON. */
  filter: ColumnType<Record<string, unknown>, string, string>
  created_at: Timestamp
  updated_at: Timestamp
}

/** Сущность с пользовательскими полями. */
type FieldEntityColumn = ColumnType<
  'deal' | 'contact' | 'organization',
  'deal' | 'contact' | 'organization',
  never
>

/** Группа пользовательских полей одной сущности (migrations/0016_fields.ts). */
export interface FieldGroupTable {
  id: Generated<string>
  project_id: string
  entity: FieldEntityColumn
  name_uk: string
  name_ru: string | null
  position: Generated<number>
  created_at: Timestamp
  updated_at: Timestamp
  created_by: string | null
}

/**
 * Описание пользовательского поля: код уникален в проекте и сущности; правила кода, типа и
 * окончательного удаления держит база (триггер field_definition_guard).
 */
export interface FieldDefinitionTable {
  id: Generated<string>
  project_id: string
  entity: FieldEntityColumn
  group_id: string
  code: string
  name_uk: string
  name_ru: string | null
  /** Один из FIELD_TYPES (packages/shared/src/fields). */
  type: string
  position: Generated<number>
  /** 'all' — во всех воронках; 'selected' — в воронках из field_pipeline. */
  pipeline_visibility: Generated<'all' | 'selected'>
  /** 'none' | 'always' | 'stages' (правила — field_required_stage). */
  required: Generated<'none' | 'always' | 'stages'>
  is_important: Generated<boolean>
  is_frequently_filtered: Generated<boolean>
  first_value_at: Date | string | null
  archived_at: Date | string | null
  purge_requested_at: Date | string | null
  /**
   * Идёт смена типа поля с данными (migrations/0017_field_values.ts): фоновая задача
   * переписывает значения в этот тип; null — смены нет.
   */
  converting_to: string | null
  /**
   * Ускорение «часто фильтруют» (migrations/0018_field_filters.ts): building — копия значений
   * в custom_value строится, ready — готова, failed — задача упала (текст в index_error); null —
   * не нужна. Ставит и снимает триггер field_definition_index; ready и failed — фоновая задача.
   */
  index_state: Generated<'building' | 'ready' | 'failed' | null>
  index_error: Generated<string | null>
  /** Копия, для которой работает задача: новая при каждой постановке building. */
  index_token: Generated<string | null>
  created_at: Timestamp
  updated_at: Timestamp
  created_by: string | null
}

/**
 * Копия значений полей с ускорением «часто фильтруют» (migrations/0018_field_filters.ts):
 * строка на значение, держит триггер custom_value_sync.
 */
export interface CustomValueTable {
  project_id: string
  field_id: string
  record_id: string
  /** 0 — значение; 1 — начало интервала дат; 2 — конец. */
  part: Generated<number>
  value_text: string | null
  value_number: number | null
}

/** Поле сделки на карточке канбана воронки: позиция 1…3. */
export interface PipelineCardFieldTable {
  project_id: string
  pipeline_id: string
  field_id: string
  position: number
}

/** Воронка, в которой видно поле сделки с видимостью 'selected'. */
export interface FieldPipelineTable {
  project_id: string
  field_id: string
  pipeline_id: string
  visibility: Generated<'selected'>
}

/** Правило «обязательно с этапа»: `stage_id` null — только при выигрыше. */
export interface FieldRequiredStageTable {
  project_id: string
  field_id: string
  pipeline_id: string
  stage_id: string | null
  required: Generated<'stages'>
}

/** Вариант списка: id стабилен, удаления нет — только архив. */
export interface FieldOptionTable {
  id: Generated<string>
  project_id: string
  field_id: string
  name_uk: string
  name_ru: string | null
  position: Generated<number>
  archived_at: Date | string | null
  created_at: Timestamp
  updated_at: Timestamp
  created_by: string | null
}

/** Таблицы базы для типов Kysely. */
/**
 * Ключ API проекта (migrations/0019_api_keys.ts). Виден только в контексте своего проекта.
 * Отпечаток секрета роль приложения пишет, но не читает: ключ по секрету находит функция
 * `api_key_by_secret_hash`. Строка не удаляется; отозванный ключ не меняется.
 */
export interface ApiKeyTable {
  id: Generated<string>
  project_id: string
  name: string
  /** null — роль отозванного или истёкшего ключа удалена. */
  role_id: string | null
  /** SHA-256 секрета, hex. Читать его роль приложения не может. */
  secret_hash: ColumnType<never, string, string>
  /** Первые 8 символов секрета — для показа в списке. */
  secret_prefix: string
  created_by: string
  created_at: Timestamp
  expires_at: Date | null
  revoked_at: Date | null
  revoked_by: string | null
  last_used_at: Date | null
}

/**
 * Ответ для повтора по `Idempotency-Key` (migrations/0020_idempotency.ts). Виден только в
 * контексте своего проекта. Пока запрос выполняется — без ответа; ответы 5xx не хранятся.
 */
export interface IdempotencyRecordTable {
  id: Generated<string>
  project_id: string
  author_type: 'user' | 'api_key'
  author_id: string
  key: string
  /** SHA-256 метода, пути и тела запроса, hex. */
  fingerprint: string
  response_status: number | null
  response_content_type: string | null
  response_body: string | null
  created_at: Timestamp
}

/**
 * Исходящее событие (migrations/0021_webhook_events.ts): пишется той же транзакцией, что
 * изменение, только добавлением. Виден только в контексте своего проекта.
 */
export interface WebhookEventTable {
  /** `evt_` и UUID. */
  id: ColumnType<string, string, never>
  project_id: ColumnType<string, string, never>
  type: ColumnType<string, string, never>
  occurred_at: ColumnType<Date, Date | string, never>
  entity_type: ColumnType<string, string, never>
  entity_id: ColumnType<string, string, never>
  /** Тело события целиком: тип, время, data (packages/shared/src/events). */
  body: ColumnType<Record<string, unknown>, string, never>
  actor_type: ColumnType<
    'user' | 'api_key' | 'intake_source',
    'user' | 'api_key' | 'intake_source',
    never
  >
  actor_id: ColumnType<string, string, never>
  created_at: ColumnType<Date, Date | string | undefined, never>
}

/** Состояние адреса автоматизации (migrations/0024_webhook_delivery.ts). */
export type WebhookEndpointState = 'active' | 'disabled'

/** Почему адрес отключён: ответ 410, 5 суток без успеха или вручную. */
export type WebhookDisabledReason = 'gone_410' | 'failing_5_days' | 'manual'

/** Состояние доставки события на адрес. */
export type WebhookDeliveryState = 'pending' | 'succeeded' | 'failed' | 'cancelled'

/** Ошибка попытки без ответа: таймаут, TLS, DNS, адрес запрещён (SSRF), прочая ошибка сети. */
export type WebhookAttemptError = 'timeout' | 'tls' | 'dns' | 'forbidden_address' | 'network'

/**
 * Адрес автоматизации (migrations/0024_webhook_delivery.ts). Секрет подписи — только
 * зашифрованным (apps/api/src/events/secret.ts); виден только в контексте своего проекта.
 */
export interface WebhookEndpointTable {
  id: ColumnType<string, string | undefined, never>
  project_id: ColumnType<string, string, never>
  url: string
  description: string | null
  event_types: string[]
  /** `v1.` и base64 от iv, тега и шифротекста AES-256-GCM. */
  secret_encrypted: string
  previous_secret_encrypted: string | null
  /** До какого времени события подписываются и предыдущим секретом. */
  previous_secret_expires_at: Date | null
  state: Generated<WebhookEndpointState>
  disabled_reason: WebhookDisabledReason | null
  disabled_at: Date | null
  /**
   * Первая неудачная попытка серии. Серия начинается заново после успеха, включения адреса и
   * перерыва без неудач дольше суток (WEBHOOK_FAILING_GAP_HOURS). Отсюда считаются 5 суток без
   * успеха.
   */
  failing_since: Date | null
  /** Последняя неудачная попытка; успех и включение сбрасывают в null, как и failing_since. */
  last_failure_at: Date | null
  last_success_at: Date | null
  created_by: ColumnType<string, string, never>
  created_at: ColumnType<Date, never, never>
  updated_at: Generated<Date>
}

/** Доставка события на адрес: одна строка на пару «событие × адрес». */
export interface WebhookDeliveryTable {
  id: Generated<string>
  project_id: ColumnType<string, string, never>
  event_id: ColumnType<string, string, never>
  endpoint_id: ColumnType<string, string, never>
  state: Generated<WebhookDeliveryState>
  attempts: Generated<number>
  /** Самое раннее время следующей попытки; null — попыток больше не будет. */
  next_attempt_at: Date | null
  succeeded_at: Date | null
  created_at: ColumnType<Date, never, never>
  updated_at: Generated<Date>
}

/** Одна попытка доставки. Только добавление. */
export interface WebhookDeliveryAttemptTable {
  id: ColumnType<string, never, never>
  project_id: ColumnType<string, string, never>
  delivery_id: ColumnType<string, string, never>
  attempted_at: ColumnType<Date, Date | string | undefined, never>
  status_code: ColumnType<number | null, number | null, never>
  error: ColumnType<WebhookAttemptError | null, WebhookAttemptError | null, never>
  duration_ms: ColumnType<number, number, never>
  /** Первые 1 КБ тела ответа (UTF-8). */
  response_body: ColumnType<string | null, string | null, never>
}

/**
 * Источник регистраций (migrations/0025_intake_sources.ts). Виден только в контексте своего
 * проекта. Отпечаток ключа роль приложения пишет, но не читает: источник по ключу находит
 * функция `intake_source_by_key_hash`. Название и воронка не меняются; строка не удаляется.
 */
export interface IntakeSourceTable {
  id: Generated<string>
  project_id: ColumnType<string, string, never>
  name: ColumnType<string, string, never>
  pipeline_id: ColumnType<string, string, never>
  /** SHA-256 ключа, hex. Читать его роль приложения не может. */
  key_hash: ColumnType<never, string, string>
  /** Первые 12 символов ключа — для показа в списке. */
  key_prefix: string
  created_by: ColumnType<string, string, never>
  created_at: ColumnType<Date, Date | string | undefined, never>
  disabled_at: Date | null
  disabled_by: string | null
  last_used_at: Date | null
}

/**
 * Слияние двух записей (migrations/0026_merge.ts): контактов (тикет crm-intake/01), сделок
 * (тикет crm-intake/02). Строка не удаляется; меняются только отметки отката.
 */
export interface MergeRecordTable {
  id: Generated<string>
  project_id: string
  /** 'contact' | 'deal'. */
  entity_type: string
  survivor_id: string
  merged_id: string
  /** Слияние, в том же действии которого объединены и эти записи (сделки — тикет 04). */
  parent_id: string | null
  merged_by: string
  merged_at: Timestamp
  undo_until: Date | string
  undone_by: string | null
  undone_at: Date | string | null
}

/** Что перешло при слиянии: вид из реестра apps/api/src/merge, id записи, поле и значение. */
export interface MergeMovedItemTable {
  id: Generated<string>
  project_id: string
  merge_id: string
  kind: string
  item_id: string | null
  field: string | null
  /** JSON: читается значением, пишется строкой JSON. */
  value: ColumnType<unknown, string | null, never>
}

/** Строковое поле регистрации: пишется при вставке, не меняется. */
type RegistrationText = ColumnType<string | null, string | null | undefined, never>

/**
 * Регистрация (migrations/0028_registration_intake.ts, тикет crm-intake/06): поля заметки
 * Pipedrive «Информация из формы», остальное — в `extra`. Меняются только контакт и сделка — их
 * переносит слияние. Удаляется вместе с контактом или сделкой (окончательное удаление).
 */
export interface RegistrationTable {
  id: Generated<string>
  project_id: string
  intake_source_id: ColumnType<string, string, never>
  /** id события у источника: уникален в пределах источника. */
  event_id: ColumnType<string, string, never>
  contact_id: string
  deal_id: string
  created_at: ColumnType<Date, Date | string | undefined, never>
  name: RegistrationText
  /** Телефон в E.164; null — не прислан или не разобран (тогда как прислан — `phone_raw`). */
  phone: RegistrationText
  phone_raw: RegistrationText
  dial_code: RegistrationText
  email: RegistrationText
  form: RegistrationText
  webinar: RegistrationText
  plan_name: RegistrationText
  page_url: RegistrationText
  referrer: RegistrationText
  utm_source: RegistrationText
  utm_medium: RegistrationText
  utm_campaign: RegistrationText
  utm_term: RegistrationText
  utm_content: RegistrationText
  ad_id: RegistrationText
  gclid: RegistrationText
  gbraid: RegistrationText
  wbraid: RegistrationText
  fbclid: RegistrationText
  fbp: RegistrationText
  fbc: RegistrationText
  registered_at: ColumnType<Date | null, Date | string | null | undefined, never>
  user_agent: RegistrationText
  /** Остальные ключи тела, как прислал источник: объект JSON. */
  extra: ColumnType<Record<string, unknown>, string | undefined, never>
}

/**
 * Пара «источник, event_id» входящего (migrations/0028): хранится вечно, без персональных
 * данных. `registration_id` — null, пока регистрация пишется, и после её окончательного удаления.
 */
export interface IntakeEventTable {
  project_id: string
  intake_source_id: string
  /** 'registration'. */
  kind: string
  event_id: string
  registration_id: string | null
  created_at: ColumnType<Date, Date | string | undefined, never>
}

/** Журнал входящих (migrations/0028): строка не меняется; ночная очистка — через 30 дней. */
export interface InboundRequestTable {
  id: Generated<string>
  project_id: string
  /** Канал: 'intake.registration' (тикет 08 — 'intake.webinar_view'). */
  channel: string
  intake_source_id: string | null
  received_at: ColumnType<Date, Date | string | undefined, never>
  status_code: number
  /** 'accepted' | 'repeat' | 'error'. */
  outcome: string
  error_code: string | null
  event_id: string | null
  /** Сырое тело запроса, как пришло. */
  body: string
  /** id созданного или найденного: JSON, пишется строкой. */
  result: ColumnType<Record<string, unknown> | null, string | null, never>
  warnings: ColumnType<string[], string[] | undefined, never>
  /** Строка журнала, которую провели заново. */
  replay_of: string | null
}

export interface Database {
  project: ProjectTable
  project_member: ProjectMemberTable
  role: RoleTable
  team: TeamTable
  pipeline: PipelineTable
  stage: StageTable
  lost_reason_group: LostReasonGroupTable
  lost_reason: LostReasonTable
  external_link: ExternalLinkTable
  user: UserTable
  session: SessionTable
  account: AccountTable
  verification: VerificationTable
  two_factor: TwoFactorTable
  rate_limit: RateLimitTable
  audit_log: AuditLogTable
  system_audit_log: SystemAuditLogTable
  bulk_job: BulkJobTable
  bulk_job_error: BulkJobErrorTable
  organization: OrganizationTable
  contact: ContactTable
  contact_phone: ContactPhoneTable
  contact_email: ContactEmailTable
  change_log: ChangeLogTable
  deal: DealTable
  deal_participant: DealParticipantTable
  product: ProductTable
  deal_product: DealProductTable
  note: NoteTable
  file: FileTable
  saved_filter: SavedFilterTable
  field_group: FieldGroupTable
  field_definition: FieldDefinitionTable
  field_pipeline: FieldPipelineTable
  field_required_stage: FieldRequiredStageTable
  field_option: FieldOptionTable
  custom_value: CustomValueTable
  pipeline_card_field: PipelineCardFieldTable
  api_key: ApiKeyTable
  idempotency_record: IdempotencyRecordTable
  webhook_event: WebhookEventTable
  webhook_endpoint: WebhookEndpointTable
  webhook_delivery: WebhookDeliveryTable
  webhook_delivery_attempt: WebhookDeliveryAttemptTable
  intake_source: IntakeSourceTable
  merge_record: MergeRecordTable
  merge_moved_item: MergeMovedItemTable
  registration: RegistrationTable
  intake_event: IntakeEventTable
  inbound_request: InboundRequestTable
}
