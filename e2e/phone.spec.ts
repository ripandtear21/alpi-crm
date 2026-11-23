import { dealIdOf, expect, signIn, test } from './support/app.ts'
import { seedUser } from './support/env.ts'

// Шаги 2–3 сценария приёмки на ширине 375 px: канбан — вкладками этапов, перетаскивания нет,
// этап меняется из меню карточки. Свой контакт и своя сделка — с основным сценарием не пересекаются.

const DEAL_TITLE = 'Приймання з телефона: курс для Олени'

test('Телефон 375 px: сделка с новым контактом и смена этапа через меню карточки', async ({
  page,
}) => {
  await signIn(page, seedUser('seed.admin@example.com'))
  await page.goto('/p/alpi/deals')
  await page.getByLabel('Воронка', { exact: true }).selectOption({ label: 'ALPI' })
  const stages = page.getByRole('tablist', { name: 'Етапи' })
  await expect(stages).toBeVisible()
  await expect(page.getByRole('region', { name: /^Канбан воронки/ })).toHaveCount(0)

  // Шаг 2: новая сделка с новым контактом.
  await page.getByRole('button', { name: '+ Угода' }).click()
  const dialog = page.getByRole('dialog', { name: 'Нова угода' })
  await dialog.getByRole('button', { name: 'Новий контакт' }).click()
  await dialog.getByLabel("Ім'я", { exact: true }).fill('Олена')
  await dialog.getByLabel('Прізвище', { exact: true }).fill('Мобільна')
  await dialog.getByLabel('Телефон', { exact: true }).fill('067 765 43 21')
  await dialog.getByLabel('Воронка', { exact: true }).selectOption({ label: 'ALPI' })
  await dialog.getByLabel('Етап', { exact: true }).selectOption({ label: 'Новий лід' })
  await dialog.getByLabel('Назва', { exact: true }).fill(DEAL_TITLE)
  await dialog.getByLabel('Сума', { exact: true }).fill('500')
  await dialog.getByRole('button', { name: 'Створити угоду' }).click()
  await expect(dialog).toBeHidden()

  const newLead = stages.getByRole('tab', { name: /^Новий лід/ })
  await expect(newLead).toHaveAttribute('aria-selected', 'true')
  const panel = page.getByRole('tabpanel')
  const card = panel.getByRole('article', { name: DEAL_TITLE, exact: true })
  await expect(card).toBeVisible()
  // Перетаскивания на телефоне нет.
  await expect(card).not.toHaveAttribute('draggable', 'true')
  const dealId = await dealIdOf(card.getByRole('link', { name: DEAL_TITLE, exact: true }))

  // Шаг 3: этап — из меню карточки.
  await card.getByRole('button', { name: `Дії з угодою «${DEAL_TITLE}»` }).click()
  await page.getByRole('menuitem', { name: 'На етап «Передано в роботу»' }).click()
  await expect(
    page.getByText(`Угоду «${DEAL_TITLE}» перенесено на етап «Передано в роботу».`),
  ).toBeVisible()
  await expect(panel.locator(`a[href$="/deals/${dealId}"]`)).toHaveCount(0)

  await page.reload()
  await stages.getByRole('tab', { name: /^Передано в роботу/ }).click()
  await expect(panel.locator(`a[href$="/deals/${dealId}"]`)).toBeVisible()
})
