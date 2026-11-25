import { randomInt } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { withProject } from '@alpi/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { type FileView, MAX_FILE_BYTES } from '../files/files.ts'
import type { NoteView } from '../notes/notes.ts'
import { localDiskStorage } from '../storage/storage.ts'
import {
  type ApiHarness,
  type Method,
  type SignedInUser,
  startApiHarness,
  type Target,
} from '../testing/api-harness.ts'
import { problemOf } from '../testing/problem.ts'
import type { TimelineItem, TimelinePage } from './timeline.ts'

// Заметки, файлы и лента сделки, контакта и организации (тикет crm-deals/07): изоляция проектов,
// права и охват, проверки загрузки и скачивания, порядок и курсор ленты — на настоящем
// PostgreSQL (API ходит ролью приложения) и настоящем каталоге хранилища. Имена — вымышленные.

const text = (value: string) => new TextEncoder().encode(value)

describe('заметки, файлы и лента', () => {
  let h: ApiHarness
  let app: Target
  /** Каталог, внутри которого — только каталог хранилища `root`. */
  let base: string
  let root: string
  let admin: SignedInUser
  let projectA: string
  let projectB: string
  let manager1: SignedInUser
  let manager2: SignedInUser
  /** «Керівник»: всё в проекте, с правом удалять. */
  let head: SignedInUser
  let stageA: { pipeline: string; stage: string }

  async function createDeal(projectId: string, ownerId: string | null, stage = stageA) {
    const contact = await h.owner
      .insertInto('contact')
      .values({
        project_id: projectId,
        first_name: `Клієнт ${randomInt(1e9)}`,
        created_by: ownerId,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const deal = await h.owner
      .insertInto('deal')
      .values({
        project_id: projectId,
        title: 'Курс',
        pipeline_id: stage.pipeline,
        stage_id: stage.stage,
        primary_contact_id: contact.id,
        owner_id: ownerId,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return { deal: deal.id, contact: contact.id }
  }

  async function createStage(projectId: string) {
    const pipeline = await h.owner
      .insertInto('pipeline')
      .values({ project_id: projectId, code: `p${randomInt(1e9)}`, name: 'Воронка', position: 1 })
      .returning('id')
      .executeTakeFirstOrThrow()
    const stage = await h.owner
      .insertInto('stage')
      .values({ project_id: projectId, pipeline_id: pipeline.id, name: 's1', position: 1 })
      .returning('id')
      .executeTakeFirstOrThrow()
    return { pipeline: pipeline.id, stage: stage.id }
  }

  const call = (user: SignedInUser, method: Method, url: string, project: string, body?: unknown) =>
    user.call(app, method, url, { project, body })

  /** Загрузка: тело — сами байты файла, как fetch(url, { body: file }). */
  function upload(
    user: SignedInUser,
    url: string,
    project: string,
    content: Uint8Array,
    contentLength?: number,
  ) {
    const target: Target = {
      request: (input, init) => {
        const headers = new Headers(init.headers)
        headers.set('content-type', 'application/octet-stream')
        if (contentLength !== undefined) headers.set('content-length', String(contentLength))
        return app.request(input, { ...init, headers, body: content })
      },
    }
    return user.call(target, 'POST', url, { project })
  }

  async function storedFiles(): Promise<string[]> {
    const entries = await readdir(root, { recursive: true, withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
      .sort()
  }

  beforeAll(async () => {
    h = await startApiHarness('alpi_test_records')
    base = await mkdtemp(path.join(tmpdir(), 'alpi-files-'))
    root = path.join(base, 'storage')
    await mkdir(root)
    app = createApp({ auth: h.auth, db: h.appDb, storage: localDiskStorage(root) })
    admin = await h.signIn('owner')
    projectA = (await h.createProject(admin, 'Записи А')).id
    projectB = (await h.createProject(admin, 'Записи Б')).id
    manager1 = await h.signIn()
    manager2 = await h.signIn()
    head = await h.signIn()
    await h.addMember(projectA, manager1.id, 'manager')
    await h.addMember(projectA, manager2.id, 'manager')
    await h.addMember(projectA, head.id, 'head')
    stageA = await createStage(projectA)
  })

  afterAll(async () => {
    await h?.stop()
    if (base) await rm(base, { recursive: true, force: true })
  })

  describe('изоляция проектов', () => {
    it('заметки и файлы проекта A не видны в B; файл A не скачать с заголовком B, зная id', async () => {
      const a = await createDeal(projectA, manager1.id)
      const stageB = await createStage(projectB)
      const b = await createDeal(projectB, null, stageB)
      const note = await call(manager1, 'POST', `/v1/deals/${a.deal}/notes`, projectA, {
        text: 'Секрет проєкту А',
      })
      expect(note.status).toBe(201)
      const uploaded = await upload(
        manager1,
        `/v1/deals/${a.deal}/files?name=a.txt`,
        projectA,
        text('файл А'),
      )
      expect(uploaded.status).toBe(201)
      const file = (await uploaded.json()) as FileView

      // Запись A с заголовком B: её нет.
      for (const url of [
        `/v1/deals/${a.deal}/notes`,
        `/v1/deals/${a.deal}/files`,
        `/v1/deals/${a.deal}/files/${file.id}`,
        `/v1/deals/${a.deal}/timeline`,
      ]) {
        const res = await call(admin, 'GET', url, projectB)
        expect(res.status, url).toBe(404)
        expect(await problemOf(res)).toEqual({ code: 'DEAL_NOT_FOUND' })
      }
      // Своя запись B и id файла A: файла нет.
      const foreign = await call(admin, 'GET', `/v1/deals/${b.deal}/files/${file.id}`, projectB)
      expect(foreign.status).toBe(404)
      expect(await problemOf(foreign)).toEqual({ code: 'FILE_NOT_FOUND' })
      expect(
        (await call(admin, 'DELETE', `/v1/deals/${b.deal}/files/${file.id}`, projectB)).status,
      ).toBe(404)
      expect(
        await (await call(admin, 'GET', `/v1/deals/${b.deal}/notes`, projectB)).json(),
      ).toEqual([])
      // Ссылка из B на запись A не пройдёт и мимо API: составной внешний ключ и RLS.
      await expect(
        withProject(h.appDb, projectB, (trx) =>
          trx
            .insertInto('note')
            .values({ project_id: projectB, deal_id: a.deal, text: 'x', author_id: admin.id })
            .execute(),
        ),
      ).rejects.toThrow(/note_deal_fkey/)
      const seen = await withProject(h.appDb, projectB, (trx) =>
        Promise.all([
          trx.selectFrom('note').select('id').execute(),
          trx.selectFrom('file').select('id').execute(),
        ]),
      )
      expect(seen).toEqual([[], []])
      // Ключ объекта начинается с id проекта.
      expect(await storedFiles()).toContain(path.join(projectA, file.id))
    })
  })

  describe('права и охват', () => {
    it('менеджер «свои» не читает и не добавляет заметки и файлы сделки коллеги — 404', async () => {
      const { deal } = await createDeal(projectA, manager1.id)
      const before = await storedFiles()
      expect(
        (await call(manager1, 'POST', `/v1/deals/${deal}/notes`, projectA, { text: 'Моя' })).status,
      ).toBe(201)
      for (const url of [`/v1/deals/${deal}/notes`, `/v1/deals/${deal}/files`]) {
        expect((await call(manager2, 'GET', url, projectA)).status, url).toBe(404)
      }
      expect((await call(manager2, 'GET', `/v1/deals/${deal}/timeline`, projectA)).status).toBe(404)
      const add = await call(manager2, 'POST', `/v1/deals/${deal}/notes`, projectA, { text: 'x' })
      expect(add.status).toBe(404)
      const file = await upload(manager2, `/v1/deals/${deal}/files?name=a.txt`, projectA, text('x'))
      expect(file.status).toBe(404)
      expect(await storedFiles()).toEqual(before)
    })

    it('чужую заметку менеджер не меняет и не удаляет — 403; автор меняет, «удалять» удаляет', async () => {
      // Сделка общей очереди: её видят и меняют оба менеджера.
      const { deal } = await createDeal(projectA, null)
      const created = await call(manager2, 'POST', `/v1/deals/${deal}/notes`, projectA, {
        text: '  Перший дзвінок  ',
      })
      expect(created.status).toBe(201)
      const note = (await created.json()) as NoteView
      expect(note).toMatchObject({ text: 'Перший дзвінок', authorId: manager2.id })

      const url = `/v1/deals/${deal}/notes/${note.id}`
      const edit = await call(manager1, 'PUT', url, projectA, { text: 'Підміна' })
      expect(edit.status).toBe(403)
      expect(await problemOf(edit)).toEqual({ code: 'PERMISSION_DENIED' })
      expect((await call(manager1, 'DELETE', url, projectA)).status).toBe(403)
      // Руководитель с правом «удалять» тоже не меняет чужую заметку.
      expect((await call(head, 'PUT', url, projectA, { text: 'Підміна' })).status).toBe(403)

      const own = await call(manager2, 'PUT', url, projectA, { text: 'Другий дзвінок' })
      expect(own.status).toBe(200)
      expect((await own.json()) as NoteView).toMatchObject({ text: 'Другий дзвінок' })
      expect((await call(manager2, 'PUT', url, projectA, { text: ' ' })).status).toBe(400)

      expect((await call(head, 'DELETE', url, projectA)).status).toBe(204)
      expect((await call(head, 'DELETE', url, projectA)).status).toBe(404)

      // Свою заметку автор удаляет сам.
      const second = (await (
        await call(manager1, 'POST', `/v1/deals/${deal}/notes`, projectA, { text: 'Моя' })
      ).json()) as NoteView
      expect(
        (await call(manager1, 'DELETE', `/v1/deals/${deal}/notes/${second.id}`, projectA)).status,
      ).toBe(204)
    })

    it('чужой файл менеджер не удаляет — 403; автор и «удалять» удаляют вместе с объектом', async () => {
      const { deal } = await createDeal(projectA, null)
      const files: FileView[] = []
      for (let i = 0; i < 2; i++) {
        const res = await upload(
          manager2,
          `/v1/deals/${deal}/files?name=f${i}.txt`,
          projectA,
          text('x'),
        )
        expect(res.status).toBe(201)
        files.push((await res.json()) as FileView)
      }
      const [mine, other] = files as [FileView, FileView]
      const url = (file: FileView) => `/v1/deals/${deal}/files/${file.id}`
      expect((await call(manager1, 'DELETE', url(mine), projectA)).status).toBe(403)
      expect((await call(manager2, 'DELETE', url(mine), projectA)).status).toBe(204)
      expect((await call(head, 'DELETE', url(other), projectA)).status).toBe(204)
      const left = await storedFiles()
      for (const file of files) expect(left).not.toContain(path.join(projectA, file.id))
      expect((await call(manager2, 'GET', url(mine), projectA)).status).toBe(404)
    })

    it('контакт и организация: заметки и файлы по их правам', async () => {
      const { contact } = await createDeal(projectA, manager1.id)
      const organization = await h.owner
        .insertInto('organization')
        .values({ project_id: projectA, name: 'ТОВ Тест' })
        .returning('id')
        .executeTakeFirstOrThrow()
      for (const url of [`/v1/contacts/${contact}`, `/v1/organizations/${organization.id}`]) {
        const added = await call(manager1, 'POST', `${url}/notes`, projectA, { text: 'Нотатка' })
        expect(added.status, url).toBe(201)
        const file = await upload(manager1, `${url}/files?name=a.txt`, projectA, text('x'))
        expect(file.status, url).toBe(201)
        const page = (await (
          await call(manager1, 'GET', `${url}/timeline`, projectA)
        ).json()) as TimelinePage
        expect(page.data.map((i) => i.kind).sort()).toEqual(['file', 'note'])
      }
      // Контакт чужой сделки и не созданный им — не «свой» для второго менеджера.
      expect((await call(manager2, 'GET', `/v1/contacts/${contact}/notes`, projectA)).status).toBe(
        404,
      )
      // У организаций охвата нет: видит каждый с правом на организации.
      expect(
        (await call(manager2, 'GET', `/v1/organizations/${organization.id}/notes`, projectA))
          .status,
      ).toBe(200)
    })
  })

  describe('загрузка и скачивание', () => {
    it('25 МБ — принят; 25 МБ + 1 байт — 413 и без файла на диске', async () => {
      const { deal } = await createDeal(projectA, manager1.id)
      const url = `/v1/deals/${deal}/files?name=big.txt`
      const before = await storedFiles()

      const exact = await upload(manager1, url, projectA, new Uint8Array(MAX_FILE_BYTES).fill(0x61))
      expect(exact.status).toBe(201)
      const big = (await exact.json()) as FileView
      expect(big).toMatchObject({
        name: 'big.txt',
        contentType: 'text/plain',
        size: MAX_FILE_BYTES,
      })

      const over = new Uint8Array(MAX_FILE_BYTES + 1).fill(0x61)
      // Без Content-Length: отказ по счёту байт потока.
      const streamed = await upload(manager1, url, projectA, over)
      expect(streamed.status).toBe(413)
      expect(await problemOf(streamed)).toEqual({
        code: 'FILE_TOO_LARGE',
        details: { maxBytes: MAX_FILE_BYTES },
      })
      // С Content-Length: отказ до чтения тела.
      expect((await upload(manager1, url, projectA, over, over.byteLength)).status).toBe(413)

      expect(await storedFiles()).toEqual([...before, path.join(projectA, big.id)].sort())
      const list = (await (
        await call(manager1, 'GET', `/v1/deals/${deal}/files`, projectA)
      ).json()) as FileView[]
      expect(list.map((f) => f.id)).toEqual([big.id])
    })

    it('файл .pdf с содержимым HTML — 415; настоящий PDF — application/pdf', async () => {
      const { deal } = await createDeal(projectA, manager1.id)
      const html = await upload(
        manager1,
        `/v1/deals/${deal}/files?name=invoice.pdf`,
        projectA,
        text('<!DOCTYPE html><html><body><script>alert(1)</script></body></html>'),
      )
      expect(html.status).toBe(415)
      expect(await problemOf(html)).toEqual({ code: 'UNSUPPORTED_FILE_TYPE' })
      const svg = await upload(
        manager1,
        `/v1/deals/${deal}/files?name=logo.png`,
        projectA,
        text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      )
      expect(svg.status).toBe(415)

      const pdf = await upload(
        manager1,
        `/v1/deals/${deal}/files?name=invoice.html`,
        projectA,
        text('%PDF-1.7\n%âãÏÓ\n'),
      )
      expect(pdf.status).toBe(201)
      expect(((await pdf.json()) as FileView).contentType).toBe('application/pdf')
      // Пустой файл и файл без имени не принимаются.
      expect(
        (await upload(manager1, `/v1/deals/${deal}/files?name=a.txt`, projectA, new Uint8Array(0)))
          .status,
      ).toBe(422)
      expect((await upload(manager1, `/v1/deals/${deal}/files`, projectA, text('x'))).status).toBe(
        400,
      )
    })

    it('скачивание — вложением, с nosniff и тем же содержимым', async () => {
      const { deal } = await createDeal(projectA, manager1.id)
      const content = text('імʼя;телефон\nОлена;+380671234567\n')
      const res = await upload(
        manager1,
        `/v1/deals/${deal}/files?name=${encodeURIComponent('Клієнти "весна".csv')}`,
        projectA,
        content,
      )
      expect(res.status).toBe(201)
      const file = (await res.json()) as FileView
      expect(file).toMatchObject({ name: 'Клієнти "весна".csv', contentType: 'text/csv' })

      const download = await call(manager1, 'GET', `/v1/deals/${deal}/files/${file.id}`, projectA)
      expect(download.status).toBe(200)
      expect(download.headers.get('content-type')).toBe('text/csv')
      expect(download.headers.get('x-content-type-options')).toBe('nosniff')
      expect(download.headers.get('content-security-policy')).toContain('sandbox')
      expect(download.headers.get('content-disposition')).toBe(
        `attachment; filename="_______ _______.csv"; filename*=UTF-8''${encodeURIComponent('Клієнти "весна".csv')}`,
      )
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(content)
    })

    it('имя ../../x не выходит за каталог хранилища', async () => {
      const { deal } = await createDeal(projectA, manager1.id)
      const before = await storedFiles()
      const res = await upload(
        manager1,
        `/v1/deals/${deal}/files?name=${encodeURIComponent('../../x')}`,
        projectA,
        text('x'),
      )
      expect(res.status).toBe(201)
      const file = (await res.json()) as FileView
      expect(file.name).toBe('x')
      expect(await storedFiles()).toEqual([...before, path.join(projectA, file.id)].sort())
      // За пределами каталога хранилища ничего не появилось.
      expect(await readdir(base)).toEqual(['storage'])
      expect((await readdir(root)).every((name) => /^[0-9a-f-]{36}$/.test(name))).toBe(true)
    })
  })

  describe('лента', () => {
    it('изменения, заметки и файлы — по времени; фильтр по типу; курсор без повторов', async () => {
      const { deal } = await createDeal(projectA, manager1.id)
      const note = (await (
        await call(manager1, 'POST', `/v1/deals/${deal}/notes`, projectA, { text: 'Нотатка' })
      ).json()) as NoteView
      const file = (await (
        await upload(manager1, `/v1/deals/${deal}/files?name=a.txt`, projectA, text('x'))
      ).json()) as FileView
      // Изменения: одно раньше заметки, одно позже файла, три — в одну и ту же микросекунду.
      const at = (offsetMs: number) => new Date(Date.parse(note.createdAt) + offsetMs)
      const change = (field: string, occurredAt: Date) => ({
        project_id: projectA,
        entity_type: 'deal',
        entity_id: deal,
        actor_id: manager1.id,
        field,
        before: JSON.stringify('було'),
        after: JSON.stringify('стало'),
        occurred_at: occurredAt,
      })
      const same = at(-60_000)
      await h.owner
        .insertInto('change_log')
        .values([
          change('title', at(-120_000)),
          change('amount', same),
          change('currency', same),
          change('stageId', same),
          change('ownerId', at(3_600_000)),
        ])
        .execute()
      // Чужая запись в журнале — не в ленте этой сделки.
      await h.owner
        .insertInto('change_log')
        .values({
          ...change('title', at(0)),
          entity_id: (await createDeal(projectA, manager1.id)).deal,
        })
        .execute()

      const page = async (query: string) => {
        const res = await call(manager1, 'GET', `/v1/deals/${deal}/timeline${query}`, projectA)
        expect(res.status, query).toBe(200)
        return (await res.json()) as TimelinePage
      }
      const full = await page('')
      expect(full.next_cursor).toBe(null)
      const times = full.data.map((i) => Date.parse(i.occurredAt))
      expect(times).toEqual([...times].sort((a, b) => b - a))
      expect(full.data.map((i) => i.kind)).toEqual([
        'change',
        // Файл загружен после заметки.
        'file',
        'note',
        'change',
        'change',
        'change',
        'change',
      ])
      expect(full.data[0]).toMatchObject({
        kind: 'change',
        actorId: manager1.id,
        change: { field: 'ownerId', before: 'було', after: 'стало' },
      })
      expect(full.data.find((i) => i.kind === 'note')).toMatchObject({
        id: note.id,
        note: { text: 'Нотатка' },
      })
      expect(full.data.find((i) => i.kind === 'file')).toMatchObject({
        id: file.id,
        file: { name: 'a.txt', contentType: 'text/plain', size: 1 },
      })

      const notesOnly = await page('?type=note')
      expect(notesOnly.data.map((i) => i.id)).toEqual([note.id])
      const changesAndFiles = await page('?type=change,file')
      expect(new Set(changesAndFiles.data.map((i) => i.kind))).toEqual(new Set(['change', 'file']))
      expect(changesAndFiles.data).toHaveLength(6)

      // По две строки: курсор проходит и через три строки с одним временем.
      const seen: TimelineItem[] = []
      let cursor: string | null = null
      do {
        const next: TimelinePage = await page(
          `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        )
        expect(next.data.length).toBeLessThanOrEqual(2)
        seen.push(...next.data)
        cursor = next.next_cursor
      } while (cursor)
      expect(seen.map((i) => i.id)).toEqual(full.data.map((i) => i.id))

      for (const bad of ['?type=task', '?cursor=abc', '?limit=0']) {
        expect(
          (await call(manager1, 'GET', `/v1/deals/${deal}/timeline${bad}`, projectA)).status,
          bad,
        ).toBe(400)
      }
    })
  })
})
