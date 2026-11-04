import { describe, expect, it } from 'vitest'
import { createI18n, LANGUAGE_STORAGE_KEY } from './index.ts'
import { resources } from './resources.ts'

function keysOf(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) {
    return [prefix]
  }
  return Object.entries(value).flatMap(([key, nested]) =>
    keysOf(nested, prefix ? `${prefix}.${key}` : key),
  )
}

describe('переводы', () => {
  it.each([
    [1, '1 угода'],
    [2, '2 угоди'],
    [5, '5 угод'],
    [21, '21 угода'],
  ])('uk: %i → «%s»', (count, expected) => {
    expect(createI18n('uk').t('deals:count', { count })).toBe(expected)
  })

  it.each([
    [1, '1 сделка'],
    [2, '2 сделки'],
    [5, '5 сделок'],
    [21, '21 сделка'],
  ])('ru: %i → «%s»', (count, expected) => {
    expect(createI18n('ru').t('deals:count', { count })).toBe(expected)
  })

  it('язык по умолчанию — украинский', () => {
    const i18n = createI18n()
    expect(i18n.language).toBe('uk')
    expect(i18n.t('layout:nav.deals')).toBe('Угоди')
  })

  it('берёт язык, сохранённый в localStorage', () => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'ru')
    expect(createI18n().language).toBe('ru')
  })

  it('неизвестный язык в localStorage заменяет украинским', () => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'de')
    expect(createI18n().language).toBe('uk')
  })

  it('переключение языка меняет тексты и запоминается', async () => {
    const i18n = createI18n('uk')
    await i18n.changeLanguage('ru')
    expect(i18n.t('layout:nav.settings')).toBe('Настройки')
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('ru')
    expect(document.documentElement.lang).toBe('ru')
  })

  it('в русских файлах те же ключи, что в украинских', () => {
    expect(keysOf(resources.ru).sort()).toEqual(keysOf(resources.uk).sort())
  })
})
