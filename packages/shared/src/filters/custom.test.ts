import { describe, expect, it } from 'vitest'
import { customOperators, customSortable, parseCustomRef } from './custom.ts'
import { parseColumns, parseFilter, parseSort, withoutUnavailable } from './index.ts'

// Условия, сортировка и колонки по пользовательским полям (тикет crm-fields/07): разбор без
// базы. Поиск по базе — apps/api/src/filters/custom-fields.test.ts.

const NUM = { id: '11111111-1111-4111-8111-111111111111', code: 'num', type: 'number' } as const
const RNG = { id: '22222222-2222-4222-8222-222222222222', code: 'rng', type: 'date_range' } as const
const PH = { id: '33333333-3333-4333-8333-333333333333', code: 'ph', type: 'phone' } as const
const MANY = {
  id: '44444444-4444-4444-8444-444444444444',
  code: 'many',
  type: 'multi_option',
} as const
const CATALOG = [NUM, RNG, PH, MANY]
const OPTION = '55555555-5555-4555-8555-555555555555'

describe('ссылка на пользовательское поле', () => {
  it('код или id, у интервала дат — часть .start / .end', () => {
    expect(parseCustomRef('custom.num')).toEqual({ key: 'num' })
    expect(parseCustomRef(`custom.${RNG.id}.end`)).toEqual({ key: RNG.id, part: 'end' })
    expect(parseCustomRef('title')).toBeNull()
    expect(parseCustomRef('custom.')).toBeNull()
  })

  it('операторы по типу поля', () => {
    expect(customOperators('number')).toContain('between')
    expect(customOperators('date_range')).toEqual([])
    expect(customOperators('date_range', 'start')).toEqual(['lt', 'gt', 'between', 'empty'])
    expect(customOperators('multi_option')).toEqual(['in', 'not_in', 'empty', 'not_empty'])
    expect(customSortable('multi_option')).toBe(false)
    expect(customSortable('money')).toBe(true)
  })
})

describe('parseFilter с пользовательскими полями', () => {
  it('приводит ссылку по коду к id, а значения — к единому виду', () => {
    const parsed = parseFilter(
      'deals',
      {
        and: [
          { field: 'custom.num', op: 'between', value: [1, 5] },
          { field: 'custom.rng.start', op: 'lt', value: '2026-02-01' },
          { field: 'custom.ph', op: 'eq', value: '050 111 22 33' },
          { field: 'custom.many', op: 'in', value: [OPTION.toUpperCase(), OPTION] },
          { field: 'title', op: 'contains', value: 'Альфа' },
        ],
      },
      CATALOG,
    )
    expect(parsed).toEqual({
      ok: true,
      filter: {
        and: [
          { field: `custom.${NUM.id}`, op: 'between', value: [1, 5] },
          { field: `custom.${RNG.id}.start`, op: 'lt', value: '2026-02-01' },
          { field: `custom.${PH.id}`, op: 'eq', value: '+380501112233' },
          { field: `custom.${MANY.id}`, op: 'in', value: [OPTION] },
          { field: 'title', op: 'contains', value: 'Альфа' },
        ],
      },
    })
  })

  it.each([
    ['оператор не своего типа', { field: 'custom.num', op: 'contains', value: 'x' }, '.op'],
    ['«от» больше «до»', { field: 'custom.num', op: 'between', value: [5, 1] }, '.value'],
    ['интервал без части', { field: 'custom.rng', op: 'lt', value: '2026-01-01' }, '.op'],
    ['несуществующая дата', { field: 'custom.rng.end', op: 'gt', value: '2026-02-30' }, '.value'],
    ['число вне предела', { field: 'custom.num', op: 'eq', value: 1e15 }, '.value'],
    ['between у системного поля', { field: 'amount', op: 'between', value: [1, 2] }, '.op'],
  ])('%s — ошибка с путём', (_label, condition, suffix) => {
    const parsed = parseFilter('deals', { and: [condition] }, CATALOG)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.error.path).toBe(`.and.0${suffix}`)
      expect(parsed.error.unknownCustomField).toBeUndefined()
    }
  })

  it('неизвестное поле — отдельная пометка (ответ 422)', () => {
    const parsed = parseFilter('deals', { and: [{ field: 'custom.nope', op: 'empty' }] }, CATALOG)
    expect(parsed).toMatchObject({ ok: false, error: { unknownCustomField: 'custom.nope' } })
  })
})

describe('сортировка, колонки и недоступные условия', () => {
  it('сортировка по полю — по id; «несколько вариантов» не сортируется', () => {
    expect(parseSort('deals', 'custom.num:desc', CATALOG)).toEqual({
      column: `custom.${NUM.id}`,
      direction: 'desc',
    })
    expect(parseSort('deals', 'custom.many:asc', CATALOG)).toBeNull()
  })

  it('колонки выгрузки: код и id, неизвестное поле помечено', () => {
    expect(parseColumns('deals', ['title', 'custom.num'], CATALOG)).toEqual({
      ok: true,
      columns: ['title', `custom.${NUM.id}`],
    })
    expect(parseColumns('deals', ['custom.nope'], CATALOG)).toEqual({
      ok: false,
      unknownCustomField: 'custom.nope',
    })
  })

  it('условия по недоступным полям убираются и считаются', () => {
    const filter = {
      or: [
        { field: `custom.${NUM.id}`, op: 'eq' as const, value: 1 },
        { and: [{ field: 'custom.99999999-9999-4999-8999-999999999999', op: 'empty' as const }] },
      ],
    }
    expect(withoutUnavailable(filter, CATALOG)).toEqual({
      filter: { or: [{ field: `custom.${NUM.id}`, op: 'eq', value: 1 }] },
      removed: 1,
    })
  })
})
