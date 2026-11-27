import { randomInt } from 'node:crypto'
import type { InboundReplayStatus, IntakeSourceWithKey } from '@alpi/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import {
  type ApiHarness,
  ORIGIN,
  type SignedInUser,
  startApiHarness,
  type Target,
} from '../testing/api-harness.ts'
import { createApiKey, createRole } from '../testing/api-key.ts'
import { problemOf } from '../testing/problem.ts'
import { type InboundReplayMessage, replayInbound } from './replay.ts'

// Ход и итог «провести заново» для экрана «Налаштування → Джерела» (тикет crm-intake/07):
// `GET /v1/inbound/replay` на настоящем PostgreSQL. Очередь — список: задача выполняется вызовом
// replayInbound, как её выполнил бы pg-boss. Телефоны выдуманные.

describe('ход и итог «провести заново»', () => {
  let h: ApiHarness
  let app: Target
  let admin: SignedInUser
  let manager: SignedInUser
  let projectId: string
  let source: IntakeSourceWithKey
  const queued: InboundReplayMessage[] = []

  const status = (user: SignedInUser) =>
    user.call(app, 'GET', '/v1/inbound/replay', { project: projectId })

  async function latest(): Promise<InboundReplayStatus['latest']> {
    const res = await status(admin)
    expect(res.status).toBe(200)
    return ((await res.json()) as InboundReplayStatus).latest
  }

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_inbound_replay_status')
    app = createApp({
      auth: h.auth,
      db: h.appDb,
      inbound: {
        async enqueueReplay(_trx, message) {
          queued.push(message)
        },
      },
    })
    admin = await h.signIn('owner')
    manager = await h.signIn()
    projectId = (await h.createProject(admin, 'Повтор вхідних')).id
    await h.addMember(projectId, manager.id, 'manager')
    const pipeline = await h.owner
      .insertInto('pipeline')
      .values({ project_id: projectId, code: 'replay', name: 'Воронка повтору', position: 50 })
      .returning('id')
      .executeTakeFirstOrThrow()
    await h.owner
      .insertInto('stage')
      .values({ project_id: projectId, pipeline_id: pipeline.id, name: 'Новий', position: 1 })
      .execute()
    const res = await admin.api('POST', '/v1/intake-sources', {
      project: projectId,
      body: { name: 'Форма повтору', pipelineId: pipeline.id },
    })
    expect(res.status).toBe(201)
    source = (await res.json()) as IntakeSourceWithKey
  })

  afterAll(async () => {
    await h?.stop()
  })

  it('запусков не было — latest: null; после запуска — идёт; после задачи — итог', async () => {
    expect(await latest()).toBeNull()

    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const accepted = await app.request(`${ORIGIN}/intake/registrations`, {
      method: 'POST',
      headers: { origin: ORIGIN, authorization: `Bearer ${source.key}` },
      body: JSON.stringify({
        event_id: `status-${randomInt(1e9)}`,
        phone: `+38050${randomInt(1_000_000, 9_999_999)}`,
      }),
    })
    expect(accepted.status).toBe(201)

    const started = await admin.call(app, 'POST', '/v1/inbound/replay', {
      project: projectId,
      body: { since },
    })
    expect(started.status).toBe(202)
    const running = await latest()
    expect(running).toMatchObject({
      since,
      startedBy: { id: admin.id },
      finishedAt: null,
      counts: null,
    })
    expect(running?.until).toBe(queued.at(-1)?.until)

    await replayInbound(h.appDb, queued.at(-1) as InboundReplayMessage)
    const finished = await latest()
    expect(finished?.since).toBe(since)
    expect(finished?.finishedAt).not.toBeNull()
    expect(finished?.counts).toEqual({ accepted: 0, repeats: 1, errors: 0 })
  })

  it('не администратор — 403; ключ API — 403 API_KEY_NOT_ALLOWED', async () => {
    const notAdmin = await status(manager)
    expect(notAdmin.status).toBe(403)
    expect(await problemOf(notAdmin)).toEqual({ code: 'PERMISSION_DENIED' })

    const key = await createApiKey(
      h,
      admin,
      projectId,
      await createRole(h, projectId, { actions: { deals: ['view'] }, scopes: {} } as never),
    )
    const byKey = await key.call(app, 'GET', '/v1/inbound/replay', {})
    expect(byKey.status).toBe(403)
    expect(await problemOf(byKey)).toEqual({ code: 'API_KEY_NOT_ALLOWED' })
  })
})
