import { describe, expect, it } from 'vitest'
import { EVENT_CATALOG, EVENT_TYPES, eventBodyProblem, eventBodySchema } from './index.ts'

// Каталог событий (тикет crm-api/05): проверка тела по схеме типа и схема для описания API.

const ID = '0b6f6c1e-6a52-4d8e-9a4e-3f1d2c5b7a90'
const OTHER = '7c1d0e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f'

function body(
  type: string,
  facts: Record<string, unknown>,
  actor: unknown = { type: 'user', id: 'u1' },
) {
  return {
    type,
    timestamp: '2026-11-04T10:15:00.000Z',
    data: { event_id: `evt_${ID}`, project_id: OTHER, ...facts, actor },
  }
}

describe('каталог событий', () => {
  it('тело deal.stage_changed из примера тикета проходит схему', () => {
    const stageChanged = body(
      'deal.stage_changed',
      {
        deal_id: ID,
        from: { pipeline_id: ID, stage_id: OTHER },
        to: { pipeline_id: OTHER, stage_id: ID },
      },
      { type: 'api_key', id: OTHER },
    )
    expect(eventBodyProblem(stageChanged)).toBeNull()
  })

  it('лишнее поле в data — ошибка: имя или телефон в тело не попадут', () => {
    const withName = body('contact.created', { contact_id: ID, first_name: 'Вигадана' })
    expect(eventBodyProblem(withName)).toBe('data.first_name: лишнее поле')
  })

  it('нет факта, неверный вид факта, неизвестный тип, неверный автор — ошибка', () => {
    expect(eventBodyProblem(body('deal.won', { deal_id: ID }))).toBe('data.stage_id: нет поля')
    expect(eventBodyProblem(body('deal.won', { deal_id: ID, stage_id: 'x' }))).toBe(
      'data.stage_id: ожидается uuid',
    )
    expect(eventBodyProblem(body('deal.updated', { deal_id: ID }))).toBe(
      'type: неизвестный тип события',
    )
    expect(
      eventBodyProblem(
        body('deal.archived', { deal_id: ID }, { type: 'user', id: 'u1', name: 'Х' }),
      ),
    ).toBe('data.actor.name: лишнее поле')
    expect(
      eventBodyProblem(body('deal.archived', { deal_id: ID }, { type: 'api_key', id: 'k' })),
    ).toBe('data.actor.id: ожидается uuid')
  })

  it('ответственный — id пользователя или null', () => {
    const owner = (from: unknown, to: unknown) =>
      eventBodyProblem(
        body('deal.owner_changed', { deal_id: ID, from_user_id: from, to_user_id: to }),
      )
    expect(owner(null, 'u2')).toBeNull()
    expect(owner('u1', null)).toBeNull()
    expect(owner('', null)).toBe('data.from_user_id: ожидается id пользователя или null')
  })

  it('схема для описания API называет каждое поле data из каталога', () => {
    for (const type of EVENT_TYPES) {
      const schema = eventBodySchema(type)
      const data = schema.properties.data
      expect(data.required).toEqual([
        'event_id',
        'project_id',
        ...Object.keys(EVENT_CATALOG[type].facts),
        'actor',
      ])
      expect(Object.keys(data.properties)).toEqual(data.required)
      expect(schema.properties.type.const).toBe(type)
    }
  })
})
