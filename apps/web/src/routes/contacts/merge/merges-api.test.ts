import { PROJECT_HEADER } from '@alpi/shared'
import { describe, expect, it } from 'vitest'
import { createMergesApi, MergesApiError } from './merges-api.tsx'

// Настоящий клиент слияния с подменённым fetch: что именно уходит в запросе. Без заголовка
// проекта API отвечает 400 PROJECT_REQUIRED (apps/api/src/middleware/project-context.ts).

interface Sent {
  url: string
  init: RequestInit
}

function recordingFetch(status = 200, payload: unknown = {}) {
  const sent: Sent[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), init: init ?? {} })
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { sent, fetchImpl }
}

function headersOf(request: Sent | undefined): Headers {
  return new Headers(request?.init.headers)
}

describe('createMergesApi', () => {
  it('запрос с телом несёт заголовок проекта и content-type JSON', async () => {
    const { sent, fetchImpl } = recordingFetch()
    await createMergesApi(fetchImpl).merge('project-1', 'survivor-1', 'merged-1')

    expect(sent).toHaveLength(1)
    expect(sent[0]?.url).toBe('/api/v1/contacts/survivor-1/merge')
    expect(sent[0]?.init.method).toBe('POST')
    const headers = headersOf(sent[0])
    expect(headers.get(PROJECT_HEADER)).toBe('project-1')
    expect(headers.get('content-type')).toBe('application/json')
    expect(JSON.parse(String(sent[0]?.init.body))).toEqual({ merge_contact_id: 'merged-1' })
  })

  it('запрос без тела несёт заголовок проекта и не объявляет content-type', async () => {
    const { sent, fetchImpl } = recordingFetch(200, [])
    await createMergesApi(fetchImpl).contactMerges('project-2', 'contact-1')

    expect(sent[0]?.url).toBe('/api/v1/contacts/contact-1/merges')
    const headers = headersOf(sent[0])
    expect(headers.get(PROJECT_HEADER)).toBe('project-2')
    expect(headers.get('content-type')).toBeNull()
    expect(sent[0]?.init.body).toBeUndefined()
  })

  it('откат и предпросмотр тоже идут в контексте проекта', async () => {
    const { sent, fetchImpl } = recordingFetch()
    const api = createMergesApi(fetchImpl)
    await api.undo('project-3', 'merge-1')
    await api.preview('project-3', 'survivor-1', 'merged-1')

    expect(sent.map((s) => s.url)).toEqual([
      '/api/v1/merges/merge-1/undo',
      '/api/v1/contacts/survivor-1/merge/preview',
    ])
    for (const request of sent) expect(headersOf(request).get(PROJECT_HEADER)).toBe('project-3')
  })

  it('отказ API — MergesApiError с кодом и подробностями', async () => {
    const { fetchImpl } = recordingFetch(409, { code: 'MERGE_UNDO_EXPIRED', details: { a: 1 } })
    const error = await createMergesApi(fetchImpl)
      .undo('project-1', 'merge-1')
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(MergesApiError)
    expect(error).toMatchObject({ status: 409, code: 'MERGE_UNDO_EXPIRED', details: { a: 1 } })
  })
})
