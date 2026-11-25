import { type Browser, test as base, expect, type Locator, type Page } from '@playwright/test'
import { totp } from '../../apps/api/src/testing/totp.ts'
import { type SeedUser, stackInfo } from './env.ts'

// Помощники сценария приёмки: вход, колонки канбана, перетаскивание, фильтр списка.
// Локаторы — по тому, что видит пользователь (подписи на украинском, роли ARIA).

/**
 * `test` с адресом клиента из стенда: адрес известен только после global-setup, поэтому
 * не в playwright.config.ts, а здесь — фикстура читает его в процессе-исполнителе.
 */
export const test = base.extend({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright требует деструктуризацию первого аргумента фикстуры
  baseURL: async ({}, use) => {
    await use(stackInfo().baseURL)
  },
})

export { expect }

/**
 * Своя вкладка для шагов, которые живут дольше одного теста (вход один раз на весь сценарий)
 * или идут под другим пользователем. Настройки — как у проекта desktop в playwright.config.ts.
 */
export function newContext(browser: Browser, baseURL = stackInfo().baseURL) {
  return browser.newContext({ baseURL, locale: 'uk-UA', viewport: { width: 1440, height: 900 } })
}

/** Вкладка телефона 375 px — как у проекта phone-375 в playwright.config.ts. */
export function newPhoneContext(browser: Browser, baseURL = stackInfo().baseURL) {
  return browser.newContext({
    baseURL,
    locale: 'uk-UA',
    viewport: { width: 375, height: 812 },
    hasTouch: true,
  })
}

/** Вход паролем и кодом 2FA, который считается по секрету из тестовых данных. */
export async function signIn(page: Page, user: SeedUser) {
  await page.goto('/sign-in')
  await page.getByLabel('Email').fill(user.email)
  await page.getByLabel('Пароль').fill(user.password)
  await page.getByRole('button', { name: 'Увійти' }).click()
  await expect(page).toHaveURL(/\/sign-in\/two-factor$/)
  await page.getByLabel('Код', { exact: true }).fill(totp(user.totpSecret))
  await page.getByRole('button', { name: 'Підтвердити' }).click()
  // После входа «/» ведёт в проект: /p/<код>/.
  await expect(page).toHaveURL(/\/p\/[^/]+\/?$/)
}

/** Колонка этапа на канбане (широкий экран). */
export function column(page: Page, stage: string): Locator {
  return page.getByRole('region', { name: `Етап ${stage}`, exact: true })
}

/** Карточка сделки на канбане — по id: названия сделок тестовых данных могут повторяться. */
export function dealCard(scope: Page | Locator, dealId: string): Locator {
  return scope.locator(`article.deal-card:has(a[href$="/deals/${dealId}"])`)
}

/** Ссылка на карточку сделки (канбан, список, сообщения). */
export function dealLink(scope: Page | Locator, dealId: string): Locator {
  return scope.locator(`a[href$="/deals/${dealId}"]`)
}

/** id сделки из ссылки на её карточку. */
export async function dealIdOf(link: Locator): Promise<string> {
  const href = await link.getAttribute('href')
  const id = href?.match(/\/deals\/([0-9a-f-]{36})$/)?.[1]
  if (!id) throw new Error(`в ссылке нет id сделки: ${href}`)
  return id
}

/** Канбан загрузился: у каждой колонки есть карточки или «Угод немає.», скелетонов нет. */
export async function waitForBoard(page: Page) {
  await expect(page.locator('.kanban-col').first()).toBeVisible()
  await expect(page.locator('.kanban .ui-skeleton')).toHaveCount(0)
}

/**
 * Перетаскивание карточки в колонку мышью (HTML5 drag-and-drop). Колонки становятся целями
 * только после dragstart (канбан перерисовывается), поэтому над целью — два движения.
 */
export async function dragCard(page: Page, card: Locator, target: Locator) {
  await card.hover()
  await page.mouse.down()
  const box = await target.boundingBox()
  if (!box) throw new Error('колонка не видна')
  await page.mouse.move(box.x + box.width / 2, box.y + 80, { steps: 5 })
  await page.mouse.move(box.x + box.width / 2, box.y + 100, { steps: 5 })
  await page.mouse.up()
}

export interface Condition {
  field: string
  op: string
  /** Значение: подпись варианта в выпадающем списке или текст/дата (YYYY-MM-DD) в поле. */
  value: string
  kind: 'choice' | 'text'
}

/** Открывает фильтр списка, добавляет условия (через «І») и применяет. */
export async function applyFilter(page: Page, conditions: Condition[]) {
  await page.getByRole('button', { name: /^Фільтр/ }).click()
  const panel = page.getByRole('dialog', { name: 'Фільтр' })
  for (const condition of conditions) {
    await panel
      .locator('.filter-editor > .filter-editor__actions')
      .getByText('Додати умову')
      .click()
    const row = panel.locator('fieldset.filter-condition').last()
    await row.getByLabel('Поле').selectOption({ label: condition.field })
    await row.getByLabel('Умова').selectOption({ label: condition.op })
    const value = row.getByLabel('Значення')
    if (condition.kind === 'choice') await value.selectOption({ label: condition.value })
    else await value.fill(condition.value)
  }
  await panel.getByRole('button', { name: 'Застосувати' }).click()
  await expect(panel).toBeHidden()
}

/** Тексты ячеек столбца `header` во всех строках таблицы списка. */
export async function columnValues(page: Page, header: string): Promise<string[]> {
  return page.locator('table.list-table').evaluate((table, name) => {
    // У сортируемых столбцов после подписи — стрелка сортировки («Назва↕»).
    const heads = [...table.querySelectorAll('thead th')].map((th) =>
      th.textContent?.replace(/[↕↑↓]/g, '').trim(),
    )
    const index = heads.indexOf(name)
    if (index < 0) throw new Error(`в списке нет столбца «${name}»: ${heads.join(', ')}`)
    return [...table.querySelectorAll('tbody tr')].map(
      (tr) => tr.children[index]?.textContent?.trim() ?? '',
    )
  }, header)
}

/** Список загрузился: есть строка «Знайдено: …». */
export async function listCount(page: Page): Promise<number> {
  const text = await page.locator('.list-count').textContent({ timeout: 15_000 })
  const digits = text?.replace(/[^\d]/g, '')
  if (!digits) throw new Error(`нет числа найденных: ${text}`)
  return Number(digits)
}

/** Сегодняшняя дата в часовом поясе браузера — значение поля type="date". */
export function todayInput(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}
