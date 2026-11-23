import type { BrowserContext, Page } from '@playwright/test'
import {
  applyFilter,
  column,
  columnValues,
  dealCard,
  dealIdOf,
  dealLink,
  dragCard,
  expect,
  listCount,
  newContext,
  signIn,
  test,
  todayInput,
  waitForBoard,
} from './support/app.ts'
import { seedUser } from './support/env.ts'

// Сценарий приёмки владельца (.scratch/crm-deals/spec.md, «Приёмка владельцем»; тикет 16) на
// данных pnpm seed. Шаги идут по порядку на одной вкладке администратора: каждый следующий
// опирается на то, что сделал предыдущий, поэтому после первого падения остальные пропускаются.

const ADMIN = 'seed.admin@example.com'
/** Менеджер с охватом «свои» только в проекте ALPI (manager01 и 06 — тимлиды). */
const MANAGER = 'seed.manager04@example.com'

const DEAL_TITLE = 'Приймання: курс для Тараса'
const CONTACT = { firstName: 'Тарас', lastName: 'Приймальний', phone: '067 123 45 67' }
const NOTE = 'Домовились: передзвонити після вебінару.'

/** Сумма в гривнах так, как её пишет карточка: «8 800,00 грн» (группы разрядов — любой пробел). */
const uah = (amount: string) => new RegExp(`^${amount.replace(' ', '\\s')}(,00)?\\s(грн|₴)$`)

test.describe
  .serial('Приёмка владельца', () => {
    let context: BrowserContext
    let page: Page
    /** Сделка, созданная на шаге 2. */
    let dealId = ''
    /** Сделки других ответственных, которые видит администратор (шаг 8). */
    let foreign: { title: string; id: string }[] = []
    /** Вкладка менеджера (шаг 8): вход один раз — код 2FA повторно не вводится. */
    let managerContext: BrowserContext | undefined
    let own: Page
    /** Названия сделок, которые менеджер видит сам: у сделок тестовых данных они повторяются. */
    const ownTitles = new Set<string>()

    test.beforeAll(async ({ browser }) => {
      context = await newContext(browser)
      page = await context.newPage()
    })

    test.afterAll(async () => {
      await managerContext?.close()
      await context?.close()
    })

    test('1. Вход администратором: пароль и код 2FA, проект ALPI', async () => {
      await signIn(page, seedUser(ADMIN))
      await page.getByLabel('Проєкт').selectOption({ label: 'ALPI' })
      await expect(page).toHaveURL(/\/p\/alpi\/?$/)
      await page.getByRole('navigation').getByRole('link', { name: 'Угоди' }).click()
      await expect(page).toHaveURL(/\/p\/alpi\/deals/)
      await expect(page.getByRole('heading', { name: 'Угоди', level: 1 })).toBeVisible()
    })

    test('2. Сделка с новым контактом в воронке «ALPI»', async () => {
      await page.getByRole('button', { name: '+ Угода' }).click()
      const dialog = page.getByRole('dialog', { name: 'Нова угода' })
      await dialog.getByRole('button', { name: 'Новий контакт' }).click()
      await dialog.getByLabel("Ім'я", { exact: true }).fill(CONTACT.firstName)
      await dialog.getByLabel('Прізвище', { exact: true }).fill(CONTACT.lastName)
      await dialog.getByLabel('Телефон', { exact: true }).fill(CONTACT.phone)
      await dialog.getByLabel('Воронка', { exact: true }).selectOption({ label: 'ALPI' })
      await dialog.getByLabel('Етап', { exact: true }).selectOption({ label: 'Новий лід' })
      await dialog.getByLabel('Назва', { exact: true }).fill(DEAL_TITLE)
      await dialog.getByLabel('Сума', { exact: true }).fill('1000')
      await dialog.getByLabel('Валюта', { exact: true }).selectOption('UAH')
      await dialog.getByRole('button', { name: 'Створити угоду' }).click()
      await expect(dialog).toBeHidden()
      await expect(page.getByText('Угоду створено.')).toBeVisible()

      await page.getByLabel('Воронка', { exact: true }).selectOption({ label: 'ALPI' })
      const link = column(page, 'Новий лід').getByRole('link', { name: DEAL_TITLE, exact: true })
      await expect(link).toBeVisible()
      dealId = await dealIdOf(link)
    })

    test('3. Перетаскивание по этапам канбана; после перезагрузки — на новом этапе', async () => {
      await waitForBoard(page)
      for (const [from, to] of [
        ['Новий лід', 'Передано в роботу'],
        ['Передано в роботу', 'Був на вебінарі'],
      ] as const) {
        await dragCard(page, dealCard(column(page, from), dealId), column(page, to))
        await expect(
          page.getByText(`Угоду «${DEAL_TITLE}» перенесено на етап «${to}».`),
        ).toBeVisible()
        await expect(dealCard(column(page, to), dealId)).toBeVisible()
        await expect(dealCard(column(page, from), dealId)).toHaveCount(0)
      }
      await page.reload()
      await waitForBoard(page)
      await expect(dealCard(column(page, 'Був на вебінарі'), dealId)).toBeVisible()
      await expect(dealCard(column(page, 'Новий лід'), dealId)).toHaveCount(0)
      await expect(dealCard(column(page, 'Передано в роботу'), dealId)).toHaveCount(0)
    })

    test('4. Карточка: строка товара, «Сума по товарах», «Підставити», заметка — в ленте', async () => {
      await dealLink(column(page, 'Був на вебінарі'), dealId).click()
      await expect(page).toHaveURL(new RegExp(`/p/alpi/deals/${dealId}$`))
      await expect(page.getByTestId('deal-amount')).toHaveText(uah('1 000'))

      // «Бронювання місця»: 4 400 ₴ по каталогу, две штуки — 8 800 ₴.
      const newLine = page.getByRole('form', { name: 'Новий рядок товару' })
      await newLine.getByLabel('Товар', { exact: true }).selectOption({ label: 'Бронювання місця' })
      await newLine.getByLabel('Кількість', { exact: true }).fill('2')
      await newLine.getByRole('button', { name: 'Додати товар' }).click()
      await expect(page.getByRole('form', { name: 'Рядок «Бронювання місця»' })).toBeVisible()
      await expect(page.getByTestId('products-total')).toHaveText(uah('8 800'))
      await expect(page.getByText(/^Сума угоди — 1\s000/)).toBeVisible()
      await page.getByRole('button', { name: 'Підставити' }).click()
      await expect(page.getByTestId('deal-amount')).toHaveText(uah('8 800'))
      await expect(page.getByRole('button', { name: 'Підставити' })).toHaveCount(0)

      const noteForm = page.getByRole('form', { name: 'Нотатка' })
      await noteForm.getByLabel('Текст нотатки').fill(NOTE)
      await noteForm.getByRole('button', { name: 'Зберегти нотатку' }).click()

      const history = page.getByRole('list', { name: 'Історія' })
      await expect(history.getByRole('article', { name: 'Нотатка' })).toContainText(NOTE)
      // Смена суммы кнопкой «Підставити» — запись журнала изменений в той же ленте.
      await expect(
        history.getByRole('article', { name: 'Зміна' }).filter({ hasText: /1\s000.*8\s800/ }),
      ).toBeVisible()
      // Лента переживает перезагрузку: всё это сохранено, а не только нарисовано.
      await page.reload()
      await expect(history.getByRole('article', { name: 'Нотатка' })).toContainText(NOTE)
      await expect(page.getByTestId('products-total')).toHaveText(uah('8 800'))
    })

    test('5. Одна сделка выиграна, другая проиграна с причиной: нет в канбане, есть в списке', async () => {
      // Выигрыш — из карточки сделки шага 2.
      await page.getByRole('button', { name: 'Виграно', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Відкрити знову' })).toBeVisible()

      // Проигрыш — сделка тестовых данных из колонки «Передано в роботу», через меню карточки.
      await page.getByRole('navigation').getByRole('link', { name: 'Угоди' }).click()
      await waitForBoard(page)
      const lostCard = column(page, 'Передано в роботу').locator('article.deal-card').first()
      const lostTitle = (await lostCard.getAttribute('aria-label')) ?? ''
      const lostId = await dealIdOf(lostCard.getByRole('link', { name: lostTitle, exact: true }))
      await lostCard.getByRole('button', { name: `Дії з угодою «${lostTitle}»` }).click()
      await page.getByRole('menuitem', { name: 'Програти' }).click()
      const lose = page.getByRole('dialog', { name: `Програти угоду «${lostTitle}»` })
      await lose.getByLabel('Група причин').selectOption({ label: 'Якість ліда' })
      await lose.getByLabel('Причина', { exact: true }).selectOption({ label: 'Не актуально' })
      await lose.getByRole('button', { name: 'Програти' }).click()
      await expect(lose).toBeHidden()
      await expect(page.getByText(`Угоду «${lostTitle}» програно.`)).toBeVisible()

      await page.reload()
      await waitForBoard(page)
      await expect(dealCard(page, dealId)).toHaveCount(0)
      await expect(dealCard(page, lostId)).toHaveCount(0)

      // В списке — по фильтру статуса (и названию: выигранных и проигранных в данных сотни).
      for (const [status, title, id] of [
        ['Виграна', DEAL_TITLE, dealId],
        ['Програна', lostTitle, lostId],
      ] as const) {
        await page.goto('/p/alpi/deals/list')
        await applyFilter(page, [
          { field: 'Статус', op: 'дорівнює', value: status, kind: 'choice' },
          { field: 'Назва', op: 'містить', value: title, kind: 'text' },
        ])
        await expect(dealLink(page.locator('table.list-table'), id)).toBeVisible()
        expect(new Set(await columnValues(page, 'Статус'))).toEqual(new Set([status]))
      }
    })

    test.fixme('6. Поиск в шапке находит контакт по телефону в трёх форматах', async () => {
      // fixme: API поиска GET /api/v1/search (тикет crm-deals/08, PR #9) ещё не в main.
      for (const query of ['067 123 45 67', '+380671234567', '(067) 123-45-67']) {
        const search = page.getByRole('combobox', { name: 'Швидкий пошук' })
        await search.fill(query)
        const results = page.getByRole('listbox', { name: 'Результати пошуку' })
        await expect(
          results
            .getByRole('group', { name: 'Контакти' })
            .getByRole('option', { name: new RegExp(`${CONTACT.firstName} ${CONTACT.lastName}`) }),
        ).toBeVisible()
        await search.fill('')
      }
    })

    test('7. Список: «Етап = Новий лід» и «Створено раніше дати», массовый архив всего результата', async () => {
      await page.goto('/p/alpi/deals/list')
      await applyFilter(page, [
        { field: 'Етап', op: 'дорівнює', value: 'ALPI — Новий лід', kind: 'choice' },
        { field: 'Створено', op: 'раніше / менше', value: todayInput(), kind: 'text' },
      ])
      const total = await listCount(page)
      expect(total).toBeGreaterThan(0)
      expect(new Set(await columnValues(page, 'Етап'))).toEqual(new Set(['Новий лід']))

      await page.getByLabel('Вибрати всі на сторінці').check()
      const all = page.getByRole('button', { name: `Вибрати всі ${total} за фільтром` })
      if (await all.isVisible()) await all.click()
      await expect(page.getByText(`Вибрано всі за фільтром: ${total}`)).toBeVisible()

      await page.getByRole('button', { name: 'Масова дія' }).click()
      const bulk = page.getByRole('dialog', { name: 'Масова дія' })
      await expect(bulk.getByText(`Усі записи за фільтром: ${total}`)).toBeVisible()
      await bulk.getByLabel('Дія').selectOption({ label: 'Архівувати' })
      await bulk.getByRole('button', { name: 'Запустити' }).click()
      const progress = bulk.getByRole('progressbar', { name: 'Прогрес масової дії' })
      await expect(progress).toBeVisible()
      await expect(bulk.getByText(`Готово: оброблено ${total}, з помилкою 0.`)).toBeVisible({
        timeout: 60_000,
      })
      await expect(progress).toHaveAttribute('aria-valuenow', String(total))
      await expect(progress).toHaveAttribute('aria-valuemax', String(total))
      // Кнопка в подвале диалога, не крестик в заголовке (у него то же доступное имя).
      await bulk.getByRole('button', { name: 'Закрити' }).and(bulk.getByText('Закрити')).click()

      // Архивные в список по умолчанию не попадают: тот же фильтр — пусто.
      await expect(page.getByText('Нічого не знайдено. Змініть фільтр.')).toBeVisible()
      // На канбане ALPI в «Новий лід» не осталось ничего: все такие сделки созданы до сегодня.
      await page.goto('/p/alpi/deals')
      await waitForBoard(page)
      await expect(column(page, 'Новий лід').locator('.kanban-col__count')).toHaveText('0')
      await expect(column(page, 'Новий лід').getByText('Угод немає.')).toBeVisible()
    })

    test('8. Менеджер с охватом «свои» не видит чужих сделок; прямая ссылка — «Немає доступу»', async ({
      browser,
    }) => {
      const manager = seedUser(MANAGER)
      // Чужие сделки — то, что администратор видит на канбане ALPI у других ответственных.
      await waitForBoard(page)
      foreign = (
        await page.locator('article.deal-card').evaluateAll((cards) =>
          cards.map((card) => ({
            title: card.getAttribute('aria-label') ?? '',
            href: card.querySelector('a.deal-card__title')?.getAttribute('href') ?? '',
            owner: card.querySelector('.deal-card__row .deal-card__meta')?.textContent ?? null,
          })),
        )
      )
        .filter((deal) => deal.owner !== null && deal.owner !== manager.name)
        .map((deal) => ({ title: deal.title, id: deal.href.split('/').pop() ?? '' }))
      expect(foreign.length).toBeGreaterThan(0)

      managerContext = await newContext(browser)
      own = await managerContext.newPage()
      await signIn(own, manager)
      await expect(own).toHaveURL(/\/p\/alpi\/?$/)

      // Канбан: на каждой карточке — сам менеджер или общая очередь; чужих сделок нет.
      await own.goto('/p/alpi/deals')
      await waitForBoard(own)
      const owners = await own
        .locator('article.deal-card')
        .evaluateAll((cards) =>
          cards.map(
            (card) => card.querySelector('.deal-card__row .deal-card__meta')?.textContent ?? null,
          ),
        )
      expect(owners.length).toBeGreaterThan(0)
      expect(owners.filter((owner) => owner !== null && owner !== manager.name)).toEqual([])
      for (const deal of foreign) await expect(dealCard(own, deal.id)).toHaveCount(0)
      for (const title of await own
        .locator('article.deal-card')
        .evaluateAll((cards) => cards.map((card) => card.getAttribute('aria-label') ?? ''))) {
        ownTitles.add(title)
      }

      // Список: в столбце «Відповідальний» — только сам менеджер или очередь.
      await own.goto('/p/alpi/deals/list')
      await listCount(own)
      const listOwners = await columnValues(own, 'Відповідальний')
      expect(listOwners.length).toBeGreaterThan(0)
      expect(
        listOwners.filter((owner) => owner !== manager.name && owner !== 'Без відповідального'),
      ).toEqual([])
      for (const deal of foreign) {
        await expect(dealLink(own.locator('table.list-table'), deal.id)).toHaveCount(0)
      }
      for (const title of await columnValues(own, 'Назва')) ownTitles.add(title)

      // Прямая ссылка на чужую сделку — нейтральный экран «Немає доступу».
      await own.goto(`/p/alpi/deals/${foreign[0]?.id}`)
      await expect(own.getByRole('heading', { name: 'Немає доступу' })).toBeVisible()
    })

    test.fixme('8. (поиск) Менеджер с охватом «свои» не находит чужих сделок в поиске', async () => {
      // fixme: API поиска GET /api/v1/search (тикет crm-deals/08, PR #9) ещё не в main.
      await own.goto('/p/alpi/deals')
      const search = own.getByRole('combobox', { name: 'Швидкий пошук' })
      const checked = foreign.filter((deal) => !ownTitles.has(deal.title)).slice(0, 3)
      expect(checked.length).toBeGreaterThan(0)
      for (const deal of checked) {
        await search.fill(deal.title)
        await expect(
          own
            .getByRole('listbox', { name: 'Результати пошуку' })
            .or(own.getByText('Нічого не знайдено.')),
        ).toBeVisible()
        await expect(
          own
            .getByRole('group', { name: 'Угоди' })
            .getByRole('option', { name: deal.title, exact: true }),
        ).toHaveCount(0)
      }
    })
  })
