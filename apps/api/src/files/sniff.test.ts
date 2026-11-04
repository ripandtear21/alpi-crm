import { describe, expect, it } from 'vitest'
import { detectContentType } from './sniff.ts'

// Тип файла по содержимому (тикет crm-deals/07): сигнатура решает, расширение — нет.

const bytes = (...parts: (string | number[])[]) =>
  Uint8Array.from(
    parts.flatMap((part) =>
      typeof part === 'string' ? [...part].map((ch) => ch.charCodeAt(0)) : part,
    ),
  )

/** Заголовок записи ZIP без сжатия: имя и содержимое. */
function zipEntry(name: string, content = ''): number[] {
  const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff]
  const le32 = (n: number) => [...le16(n & 0xffff), ...le16(n >>> 16)]
  return [
    ...bytes('PK\x03\x04'),
    ...le16(20),
    ...le16(0),
    ...le16(0),
    ...le32(0),
    ...le32(0),
    ...le32(content.length),
    ...le32(content.length),
    ...le16(name.length),
    ...le16(0),
    ...bytes(name, content),
  ]
}

describe('detectContentType', () => {
  it('изображения и PDF — по сигнатуре, имя не важно', () => {
    expect(detectContentType(bytes([0xff, 0xd8, 0xff, 0xe0], 'JFIF'), 'x.txt')).toBe('image/jpeg')
    expect(detectContentType(bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), 'x.pdf')).toBe(
      'image/png',
    )
    expect(detectContentType(bytes('GIF89a', [1, 0]), 'x')).toBe('image/gif')
    expect(detectContentType(bytes('GIF87a', [1, 0]), 'x')).toBe('image/gif')
    expect(detectContentType(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '), 'x.png')).toBe('image/webp')
    expect(detectContentType(bytes('%PDF-1.7\n'), 'scan.jpg')).toBe('application/pdf')
  })

  it('Office Open XML — по папке частей, OpenDocument — по записи mimetype', () => {
    const ooxml = (part: string) =>
      Uint8Array.from([
        ...zipEntry('[Content_Types].xml', '<Types/>'),
        ...zipEntry('_rels/.rels', '<Relationships/>'),
        ...zipEntry(part, '<x/>'),
      ])
    expect(detectContentType(ooxml('word/document.xml'), 'a.pdf')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    expect(detectContentType(ooxml('xl/workbook.xml'), 'a')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    expect(detectContentType(ooxml('ppt/presentation.xml'), 'a')).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    )
    for (const kind of ['text', 'spreadsheet', 'presentation']) {
      const type = `application/vnd.oasis.opendocument.${kind}`
      expect(
        detectContentType(
          Uint8Array.from([...zipEntry('mimetype', type), ...zipEntry('content.xml')]),
          'a',
        ),
      ).toBe(type)
    }
    // Архив ZIP, но не документ; OpenDocument не из списка.
    expect(detectContentType(Uint8Array.from(zipEntry('photo.jpg', 'x')), 'a.docx')).toBe(undefined)
    expect(
      detectContentType(
        Uint8Array.from(zipEntry('mimetype', 'application/vnd.oasis.opendocument.graphics')),
        'a.odg',
      ),
    ).toBe(undefined)
  })

  it('текст и CSV: CSV отличает только имя', () => {
    const csv = new TextEncoder().encode('імʼя;телефон\r\nОлена;+380671234567\r\n')
    expect(detectContentType(csv, 'export.csv')).toBe('text/csv')
    expect(detectContentType(csv, 'export.txt')).toBe('text/plain')
    // Windows-1251 из Excel — тоже текст.
    expect(
      detectContentType(Uint8Array.from([0xcf, 0xf0, 0xe8, 0xe2, 0xb3, 0xf2, 0x0a]), 'a'),
    ).toBe('text/plain')
  })

  it('не принимает HTML, SVG, XML, двоичное, старый Office и пустой файл', () => {
    const rejected = [
      bytes('<!DOCTYPE html><html><script>alert(1)</script>'),
      bytes('\xef\xbb\xbf  <html>'),
      bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      bytes('<?xml version="1.0"?><svg/>'),
      new TextEncoder().encode('Привіт\n<script>alert(1)</script>'),
      bytes([0x00, 0x01, 0x02, 0x03]),
      bytes('MZ', [0x90, 0x00]),
      bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      new Uint8Array(0),
    ]
    for (const head of rejected) expect(detectContentType(head, 'file.pdf')).toBe(undefined)
  })
})
