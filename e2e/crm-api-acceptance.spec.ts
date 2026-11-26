import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type APIResponse, type BrowserContext, test as base, type Page } from '@playwright/test'
import { expect, newContext, signIn } from './support/app.ts'
import { type StackInfo, seedUser } from './support/env.ts'
import { startStack } from './support/stack-process.ts'

// Экраны сценария приёмки эпика crm-api (.scratch/crm-api/spec.md, «Приёмка владельцем»;
// тикет crm-api/08) на данных pnpm seed: ключ API и секрет один раз (шаг 1), вебхук и его
// секрет (шаг 2), журнал доставок с автоматическим и ручным повтором (шаги 5–6), вебхук,
// отключённый ответом 410, с причиной и предупреждением (шаг 8). Сам сценарий целиком — с
// приёмником, который двигает сделку ключом, — в apps/api/src/acceptance/crm-api.acceptance.test.ts.
// Своя база: стенд поднимается здесь (API с WEBHOOK_ALLOW_INSECURE_URLS=1), приёмник событий —
// HTTP-сервер этого процесса на 127.0.0.1. Повторы — настоящие, как в проде: первый через 10–20 с.

const ADMIN = 'seed.admin@example.com'
const KEY_NAME = 'Автоматизація (тест)'
const KEY_ROLE = 'Керівник'
const WEBHOOK_NAME = 'Приймач (тест)'
const PIPELINE = 'ALPI'

interface Delivery {
  webhookId: string
  /** Подпись сошлась с секретом, который показал экран. */
  signed: boolean
  status: number
}

interface Receiver {
  url: string
  deliveries: Delivery[]
  /** Коды ответов на следующие запросы, по одному на запрос; дальше — 200. */
  replies: number[]
  /** Секрет подписи вебхука (whsec_…), скопированный с экрана. */
  secret: string
  close(): Promise<void>
}

/** Проверка подписи Standard Webhooks: HMAC-SHA256 от «id.timestamp.тело», ключ — секрет без whsec_. */
function signatureMatches(secret: string, headers: IncomingHttpHeaders, body: string): boolean {
  const id = String(headers['webhook-id'] ?? '')
  const timestamp = String(headers['webhook-timestamp'] ?? '')
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest()
  return String(headers['webhook-signature'] ?? '')
    .split(' ')
    .some((part) => {
      const [version, value = ''] = part.split(',')
      const actual = Buffer.from(value, 'base64')
      return (
        version === 'v1' && actual.length === expected.length && timingSafeEqual(actual, expected)
      )
    })
}

function startReceiver(): Promise<Receiver> {
  const receiver: Omit<Receiver, 'url' | 'close'> = { deliveries: [], replies: [], secret: '' }
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const status = receiver.replies.shift() ?? 200
      receiver.deliveries.push({
        webhookId: String(req.headers['webhook-id'] ?? ''),
        signed: signatureMatches(receiver.secret, req.headers, body),
        status,
      })
      res.writeHead(status).end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(
        Object.assign(receiver, {
          url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/crm-events`,
          close: async () => {
            server.closeAllConnections()
            await new Promise((done) => server.close(done))
          },
        }),
      )
    })
  })
}

const test = base.extend<object, { crmApiStack: StackInfo }>({
  crmApiStack: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright требует деструктуризацию первого аргумента фикстуры
    async ({}, use) => {
      const stack = await startStack('test-results/stack-crm-api.log')
      try {
        await use(stack.info)
      } finally {
        await stack.stop()
      }
    },
    { scope: 'worker', timeout: 240_000 },
  ],
  baseURL: async ({ crmApiStack }, use) => {
    await use(crmApiStack.baseURL)
  },
})

async function json<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status)
  return (await response.json()) as T
}

test.describe
  .serial('Приёмка владельца: ключ API и вебхуки', () => {
    let context: BrowserContext
    let page: Page
    let receiver: Receiver
    let baseURL: string
    let keySecret = ''
    let pipelineId = ''

    test.beforeAll(async ({ browser, crmApiStack }) => {
      baseURL = crmApiStack.baseURL
      receiver = await startReceiver()
      context = await newContext(browser, baseURL)
      page = await context.newPage()
      await signIn(page, seedUser(ADMIN, crmApiStack))
      const projects = await json<{ id: string; code: string }[]>(
        await page.request.get('/api/projects'),
      )
      const projectId = projects.find((p) => p.code === 'alpi')?.id ?? ''
      const pipelines = await json<{ id: string; name: string }[]>(
        await page.request.get('/api/v1/pipelines', { headers: { 'X-Project-Id': projectId } }),
      )
      pipelineId = pipelines.find((p) => p.name === PIPELINE)?.id ?? ''
      expect(pipelineId).not.toBe('')
    })

    test.afterAll(async () => {
      await context?.close()
      await receiver?.close()
    })

    /** Сделка запросом по ключу API — событие deal.created для приёмника. */
    async function dealByKey(title: string) {
      const res = await fetch(`${baseURL}/api/v1/deals`, {
        method: 'POST',
        headers: { authorization: `Bearer ${keySecret}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          title,
          pipelineId,
          contact: { firstName: 'Приймання', lastName: title },
        }),
      })
      expect(res.status, await res.clone().text()).toBe(201)
    }

    const webhookCard = () => page.getByRole('article', { name: WEBHOOK_NAME })

    test('1. Администратор создаёт ключ API с ролью «Керівник»; секрет показан один раз', async () => {
      await page.goto('/p/alpi/settings/api-keys')
      await page.getByRole('button', { name: 'Створити ключ' }).click()
      const dialog = page.getByRole('dialog', { name: 'Новий ключ API' })
      await dialog.getByRole('textbox', { name: 'Назва' }).fill(KEY_NAME)
      await dialog.getByRole('combobox', { name: /Роль/ }).selectOption({ label: KEY_ROLE })
      await dialog.getByRole('button', { name: 'Створити' }).click()

      const secretDialog = page.getByRole('dialog', { name: `Секрет ключа «${KEY_NAME}»` })
      await expect(secretDialog).toContainText('більше не буде показано')
      keySecret = await secretDialog.getByRole('textbox', { name: 'Секрет' }).inputValue()
      expect(keySecret).toMatch(/^alpi_/)
      await secretDialog.getByRole('button', { name: 'Готово' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByRole('article', { name: KEY_NAME })).toContainText(KEY_ROLE)
      expect(await page.content()).not.toContain(keySecret)
      await page.reload()
      await expect(page.getByRole('article', { name: KEY_NAME })).toBeVisible()
      expect(await page.content()).not.toContain(keySecret)
    })

    test('2. Администратор создаёт вебхук на «угоду створено», «етап змінено», «угоду виграно» и получает секрет', async () => {
      await page.goto('/p/alpi/settings/webhooks')
      await page.getByRole('button', { name: 'Створити вебхук' }).click()
      const dialog = page.getByRole('dialog', { name: 'Новий вебхук' })
      await dialog.getByRole('textbox', { name: /Адреса \(URL\)/ }).fill(receiver.url)
      await dialog.getByRole('textbox', { name: /Опис/ }).fill(WEBHOOK_NAME)
      for (const type of [/^Угоду створено/, /^Етап угоди змінено/, /^Угоду виграно/]) {
        await dialog.getByRole('checkbox', { name: type }).check()
      }
      await dialog.getByRole('button', { name: 'Створити' }).click()

      const secretDialog = page.getByRole('dialog', { name: `Секрет вебхука «${WEBHOOK_NAME}»` })
      await expect(secretDialog).toContainText('більше не буде показано')
      receiver.secret = await secretDialog
        .getByRole('textbox', { name: 'Секрет підпису' })
        .inputValue()
      expect(receiver.secret).toMatch(/^whsec_/)
      await secretDialog.getByRole('button', { name: 'Готово' }).click()
      await expect(webhookCard()).toContainText('увімкнений')
      await expect(webhookCard()).toContainText(receiver.url)
      expect(await page.content()).not.toContain(receiver.secret)
    })

    test('5–6. Журнал доставок: ответ 500 — повтор с тем же webhook-id, две попытки; «Надіслати ще раз» — третья', async () => {
      test.setTimeout(150_000)
      receiver.replies.push(500)
      await dealByKey('Повтор доставки')
      await expect.poll(() => receiver.deliveries.length).toBe(1)

      await webhookCard().getByRole('button', { name: 'Журнал доставок' }).click()
      const log = webhookCard().getByRole('region', { name: 'Журнал доставок' })
      const delivery = log.getByRole('listitem', { name: /Угоду створено/ })
      // Пока доставка «очікує», журнал обновляется сам; первый повтор pg-boss — через 10–20 с.
      await expect(delivery).toContainText('доставлено', { timeout: 90_000 })
      await expect(delivery).toContainText('Спроб: 2')
      await delivery.getByRole('button', { name: 'Деталі' }).click()
      const attempts = delivery.getByRole('list', { name: 'Спроби' })
      await expect(attempts.getByRole('listitem')).toHaveCount(2)
      await expect(attempts).toContainText('500')

      await delivery.getByRole('button', { name: 'Надіслати ще раз' }).click()
      await expect(page.getByText('Доставку поставлено в чергу.')).toBeVisible()
      await expect(attempts.getByRole('listitem')).toHaveCount(3, { timeout: 30_000 })
      await expect(delivery).toContainText('Спроб: 3')

      const [first] = receiver.deliveries
      expect(receiver.deliveries.map((d) => [d.webhookId, d.signed, d.status])).toEqual([
        [first?.webhookId, true, 500],
        [first?.webhookId, true, 200],
        [first?.webhookId, true, 200],
      ])
    })

    test('8. Ответ 410 — вебхук вимкнений с причиной, у администратора предупреждение', async () => {
      receiver.replies.push(410)
      await dealByKey('Відповідь 410')
      await expect.poll(() => receiver.deliveries.at(-1)?.status).toBe(410)
      await page.reload()
      await expect(webhookCard()).toContainText('вимкнений')
      await expect(webhookCard()).toContainText('адреса відповіла 410 Gone')
      await expect(webhookCard().getByRole('button', { name: 'Увімкнути' })).toBeVisible()
      const alert = page.getByRole('link', { name: /^Події не надсилаються на вебхук/ })
      await expect(alert).toContainText(`«${WEBHOOK_NAME}»`)
      await expect(alert).toContainText('приймач відповів 410 Gone')
    })
  })
