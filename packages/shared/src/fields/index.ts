import { transliterateUk } from './transliterate.ts'

// Конструктор полей (эпик crm-fields, тикет 01; spec.md MVP, раздел 3.3): группы полей,
// описания пользовательских полей и варианты списков в ответах `/api/v1/field-groups` и
// `/api/v1/fields`. Здесь же правила кода поля — одни для клиента (подсказка в форме) и сервера
// (проверка запроса); база держит те же правила своими ограничениями
// (packages/db/migrations/0016_fields.ts — снимок списков отсюда).

export { transliterateUk } from './transliterate.ts'

/** Сущности, у которых есть пользовательские поля. */
export const FIELD_ENTITIES = ['deal', 'contact', 'organization'] as const
export type FieldEntity = (typeof FIELD_ENTITIES)[number]

/** 15 типов поля (раздел 3.3 спецификации MVP). */
export const FIELD_TYPES = [
  'text',
  'long_text',
  'number',
  'money',
  'date',
  'time',
  'date_range',
  'single_option',
  'multi_option',
  'boolean',
  'phone',
  'email',
  'url',
  'address',
  'user',
] as const
export type FieldType = (typeof FIELD_TYPES)[number]

/** Типы со списком вариантов: варианты есть только у них. */
export const OPTION_FIELD_TYPES = ['single_option', 'multi_option'] as const satisfies FieldType[]

export function hasOptions(type: FieldType): boolean {
  return OPTION_FIELD_TYPES.some((t) => t === type)
}

/** Наибольшая длина кода поля (имя идентификатора PostgreSQL — до 63 байт). */
export const FIELD_CODE_MAX_LENGTH = 63

/** Код поля: латиница в нижнем регистре, цифры и `_`, начинается с буквы, до 63 символов. */
export const FIELD_CODE = /^[a-z][a-z0-9_]{0,62}$/

/** Наибольшая длина названия группы, поля и варианта. */
export const FIELD_NAME_MAX_LENGTH = 100

/** Коды, занятые у всех сущностей: служебные столбцы записи и разделы карточки. */
const COMMON_SYSTEM_CODES = [
  'id',
  'project',
  'project_id',
  'custom',
  'created_at',
  'created_by',
  'updated_at',
  'deleted_at',
  'deleted_by',
  'archived',
  'archived_at',
  'notes',
  'files',
  'timeline',
  'history',
] as const

/**
 * Коды системных полей по сущностям (решено без владельца, подтвердить): системные поля
 * (сделка: название, воронка, этап, статус, сумма, валюта, ответственный, причина проигрыша,
 * архив, даты; контакт: имя, фамилия, телефоны, email, организация, язык; организация: название,
 * адрес, сайт) и служебные столбцы. Пользовательское поле с таким кодом спуталось бы с системным
 * в фильтрах, импорте и приёме регистраций.
 */
export const SYSTEM_FIELD_CODES: Record<FieldEntity, readonly string[]> = {
  deal: [
    ...COMMON_SYSTEM_CODES,
    'title',
    'pipeline',
    'pipeline_id',
    'stage',
    'stage_id',
    'status',
    'amount',
    'currency',
    'owner',
    'owner_id',
    'lost_reason',
    'lost_reason_id',
    'contact',
    'primary_contact',
    'primary_contact_id',
    'organization',
    'organization_id',
    'participants',
    'products',
    'won_at',
    'lost_at',
    'stage_changed_at',
    'expected_close_date',
  ],
  contact: [
    ...COMMON_SYSTEM_CODES,
    'name',
    'first_name',
    'last_name',
    'phone',
    'phones',
    'email',
    'emails',
    'organization',
    'organization_id',
    'language',
    'owner',
    'possible_duplicate',
    'deals',
  ],
  organization: [
    ...COMMON_SYSTEM_CODES,
    'name',
    'address',
    'website',
    'owner',
    'contacts',
    'deals',
  ],
}

/** Что не так с кодом: формат или код системного поля; null — код допустим. */
export type FieldCodeProblem = 'format' | 'system'

export function fieldCodeProblem(entity: FieldEntity, code: string): FieldCodeProblem | null {
  if (!FIELD_CODE.test(code)) return 'format'
  return SYSTEM_FIELD_CODES[entity].includes(code) ? 'system' : null
}

/**
 * Код по умолчанию из украинского названия: транслитерация, всё, кроме латиницы и цифр, — `_`.
 * Не начинается с цифры и не пустой. Занятость кода (системный, уже есть в проекте) проверяет
 * вызывающий: сервер подбирает суффикс `_2`, `_3`…
 */
export function fieldCodeFromName(name: string): string {
  let code = transliterateUk(name)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (code === '') code = 'field'
  if (!/^[a-z]/.test(code)) code = `f_${code}`
  return code.slice(0, FIELD_CODE_MAX_LENGTH).replace(/_+$/, '')
}

/** Код с суффиксом `_n`, обрезанный так, чтобы влезть в 63 символа. */
export function fieldCodeWithSuffix(code: string, n: number): string {
  const suffix = `_${n}`
  return `${code.slice(0, FIELD_CODE_MAX_LENGTH - suffix.length).replace(/_+$/, '')}${suffix}`
}

/** Название на украинском (обязательно) и русском (необязательно: нет — показывается украинское). */
export interface FieldNames {
  nameUk: string
  nameRu: string | null
}

/** Название на языке интерфейса: русского нет — украинское. */
export function fieldName(names: FieldNames, locale: 'uk' | 'ru'): string {
  return locale === 'ru' && names.nameRu !== null ? names.nameRu : names.nameUk
}

/** Группа полей одной сущности. */
export interface FieldGroupSummary extends FieldNames {
  id: string
  entity: FieldEntity
  /** Порядок групп сущности: 1, 2, 3… */
  position: number
}

/** Вариант списка: id стабилен, значения поля хранят его. */
export interface FieldOptionSummary extends FieldNames {
  id: string
  position: number
  /** Время архивации в ISO 8601; архивный вариант не предлагается для новых значений. */
  archivedAt: string | null
}

/** Правило «обязательно с этапа»: `stageId` null — только при выигрыше. */
export interface FieldRequiredStage {
  pipelineId: string
  stageId: string | null
}

/**
 * Обязательность: нет; «всегда»; с этапа X в перечисленных воронках (только у полей сделки, по
 * одному правилу на воронку, воронка — из тех, где поле видно).
 */
export type FieldRequirement =
  | { mode: 'none' }
  | { mode: 'always' }
  | { mode: 'stages'; stages: FieldRequiredStage[] }

/** Видимость поля сделки: во всех воронках проекта или в перечисленных. */
export type FieldPipelines = 'all' | string[]

/** Описание пользовательского поля. */
export interface FieldDefinitionSummary extends FieldNames {
  id: string
  entity: FieldEntity
  groupId: string
  /** Стабильный код: ключ значения в `custom`, имя поля в API, фильтрах и импорте. */
  code: string
  type: FieldType
  /** Порядок в группе: 1, 2, 3… */
  position: number
  /** У полей контакта и организации — всегда 'all'. */
  pipelines: FieldPipelines
  required: FieldRequirement
  isImportant: boolean
  /** «Часто фильтруют»: по коду строится индекс, код не меняется. */
  isFrequentlyFiltered: boolean
  /** Время первого значения; пока null — код и тип меняются свободно. */
  firstValueAt: string | null
  archivedAt: string | null
  /** Окончательное удаление запрошено: фоновая задача убирает значения, потом описание. */
  purgeRequestedAt: string | null
  /** Варианты по порядку, вместе с архивными (только у типов со списком). */
  options: FieldOptionSummary[]
}

/** Варианты, которые предлагаются для нового значения: без архивных. */
export function offeredOptions(field: Pick<FieldDefinitionSummary, 'options'>) {
  return field.options.filter((option) => option.archivedAt === null)
}

/** Код поля можно менять: значений ещё не было и поле не отмечено «часто фильтруют». */
export function fieldCodeEditable(
  field: Pick<FieldDefinitionSummary, 'firstValueAt' | 'isFrequentlyFiltered'>,
): boolean {
  return field.firstValueAt === null && !field.isFrequentlyFiltered
}

/** Через сколько дней после архивирования поле с данными можно удалить окончательно. */
export const FIELD_PURGE_AFTER_DAYS = 30

/** Коды ошибок API конструктора полей (вдобавок к PERMISSION_DENIED). */
export type FieldsErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  /** Новый порядок — не ровно те же записи. */
  | 'INVALID_ORDER'
  /** Код не по формату. */
  | 'FIELD_CODE_INVALID'
  /** Код системного поля сущности. */
  | 'FIELD_CODE_RESERVED'
  /** Код уже занят полем той же сущности (живым или архивным). */
  | 'FIELD_CODE_TAKEN'
  /** Код не меняется: у поля были значения или оно отмечено «часто фильтруют». */
  | 'FIELD_CODE_LOCKED'
  /** Тип не меняется: у поля были значения (безопасная смена типа — тикет 02). */
  | 'FIELD_TYPE_LOCKED'
  /** Группа не найдена или другой сущности. */
  | 'FIELD_GROUP_NOT_FOUND'
  /** В группе есть поля (в том числе архивные): удалить нельзя. */
  | 'FIELD_GROUP_NOT_EMPTY'
  /** Видимость по воронкам или правило «с этапа» — только у полей сделки. */
  | 'FIELD_DEAL_ONLY'
  /** Воронка не найдена в проекте. */
  | 'FIELD_PIPELINE_NOT_FOUND'
  /** Этап не найден в этой воронке (или удалён). */
  | 'FIELD_STAGE_NOT_FOUND'
  /** Правило «с этапа» для воронки, в которой поле не видно. */
  | 'FIELD_PIPELINE_HIDDEN'
  /** Варианты есть только у типов «один вариант» и «несколько вариантов». */
  | 'FIELD_OPTIONS_NOT_ALLOWED'
  /** У поля есть варианты: тип без вариантов поставить нельзя. */
  | 'FIELD_HAS_OPTIONS'
  /** Окончательное удаление раньше 30 дней после архивирования. */
  | 'FIELD_PURGE_TOO_EARLY'
  /** Окончательное удаление уже идёт: поле не меняется и не возвращается из архива. */
  | 'FIELD_PURGE_PENDING'
