import { describe, expect, it } from 'vitest'
import { createRolesApi, RolesApiError } from './roles-api.ts'

// Запрос групп полей для редактора ролей (тикет crm-fields/03): три сущности одним списком.

const PROJECT = '00000000-0000-4000-8000-000000000001'

function respond(byEntity: Record<string, { status: number; body: unknown }>) {
  const urls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    const entity = new URL(url, 'http://localhost').searchParams.get('entity') ?? ''
    const answer = byEntity[entity] ?? { status: 500, body: {} }
    return new Response(JSON.stringify(answer.body), { status: answer.status })
  }) as typeof fetch
  return { api: createRolesApi(fetchImpl), urls }
}

describe('createRolesApi().fieldGroups', () => {
  it('группы всех сущностей; сущность без права смотреть (403) — без групп', async () => {
    const { api, urls } = respond({
      deal: { status: 200, body: [{ id: 'd1', entity: 'deal' }] },
      contact: { status: 403, body: { code: 'PERMISSION_DENIED' } },
      organization: { status: 200, body: [{ id: 'o1', entity: 'organization' }] },
    })
    expect((await api.fieldGroups(PROJECT)).map((g) => g.id)).toEqual(['d1', 'o1'])
    expect(urls).toEqual([
      '/api/v1/field-groups?entity=deal',
      '/api/v1/field-groups?entity=contact',
      '/api/v1/field-groups?entity=organization',
    ])
  })

  it('другая ошибка — отказ с кодом', async () => {
    const { api } = respond({
      deal: { status: 200, body: [] },
      contact: { status: 500, body: { code: 'BOOM' } },
      organization: { status: 200, body: [] },
    })
    await expect(api.fieldGroups(PROJECT)).rejects.toBeInstanceOf(RolesApiError)
  })
})
