// Тип файла по содержимому (тикет crm-deals/07): сигнатура в начале файла, не расширение и не
// заголовок Content-Type запроса. Разрешены (список решён без владельца — подтвердить):
// изображения JPEG, PNG, WebP, GIF; PDF; документы Word, Excel, PowerPoint (Office Open XML) и
// OpenDocument (текст, таблица, презентация); простой текст и CSV. Старые двоичные форматы
// Office (.doc, .xls, .ppt — контейнер OLE) не принимаются: в них макросы, а отличить один от
// другого по сигнатуре нельзя. HTML, SVG и XML не принимаются вовсе.

/** Сколько первых байт файла достаточно для определения типа. */
export const SNIFF_BYTES = 64 * 1024

export const ALLOWED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'text/plain',
  'text/csv',
] as const
export type AllowedType = (typeof ALLOWED_TYPES)[number]

const ascii = (text: string) => Uint8Array.from(text, (ch) => ch.charCodeAt(0))

function startsWith(head: Uint8Array, signature: Uint8Array, offset = 0): boolean {
  if (head.length < offset + signature.length) return false
  return signature.every((byte, i) => head[offset + i] === byte)
}

/** Сигнатуры в начале файла. */
const SIGNATURES: readonly { type: AllowedType; bytes: Uint8Array }[] = [
  { type: 'image/jpeg', bytes: Uint8Array.of(0xff, 0xd8, 0xff) },
  { type: 'image/png', bytes: Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) },
  { type: 'image/gif', bytes: ascii('GIF87a') },
  { type: 'image/gif', bytes: ascii('GIF89a') },
  { type: 'application/pdf', bytes: ascii('%PDF-') },
]

const RIFF = ascii('RIFF')
const WEBP = ascii('WEBP')
const ZIP_LOCAL_HEADER = ascii('PK\x03\x04')

/** Первая папка записи архива Office Open XML → тип документа. */
const OOXML_PARTS: readonly [prefix: string, type: AllowedType][] = [
  ['word/', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xl/', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['ppt/', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
]

const ODF_TYPES: readonly AllowedType[] = [
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
]

const u16 = (head: Uint8Array, at: number) => (head[at] ?? 0) | ((head[at + 1] ?? 0) << 8)
const u32 = (head: Uint8Array, at: number) => (u16(head, at) | (u16(head, at + 2) << 16)) >>> 0
const LATIN1 = new TextDecoder('latin1')
const latin1 = (bytes: Uint8Array) => LATIN1.decode(bytes)

/**
 * Документ в архиве ZIP: OpenDocument — по первой записи `mimetype` (хранится без сжатия);
 * Office Open XML — по папке частей (word/, xl/, ppt/). Записи ищутся по заголовкам в начале
 * файла. shortcut: смотрятся только записи в первых SNIFF_BYTES байтах, документ Office, у
 * которого до части word/ (xl/, ppt/) лежит больше 64 КБ других частей, получит 415 — читать
 * центральный каталог архива с конца сохранённого файла, если такие документы встретятся.
 */
function zipDocumentType(head: Uint8Array): AllowedType | undefined {
  for (let at = 0; at + 30 <= head.length; at++) {
    if (!startsWith(head, ZIP_LOCAL_HEADER, at)) continue
    const nameLength = u16(head, at + 26)
    const extraLength = u16(head, at + 28)
    const name = latin1(head.subarray(at + 30, at + 30 + nameLength))
    if (name === 'mimetype') {
      const start = at + 30 + nameLength + extraLength
      const content = latin1(head.subarray(start, start + u32(head, at + 18)))
      return ODF_TYPES.find((type) => type === content)
    }
    const part = OOXML_PARTS.find(([prefix]) => name.startsWith(prefix))
    if (part) return part[1]
    at += 29
  }
  return undefined
}

/** Разметка: страница или картинка SVG, которую браузер мог бы показать как документ. */
const MARKUP = /<(!doctype|html|head|body|script|iframe|svg|\?xml)[\s>/]/i

/**
 * Простой текст (любая однобайтная кодировка или UTF-8): без управляющих байт, кроме табуляции,
 * перевода строки и страницы, и не разметка — не начинается с «<» и без тегов страницы.
 */
function isPlainText(head: Uint8Array): boolean {
  for (const byte of head) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d) {
      return false
    }
  }
  const text = latin1(head.subarray(0, 4096))
  return (
    !text
      .replace(/^\xef\xbb\xbf/, '')
      .trimStart()
      .startsWith('<') && !MARKUP.test(text)
  )
}

/**
 * Тип файла по первым байтам `head` (до SNIFF_BYTES; меньше — если файл короче); не из списка —
 * undefined. `name` — исходное имя: только чтобы отличить CSV от простого текста (содержимое у
 * них одного вида, и оба отдаются как вложение).
 */
export function detectContentType(head: Uint8Array, name: string): AllowedType | undefined {
  if (head.length === 0) return undefined
  const signature = SIGNATURES.find(({ bytes }) => startsWith(head, bytes))
  if (signature) return signature.type
  if (startsWith(head, RIFF) && startsWith(head, WEBP, 8)) return 'image/webp'
  if (startsWith(head, ZIP_LOCAL_HEADER)) return zipDocumentType(head)
  if (isPlainText(head)) return /\.csv$/i.test(name) ? 'text/csv' : 'text/plain'
  return undefined
}
