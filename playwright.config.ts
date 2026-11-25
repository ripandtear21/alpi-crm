import { defineConfig, devices } from '@playwright/test'

// Сквозной тест приёмки (тикет crm-deals/16): `pnpm e2e` — сборка клиента, затем Playwright.
// Стенд (своя база, pnpm seed, API, клиент) поднимает e2e/global-setup.ts на каждый запуск;
// сценарий crm-fields/09 поднимает себе второй такой же (e2e/support/stack-process.ts).
// Сценарий идёт по шагам на одних данных, поэтому исполнитель один и повторов нет.
export default defineConfig({
  testDir: './e2e',
  testMatch: '*.spec.ts',
  globalSetup: './e2e/global-setup.ts',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    ...devices['Desktop Chrome'],
    locale: 'uk-UA',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      testMatch: 'acceptance.spec.ts',
      use: { viewport: { width: 1440, height: 900 } },
    },
    {
      // Шаги 2–3 на телефоне: канбан вкладками, смена этапа через меню карточки. После
      // основного сценария: шаг 7 архивирует весь «Новий лід», созданный до сегодня.
      name: 'phone-375',
      testMatch: 'phone.spec.ts',
      dependencies: ['desktop'],
      use: { viewport: { width: 375, height: 812 }, hasTouch: true },
    },
    {
      // Сценарий приёмки конструктора полей (тикет crm-fields/09): свой стенд и своя база —
      // поднимает фикстура в самом файле, от проектов выше не зависит. Прогон на 375 px — там же,
      // своей вкладкой.
      name: 'fields',
      testMatch: 'fields-acceptance.spec.ts',
      use: { viewport: { width: 1440, height: 900 } },
    },
  ],
})
