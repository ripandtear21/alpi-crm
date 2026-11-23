import {
  DEFAULT_LIST_COLUMNS,
  type FilterEntity,
  LIST_COLUMNS,
  type ListColumn,
} from '@alpi/shared'

// Выгрузка списков в CSV (тикет crm-deals/12): текущие колонки и фильтр списка, с охватом
// пользователя, потоком — строки уходят клиенту порциями по мере чтения из базы. Право —
// «выгрузка в файл» (`export`), каждая выгрузка пишется в журнал опасных действий
// (export.downloaded). Файл — UTF-8 с BOM: так Excel открывает кириллицу без выбора кодировки.

/** Метка порядка байтов UTF-8: Excel по ней узнаёт кодировку файла. */
export const UTF8_BOM = '\uFEFF'

/** Строк в одной порции чтения из базы. */
export const EXPORT_BATCH = 500

/** Язык заголовков и значений файла. */
export type ExportLanguage = 'uk' | 'ru'

/** Значение ячейки до записи в CSV. */
export type CsvValue = string | number | boolean | null

/**
 * Ячейка CSV (RFC 4180): кавычки — при запятой, кавычке, переводе строки. Текст, который
 * Excel принял бы за формулу (=, +, -, @, табуляция в начале), начинается с апострофа: иначе
 * открытие выгрузки выполнило бы чужую формулу из названия сделки (CSV injection).
 */
export function csvCell(value: CsvValue): string {
  if (value === null) return ''
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? '1' : '0'
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function csvRow(values: readonly CsvValue[]): string {
  return `${values.map(csvCell).join(',')}\r\n`
}

/** Колонки выгрузки из параметра `columns=a,b,c`; нет параметра — колонки по умолчанию. */
export function readColumns<E extends FilterEntity>(
  entity: E,
  raw: string | undefined,
): ListColumn<E>[] | null {
  if (raw === undefined) return [...DEFAULT_LIST_COLUMNS[entity]]
  const known: readonly string[] = LIST_COLUMNS[entity]
  const columns = [...new Set(raw.split(',').filter((column) => column !== ''))]
  if (columns.length === 0 || !columns.every((column) => known.includes(column))) return null
  return columns as ListColumn<E>[]
}

export function readLanguage(raw: string | undefined): ExportLanguage | null {
  if (raw === undefined) return 'uk'
  return raw === 'uk' || raw === 'ru' ? raw : null
}

/** Заголовки колонок по языкам. */
const HEADERS: Record<ExportLanguage, Record<string, string>> = {
  uk: {
    title: 'Назва',
    pipeline: 'Воронка',
    stage: 'Етап',
    status: 'Статус',
    amount: 'Сума',
    currency: 'Валюта',
    owner: 'Відповідальний',
    contact: 'Контакт',
    organization: 'Організація',
    createdAt: 'Створено',
    stageChangedAt: 'Зміна етапу',
    wonAt: 'Виграно',
    lostAt: 'Програно',
    lostReason: 'Причина програшу',
    archivedAt: 'Архів',
    name: "Ім'я",
    phone: 'Телефон',
    email: 'Email',
    language: 'Мова',
    possibleDuplicate: 'Можливий дубль',
    updatedAt: 'Змінено',
    address: 'Адреса',
    website: 'Сайт',
  },
  ru: {
    title: 'Название',
    pipeline: 'Воронка',
    stage: 'Этап',
    status: 'Статус',
    amount: 'Сумма',
    currency: 'Валюта',
    owner: 'Ответственный',
    contact: 'Контакт',
    organization: 'Организация',
    createdAt: 'Создано',
    stageChangedAt: 'Смена этапа',
    wonAt: 'Выиграно',
    lostAt: 'Проиграно',
    lostReason: 'Причина проигрыша',
    archivedAt: 'Архив',
    name: 'Имя',
    phone: 'Телефон',
    email: 'Email',
    language: 'Язык',
    possibleDuplicate: 'Возможный дубль',
    updatedAt: 'Изменено',
    address: 'Адрес',
    website: 'Сайт',
  },
}

export function csvHeader(columns: readonly string[], language: ExportLanguage): string {
  return csvRow(columns.map((column) => HEADERS[language][column] ?? column))
}

/** Статусы сделки по языкам. */
export const STATUS_LABELS: Record<ExportLanguage, Record<string, string>> = {
  uk: { open: 'Відкрита', won: 'Виграна', lost: 'Програна' },
  ru: { open: 'Открыта', won: 'Выиграна', lost: 'Проиграна' },
}

/** «Общая очередь» вместо пустого ответственного. */
export const QUEUE_LABEL: Record<ExportLanguage, string> = {
  uk: 'Без відповідального',
  ru: 'Без ответственного',
}

/**
 * Ответ-файл: строки идут из `rows` по мере готовности. `rows` сам открывает транзакции
 * проекта на каждую порцию: транзакция запроса к этому времени уже закрыта.
 */
export function csvResponse(filename: string, rows: AsyncGenerator<string>): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await rows.next()
        if (next.done) controller.close()
        else controller.enqueue(encoder.encode(next.value))
      } catch (error) {
        console.error('выгрузка CSV прервана', error)
        controller.error(error)
      }
    },
    async cancel() {
      await rows.return(undefined)
    },
  })
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  })
}

/** Имя файла: список и дата выгрузки (UTC). */
export function exportFilename(entity: FilterEntity, now = new Date()): string {
  return `${entity}-${now.toISOString().slice(0, 10)}.csv`
}
