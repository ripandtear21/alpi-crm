import { describe, expect, it } from 'vitest'
import { formatPhone, normalizeEmail, normalizePhone } from './phone.ts'

// Ключи поиска контакта (тикет crm-deals/03): телефон в E.164, email в нижнем регистре.
// Номера вымышленные.

describe('normalizePhone', () => {
  it.each([
    '0671234567',
    '067 123 45 67',
    '(067) 123-45-67',
    '+380671234567',
    '380671234567',
    '+38 (067) 123-45-67',
  ])('украинский номер «%s» → +380671234567', (input) => {
    expect(normalizePhone(input)).toBe('+380671234567')
  })

  it('польский номер сохраняется польским', () => {
    expect(normalizePhone('+48 601 234 567')).toBe('+48601234567')
    expect(normalizePhone('+48601234567')).toBe('+48601234567')
  })

  it.each(['', '   ', 'abc', '123', '067', '+380', '0671234567890123', 'телефон', '+0671234567'])(
    'мусор «%s» не разбирается',
    (input) => {
      expect(normalizePhone(input)).toBeNull()
    },
  )
})

describe('normalizeEmail', () => {
  it('приводит к нижнему регистру и обрезает пробелы', () => {
    expect(normalizeEmail('  Test.User@Example.COM ')).toBe('test.user@example.com')
  })

  it.each(['', 'not-an-email', 'a@b', '@example.com', `${'a'.repeat(250)}@example.com`])(
    'не email «%s» — null',
    (input) => {
      expect(normalizeEmail(input)).toBeNull()
    },
  )
})

describe('formatPhone', () => {
  it('«067 123 45 67» после нормализации показывается как +380 67 123 4567', () => {
    const e164 = normalizePhone('067 123 45 67')
    expect(e164).toBe('+380671234567')
    expect(formatPhone(e164 ?? '')).toBe('+380 67 123 4567')
  })

  it('номер другой страны — в международном виде своей страны', () => {
    expect(formatPhone('+48601234567')).toBe('+48 601 234 567')
  })

  it.each(['', 'не номер', '+380'])('неразбираемая строка «%s» возвращается как есть', (input) => {
    expect(formatPhone(input)).toBe(input)
  })
})
