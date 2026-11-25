import { describe, expect, it } from 'vitest'
import type { FieldType } from './index.ts'
import { type FieldValueContext, normalizeFieldValue, typeChangeWithValues } from './values.ts'

// Проверка и приведение значений пользовательских полей (тикет crm-fields/02): по каждому из
// 15 типов — верное значение в приведённом виде и неверное с причиной.

const OPTIONS = [
  { id: 'a', archivedAt: null },
  { id: 'b', archivedAt: null },
  { id: 'old', archivedAt: '2026-01-01T00:00:00.000Z' },
]
const USERS: FieldValueContext['users'] = new Map([
  ['u1', { disabled: false }],
  ['gone', { disabled: true }],
])

const check = (type: FieldType, raw: unknown, context: FieldValueContext = {}) =>
  normalizeFieldValue({ type, options: OPTIONS }, raw, { users: USERS, ...context })

describe('normalizeFieldValue', () => {
  it.each<[FieldType, unknown, unknown]>([
    ['text', '  Текст  ', 'Текст'],
    ['address', ' Київ, Хрещатик 1 ', 'Київ, Хрещатик 1'],
    ['long_text', 'Рядок 1\nРядок 2', 'Рядок 1\nРядок 2'],
    ['number', 12.5, 12.5],
    ['money', { amount: 10.1, currency: 'UAH' }, { amount: 10.1, currency: 'UAH' }],
    ['date', '2026-02-28', '2026-02-28'],
    ['time', '09:30', '09:30'],
    [
      'date_range',
      { from: '2026-01-01', to: '2026-01-01' },
      { from: '2026-01-01', to: '2026-01-01' },
    ],
    ['single_option', 'b', 'b'],
    ['multi_option', ['b', 'a', 'b'], ['a', 'b']],
    ['boolean', false, false],
    ['phone', '067 123 45 67', '+380671234567'],
    ['email', ' Ivan@Example.COM ', 'ivan@example.com'],
    ['url', ' https://alpi.ua/kurs?x=1 ', 'https://alpi.ua/kurs?x=1'],
    ['user', 'u1', 'u1'],
  ])('%s: %j → %j', (type, raw, value) => {
    expect(check(type, raw)).toEqual({ ok: true, value })
  })

  it.each<[FieldType, unknown, string]>([
    ['text', 'x'.repeat(501), 'too_long'],
    ['text', 5, 'type'],
    ['address', ['Київ'], 'type'],
    ['long_text', 'x'.repeat(10_001), 'too_long'],
    ['number', '5', 'type'],
    ['money', { amount: -1, currency: 'UAH' }, 'range'],
    ['money', { amount: 1.005, currency: 'UAH' }, 'precision'],
    ['money', { amount: 1, currency: 'PLN' }, 'currency'],
    ['money', { amount: 1, currency: 'UAH', extra: 1 }, 'type'],
    ['date', '2026-02-30', 'format'],
    ['time', '24:00', 'format'],
    ['date_range', { from: '2026-02-02', to: '2026-02-01' }, 'range'],
    ['date_range', { from: '2026-02-02' }, 'type'],
    ['single_option', 'nope', 'unknown_option'],
    ['single_option', 'old', 'archived_option'],
    ['multi_option', 'a', 'type'],
    ['multi_option', ['a', 'old'], 'archived_option'],
    ['boolean', 'true', 'type'],
    ['phone', '12', 'format'],
    ['email', 'not-an-email', 'format'],
    ['url', 'javascript:alert(1)', 'scheme'],
    ['url', 'ftp://alpi.ua', 'scheme'],
    ['url', 'alpi.ua', 'format'],
    ['url', 'https://', 'format'],
    ['user', 'stranger', 'unknown_user'],
    ['user', 'gone', 'disabled_user'],
  ])('%s: %j — %s', (type, raw, problem) => {
    expect(check(type, raw)).toEqual({ ok: false, problem })
  })

  it('null и пустое значение — убрать ключ', () => {
    for (const type of ['text', 'long_text', 'phone', 'email', 'url', 'number'] as const) {
      expect(check(type, null)).toEqual({ ok: true, value: null })
    }
    expect(check('text', '   ')).toEqual({ ok: true, value: null })
    expect(check('multi_option', [])).toEqual({ ok: true, value: null })
  })

  it('архивный вариант и отключённый пользователь, которые уже в значении, остаются допустимыми', () => {
    expect(check('single_option', 'old', { previous: 'old' })).toEqual({ ok: true, value: 'old' })
    expect(check('multi_option', ['old', 'a'], { previous: ['old'] })).toEqual({
      ok: true,
      value: ['a', 'old'],
    })
    expect(check('multi_option', ['old', 'a'], { previous: ['a'] })).toEqual({
      ok: false,
      problem: 'archived_option',
    })
    expect(check('user', 'gone', { previous: 'gone' })).toEqual({ ok: true, value: 'gone' })
  })

  it('без списка участников (форма) пользователь проверяется только по виду', () => {
    expect(normalizeFieldValue({ type: 'user' }, 'anyone')).toEqual({ ok: true, value: 'anyone' })
    expect(normalizeFieldValue({ type: 'user' }, 7)).toEqual({ ok: false, problem: 'type' })
  })
})

describe('typeChangeWithValues', () => {
  it('безопасные смены — только три; остальные запрещены', () => {
    expect(typeChangeWithValues('text', 'long_text')).toBe('keep')
    expect(typeChangeWithValues('number', 'text')).toBe('rewrite')
    expect(typeChangeWithValues('single_option', 'multi_option')).toBe('rewrite')
    expect(typeChangeWithValues('long_text', 'text')).toBeNull()
    expect(typeChangeWithValues('date', 'number')).toBeNull()
    expect(typeChangeWithValues('multi_option', 'single_option')).toBeNull()
    expect(typeChangeWithValues('text', 'number')).toBeNull()
  })
})
