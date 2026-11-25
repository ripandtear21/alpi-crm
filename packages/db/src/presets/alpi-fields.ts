// Стартовые пользовательские поля проекта ALPI (тикет crm-fields/08): таблица
// docs/setup/alpi-start-fields.md, раздел 1, подтверждённая владельцем 2026-11-25. Таблица —
// источник: что она меняет, то меняется здесь, и наоборот (сверку держит
// apps/api/src/cli/project-preset.test.ts).
//
// Воронки — коды стартовых воронок ALPI (project-preset.ts), этапы — названия их этапов.
// Правило обязательности: `stage` — этап, с которого поле обязательно в воронке `pipeline`;
// null — только при выигрыше (пункт «Виграно» правила «з етапу X»).

export type FieldPresetEntity = 'deal' | 'contact' | 'organization'

export interface FieldGroupPreset {
  entity: FieldPresetEntity
  nameUk: string
  nameRu: string
}

export interface FieldRequiredRulePreset {
  pipeline: string
  /** Название этапа воронки; null — только при выигрыше. */
  stage: string | null
}

export interface FieldPreset {
  entity: FieldPresetEntity
  /** Название группы (nameUk) той же сущности. */
  group: string
  code: string
  nameUk: string
  nameRu: string
  /** Один из 15 типов конструктора (FIELD_TYPES, packages/shared/src/fields). */
  type: string
  /** Варианты списка по порядку (названия uk); только у single_option и multi_option. */
  options?: readonly string[]
  /** Коды воронок, где поле видно; не задано — во всех воронках. */
  pipelines?: readonly string[]
  required?: readonly FieldRequiredRulePreset[]
  important?: boolean
  frequentlyFiltered?: boolean
}

const ALPI = 'alpi'
const PLATFORM = 'platform'
const AUTOWEBINARS = 'autowebinars'
const ALPI_PLATFORM = [ALPI, PLATFORM]
const ALL_THREE = [ALPI, PLATFORM, AUTOWEBINARS]

const won = (pipeline: string): FieldRequiredRulePreset => ({ pipeline, stage: null })

const LEAD = 'Профіль ліда'
const CLOSING = 'Закриття'
const SOURCE = 'Джерело та команда'
const CONTACT = "Зв'язок"

export const ALPI_FIELD_GROUPS: readonly FieldGroupPreset[] = [
  { entity: 'deal', nameUk: LEAD, nameRu: 'Профиль лида' },
  { entity: 'deal', nameUk: CLOSING, nameRu: 'Закрытие' },
  { entity: 'deal', nameUk: SOURCE, nameRu: 'Источник и команда' },
  { entity: 'contact', nameUk: CONTACT, nameRu: 'Связь' },
]

export const ALPI_FIELDS: readonly FieldPreset[] = [
  {
    entity: 'deal',
    group: LEAD,
    code: 'score',
    nameUk: 'Score',
    nameRu: 'Score',
    type: 'number',
    pipelines: ALPI_PLATFORM,
  },
  {
    entity: 'deal',
    group: LEAD,
    code: 'priorytet',
    nameUk: 'Пріоритет',
    nameRu: 'Приоритет',
    type: 'single_option',
    options: ['P1', 'P2', 'P3'],
    pipelines: ALPI_PLATFORM,
  },
  {
    entity: 'deal',
    group: LEAD,
    code: 'sql',
    nameUk: 'SQL',
    nameRu: 'SQL',
    type: 'single_option',
    options: ['SQL1', 'SQL2', 'SQL3', 'SQL4', 'SQL5', 'SQL6', 'SQL7'],
    pipelines: ALPI_PLATFORM,
    frequentlyFiltered: true,
  },
  {
    entity: 'deal',
    group: LEAD,
    code: 'yakist_lida',
    nameUk: 'Якість ліда',
    nameRu: 'Качество лида',
    type: 'single_option',
    options: [
      'B0 — контактні дані не вірні',
      'B1 — нецільовий',
      'B3 — цільова аудиторія',
      'Не визначено',
    ],
    pipelines: ALPI_PLATFORM,
    required: [
      { pipeline: ALPI, stage: 'Не вийшов на звязок' },
      { pipeline: PLATFORM, stage: 'Приймає рішення (Д)' },
    ],
    important: true,
  },
  {
    entity: 'deal',
    group: LEAD,
    code: 'kupivelnyi_namir',
    nameUk: 'Купівельний намір',
    nameRu: 'Покупательское намерение',
    type: 'boolean',
    pipelines: ALPI_PLATFORM,
  },
  {
    entity: 'deal',
    group: LEAD,
    code: 'barier',
    nameUk: "Бар'єр",
    nameRu: 'Барьер',
    type: 'single_option',
    options: ['гроші', 'час', 'сумніви', 'немає потреби', 'інше'],
    pipelines: ALPI_PLATFORM,
  },
  {
    entity: 'deal',
    group: LEAD,
    code: 'typ_kliienta',
    nameUk: 'Тип клієнта',
    nameRu: 'Тип клиента',
    type: 'single_option',
    // Названия обрезаны «…» ещё в разборе Pipedrive; полные администратор поправит в
    // конструкторе (id варианта при переименовании не меняется).
    options: [
      'Шукачі (пенсіонери, мами в декреті…)',
      'Шукачі онлайн-професії (контент…)',
      'Малий бізнес (товарка, магазин…)',
      'Середній бізнес',
      'Професіонали (маркетологи, SMM…)',
    ],
    pipelines: ALL_THREE,
    required: [
      { pipeline: ALPI, stage: 'Дивиться запис вебінар' },
      { pipeline: PLATFORM, stage: 'Приймає рішення (Д)' },
      won(AUTOWEBINARS),
    ],
    important: true,
  },
  {
    entity: 'deal',
    group: LEAD,
    code: 'rid_diialnosti',
    nameUk: 'Рід діяльності',
    nameRu: 'Род деятельности',
    type: 'single_option',
    options: [
      'Власний бізнес',
      'Фриланс',
      'Наймана робота',
      'Наймана робота — офіс',
      'Наймана робота — онлайн / IT / маркетинг',
      'Наймана робота — торгівля',
      'Наймана робота — виробництво',
      'Не працюю',
      'Держслужба',
      'Освіта',
      'Військова служба',
      'На пенсії',
      'Інше',
    ],
    pipelines: ALPI_PLATFORM,
  },
  {
    entity: 'deal',
    group: LEAD,
    code: 'typazh_tsa',
    nameUk: 'ТИПАЖ ЦА',
    nameRu: 'Типаж ЦА',
    type: 'single_option',
    options: ['уникаючий', 'натхненний', 'прогресивний', 'прагматичний'],
    pipelines: ALPI_PLATFORM,
    required: [won(ALPI), won(PLATFORM)],
    important: true,
  },
  {
    entity: 'deal',
    group: LEAD,
    code: 'holovnyi_motyv_v_ai',
    nameUk: 'Головний мотив в AI',
    nameRu: 'Главный мотив в AI',
    type: 'single_option',
    options: [
      'Збільшення доходу',
      'Самореалізація / творчість',
      'Зменшити робочу рутину',
      'Для ведення контенту / маркетингу',
      'Вже вивчає нейронки',
      'Хоче бути в тренді',
      'Не знає для чого',
      'Інше',
    ],
    pipelines: ALPI_PLATFORM,
    required: [
      { pipeline: ALPI, stage: 'Дивиться запис вебінар' },
      { pipeline: PLATFORM, stage: 'Приймає рішення (Д)' },
    ],
    important: true,
  },
  {
    entity: 'deal',
    group: LEAD,
    code: 'profesiia_kliienta',
    nameUk: 'Професія клієнта',
    nameRu: 'Профессия клиента',
    type: 'text',
    pipelines: ALPI_PLATFORM,
    required: [won(ALPI), won(PLATFORM)],
  },
  {
    entity: 'deal',
    group: CLOSING,
    code: 'vziatyi_v_robotu',
    nameUk: 'Взятий в роботу',
    nameRu: 'Взят в работу',
    type: 'date_range',
    pipelines: ALL_THREE,
    required: [
      { pipeline: ALPI, stage: 'Не вийшов на звязок' },
      { pipeline: PLATFORM, stage: "Не вийшов на зв'язок (Д)" },
      won(AUTOWEBINARS),
    ],
    important: true,
    frequentlyFiltered: true,
  },
  {
    entity: 'deal',
    group: CLOSING,
    code: 'pislia_broni',
    nameUk: 'Після броні',
    nameRu: 'После брони',
    type: 'boolean',
    pipelines: ALPI_PLATFORM,
    important: true,
  },
  {
    entity: 'deal',
    group: CLOSING,
    code: 'detalizatsiia_zakryttia',
    nameUk: 'Деталізація закриття',
    nameRu: 'Детализация закрытия',
    type: 'single_option',
    options: ['Реєстрація', 'Глядач', 'Гаряча угода (Консультація)', 'Власна робота'],
    pipelines: ALPI_PLATFORM,
    required: [won(ALPI), won(PLATFORM)],
    frequentlyFiltered: true,
  },
  {
    entity: 'deal',
    group: CLOSING,
    code: 'typ_zakryttia',
    nameUk: 'Тип закриття',
    nameRu: 'Тип закрытия',
    type: 'number',
    pipelines: ALL_THREE,
    required: [won(ALPI), won(AUTOWEBINARS)],
    frequentlyFiltered: true,
  },
  {
    entity: 'deal',
    group: CLOSING,
    code: 'potik',
    nameUk: 'Потік',
    nameRu: 'Поток',
    type: 'single_option',
    options: Array.from({ length: 26 }, (_, i) => String(i + 1)),
    pipelines: ALL_THREE,
    required: [won(ALPI), won(AUTOWEBINARS), won(PLATFORM)],
    frequentlyFiltered: true,
  },
  {
    entity: 'deal',
    group: SOURCE,
    code: 'menedzher_sapportu',
    nameUk: 'Менеджер саппорту',
    nameRu: 'Менеджер саппорта',
    type: 'user',
    pipelines: ALPI_PLATFORM,
  },
  {
    entity: 'deal',
    group: SOURCE,
    code: 'pervynnyi_dotyk',
    nameUk: 'Первинний дотик',
    nameRu: 'Первичное касание',
    type: 'single_option',
    // Известен один код — «4» (его ставит автоматизация «KZ»); остальные коды администратор
    // добавит вариантами, когда будет расшифровка.
    options: ['4'],
    pipelines: ALL_THREE,
    frequentlyFiltered: true,
  },
  {
    entity: 'deal',
    group: SOURCE,
    code: 'viddil_prodazhiv',
    nameUk: 'Відділ продажів',
    nameRu: 'Отдел продаж',
    type: 'single_option',
    options: ['Відділ продажів 1', 'Реєстрації, які пропустили ефір'],
    pipelines: ALL_THREE,
    frequentlyFiltered: true,
  },
  {
    entity: 'contact',
    group: CONTACT,
    code: 'telegram',
    nameUk: 'Telegram',
    nameRu: 'Telegram',
    type: 'text',
  },
]
