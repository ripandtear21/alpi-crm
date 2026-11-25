import {
  type APIResponse,
  type BrowserContext,
  test as base,
  type Locator,
  type Page,
} from '@playwright/test'
import {
  applyFilter,
  column,
  columnValues,
  dealIdOf,
  dealLink,
  expect,
  listCount,
  newContext,
  newPhoneContext,
  signIn,
  todayInput,
  waitForBoard,
} from './support/app.ts'
import { type SeedUser, type StackInfo, seedUser } from './support/env.ts'
import { startStack } from './support/stack-process.ts'

// Сценарий приёмки владельца эпика «конструктор полей» (.scratch/crm-fields/spec.md, «Приёмка
// владельцем»; тикет crm-fields/09) на данных pnpm seed. Своя база: сценарий заводит поле,
// обязательное с этапа «!Приймає рішення», и прячет группу от менеджеров — на общем стенде это
// сломало бы сценарий crm-deals, поэтому стенд поднимается здесь, на процесс-исполнитель.
// Шаги идут по порядку на одних данных; после первого падения остальные пропускаются.

const ADMIN = 'seed.admin@example.com'
/** Менеджер с охватом «свои» в проекте ALPI: сделка сценария — его, иначе он её не увидит. */
const MANAGER = 'seed.manager04@example.com'

const GROUP = 'Приймання: готовність'
const FIELD = 'Готовність до покупки'
const CODE = 'pryiom_gotovnist'
const OPTIONS = ['Холодний', 'Теплий', 'Гарячий'] as const
const PIPELINE = 'ALPI'
const START_STAGE = 'Новий лід'
const STAGE = '!Приймає рішення'
const FILTER_NAME = 'Приймання: теплі'

const DEAL_TITLE = 'Приймання полів: курс для Ірини'
const PHONE_DEAL_TITLE = 'Приймання полів з телефона: курс для Петра'

const test = base.extend<object, { fieldsStack: StackInfo }>({
  fieldsStack: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright требует деструктуризацию первого аргумента фикстуры
    async ({}, use) => {
      const stack = await startStack('test-results/stack-fields.log')
      try {
        await use(stack.info)
      } finally {
        await stack.stop()
      }
    },
    { scope: 'worker', timeout: 240_000 },
  ],
  baseURL: async ({ fieldsStack }, use) => {
    await use(fieldsStack.baseURL)
  },
})

/** Запросы `/api/v1` из теста — под сессией вкладки `page` (её cookie) в проекте `projectId`. */
function projectApi(page: Page, projectId: string) {
  const headers = { 'X-Project-Id': projectId }
  return {
    get: (path: string) => page.request.get(`/api/v1${path}`, { headers }),
    post: (path: string, data: unknown) => page.request.post(`/api/v1${path}`, { headers, data }),
  }
}

async function json<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status)
  return (await response.json()) as T
}

interface Ids {
  projectId: string
  pipelineId: string
  startStageId: string
  stageId: string
}

/** Проект ALPI, его воронка и этапы сценария — из API, как их видит вкладка `page`. */
async function lookupIds(page: Page): Promise<Ids> {
  const projects = await json<{ id: string; code: string }[]>(
    await page.request.get('/api/projects'),
  )
  const project = projects.find((p) => p.code === 'alpi')
  if (!project) throw new Error('нет проекта alpi')
  const pipelines = await json<
    { id: string; name: string; stages: { id: string; name: string }[] }[]
  >(await projectApi(page, project.id).get('/pipelines'))
  const pipeline = pipelines.find((p) => p.name === PIPELINE)
  const stageId = (name: string) => {
    const id = pipeline?.stages.find((s) => s.name === name)?.id
    if (!id) throw new Error(`нет этапа «${name}» воронки ${PIPELINE}`)
    return id
  }
  if (!pipeline) throw new Error(`нет воронки ${PIPELINE}`)
  return {
    projectId: project.id,
    pipelineId: pipeline.id,
    startStageId: stageId(START_STAGE),
    stageId: stageId(STAGE),
  }
}

/** Новая сделка на первом этапе ALPI с новым контактом — запросом API, без пользовательских полей. */
async function createDeal(
  page: Page,
  ids: Ids,
  title: string,
  contact: { firstName: string; lastName: string },
  ownerId?: string,
): Promise<string> {
  const deal = await json<{ id: string }>(
    await projectApi(page, ids.projectId).post('/deals', {
      title,
      pipelineId: ids.pipelineId,
      stageId: ids.startStageId,
      contact,
      ...(ownerId === undefined ? {} : { ownerId }),
    }),
    201,
  )
  return deal.id
}

/** Карточка канбана целиком: статья сделки и строки полей под ней (`dl.kanban-card__fields`). */
function boardCard(scope: Page | Locator, dealId: string): Locator {
  return scope.locator(`.kanban-card:has(a[href$="/deals/${dealId}"])`)
}

/**
 * Перетаскивание карточки на дальнюю колонку: «!Приймає рішення» — шестая, на широком экране
 * она за краем канбана. Сначала начинаем перетаскивание (колонки становятся целями только после
 * dragstart), потом прокручиваем канбан к цели и отпускаем над ней.
 */
async function dragToColumn(page: Page, card: Locator, target: Locator) {
  await card.scrollIntoViewIfNeeded()
  const start = await card.boundingBox()
  if (!start) throw new Error('карточка не видна')
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
  await page.mouse.down()
  await page.mouse.move(start.x + start.width / 2 + 12, start.y + start.height / 2 + 12, {
    steps: 3,
  })
  await target.scrollIntoViewIfNeeded()
  const box = await target.boundingBox()
  if (!box) throw new Error('колонка не видна')
  await page.mouse.move(box.x + box.width / 2, box.y + 80, { steps: 5 })
  await page.mouse.move(box.x + box.width / 2, box.y + 100, { steps: 5 })
  await page.mouse.up()
}

/** Форма заполнения перед этапом «!Приймає рішення». */
function fillDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: `Заповніть поля для етапу «${STAGE}»` })
}

/**
 * Заполняет форму перед «!Приймає рішення»: стартовые поля ALPI, обязательные с более ранних
 * этапов (packages/db/src/presets/alpi-fields.ts), и поле сценария — вариантом `option`.
 */
async function fillToDecision(fill: Locator, option: string) {
  const field = (name: string) => fill.getByLabel(name, { exact: true })
  await field('Якість ліда').selectOption({ label: 'B3 — цільова аудиторія' })
  await field('Тип клієнта').selectOption({ index: 1 })
  await field('Головний мотив в AI').selectOption({ index: 1 })
  await field('Взятий в роботу: з').fill(todayInput())
  await field('Взятий в роботу: по').fill(todayInput())
  await field(FIELD).selectOption({ label: option })
}

/** Ответ 422 смены этапа: код ошибки и незаполненные поля, которые роль видит. */
interface StageRefusal {
  code: string
  details: { fields: string[]; names: { code: string; nameUk: string }[]; hiddenCount: number }
}

async function expectStageRefused(page: Page, ids: Ids, dealId: string) {
  const api = projectApi(page, ids.projectId)
  const refusal = await json<StageRefusal>(
    await api.post(`/deals/${dealId}/stage`, { stageId: ids.stageId }),
    422,
  )
  expect(refusal.code).toBe('STAGE_REQUIREMENTS_MISSING')
  expect(refusal.details.fields).toContain(CODE)
  expect(refusal.details.names).toContainEqual(
    expect.objectContaining({ code: CODE, nameUk: FIELD }),
  )
  const deal = await json<{ stageId: string; custom: Record<string, unknown> }>(
    await api.get(`/deals/${dealId}`),
  )
  expect(deal.stageId).toBe(ids.startStageId)
  expect(deal.custom).not.toHaveProperty(CODE)
}

/** Группа полей сценария в карточке сделки и строка поля в ней. */
function cardField(page: Page): Locator {
  return page.getByRole('region', { name: GROUP, exact: true }).locator(`[data-field="${CODE}"]`)
}

/** Карточка сделки загрузила пользовательские поля: группа стартовых полей ALPI на месте. */
async function waitForCustomFields(page: Page) {
  await expect(page.getByRole('region', { name: 'Профіль ліда', exact: true })).toBeVisible()
}

async function openFieldsSettings(page: Page) {
  await page.goto('/p/alpi/settings')
  await page.getByRole('link', { name: 'Поля', exact: true }).click()
  await expect(page).toHaveURL(/\/p\/alpi\/settings\/fields$/)
  await expect(page.getByRole('heading', { name: 'Поля', level: 1 })).toBeVisible()
}

async function openBoard(page: Page) {
  await page.goto('/p/alpi/deals')
  await page.getByLabel('Воронка', { exact: true }).selectOption({ label: PIPELINE })
}

test.describe
  .serial('Приёмка владельца: конструктор полей', () => {
    let context: BrowserContext
    let page: Page
    let admin: SeedUser
    let manager: SeedUser
    let ids: Ids
    /** Сделка сценария: ответственный — менеджер (шаг 5). */
    let dealId = ''
    /** id варианта «Теплий» — так значение лежит в `custom` ответа API. */
    let optionId = ''
    let managerContext: BrowserContext | undefined
    let own: Page

    test.beforeAll(async ({ browser, fieldsStack }) => {
      admin = seedUser(ADMIN, fieldsStack)
      manager = seedUser(MANAGER, fieldsStack)
      context = await newContext(browser, fieldsStack.baseURL)
      page = await context.newPage()
    })

    test.afterAll(async () => {
      await managerContext?.close()
      await context?.close()
    })

    test('1. Администратор заводит поле «один вариант» в новой группе и показывает его на канбане', async () => {
      await signIn(page, admin)
      await page.getByLabel('Проєкт').selectOption({ label: 'ALPI' })
      await expect(page).toHaveURL(/\/p\/alpi\/?$/)
      await openFieldsSettings(page)

      // Новая группа сделок.
      await page.getByRole('button', { name: 'Нова група', exact: true }).click()
      const groupDialog = page.getByRole('dialog', { name: 'Нова група' })
      await groupDialog.getByLabel('Назва українською').fill(GROUP)
      await groupDialog.getByRole('button', { name: 'Створити групу' }).click()
      await expect(groupDialog).toBeHidden()
      await expect(page.getByRole('list', { name: 'Групи полів' })).toContainText(GROUP)

      // Поле: три варианта, обязательное с «!Приймає рішення» в ALPI, «часто фільтрують».
      await page.getByRole('button', { name: `Додати поле в групу «${GROUP}»` }).click()
      const fieldDialog = page.getByRole('dialog', { name: 'Нове поле' })
      await fieldDialog.getByLabel('Назва українською').fill(FIELD)
      await fieldDialog.getByLabel('Код', { exact: true }).fill(CODE)
      await fieldDialog.getByLabel('Тип', { exact: true }).selectOption({ label: 'Один варіант' })
      await fieldDialog.getByLabel('Група', { exact: true }).selectOption({ label: GROUP })
      for (const [index, option] of OPTIONS.entries()) {
        await fieldDialog.getByRole('button', { name: 'Додати варіант' }).click()
        await fieldDialog.getByLabel(`Варіант ${index + 1} українською`).fill(option)
      }
      await fieldDialog.getByLabel('З етапу', { exact: true }).check()
      await fieldDialog.getByLabel(`Етап у воронці «${PIPELINE}»`).selectOption({ label: STAGE })
      await fieldDialog.getByLabel('Часто фільтрують').check()
      await fieldDialog.getByRole('button', { name: 'Створити поле' }).click()
      await expect(fieldDialog).toBeHidden()
      const row = page
        .getByRole('list', { name: `Поля групи «${GROUP}»` })
        .getByRole('listitem')
        .filter({ hasText: FIELD })
      await expect(row).toContainText(CODE)
      await expect(row).toContainText("обов'язкове")
      await expect(row).toContainText('часто фільтрують')

      // Настройки воронки: поле — на карточке канбана (свободное место из трёх).
      await page.goto('/p/alpi/settings/pipelines')
      const cardFields = page.getByRole('form', { name: `Поля на картці канбану: ${PIPELINE}` })
      const slots = cardFields.locator('select')
      await expect(slots).toHaveCount(3)
      let slot = slots.last()
      for (const candidate of await slots.all()) {
        if ((await candidate.inputValue()) === '') {
          slot = candidate
          break
        }
      }
      await slot.selectOption({ label: FIELD })
      await cardFields.getByRole('button', { name: 'Зберегти поля картки' }).click()
      await expect(cardFields.getByText('Поля картки збережено.')).toBeVisible()

      // Сделка сценария — у менеджера (шаг 5), на первом этапе ALPI, без значений полей.
      ids = await lookupIds(page)
      const owners = await json<{ id: string; name: string }[]>(
        await projectApi(page, ids.projectId).get('/deals/owners'),
      )
      const ownerId = owners.find((o) => o.name === manager.name)?.id
      expect(ownerId, `нет ответственного ${manager.name}`).toBeDefined()
      dealId = await createDeal(
        page,
        ids,
        DEAL_TITLE,
        { firstName: 'Ірина', lastName: 'Приймальна' },
        ownerId,
      )
    })

    test('2. Перетаскивание на «!Приймає рішення» открывает форму; отмена — сделка на месте; API — 422', async () => {
      await openBoard(page)
      await waitForBoard(page)
      const from = column(page, START_STAGE)
      const to = column(page, STAGE)
      await dragToColumn(page, boardCard(from, dealId), to)

      const fill = fillDialog(page)
      await expect(fill).toBeVisible()
      await expect(fill.getByLabel(FIELD, { exact: true })).toBeVisible()
      await fill.getByRole('button', { name: 'Скасувати' }).click()
      await expect(fill).toBeHidden()
      await expect(boardCard(from, dealId)).toBeVisible()
      await expect(boardCard(to, dealId)).toHaveCount(0)

      // Тот же переход запросом /api/v1 под сессией администратора.
      await expectStageRefused(page, ids, dealId)
    })

    test('3. Заполнение в форме — сделка на новом этапе; значение на канбане, в карточке и в ленте', async () => {
      await page.reload()
      await waitForBoard(page)
      const to = column(page, STAGE)
      await dragToColumn(page, boardCard(column(page, START_STAGE), dealId), to)
      const fill = fillDialog(page)
      await expect(fill).toBeVisible()
      await fillToDecision(fill, 'Теплий')
      await fill.getByRole('button', { name: 'Зберегти' }).click()
      await expect(fill).toBeHidden()
      await expect(
        page.getByText(`Угоду «${DEAL_TITLE}» перенесено на етап «${STAGE}».`),
      ).toBeVisible()

      const card = boardCard(to, dealId)
      await expect(card).toBeVisible()
      await expect(card.locator('.kanban-card__field').filter({ hasText: FIELD })).toContainText(
        'Теплий',
      )
      await expect(boardCard(column(page, START_STAGE), dealId)).toHaveCount(0)

      await dealLink(card, dealId).click()
      await expect(page).toHaveURL(new RegExp(`/p/alpi/deals/${dealId}$`))
      await expect(cardField(page).locator('dd')).toContainText('Теплий')
      const history = page.getByRole('list', { name: 'Історія' })
      await expect(
        history
          .getByRole('article', { name: 'Зміна' })
          .filter({ hasText: new RegExp(`${FIELD}:\\s*\\S+\\s*→\\s*Теплий`) }),
      ).toBeVisible()

      const deal = await json<{ stageId: string; custom: Record<string, string> }>(
        await projectApi(page, ids.projectId).get(`/deals/${dealId}`),
      )
      expect(deal.stageId).toBe(ids.stageId)
      optionId = deal.custom[CODE] ?? ''
      expect(optionId).toMatch(/^[0-9a-f-]{36}$/)
    })

    test('4. Фильтр списка по полю, сохранение фильтра, повторное открытие — тот же результат', async () => {
      await page.goto('/p/alpi/deals/list')
      const total = await listCount(page)
      expect(total).toBeGreaterThan(1)

      await page.getByRole('button', { name: 'Колонки', exact: true }).click()
      const columns = page.getByRole('dialog', { name: 'Колонки списку' })
      await columns.getByLabel(FIELD, { exact: true }).check()
      await columns.getByRole('button', { name: 'Готово' }).click()
      await expect(columns).toBeHidden()

      await applyFilter(page, [{ field: FIELD, op: 'одне з', value: 'Теплий', kind: 'choice' }])
      await expect.poll(() => listCount(page)).toBe(1)
      expect(await columnValues(page, 'Назва')).toEqual([DEAL_TITLE])
      expect(await columnValues(page, FIELD)).toEqual(['Теплий'])

      await page.getByRole('button', { name: 'Збережені фільтри' }).click()
      await page.getByRole('menuitem', { name: 'Зберегти поточний фільтр…' }).click()
      const save = page.getByRole('dialog', { name: 'Зберегти фільтр' })
      await save.getByLabel('Назва', { exact: true }).fill(FILTER_NAME)
      await save.getByRole('button', { name: 'Зберегти' }).click()
      await expect(save).toBeHidden()
      await expect(page.getByText(`Фільтр «${FILTER_NAME}» збережено.`)).toBeVisible()

      // Повторное открытие: список без фильтра, затем сохранённый фильтр из меню.
      await page.goto('/p/alpi/deals/list')
      await expect.poll(() => listCount(page)).toBe(total)
      await page.getByRole('button', { name: 'Збережені фільтри' }).click()
      await page.getByRole('menuitem', { name: FILTER_NAME, exact: true }).click()
      await expect(page.getByText(`Застосовано фільтр «${FILTER_NAME}».`)).toBeVisible()
      await expect.poll(() => listCount(page)).toBe(1)
      expect(await columnValues(page, 'Назва')).toEqual([DEAL_TITLE])
      expect(await columnValues(page, FIELD)).toEqual(['Теплий'])
    })

    test('5. Группа «приховано» для менеджера: поля нет в интерфейсе и в ответе API', async ({
      browser,
      fieldsStack,
    }) => {
      await openFieldsSettings(page)
      await page.getByRole('button', { name: `Доступ ролей до групи «${GROUP}»` }).click()
      const access = page.getByRole('dialog', { name: `Доступ ролей до групи «${GROUP}»` })
      await access.getByLabel('Доступ ролі «Менеджер»').selectOption({ label: 'Приховано' })
      await expect(access.getByText('Збережено.')).toBeVisible()
      await access.getByRole('button', { name: 'Готово' }).click()
      await expect(access).toBeHidden()

      managerContext = await newContext(browser, fieldsStack.baseURL)
      own = await managerContext.newPage()
      await signIn(own, manager)
      await expect(own).toHaveURL(/\/p\/alpi\/?$/)

      // Карточка сделки и лента.
      await own.goto(`/p/alpi/deals/${dealId}`)
      await expect(own.getByRole('heading', { name: DEAL_TITLE })).toBeVisible()
      await waitForCustomFields(own)
      await expect(own.getByRole('region', { name: GROUP, exact: true })).toHaveCount(0)
      await expect(own.locator(`[data-field="${CODE}"]`)).toHaveCount(0)
      const history = own.getByRole('list', { name: 'Історія' })
      await expect(history.getByRole('article', { name: 'Зміна' }).first()).toBeVisible()
      await expect(history.getByText(FIELD)).toHaveCount(0)
      await expect(history.getByText('Теплий')).toHaveCount(0)

      // Список: ни столбца, ни выбора в «Колонки», ни условия в фильтре.
      await own.goto('/p/alpi/deals/list')
      await listCount(own)
      await expect(own.locator('table.list-table thead')).not.toContainText(FIELD)
      await own.getByRole('button', { name: 'Колонки', exact: true }).click()
      const columns = own.getByRole('dialog', { name: 'Колонки списку' })
      await expect(columns.getByLabel('Якість ліда', { exact: true })).toBeVisible()
      await expect(columns.getByLabel(FIELD, { exact: true })).toHaveCount(0)
      await own.keyboard.press('Escape')
      await expect(columns).toBeHidden()
      await own.getByRole('button', { name: /^Фільтр/ }).click()
      const panel = own.getByRole('dialog', { name: 'Фільтр' })
      await panel
        .locator('.filter-editor > .filter-editor__actions')
        .getByText('Додати умову')
        .click()
      const fieldSelect = panel.locator('fieldset.filter-condition').last().getByLabel('Поле')
      await expect(fieldSelect.locator('option', { hasText: 'Якість ліда' })).toHaveCount(1)
      await expect(fieldSelect.locator('option', { hasText: FIELD })).toHaveCount(0)

      // Канбан: карточка сделки — без значения поля.
      await openBoard(own)
      await waitForBoard(own)
      const card = boardCard(column(own, STAGE), dealId)
      await card.scrollIntoViewIfNeeded()
      await expect(card).toBeVisible()
      await expect(card).not.toContainText(FIELD)
      await expect(card).not.toContainText('Теплий')

      // Ответ /api/v1/deals/:id под сессией менеджера: ни кода, ни значения.
      const response = await projectApi(own, ids.projectId).get(`/deals/${dealId}`)
      const body = await response.text()
      expect(response.status(), body).toBe(200)
      expect(body).not.toContain(CODE)
      expect(body).not.toContain(optionId)
      // Та же сделка у администратора — с полем: проверка выше не пустая.
      const adminBody = await (await projectApi(page, ids.projectId).get(`/deals/${dealId}`)).text()
      expect(adminBody).toContain(CODE)
      expect(adminBody).toContain(optionId)
    })

    test('6. Архив поля: пропало из карточки и списка; возврат из архива — значения на месте', async () => {
      await openFieldsSettings(page)
      await page.getByRole('button', { name: `Видалити поле «${FIELD}»` }).click()
      const confirm = page.getByRole('dialog', { name: `Видалити поле «${FIELD}»?` })
      await expect(confirm).toContainText('перенесено в архів')
      await confirm.getByRole('button', { name: 'Видалити', exact: true }).click()
      await expect(confirm).toBeHidden()
      await expect(page.getByRole('list', { name: `Поля групи «${GROUP}»` })).toHaveCount(0)

      await page.goto(`/p/alpi/deals/${dealId}`)
      await waitForCustomFields(page)
      await expect(page.locator(`[data-field="${CODE}"]`)).toHaveCount(0)

      await page.goto('/p/alpi/deals/list')
      await listCount(page)
      await expect(page.locator('table.list-table thead')).not.toContainText(FIELD)
      await page.getByRole('button', { name: 'Колонки', exact: true }).click()
      const columns = page.getByRole('dialog', { name: 'Колонки списку' })
      await expect(columns.getByLabel('Якість ліда', { exact: true })).toBeVisible()
      await expect(columns.getByLabel(FIELD, { exact: true })).toHaveCount(0)
      await page.keyboard.press('Escape')

      // Возврат из архива.
      await openFieldsSettings(page)
      await page.getByRole('tab', { name: 'Архів' }).click()
      await page.getByRole('button', { name: `Повернути поле «${FIELD}»` }).click()
      await expect(page.getByRole('button', { name: `Повернути поле «${FIELD}»` })).toHaveCount(0)
      await page.getByRole('tab', { name: 'Угоди' }).click()
      await expect(page.getByRole('list', { name: `Поля групи «${GROUP}»` })).toContainText(FIELD)

      await page.goto(`/p/alpi/deals/${dealId}`)
      await expect(cardField(page).locator('dd')).toContainText('Теплий')
      await page.goto('/p/alpi/deals/list')
      await applyFilter(page, [{ field: FIELD, op: 'одне з', value: 'Теплий', kind: 'choice' }])
      await expect.poll(() => listCount(page)).toBe(1)
      expect(await columnValues(page, 'Назва')).toEqual([DEAL_TITLE])
      const deal = await json<{ custom: Record<string, string> }>(
        await projectApi(page, ids.projectId).get(`/deals/${dealId}`),
      )
      expect(deal.custom[CODE]).toBe(optionId)
    })

    test('Телефон 375 px: шаги 2–3 — смена этапа через меню карточки, форма на весь экран', async ({
      browser,
      fieldsStack,
    }) => {
      // Вкладка телефона с сессией администратора: код 2FA повторно не вводится.
      const phone = await newPhoneContext(browser, fieldsStack.baseURL)
      await phone.addCookies(await context.cookies())
      const mobile = await phone.newPage()
      try {
        const phoneDealId = await createDeal(mobile, ids, PHONE_DEAL_TITLE, {
          firstName: 'Петро',
          lastName: 'Мобільний',
        })
        await openBoard(mobile)
        const stages = mobile.getByRole('tablist', { name: 'Етапи' })
        await expect(stages).toBeVisible()
        await stages.getByRole('tab', { name: new RegExp(`^${START_STAGE}`) }).click()
        const panel = mobile.getByRole('tabpanel')
        const card = panel.getByRole('article', { name: PHONE_DEAL_TITLE, exact: true })
        await expect(card).toBeVisible()
        expect(await dealIdOf(card.getByRole('link', { name: PHONE_DEAL_TITLE }))).toBe(phoneDealId)
        const toStage = async () => {
          await card.getByRole('button', { name: `Дії з угодою «${PHONE_DEAL_TITLE}»` }).click()
          await mobile.getByRole('menuitem', { name: `На етап «${STAGE}»` }).click()
        }

        // Шаг 2: форма открывается на всю ширину экрана; отмена — сделка на месте; API — 422.
        await toStage()
        const fill = fillDialog(mobile)
        await expect(fill).toBeVisible()
        // Нижняя шторка во всю ширину страницы (без полосы прокрутки), до низа экрана.
        // Опрос — шторка въезжает с анимацией; допуск 2 px на дробные пиксели.
        const screen = await mobile.evaluate(() => ({
          width: document.documentElement.clientWidth,
          height: window.innerHeight,
        }))
        await expect
          .poll(async () => {
            const box = await fill.boundingBox()
            if (!box) return 'не видна'
            const edges = { left: box.x, right: box.x + box.width, bottom: box.y + box.height }
            return edges.left <= 2 &&
              edges.right >= screen.width - 2 &&
              edges.bottom >= screen.height - 2
              ? 'во всю ширину, до низа'
              : JSON.stringify(edges)
          })
          .toBe('во всю ширину, до низа')
        await expect(fill.getByLabel(FIELD, { exact: true })).toBeVisible()
        await fill.getByRole('button', { name: 'Скасувати' }).click()
        await expect(fill).toBeHidden()
        await expect(card).toBeVisible()
        await expectStageRefused(mobile, ids, phoneDealId)

        // Шаг 3: заполнение — сделка на новом этапе, значение на карточке канбана и в карточке.
        await toStage()
        await fillToDecision(fill, 'Гарячий')
        await fill.getByRole('button', { name: 'Зберегти' }).click()
        await expect(fill).toBeHidden()
        await expect(
          mobile.getByText(`Угоду «${PHONE_DEAL_TITLE}» перенесено на етап «${STAGE}».`),
        ).toBeVisible()
        await expect(card).toHaveCount(0)
        await stages.getByRole('tab', { name: new RegExp(`^${STAGE}`) }).click()
        const moved = boardCard(panel, phoneDealId)
        await expect(moved).toBeVisible()
        await expect(moved.locator('.kanban-card__field').filter({ hasText: FIELD })).toContainText(
          'Гарячий',
        )
        await mobile.goto(`/p/alpi/deals/${phoneDealId}`)
        await expect(cardField(mobile).locator('dd')).toContainText('Гарячий')
      } finally {
        await phone.close()
      }
    })
  })
