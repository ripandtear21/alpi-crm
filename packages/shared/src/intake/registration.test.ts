import { describe, expect, it } from 'vitest'
import { type ParsedRegistration, parseRegistration, registrationEventId } from './registration.ts'

// Разбор тела регистрации (тикет crm-intake/06) без базы: что уходит в столбцы, а что — в
// `extra`. Телефон и email — выдуманные.

const base = { event_id: 'evt-1', phone: '+380671234567' }

function parsed(body: Record<string, unknown>): ParsedRegistration {
  const result = parseRegistration(body)
  if (!result.ok) throw new Error(`тело отклонено: ${result.code}`)
  return result.value
}

describe('registered_at', () => {
  it.each([
    ['0001-01-01T00:00:00Z', '0001-01-01T00:00:00.000Z'],
    ['9999-12-31T23:59:59Z', '9999-12-31T23:59:59.000Z'],
    ['2026-11-27T09:15:00+02:00', '2026-11-27T07:15:00.000Z'],
  ])('год 1–9999 по UTC — в столбец: «%s»', (raw, iso) => {
    const value = parsed({ ...base, registered_at: raw })
    expect(value.registeredAt).toBe(iso)
    expect(value.extra).toEqual({})
  })

  it.each([
    '0000-01-01T00:00:00Z',
    '-000001-01-01T00:00:00Z',
    '+010000-01-01T00:00:00Z',
    '0001-01-01T00:00:00+01:00',
    'вчора',
  ])('год вне 1–9999 по UTC или не дата — null, как прислано — в extra: «%s»', (raw) => {
    const value = parsed({ ...base, registered_at: raw })
    expect(value.registeredAt).toBeNull()
    expect(value.extra).toEqual({ registered_at: raw })
  })
})

describe('строки, которые PostgreSQL не хранит', () => {
  const lone = String.fromCharCode(0xd83d)
  const low = String.fromCharCode(0xde00)
  const replacement = String.fromCharCode(0xfffd)
  const nul = String.fromCharCode(0)

  it('одиночная половинка суррогатной пары в extra (строки и ключи, вложенные тоже) — U+FFFD', () => {
    const value = parsed({
      ...base,
      comment: `abc${lone}`,
      [`key${low}`]: [`x${low}y`, { [`in${lone}`]: `${lone}${low}${low}` }],
    })
    expect(value.extra).toEqual({
      comment: `abc${replacement}`,
      [`key${replacement}`]: [
        `x${replacement}y`,
        { [`in${replacement}`]: `${lone}${low}${replacement}` },
      ],
    })
  })

  it('две старшие половинки подряд перед младшей — заменяется только первая', () => {
    expect(parsed({ ...base, comment: `${lone}${lone}${low}` }).extra).toEqual({
      comment: `${replacement}${lone}${low}`,
    })
  })

  it('полная суррогатная пара (эмодзи) не меняется', () => {
    expect(parsed({ ...base, comment: 'ok 😀' }).extra).toEqual({ comment: 'ok 😀' })
  })

  it('строковые поля — так же: без NUL, половинка — U+FFFD', () => {
    const value = parsed({ ...base, name: `Оле${nul}на${lone}`, form: `${low}форма` })
    expect(value.text.name).toBe(`Олена${replacement}`)
    expect(value.text.form).toBe(`${replacement}форма`)
  })
})

describe('ключ __proto__', () => {
  it('ключ __proto__ из тела — обычный ключ extra и попадает в JSON', () => {
    const body = JSON.parse(
      '{"event_id":"evt-1","phone":"+380671234567","__proto__":{"polluted":1},"a":{"__proto__":2}}',
    ) as Record<string, unknown>
    const { extra } = parsed(body)
    expect(Object.hasOwn(extra, '__proto__')).toBe(true)
    expect(Object.getOwnPropertyDescriptor(extra, '__proto__')?.value).toEqual({ polluted: 1 })
    expect(JSON.parse(JSON.stringify(extra))).toEqual(
      JSON.parse('{"__proto__":{"polluted":1},"a":{"__proto__":2}}'),
    )
    expect(JSON.stringify(extra)).toBe('{"__proto__":{"polluted":1},"a":{"__proto__":2}}')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('registrationEventId', () => {
  const nul = String.fromCharCode(0)

  it.each([
    [{ event_id: '  evt-1 ' }, 'evt-1'],
    [{ event_id: 42 }, '42'],
    [{ event_id: true }, 'true'],
    [{ event_id: `ev${nul}t` }, 'evt'],
    [{ event_id: `${'x'.repeat(250)}${nul.repeat(10)}` }, 'x'.repeat(250)],
  ])('%j → «%s», как в разборе тела', (body, id) => {
    expect(registrationEventId(body)).toBe(id)
    expect(parsed({ ...base, ...body }).eventId).toBe(id)
  })

  it.each([
    [{}],
    [{ event_id: null }],
    [{ event_id: '   ' }],
    [{ event_id: ` ${nul} ` }],
    [{ event_id: 'x'.repeat(256) }],
    [{ event_id: { id: 1 } }],
    [null],
    [[1]],
  ])('%j → null, разбор — INVALID_EVENT_ID или INVALID_REGISTRATION', (body) => {
    expect(registrationEventId(body)).toBeNull()
    expect(parseRegistration(body).ok).toBe(false)
  })
})
