import { describe, expect, it } from 'vitest'
import {
  FIELD_CODE_MAX_LENGTH,
  type FieldOptionSummary,
  fieldCodeEditable,
  fieldCodeFromName,
  fieldCodeProblem,
  fieldCodeWithSuffix,
  fieldName,
  offeredOptions,
} from './index.ts'
import { transliterateUk } from './transliterate.ts'

// Правила кода пользовательского поля (тикет crm-fields/01): одни для клиента и сервера.

describe('transliterateUk — таблица КМУ 2010', () => {
  it.each([
    ['Головний мотив', 'holovnyi motyv'],
    // є, ї, й, ю, я: в начале слова — ye, yi, y, yu, ya; дальше — ie, i, i, iu, ia.
    ['Єнакієве', 'yenakiieve'],
    ['Їжакевич', 'yizhakevych'],
    ['Йосипівка', 'yosypivka'],
    ['Юрій', 'yurii'],
    ['Яготин', 'yahotyn'],
    ['Згурівка', 'zghurivka'],
    ['Знам’янка', 'znamianka'],
    ["Олександр Щербак'", 'oleksandr shcherbak'],
    ['Ґудзик Хмельницький', 'gudzyk khmelnytskyi'],
  ])('«%s» → «%s»', (input, expected) => {
    expect(transliterateUk(input)).toBe(expected)
  })
})

describe('fieldCodeFromName', () => {
  it('«Головний мотив» → holovnyi_motyv', () => {
    expect(fieldCodeFromName('Головний мотив')).toBe('holovnyi_motyv')
  })

  it('знаки — один `_`, без `_` по краям; латиница и цифры остаются', () => {
    expect(fieldCodeFromName('  Бюджет (EUR), 2026 рік! ')).toBe('biudzhet_eur_2026_rik')
  })

  it('начинается не с буквы — префикс f_; пусто — field', () => {
    expect(fieldCodeFromName('2 рівень')).toBe('f_2_riven')
    expect(fieldCodeFromName('!!!')).toBe('field')
  })

  it('не длиннее 63 символов и не кончается на `_`', () => {
    const code = fieldCodeFromName(`${'а'.repeat(62)} б`)
    expect(code.length).toBeLessThanOrEqual(FIELD_CODE_MAX_LENGTH)
    expect(code).toBe('a'.repeat(62))
    expect(fieldCodeProblem('deal', fieldCodeFromName('ж'.repeat(100)))).toBeNull()
  })

  it('суффикс помещается в 63 символа', () => {
    expect(fieldCodeWithSuffix('status', 2)).toBe('status_2')
    const long = fieldCodeWithSuffix('a'.repeat(63), 12)
    expect(long).toBe(`${'a'.repeat(60)}_12`)
  })
})

describe('fieldCodeProblem', () => {
  it.each(['holovnyi_motyv', 'a', 'x1_2', 'a'.repeat(63)])('«%s» допустим', (code) => {
    expect(fieldCodeProblem('deal', code)).toBeNull()
  })

  it.each(['', '1abc', '_abc', 'Abc', 'abc-def', 'код', 'a b', 'a'.repeat(64)])(
    '«%s» — не по формату',
    (code) => {
      expect(fieldCodeProblem('deal', code)).toBe('format')
    },
  )

  it('коды системных полей своей сущности запрещены, чужой — нет', () => {
    for (const code of ['title', 'stage', 'amount', 'currency', 'owner', 'status', 'custom']) {
      expect(fieldCodeProblem('deal', code)).toBe('system')
    }
    expect(fieldCodeProblem('contact', 'first_name')).toBe('system')
    expect(fieldCodeProblem('organization', 'website')).toBe('system')
    expect(fieldCodeProblem('contact', 'title')).toBeNull()
  })
})

describe('названия, варианты, редактируемость кода', () => {
  it('русского названия нет — показывается украинское', () => {
    expect(fieldName({ nameUk: 'Мотив', nameRu: null }, 'ru')).toBe('Мотив')
    expect(fieldName({ nameUk: 'Мотив', nameRu: 'Мотив ру' }, 'ru')).toBe('Мотив ру')
    expect(fieldName({ nameUk: 'Мотив', nameRu: 'Мотив ру' }, 'uk')).toBe('Мотив')
  })

  it('архивный вариант не предлагается', () => {
    const option = (id: string, archivedAt: string | null): FieldOptionSummary => ({
      id,
      nameUk: id,
      nameRu: null,
      position: 1,
      archivedAt,
    })
    const options = [option('a', null), option('b', '2026-11-01T00:00:00.000Z')]
    expect(offeredOptions({ options }).map((o) => o.id)).toEqual(['a'])
  })

  it('код меняется, только пока нет значений и нет отметки «часто фильтруют»', () => {
    expect(fieldCodeEditable({ firstValueAt: null, isFrequentlyFiltered: false })).toBe(true)
    expect(fieldCodeEditable({ firstValueAt: '2026-11-01', isFrequentlyFiltered: false })).toBe(
      false,
    )
    expect(fieldCodeEditable({ firstValueAt: null, isFrequentlyFiltered: true })).toBe(false)
  })
})
